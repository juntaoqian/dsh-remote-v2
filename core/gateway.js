/**
 * Loopback remote-access gateway.
 *
 * Responsibilities:
 *   1. serve the one-time pairing page (`/pair`) and claim endpoint
 *      (`/pair/claim`), issuing device-session cookies;
 *   2. enforce the public same-origin policy (Host / Origin / sec-fetch-site);
 *   3. authenticate every other request with the device cookie;
 *   4. deny the plugin's own management prefix (decode-safe, defense in depth);
 *   5. stream authenticated HTTP and WebSocket traffic to the loopback DSH web
 *      server after rewriting Host/Origin and stripping edge credentials.
 *
 * The gateway only ever listens on 127.0.0.1. The public origin is provided by
 * the tunnel manager and starts undefined ("CLOSED"): until a tunnel reports a
 * validated URL, every request except loopback /healthz is rejected with 503.
 */

import { createServer } from 'node:http'

import {
  deviceCookie,
  isLoopbackHost,
  normalizePathname,
  parseCookieHeader,
  readBody,
  sendJson,
  sendText,
  STRIPPED_UPSTREAM_HEADERS,
  stripCookie,
} from './http-util.js'
import { createProxy } from './proxy.js'

const MAX_CLAIM_BODY = 4 * 1024

const PAIRING_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>DSH Remote v2 · 配对</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d12;color:#e8eaf0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
main{width:min(92vw,420px);padding:28px 24px;border-radius:16px;background:#151922;box-shadow:0 18px 60px rgba(0,0,0,.45)}
h1{font-size:20px;margin:0 0 8px}
p{color:#a9b1c3;margin:8px 0 20px}
form{display:flex;gap:10px}
input{flex:1;padding:12px 14px;border-radius:10px;border:1px solid #2c3342;background:#0d1118;color:#fff;font-size:17px;letter-spacing:.18em;text-transform:uppercase}
button{padding:12px 18px;border:0;border-radius:10px;background:#4d6bfe;color:#fff;font-size:15px;font-weight:600}
button:active{opacity:.85}
.hint{font-size:13px;color:#6f7a90;margin-top:16px}
.err{color:#ff7b72}
</style>
</head>
<body>
<main>
<h1>DSH Remote v2</h1>
<p id="msg">正在配对…</p>
<form id="form" hidden>
  <input id="code" inputmode="text" autocomplete="one-time-code" maxlength="8" placeholder="8 位配对码" aria-label="8 位配对码">
  <button type="submit">连接</button>
</form>
<p class="hint">配对码由电脑端「设置 → 远程访问」生成，5 分钟内有效且只能使用一次。</p>
</main>
<script>
(function () {
  var msg = document.getElementById('msg');
  var form = document.getElementById('form');
  var input = document.getElementById('code');
  function fail(text) { msg.textContent = text; msg.className = 'err'; form.hidden = false; }
  function claim(payload) {
    msg.textContent = '正在配对…';
    msg.className = '';
    fetch('/pair/claim', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (response.ok && body.ok) { location.replace(body.redirect || '/'); return; }
        if (response.status === 429) fail('请求过于频繁，请稍后再试。');
        else if (response.status === 401) fail('配对码无效或已过期，请在电脑端重新生成。');
        else fail('配对失败，请重试。');
      });
    }).catch(function () { fail('网络错误，请检查连接后重试。'); });
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var value = input.value.trim().toUpperCase();
    if (value.length >= 6) claim({ code: value });
  });
  var match = location.hash.match(/^#s=([A-Za-z0-9_-]{43})$/);
  if (match) {
    history.replaceState(null, '', location.pathname);
    claim({ secret: match[1] });
  } else {
    msg.textContent = '请输入电脑端显示的 8 位配对码。';
    form.hidden = false;
    input.focus();
  }
})();
</script>
</body>
</html>`

function pairingHeaders() {
  return {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
  }
}

function exactOrigin(value, expected) {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).origin === value && value === expected
  } catch {
    return false
  }
}

/**
 * @param {{
 *   upstream: URL,
 *   devices: { verify: (token: string) => Promise<unknown>, create: (name?: string, ua?: string) => Promise<{ id: string, token: string }> },
 *   pairing: { claim: (credential: string) => { ok: boolean, reason?: string }, peek: () => unknown, invalidateAll: () => void },
 *   getPublicOrigin: () => URL | undefined,
 *   getLaunchUrl?: (origin: string) => Promise<string | undefined>,
 *   logger?: { info?: (obj: unknown) => void, warn?: (obj: unknown) => void },
 *   deniedPrefix?: string[],
 *   cookieName?: string,
 *   cookieSecure?: boolean,
 *   cookieMaxAgeSeconds?: number,
 *   now?: () => number,
 * }} options
 */
export function createGateway(options) {
  const upstream = options.upstream
  const devices = options.devices
  const pairing = options.pairing
  const logger = options.logger
  const getPublicOrigin = options.getPublicOrigin
  const getLaunchUrl = options.getLaunchUrl
  const deniedPrefix = (options.deniedPrefix ?? ['/dsh-remote-v2']).map((prefix) => prefix.toLowerCase())
  const cookieName = options.cookieName ?? 'dsh_remote_v2'
  const cookieSecure = options.cookieSecure ?? true
  const cookieMaxAgeSeconds = options.cookieMaxAgeSeconds ?? 7 * 24 * 3600

  const proxy = createProxy({ upstream, logger })

  function origin() {
    try {
      return getPublicOrigin()
    } catch {
      return undefined
    }
  }

  function hostMatches(req, expected) {
    const host = req.headers.host
    return typeof host === 'string' && host.toLowerCase() === expected.host
  }

  function isDenied(pathname) {
    const lower = pathname.toLowerCase()
    return deniedPrefix.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`))
  }

  function tokenFromCookies(req) {
    const { values, duplicated } = parseCookieHeader(req.headers.cookie)
    if (duplicated.has(cookieName)) return undefined
    return values.get(cookieName)
  }

  async function servePairingPage(req, res, current) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'method not allowed', { allow: 'GET, HEAD' })
      return
    }
    if (!hostMatches(req, current)) {
      logger?.warn?.({ event: 'pair_page_host_mismatch' })
      sendText(res, 403, 'forbidden')
      return
    }
    res.writeHead(200, pairingHeaders())
    res.end(req.method === 'HEAD' ? undefined : PAIRING_PAGE)
  }

  async function handleClaim(req, res, current) {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed', { allow: 'POST' })
      return
    }
    if (!hostMatches(req, current)) {
      sendText(res, 403, 'forbidden')
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      sendJson(res, 415, { ok: false, error: 'content-type-must-be-json' })
      return
    }
    let body
    try {
      const raw = await readBody(req, MAX_CLAIM_BODY)
      body = JSON.parse(raw.toString('utf8'))
    } catch (error) {
      if (error && error.code === 'body-too-large') sendJson(res, 413, { ok: false, error: 'body-too-large' })
      else sendJson(res, 400, { ok: false, error: 'bad-json' })
      return
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: 'bad-request' })
      return
    }
    const credential =
      typeof body.secret === 'string'
        ? body.secret
        : typeof body.code === 'string'
          ? body.code
          : undefined
    if (credential === undefined) {
      sendJson(res, 400, { ok: false, error: 'bad-request' })
      return
    }
    const outcome = pairing.claim(credential)
    if (!outcome.ok) {
      if (outcome.reason === 'rate-limited') {
        logger?.warn?.({ event: 'pair_claim_rate_limited' })
        sendJson(res, 429, { ok: false, error: 'rate-limited' })
      } else {
        logger?.warn?.({ event: 'pair_claim_rejected', reason: outcome.reason })
        sendJson(res, 401, { ok: false, error: 'pairing-failed' })
      }
      return
    }

    let device
    try {
      const name = typeof body.name === 'string' ? body.name.slice(0, 64) : undefined
      const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined
      device = await devices.create(name, ua)
    } catch (error) {
      logger?.warn?.({ event: 'pair_device_create_failed', message: error?.message })
      sendJson(res, 500, { ok: false, error: 'device-create-failed' })
      return
    }

    let redirect = `${current.origin}/`
    if (typeof getLaunchUrl === 'function') {
      try {
        const launch = await getLaunchUrl(current.origin)
        if (typeof launch === 'string' && launch.length > 0) redirect = launch
      } catch (error) {
        logger?.warn?.({ event: 'pair_launch_url_failed', message: error?.message })
      }
    }
    logger?.info?.({ event: 'device_paired', deviceId: device.id })
    sendJson(res, 200, { ok: true, redirect }, {
      'set-cookie': deviceCookie(cookieName, device.token, {
        secure: cookieSecure,
        maxAgeSeconds: cookieMaxAgeSeconds,
      }),
    })
  }

  /** Apply upstream header normalization in place. */
  function prepareUpstreamHeaders(req, { preserveUpgrade = false } = {}) {
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      headers[name] = value
    }
    for (const name of STRIPPED_UPSTREAM_HEADERS) {
      // The WebSocket handshake IS the hop-by-hop pair: stripping `connection`
      // and `upgrade` would turn a real upgrade into a plain GET, which DSH
      // answers with 404 for the mux route (the remote UI then spins forever).
      if (preserveUpgrade && (name === 'connection' || name === 'upgrade')) continue
      delete headers[name]
    }
    delete headers.host
    headers.host = upstream.host
    if (headers.origin !== undefined) headers.origin = upstream.origin
    const cookie = stripCookie(typeof headers.cookie === 'string' ? headers.cookie : undefined, cookieName)
    if (cookie === undefined) delete headers.cookie
    else headers.cookie = cookie
    req.headers = headers
  }

  function checkOriginPolicy(req, current, { requireOrigin }) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    const requestOrigin = req.headers.origin
    if (requestOrigin !== undefined) {
      if (!exactOrigin(requestOrigin, current.origin)) return false
    } else if (requireOrigin) {
      return false
    }
    return true
  }

  const server = createServer((req, res) => {
    void (async () => {
      const pathname = normalizePathname(req.url)
      try {
        if (pathname === '/healthz' && isLoopbackHost(req.headers.host)) {
          sendJson(res, 200, { status: 'ok' })
          return
        }
        const current = origin()
        if (current === undefined) {
          sendText(res, 503, 'remote access is not ready')
          return
        }
        if (pathname === '/pair') {
          await servePairingPage(req, res, current)
          return
        }
        if (pathname === '/pair/claim') {
          await handleClaim(req, res, current)
          return
        }
        if (!hostMatches(req, current)) {
          logger?.warn?.({ event: 'http_rejected_host', path: pathname })
          sendText(res, 403, 'forbidden')
          return
        }
        if (isDenied(pathname)) {
          sendText(res, 404, 'not found')
          return
        }
        if (!checkOriginPolicy(req, current, { requireOrigin: req.method !== 'GET' && req.method !== 'HEAD' })) {
          logger?.warn?.({ event: 'http_rejected_origin', path: pathname, method: req.method })
          sendText(res, 403, 'forbidden')
          return
        }
        const token = tokenFromCookies(req)
        if (token === undefined || (await devices.verify(token)) === undefined) {
          logger?.warn?.({ event: 'http_rejected_auth', path: pathname })
          sendText(res, 401, 'unauthorized')
          return
        }
        prepareUpstreamHeaders(req)
        proxy.web(req, res, () => sendText(res, 502, 'bad gateway'))
      } catch (error) {
        logger?.warn?.({ event: 'gateway_internal_error', path: pathname, message: error?.message })
        if (!res.headersSent) sendText(res, 500, 'internal error')
        else res.destroy()
      }
    })()
  })

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const pathname = normalizePathname(req.url)
      const current = origin()
      if (current === undefined) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n')
        return
      }
      if (!hostMatches(req, current) || isDenied(pathname)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      if (!checkOriginPolicy(req, current, { requireOrigin: true })) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      const token = tokenFromCookies(req)
      if (token === undefined || (await devices.verify(token)) === undefined) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return
      }
      prepareUpstreamHeaders(req, { preserveUpgrade: true })
      proxy.ws(req, socket, head, () => socket.destroy())
    })().catch(() => socket.destroy())
  })

  return {
    /**
     * Start listening on loopback.
     * @param {number} [port] fixed port for a Named Tunnel, or 0 for a random one.
     */
    start(port = 0) {
      return new Promise((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          const address = server.address()
          const boundPort = typeof address === 'object' && address !== null ? address.port : 0
          resolvePromise({ port: boundPort })
        })
      })
    },
    /** Stop accepting connections and close the upstream agent. */
    stop() {
      proxy.close()
      return new Promise((resolvePromise) => {
        if (!server.listening) {
          resolvePromise()
          return
        }
        server.close(() => resolvePromise())
        server.closeIdleConnections?.()
      })
    },
    /** Read-only diagnostic snapshot. */
    info() {
      const current = origin()
      return {
        publicOrigin: current === undefined ? null : current.origin,
        pairing: pairing.peek(),
      }
    },
  }
}
