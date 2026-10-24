/**
 * Minimal streaming reverse proxy for HTTP and WebSocket upgrades.
 *
 * Deliberately dependency-free: the public entry only needs to forward what
 * the DSH browser UI already does (HTML/JS/assets, /api JSON, SSE and WS),
 * while preserving streaming behavior. Header sanitation and authentication
 * belong to `gateway.js`; this module forwards `req.headers` verbatim.
 */

import http from 'node:http'
import net from 'node:net'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Copy headers without mutating the source object. */
function copyHeaders(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    out[name] = value
  }
  return out
}

/** Serialize a WebSocket handshake request for the loopback upstream. */
function serializeUpgrade(req) {
  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`)
    } else {
      lines.push(`${name}: ${String(value)}`)
    }
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * @param {{ upstream: URL, logger?: { warn: (obj: unknown) => void }, idleTimeoutMs?: number }} options
 */
export function createProxy(options) {
  const upstream = options.upstream
  const logger = options.logger
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000
  const agent = new http.Agent({ keepAlive: true, maxSockets: 128 })

  function upstreamRequestOptions(req) {
    return {
      protocol: 'http:',
      hostname: upstream.hostname,
      port: upstream.port || 80,
      method: req.method,
      path: req.url,
      headers: copyHeaders(req.headers),
      agent,
    }
  }

  return {
    /**
     * Proxy one HTTP request/response pair.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {(error: Error) => void} onError
     * @param {{ onResponse?: (statusCode: number, upstreamRes: import('node:http').IncomingMessage) => boolean }} [options]
     *   `onResponse` may claim a response (returns true) after reading/discarding it.
     */
    web(req, res, onError, options = {}) {
      const startedAt = Date.now()
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        logger?.warn?.({ event: 'upstream_error', message: error?.message, ms: Date.now() - startedAt })
        onError(error instanceof Error ? error : new Error(String(error)))
      }

      const upstreamReq = http.request(upstreamRequestOptions(req), (upstreamRes) => {
        settled = true
        if (typeof options.onResponse === 'function' && options.onResponse(upstreamRes.statusCode ?? 0, upstreamRes) === true) {
          upstreamRes.resume()
          return
        }
        // Strip hop-by-hop headers the upstream must not hand back verbatim.
        const headers = {}
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined) continue
          if (HOP_BY_HOP.has(name.toLowerCase())) continue
          headers[name] = value
        }
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, headers)
        upstreamRes.pipe(res)
        upstreamRes.on('error', (error) => {
          logger?.warn?.({ event: 'upstream_response_error', message: error?.message })
          res.destroy()
        })
      })

      upstreamReq.setTimeout(idleTimeoutMs, () => {
        upstreamReq.destroy(new Error('upstream timeout'))
      })
      upstreamReq.on('error', fail)
      req.on('error', fail)
      req.pipe(upstreamReq)
      res.on('close', () => {
        if (!res.writableEnded) upstreamReq.destroy()
      })
    },

    /**
     * Proxy one WebSocket upgrade by piping raw sockets.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:stream').Duplex} socket
     * @param {Buffer} head
     * @param {(error: Error) => void} onError
     */
    ws(req, socket, head, onError) {
      const target = net.connect(Number(upstream.port || 80), upstream.hostname)
      target.setNoDelay(true)
      socket.setNoDelay?.(true)

      let closed = false
      const closeBoth = () => {
        if (closed) return
        closed = true
        socket.destroy()
        target.destroy()
      }
      const fail = (error) => {
        logger?.warn?.({ event: 'ws_upstream_error', message: error?.message })
        if (!closed) onError(error instanceof Error ? error : new Error(String(error)))
        closeBoth()
      }

      target.once('connect', () => {
        target.write(serializeUpgrade(req))
        if (head && head.length > 0) target.write(head)
        socket.pipe(target)
        target.pipe(socket)
        target.on('error', fail)
        socket.on('error', fail)
        socket.on('close', () => closeBoth())
        target.on('close', () => closeBoth())
      })
      target.once('error', fail)
      socket.once('error', fail)
      target.setTimeout(idleTimeoutMs, () => fail(new Error('ws idle timeout')))
      socket.setTimeout?.(0)
    },

    close() {
      agent.destroy()
    },
  }
}
