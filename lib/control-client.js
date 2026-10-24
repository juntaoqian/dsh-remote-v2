/**
 * dsh-remote-v2 — client for the sidecar's loopback control API.
 *
 * The sidecar (`core/sidecar.js`) binds a control HTTP server to
 * `127.0.0.1:0` and publishes `{ port, pid, startedAt, version }` to
 * `<stateDir>/control.json` once it is ready (docs/contracts.md §1, §8).
 * This module owns:
 *
 *   - reading/waiting for that control file,
 *   - mapping the settings-page management methods onto the control routes,
 *   - normalising transport failures into `{ ok:false, error:{ code, message } }`
 *     so the host adapter never has to invent an error shape.
 *
 * @module lib/control-client
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** File name the sidecar atomically writes into the state directory. */
export const CONTROL_FILE_NAME = 'control.json'

/** Default upper bound the host waits for `control.json` (contracts §1). */
export const DEFAULT_CONTROL_TIMEOUT_MS = 15_000

/** Default poll interval while waiting for `control.json`. */
export const CONTROL_POLL_INTERVAL_MS = 100

/** Default per-request timeout for control API calls. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

/** Upper bound for a control API response body (defensive; responses are small). */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/**
 * Create an Error carrying a stable machine-readable `code`.
 * @param {string} code stable error code reported to the settings page.
 * @param {string} message human-readable (Chinese-first) message.
 * @param {unknown} [cause] optional underlying failure.
 * @returns {Error & { code: string }} the coded error.
 */
export function codedError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  /** @type {Error & { code: string }} */
  const coded = /** @type {Error & { code: string }} */ (error)
  coded.code = code
  return coded
}

/**
 * Failure envelope in the control API's wire shape.
 * @param {string} code stable error code.
 * @param {string} message human-readable message.
 * @returns {{ ok: false, error: { code: string, message: string } }} envelope.
 */
export function failure(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * Absolute control URL for a loopback port.
 * @param {number} port control server port.
 * @returns {string} `http://127.0.0.1:<port>`.
 */
export function controlBaseUrl(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw codedError('control-bad-port', `控制服务端口无效：${String(port)}`)
  }
  return `http://127.0.0.1:${String(port)}`
}

/**
 * Path of the sidecar control file inside the state directory.
 * @param {string} stateDir absolute state directory.
 * @returns {string} absolute `control.json` path.
 */
export function controlFilePath(stateDir) {
  return join(stateDir, CONTROL_FILE_NAME)
}

/**
 * Remove a stale control file before spawning a new sidecar.
 *
 * A control file left over from a previous host generation would point at a
 * dead port; removing it makes the new sidecar's atomic write the only
 * readable document.
 * @param {string} stateDir absolute state directory.
 * @returns {Promise<void>} resolves even when nothing was removed.
 */
export async function removeStaleControlFile(stateDir) {
  await rm(controlFilePath(stateDir), { force: true })
}

/**
 * Read and validate `<stateDir>/control.json` once.
 * @param {string} stateDir absolute state directory.
 * @returns {Promise<{ port: number, pid?: number, startedAt?: number, version?: string } | undefined>} parsed document, or undefined when absent/invalid.
 */
export async function readControlFile(stateDir) {
  let raw
  try {
    raw = await readFile(controlFilePath(stateDir), 'utf8')
  } catch {
    return undefined
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const candidate = /** @type {{ port?: unknown, pid?: unknown, startedAt?: unknown, version?: unknown }} */ (parsed)
  if (!Number.isInteger(candidate.port) || candidate.port <= 0 || candidate.port > 65_535) return undefined
  const document = { port: /** @type {number} */ (candidate.port) }
  if (Number.isInteger(candidate.pid)) document.pid = /** @type {number} */ (candidate.pid)
  if (Number.isFinite(candidate.startedAt)) document.startedAt = /** @type {number} */ (candidate.startedAt)
  if (typeof candidate.version === 'string') document.version = candidate.version
  return document
}

/**
 * Sleep for a bounded duration.
 * @param {number} milliseconds delay.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(milliseconds) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

/**
 * Poll `<stateDir>/control.json` until the sidecar publishes a usable port.
 *
 * Stale files are the primary failure mode (a previous host generation), so
 * when `expectedPid` is known a document produced by another process is
 * ignored instead of trusted.
 * @param {object} options options.
 * @param {string} options.stateDir absolute state directory.
 * @param {number} [options.timeoutMs] total wait budget.
 * @param {number} [options.intervalMs] poll interval.
 * @param {number} [options.expectedPid] sidecar pid; documents with another pid are ignored.
 * @param {() => boolean} [options.isCancelled] abort predicate checked between polls.
 * @param {(milliseconds: number) => Promise<void>} [options.sleepImpl] injected sleep (tests).
 * @returns {Promise<{ port: number, pid?: number, startedAt?: number, version?: string }>} the control document.
 * @throws {Error & { code: string }} `control-timeout` or `control-cancelled`.
 */
export async function waitForControlFile(options) {
  const {
    stateDir,
    timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
    intervalMs = CONTROL_POLL_INTERVAL_MS,
    expectedPid,
    isCancelled,
    sleepImpl = sleep,
  } = options
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (isCancelled?.() === true) {
      throw codedError('control-cancelled', '远程服务启动已取消')
    }
    const document = await readControlFile(stateDir)
    if (document !== undefined && (expectedPid === undefined || document.pid === expectedPid)) {
      return document
    }
    if (Date.now() >= deadline) {
      throw codedError(
        'control-timeout',
        `等待远程服务启动超时（${String(Math.round(timeoutMs / 1000))} 秒）：未找到可用的控制端口`,
      )
    }
    await sleepImpl(intervalMs)
  }
}

/**
 * Read a response body as text with a hard byte cap.
 * @param {Response} response fetch response.
 * @returns {Promise<string>} body text.
 * @throws {Error & { code: string }} when the body is not readable.
 */
async function readResponseText(response) {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    throw codedError('control-response-too-large', '控制服务响应过大')
  }
  return await response.text()
}

/**
 * Build the outgoing request body for one management method.
 * @param {string} method management method name.
 * @param {unknown} payload caller payload.
 * @returns {{ body?: unknown, error?: { ok: false, error: { code: string, message: string } } }} body or a validation failure.
 */
function bodyFor(method, payload) {
  const value = payload === undefined ? {} : payload
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: failure('invalid-payload', '请求参数必须是对象') }
  }
  const record = /** @type {Record<string, unknown>} */ (value)
  switch (method) {
    case 'start': {
      const transport = record.transport
      if (transport !== 'quick' && transport !== 'named') {
        return { error: failure('invalid-transport', '传输方式必须是 quick 或 named') }
      }
      /** @type {{ transport: string, namedToken?: string, publicUrl?: string }} */
      const body = { transport }
      if (typeof record.namedToken === 'string') body.namedToken = record.namedToken
      if (typeof record.publicUrl === 'string') body.publicUrl = record.publicUrl
      if (transport === 'named') {
        if (typeof body.namedToken !== 'string' || body.namedToken.trim() === '') {
          return { error: failure('named-token-required', 'Named 传输需要 Cloudflare Tunnel token') }
        }
        if (typeof body.publicUrl !== 'string' || !/^https:\/\//i.test(body.publicUrl.trim())) {
          return { error: failure('public-url-required', 'Named 传输需要 https 公网地址') }
        }
      }
      return { body }
    }
    case 'revoke': {
      if (typeof record.id !== 'string' || record.id === '') {
        return { error: failure('invalid-device-id', '缺少要撤销的设备 id') }
      }
      return { body: { id: record.id } }
    }
    case 'configSet': {
      const config = record.config
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        return { error: failure('invalid-config', '配置必须是对象') }
      }
      return { body: { config } }
    }
    case 'pairingRotate':
    case 'stop':
    case 'revokeAll':
      return { body: undefined }
    default:
      return { body: undefined }
  }
}

/**
 * Route table for management methods (docs/contracts.md §8).
 * `null` body means the method ignores its payload.
 * @type {Readonly<Record<string, { verb: 'GET' | 'POST', path: string }>>}
 */
const ROUTES = Object.freeze({
  status: { verb: 'GET', path: '/status' },
  start: { verb: 'POST', path: '/start' },
  stop: { verb: 'POST', path: '/stop' },
  pairingRotate: { verb: 'POST', path: '/pairing/rotate' },
  pairingStatus: { verb: 'GET', path: '/pairing' },
  devices: { verb: 'GET', path: '/devices' },
  revoke: { verb: 'POST', path: '/devices/revoke' },
  revokeAll: { verb: 'POST', path: '/devices/revokeAll' },
  configGet: { verb: 'GET', path: '/config' },
  configSet: { verb: 'POST', path: '/config' },
  diagnostics: { verb: 'GET', path: '/diagnostics' },
})

/** Management methods this client understands. */
export const CONTROL_METHODS = Object.freeze(Object.keys(ROUTES))

/**
 * Client for the sidecar control API.
 *
 * Every public call resolves to the control API envelope — it never rejects —
 * because the settings page renders failures inline and the host adapter must
 * return a stable JSON shape even when the sidecar died.
 */
export class ControlClient {
  /**
   * @param {object} options options.
   * @param {string} options.baseUrl loopback base URL, e.g. `http://127.0.0.1:1234`.
   * @param {string} options.token control API Bearer token.
   * @param {typeof fetch} [options.fetchImpl] fetch implementation (tests).
   * @param {number} [options.timeoutMs] per-request timeout.
   */
  constructor(options) {
    const { baseUrl, token, fetchImpl = fetch, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = options
    if (typeof baseUrl !== 'string' || baseUrl === '') {
      throw codedError('control-bad-base-url', '缺少控制服务地址')
    }
    if (typeof token !== 'string' || token === '') {
      throw codedError('control-bad-token', '缺少控制服务 token')
    }
    /** @private @type {string} */
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    /** @private @type {string} */
    this.token = token
    /** @private @type {typeof fetch} */
    this.fetchImpl = fetchImpl
    /** @private @type {number} */
    this.timeoutMs = timeoutMs
  }

  /**
   * One authenticated control request.
   * @param {'GET' | 'POST'} verb HTTP method.
   * @param {string} path absolute control path.
   * @param {unknown} [body] JSON body for POST.
   * @param {number} [timeoutMs] per-request timeout override (long-running start).
   * @returns {Promise<{ ok: true, value: unknown } | { ok: false, error: { code: string, message: string } }>} envelope.
   */
  async request(verb, path, body, timeoutMs = this.timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      /** @type {Record<string, string>} */
      const headers = {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
      }
      if (body !== undefined) headers['content-type'] = 'application/json'
      let response
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: verb,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) {
          return failure('control-timeout', '远程服务响应超时')
        }
        return failure(
          'control-unreachable',
          `无法连接远程服务：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      let text
      try {
        text = await readResponseText(response)
      } catch (error) {
        return failure(
          'control-unreadable',
          error instanceof Error ? error.message : '无法读取远程服务响应',
        )
      }
      let parsed
      if (text.trim() !== '') {
        try {
          parsed = JSON.parse(text)
        } catch {
          return failure('control-bad-response', `远程服务返回了无法解析的响应（HTTP ${String(response.status)}）`)
        }
      }
      if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
        const envelope = /** @type {{ ok?: unknown, value?: unknown, error?: unknown }} */ (parsed)
        if (envelope.ok === true) {
          return { ok: true, value: envelope.value }
        }
        if (envelope.ok === false) {
          const error = /** @type {{ code?: unknown, message?: unknown }} */ (envelope.error ?? {})
          return failure(
            typeof error.code === 'string' ? error.code : 'control-error',
            typeof error.message === 'string' ? error.message : '远程服务返回错误',
          )
        }
      }
      if (!response.ok) {
        return failure(`control-http-${String(response.status)}`, `远程服务返回 HTTP ${String(response.status)}`)
      }
      return failure('control-bad-response', '远程服务返回了意外的响应格式')
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Call one management method, mapping it onto its control route.
   * @param {string} method management method from docs/contracts.md §11.
   * @param {unknown} [payload] method payload.
   * @param {{ timeoutMs?: number }} [options] per-call options (`start` may need minutes for the cloudflared download).
   * @returns {Promise<{ ok: true, value: unknown } | { ok: false, error: { code: string, message: string } }>} envelope.
   */
  async call(method, payload, options) {
    const route = ROUTES[method]
    if (route === undefined) {
      return failure('unknown-method', `未知的管理方法：${String(method)}`)
    }
    const prepared = bodyFor(method, payload)
    if (prepared.error !== undefined) return prepared.error
    // POST control routes are JSON endpoints; send an empty object when the
    // method carries no payload so the sidecar's body parser sees JSON either
    // way (GET routes must not carry a body).
    const body = route.verb === 'POST' ? prepared.body ?? {} : undefined
    return await this.request(route.verb, route.path, body, options?.timeoutMs)
  }
}

/**
 * Create a control client for a published control document / explicit URL.
 * @param {object} options options.
 * @param {number} [options.port] control port from `control.json`.
 * @param {string} [options.controlUrl] explicit base URL (test/dev override).
 * @param {string} options.token control token.
 * @param {typeof fetch} [options.fetchImpl] fetch implementation.
 * @param {number} [options.timeoutMs] per-request timeout.
 * @returns {ControlClient} client instance.
 */
export function createControlClient(options) {
  const { port, controlUrl, token, fetchImpl, timeoutMs } = options
  const baseUrl = typeof controlUrl === 'string' && controlUrl !== '' ? controlUrl : controlBaseUrl(port)
  return new ControlClient({ baseUrl, token, fetchImpl, timeoutMs })
}
