/**
 * Small HTTP helpers shared by the gateway, control server and tests.
 * No third-party dependencies; plain node built-ins only.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** Headers that must never be forwarded from the public edge to the DSH host. */
export const STRIPPED_UPSTREAM_HEADERS = [
  'authorization',
  'cf-access-jwt-assertion',
  'cf-access-client-id',
  'cf-access-client-secret',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

/**
 * Read a request body, rejecting (code 'body-too-large') beyond `limit`.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
export function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error('body too large')
        error.code = 'body-too-large'
        req.destroy()
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', reject)
    req.on('aborted', () => {
      const error = new Error('request aborted')
      error.code = 'aborted'
      reject(error)
    })
  })
}

/**
 * Write a JSON response with no-store caching.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 * @param {Record<string, string | string[]>} [headers]
 */
export function sendJson(res, status, value, headers = {}) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(body)
}

/**
 * Write a plain text response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 * @param {Record<string, string | string[]>} [headers]
 */
export function sendText(res, status, text, headers = {}) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(text)
}

/**
 * Parse a Cookie header, reporting duplicate names separately so callers can
 * reject ambiguous bearer-cookie smuggling.
 * @param {string | undefined} header
 * @returns {{ values: Map<string, string>, duplicated: Set<string> }}
 */
export function parseCookieHeader(header) {
  const values = new Map()
  const duplicated = new Set()
  if (typeof header !== 'string') return { values, duplicated }
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const equals = trimmed.indexOf('=')
    if (equals <= 0) continue
    const name = trimmed.slice(0, equals).trim()
    const value = trimmed.slice(equals + 1)
    if (values.has(name)) duplicated.add(name)
    else values.set(name, value)
  }
  return { values, duplicated }
}

/** Remove one cookie name from a Cookie header, preserving the rest. */
export function stripCookie(header, name) {
  if (typeof header !== 'string') return undefined
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const equals = part.indexOf('=')
      const key = equals === -1 ? part : part.slice(0, equals)
      return key !== name
    })
  return kept.length === 0 ? undefined : kept.join('; ')
}

/**
 * Normalize a request target for security decisions: absolute-form URLs are
 * reduced to their path, backslashes become slashes, percent-encoding is
 * decoded up to three times, and dot segments are resolved. The result always
 * starts with '/'.
 * @param {string | undefined} raw
 * @returns {string}
 */
export function normalizePathname(raw) {
  let value = raw ?? '/'
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = new URL(value).pathname
  } catch {
    return '/'
  }
  for (let i = 0; i < 3; i += 1) {
    let decoded
    try {
      decoded = decodeURIComponent(value)
    } catch {
      break
    }
    if (decoded === value) break
    value = decoded
  }
  value = value.replace(/\\/g, '/')
  if (!value.startsWith('/')) value = `/${value}`
  try {
    // URL resolves dot segments (including percent-encoded variants) and
    // collapses duplicate slashes without decoding ordinary path characters.
    value = new URL(value, 'http://gateway.invalid').pathname
  } catch {
    return '/'
  }
  if (value.length > 2048) value = value.slice(0, 2048)
  return value.length === 0 ? '/' : value
}

/** Whether a Host header names the local machine. */
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false
  const name = host.toLowerCase().replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/** Constant-time string equality over SHA-256 digests. */
export function safeEqual(a, b) {
  const left = createHash('sha256').update(String(a), 'utf8').digest()
  const right = createHash('sha256').update(String(b), 'utf8').digest()
  return timingSafeEqual(left, right)
}

/** Build a `Set-Cookie` value for a host-only session cookie. */
export function deviceCookie(name, token, { secure = true, maxAgeSeconds = 7 * 24 * 3600 } = {}) {
  const parts = [
    `${name}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(maxAgeSeconds)}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
