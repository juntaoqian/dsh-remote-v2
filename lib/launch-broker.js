/**
 * dsh-remote-v2 — loopback launch-URL broker.
 *
 * The sidecar (and therefore Cloudflare's edge) never holds DSH's browser
 * launch token. After pairing, `core/gateway.js` asks this broker for a URL
 * that carries DSH's own one-time launch token by calling
 * `ctx.connection.authenticatedUrl(origin)`. The broker is bound to
 * `127.0.0.1` and requires a random Bearer token that only the sidecar knows,
 * so a remote peer cannot mint authenticated DSH URLs even if it reaches the
 * loopback port.
 *
 * Wire contract (docs/contracts.md §10):
 *   POST /launch-url   Authorization: Bearer <DSH_REMOTE_V2_BROKER_TOKEN>
 *   body: { "origin": "https://xxx.trycloudflare.com" }
 *   → { "ok": true, "url": "https://.../?token=..." }
 *   → { "ok": false, "error": { "code": "...", "message": "..." } }
 *
 * @module lib/launch-broker
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'

/** Default POST body cap for `/launch-url`; requests carry one origin URL. */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024

/** Maximum accepted origin length. */
const MAX_ORIGIN_LENGTH = 2_048

/**
 * Message-shaped envelope for a broker failure.
 * @param {string} code stable error code.
 * @param {string} message human-readable message.
 * @returns {{ ok: false, error: { code: string, message: string } }} envelope.
 */
function failure(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * Constant-time bearer comparison.
 *
 * Hashing both sides first keeps `timingSafeEqual` length-stable, so the
 * comparison does not leak the expected token length.
 * @param {unknown} expected configured token.
 * @param {unknown} supplied caller-provided header value.
 * @returns {boolean} true only for an exact Bearer match.
 */
function tokensMatch(expected, supplied) {
  if (typeof expected !== 'string' || expected === '') return false
  if (typeof supplied !== 'string') return false
  const digest = (value) => createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(digest(expected), digest(supplied))
}

/**
 * Whether a `Host` header names the loopback interface.
 *
 * The broker is only reachable via loopback, so a non-loopback Host means a
 * rebinding-style or proxied request and is refused.
 * @param {string | undefined} header `Host` header value.
 * @returns {boolean} true for 127.0.0.0/8, `localhost`, or `::1`.
 */
function isLoopbackHost(header) {
  if (typeof header !== 'string' || header === '') return false
  let hostname
  try {
    hostname = new URL(`http://${header}`).hostname
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  const ipv4 = hostname.startsWith('::ffff:') ? hostname.slice('::ffff:'.length) : hostname
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipv4)
  if (match === null) return false
  return match[1] === '127'
}

/**
 * Validate a caller-supplied origin and return its normalised form.
 * @param {unknown} value claimed public origin.
 * @returns {string | undefined} `http(s)` origin, or undefined when invalid.
 */
function normalizeOrigin(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_ORIGIN_LENGTH) return undefined
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  if (url.hostname === '') return undefined
  // The broker mints a launch URL for a public entry root; a path/query on the
  // claimed origin would be dropped by `authenticatedUrl` anyway.
  url.search = ''
  url.hash = ''
  return url.origin
}

/**
 * Degraded launch URL used when DSH's `authenticatedUrl` is unavailable.
 *
 * Sending the user to `/` is the documented fallback (contracts §10); the DSH
 * cookie the remote browser already has may still admit it.
 * @param {string} origin validated origin.
 * @returns {string | undefined} `origin + '/'`.
 */
export function fallbackLaunchUrl(origin) {
  const normalized = normalizeOrigin(origin)
  if (normalized === undefined) return undefined
  return `${normalized}/`
}

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @param {number} limit byte cap.
 * @returns {Promise<{ kind: 'value', value: unknown } | { kind: 'invalid' | 'too-large' }>} decoded outcome.
 */
async function readJsonBody(request, limit) {
  const declared = request.headers['content-length']
  if (declared !== undefined && Number(declared) > limit) return { kind: 'too-large' }
  const chunks = []
  let received = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buffer.byteLength
    if (received > limit) return { kind: 'too-large' }
    chunks.push(buffer)
  }
  try {
    return { kind: 'value', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { kind: 'invalid' }
  }
}

/**
 * One loopback HTTP broker exposing `POST /launch-url`.
 *
 * @param {object} options options.
 * @param {string} options.token Bearer token the sidecar must present.
 * @param {(origin: string) => Promise<string | undefined> | string | undefined} options.getLaunchUrl launch-token resolver (host calls `ctx.connection.authenticatedUrl`).
 * @param {string} [options.host] bind address; only loopback makes sense.
 * @param {number} [options.port] bind port; 0 requests an OS-assigned port.
 * @param {number} [options.maxBodyBytes] POST body cap.
 * @param {{ info?: (message: string) => void, warn?: (message: string) => void, error?: (message: string) => void }} [options.logger] best-effort logger.
 * @returns {{ start: () => Promise<{ port: number, origin: string, launchUrl: string }>, stop: () => Promise<void>, port: () => number | undefined }} broker handle.
 */
export function createLaunchBroker(options) {
  const {
    token,
    getLaunchUrl,
    host = '127.0.0.1',
    port = 0,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    logger = {},
  } = options
  if (typeof token !== 'string' || token === '') {
    throw new Error('launch-broker: a non-empty Bearer token is required')
  }
  if (typeof getLaunchUrl !== 'function') {
    throw new Error('launch-broker: getLaunchUrl must be a function')
  }

  /** @type {import('node:http').Server | undefined} */
  let server
  /** @type {number | undefined} */
  let actualPort
  /** @type {Promise<{ port: number, origin: string, launchUrl: string }> | undefined} */
  let starting

  /**
   * Send one JSON response and finish the exchange.
   * @param {import('node:http').ServerResponse} response response to own.
   * @param {number} status HTTP status code.
   * @param {unknown} body JSON body.
   * @returns {void}
   */
  function sendJson(response, status, body) {
    if (response.writableEnded) return
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    response.end(payload)
  }

  /**
   * Handle `POST /launch-url`.
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @param {import('node:http').ServerResponse} response response to own.
   * @returns {Promise<void>} resolves once the exchange is finished.
   */
  async function handleLaunchUrl(request, response) {
    if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      sendJson(response, 415, failure('content-type-required', '请求必须是 application/json'))
      return
    }
    const body = await readJsonBody(request, maxBodyBytes)
    if (body.kind === 'too-large') {
      sendJson(response, 413, failure('body-too-large', '请求体过大'))
      return
    }
    if (body.kind === 'invalid' || typeof body.value !== 'object' || body.value === null || Array.isArray(body.value)) {
      sendJson(response, 400, failure('invalid-body', '请求体必须是 JSON 对象'))
      return
    }
    const origin = normalizeOrigin(/** @type {{ origin?: unknown }} */ (body.value).origin)
    if (origin === undefined) {
      sendJson(response, 400, failure('invalid-origin', 'origin 必须是有效的 http(s) 地址'))
      return
    }
    let launchUrl
    try {
      launchUrl = await getLaunchUrl(origin)
    } catch (error) {
      logger.warn?.(
        `[dsh-remote-v2] launch broker: authenticatedUrl failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      launchUrl = undefined
    }
    const resolved = typeof launchUrl === 'string' && launchUrl !== '' ? launchUrl : fallbackLaunchUrl(origin)
    if (resolved === undefined) {
      sendJson(response, 500, failure('launch-url-unavailable', '无法生成启动链接'))
      return
    }
    sendJson(response, 200, { ok: true, url: resolved })
  }

  /**
   * Route one broker request.
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @param {import('node:http').ServerResponse} response response to own.
   * @returns {Promise<void>} resolves once the exchange is finished.
   */
  async function route(request, response) {
    try {
      if (!isLoopbackHost(request.headers.host)) {
        sendJson(response, 403, failure('forbidden-host', '启动服务仅接受本机请求'))
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (pathname === '/healthz' && request.method === 'GET') {
        sendJson(response, 200, { ok: true })
        return
      }
      if (pathname !== '/launch-url') {
        sendJson(response, 404, failure('not-found', '接口不存在'))
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, failure('method-not-allowed', '只支持 POST'))
        return
      }
      const header = request.headers.authorization
      const supplied = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
      if (!tokensMatch(token, supplied)) {
        sendJson(response, 401, failure('unauthorized', '启动服务认证失败'))
        return
      }
      await handleLaunchUrl(request, response)
    } catch (error) {
      logger.error?.(
        `[dsh-remote-v2] launch broker request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      if (!response.writableEnded) {
        sendJson(response, 500, failure('broker-failure', '启动服务内部错误'))
      }
    }
  }

  /**
   * Start listening. Idempotent while `start` is in flight.
   * @returns {Promise<{ port: number, origin: string, launchUrl: string }>} bound endpoint facts.
   */
  async function start() {
    if (starting !== undefined) return await starting
    if (server !== undefined && actualPort !== undefined) {
      return { port: actualPort, origin: `http://${host}:${String(actualPort)}`, launchUrl: `http://${host}:${String(actualPort)}/launch-url` }
    }
    starting = new Promise((resolve, reject) => {
      const created = http.createServer((request, response) => {
        void route(request, response)
      })
      const onError = (error) => {
        created.removeListener('listening', onListening)
        starting = undefined
        reject(error)
      }
      const onListening = () => {
        created.removeListener('error', onError)
        const address = created.address()
        if (address === null || typeof address === 'string') {
          starting = undefined
          created.close()
          reject(new Error('launch-broker: unexpected listen address'))
          return
        }
        server = created
        actualPort = address.port
        const origin = `http://${host}:${String(actualPort)}`
        resolve({ port: actualPort, origin, launchUrl: `${origin}/launch-url` })
      }
      created.once('error', onError)
      created.once('listening', onListening)
      created.listen(port, host)
    })
    return await starting
  }

  /**
   * Close the listener; safe to call repeatedly and when never started.
   * @returns {Promise<void>} resolves once closed.
   */
  async function stop() {
    starting = undefined
    const current = server
    server = undefined
    actualPort = undefined
    if (current === undefined) return
    current.closeAllConnections?.()
    await new Promise((resolve) => {
      current.close(() => { resolve() })
    })
  }

  /**
   * Bound port, when started.
   * @returns {number | undefined} listening port.
   */
  function boundPort() {
    return actualPort
  }

  return { start, stop, port: boundPort }
}
