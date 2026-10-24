/**
 * dsh-remote-v2 — DSH host adapter.
 *
 * This plugin row owns the remote-access machinery *inside* DSH:
 *
 *   1. it spawns `core/sidecar.js` as a separate Node process (with
 *      `ELECTRON_RUN_AS_NODE=1` so it works under the Electron-based DSH host),
 *   2. it starts a loopback launch-URL broker that turns a public origin into a
 *      DSH token-authenticated URL via `ctx.connection.authenticatedUrl`,
 *   3. it mounts the loopback-only management API that the settings page calls:
 *      `POST /dsh-remote-v2/api` with `{ method, payload }`.
 *
 * Loading the plugin never opens the public network: the sidecar binds only
 * loopback ports and the Cloudflare tunnel starts solely on an explicit user
 * action (settings page → 启动). All resources are registered through
 * `ctx.effect(...)`, so a plugin reload or shutdown kills the sidecar tree,
 * closes the broker, and removes the HTTP route.
 *
 * @module lib/index
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_CONTROL_TIMEOUT_MS,
  codedError,
  createControlClient,
  failure,
  removeStaleControlFile,
  waitForControlFile,
} from './control-client.js'
import { createLaunchBroker, fallbackLaunchUrl } from './launch-broker.js'
import qrcode from './qrcode-generator.js'

/** Stable cordis plugin name (docs/contracts.md §10). */
export const name = 'dsh-remote-v2'

/** Host services required before this plugin mounts. */
export const inject = ['connection', 'webServer']

/** Management API prefix mounted on the DSH web server. */
export const API_PREFIX = '/dsh-remote-v2/api'

/** Maximum management request body; all methods carry tiny JSON payloads. */
const MAX_MANAGEMENT_BODY_BYTES = 64 * 1024

/** Maximum QR payload length accepted by `qrSvg`. */
const MAX_QR_TEXT_LENGTH = 2_048

/** Character cap for one forwarded sidecar log line. */
const MAX_FORWARDED_LOG_CHARS = 2_000

/** Upper bound for one sidecar log line buffer before it is trimmed. */
const MAX_LOG_BUFFER_CHARS = 64 * 1024

/** How long a management request waits for the first sidecar start. */
const CONTROL_READY_TIMEOUT_MS = 15_000

/** How long shutdown waits for the sidecar to exit before SIGKILL/taskkill. */
const TERMINATE_GRACE_MS = 3_000

/**
 * Best-effort logger over the host's `ctx.logger`.
 *
 * Missing/partial logger services must never break plugin startup; every call
 * is guarded and no failure detail is allowed to escape.
 * @param {any} ctx cordis host context.
 * @returns {{ info: (message: string) => void, warn: (message: string) => void, error: (message: string) => void }} logger facade.
 */
function createLogger(ctx) {
  const raw = ctx !== null && typeof ctx === 'object' ? ctx.logger : undefined
  /**
   * @param {'info' | 'warn' | 'error'} level log level.
   * @param {string} message message.
   */
  const emit = (level, message) => {
    try {
      const method = raw?.[level]
      if (typeof method === 'function' && raw !== undefined) {
        method.call(raw, '[dsh-remote-v2] %s', message)
      }
    } catch {
      // Logging must never affect plugin lifecycle.
    }
  }
  return {
    info: message => emit('info', message),
    warn: message => emit('warn', message),
    error: message => emit('error', message),
  }
}

/**
 * Register an effect with a graceful fallback for older DSH hosts that do not
 * expose `ctx.effect` yet: run the callback once and keep its disposer.
 * @param {any} ctx cordis host context.
 * @param {() => (() => void) | void} callback effect body.
 * @param {string} label effect label.
 * @param {{ warn: (message: string) => void }} logger logger facade.
 * @returns {() => void} disposer (a no-op on failure).
 */
function addEffect(ctx, callback, label, logger) {
  const noop = () => {}
  if (ctx !== null && typeof ctx === 'object' && typeof ctx.effect === 'function') {
    try {
      const disposer = ctx.effect(callback, label)
      return typeof disposer === 'function' ? disposer : noop
    } catch (error) {
      logger.warn(`ctx.effect(${label}) 注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : noop
  } catch (error) {
    logger.warn(`${label} 初始化失败：${error instanceof Error ? error.message : String(error)}`)
    return noop
  }
}

/**
 * Resolve the plugin package root (the parent of this `lib/` directory).
 * @returns {string} absolute package root.
 */
function resolvePluginRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Read the plugin version from its own `package.json`.
 * @param {string} pluginRoot absolute package root.
 * @returns {string} version string, or `0.1.0` when unreadable.
 */
function readPluginVersion(pluginRoot) {
  try {
    const parsed = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
    if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
  } catch {
    // Fall through to the default.
  }
  return '0.1.0'
}

/**
 * Resolve the persistent state directory.
 *
 * Precedence: `DSH_REMOTE_V2_STATE_DIR` (explicit deployment override) →
 * loader config `stateDir` → `$DSH_HOME/plugins/dsh-remote-v2` →
 * `~/.dsh/plugins/dsh-remote-v2` (docs/contracts.md §1, §10).
 * @param {{ stateDir?: unknown }} config normalised options.
 * @returns {string} absolute state directory.
 */
function resolveStateDir(config) {
  const fromEnv = process.env.DSH_REMOTE_V2_STATE_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  if (typeof config.stateDir === 'string' && config.stateDir.trim() !== '') return resolve(config.stateDir.trim())
  const dshHome = process.env.DSH_HOME
  const home = typeof dshHome === 'string' && dshHome.trim() !== '' ? resolve(dshHome.trim()) : join(homedir(), '.dsh')
  return join(home, 'plugins', 'dsh-remote-v2')
}

/**
 * Normalise the loader-supplied config plus documented test/dev overrides.
 *
 * `skipSidecar`, `controlUrl` and `controlToken` are test seams: they let the
 * host test suite drive the management API against a fake control server
 * without spawning a real sidecar (docs/contracts.md §13).
 * @param {unknown} config loader config.
 * @returns {{ stateDir?: string, controlTimeoutMs: number, skipSidecar: boolean, controlUrl?: string, controlToken?: string }} normalised options.
 */
function normalizeOptions(config) {
  const value = typeof config === 'object' && config !== null ? /** @type {Record<string, unknown>} */ (config) : {}
  const controlTimeout = value.controlTimeoutMs
  return {
    stateDir: typeof value.stateDir === 'string' ? value.stateDir : undefined,
    controlTimeoutMs:
      Number.isInteger(controlTimeout) && /** @type {number} */ (controlTimeout) > 0
        ? /** @type {number} */ (controlTimeout)
        : DEFAULT_CONTROL_TIMEOUT_MS,
    skipSidecar: value.skipSidecar === true,
    controlUrl: typeof value.controlUrl === 'string' && value.controlUrl !== '' ? value.controlUrl : undefined,
    controlToken: typeof value.controlToken === 'string' && value.controlToken !== '' ? value.controlToken : undefined,
  }
}

/**
 * Render one pairing URL as an inline SVG QR code.
 *
 * The vendor library is local (no network, no external service) and the
 * returned SVG is inlined by the settings page as a data URL; it is never
 * injected into the DOM as raw HTML.
 * @param {string} text QR payload (the `/pair#s=<secret>` URL).
 * @param {string} [caption] accessible label.
 * @returns {string} SVG markup.
 */
function renderQrSvg(text, caption) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({
    cellSize: 4,
    margin: 8,
    scalable: true,
    alt: typeof caption === 'string' && caption !== '' ? caption : '配对二维码',
    title: '配对二维码',
  })
}

/**
 * Sleep for a bounded duration without keeping the process alive.
 * @param {number} milliseconds delay.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(milliseconds) {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, milliseconds)
    timer.unref?.()
  })
}

/**
 * Read a JSON request body with a hard byte cap.
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @param {number} limit byte cap.
 * @returns {Promise<unknown>} parsed JSON value.
 * @throws {Error & { code: string }} `body-too-large` or `invalid-json`.
 */
async function readLimitedJsonBody(request, limit) {
  const declared = request.headers['content-length']
  if (declared !== undefined && Number(declared) > limit) {
    throw codedError('body-too-large', '请求体过大')
  }
  /** @type {Buffer[]} */
  const chunks = []
  let received = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buffer.byteLength
    if (received > limit) throw codedError('body-too-large', '请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw codedError('invalid-json', '请求体必须是合法 JSON')
  }
}

/**
 * Write a JSON response once, tolerating an already-finished exchange.
 * @param {import('node:http').ServerResponse} response response to own.
 * @param {number} status HTTP status.
 * @param {unknown} body JSON body.
 * @returns {void}
 */
function sendJson(response, status, body) {
  if (response.writableEnded) return
  let payload
  try {
    payload = JSON.stringify(body)
  } catch {
    payload = JSON.stringify(failure('internal-error', '响应序列化失败'))
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

/**
 * Write a short plain-text response once.
 * @param {import('node:http').ServerResponse} response response to own.
 * @param {number} status HTTP status.
 * @param {string} text body text.
 * @returns {void}
 */
function sendText(response, status, text) {
  if (response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(text)
}

/**
 * Wait for a child process to exit, bounded.
 * @param {import('node:child_process').ChildProcess} child process.
 * @param {number} timeoutMs wait budget.
 * @returns {Promise<void>} resolves on exit or timeout.
 */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolveExit()
    }, timeoutMs)
    timer.unref?.()
    const onExit = () => {
      clearTimeout(timer)
      resolveExit()
    }
    child.once('exit', onExit)
  })
}

/**
 * Terminate a sidecar process tree.
 *
 * On Windows `ChildProcess.kill()` terminates only the Node entry process, so
 * `taskkill /T` is used to take down the sidecar's own cloudflared child as
 * well. On other platforms SIGTERM gives the sidecar a chance to run its
 * graceful shutdown.
 * @param {import('node:child_process').ChildProcess | undefined} child sidecar process.
 * @returns {Promise<void>} resolves once terminated (or the wait budget expired).
 */
async function terminateChild(child) {
  if (child === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    await new Promise((resolveKill) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolveKill()
      }
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.once('error', () => {
          try {
            child.kill()
          } catch {
            // Already gone.
          }
          finish()
        })
        killer.once('exit', finish)
        setTimeout(finish, TERMINATE_GRACE_MS).unref?.()
      } catch {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
        finish()
      }
    })
    await waitForExit(child, TERMINATE_GRACE_MS)
    return
  }
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  await waitForExit(child, TERMINATE_GRACE_MS)
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
    await waitForExit(child, 1_000)
  }
}

/**
 * Mount the dsh-remote-v2 host plugin.
 * @param {any} ctx cordis host context (injects `connection` and `webServer`).
 * @param {unknown} [config] loader config (state dir, timeouts, test seams).
 * @returns {void}
 */
export function apply(ctx, config) {
  const logger = createLogger(ctx)
  const pluginRoot = resolvePluginRoot()
  const options = normalizeOptions(config)
  const stateDir = resolveStateDir(options)
  const version = readPluginVersion(pluginRoot)

  /** Random per-host-generation secrets. They never leave this process except
   * through the sidecar's inherited environment. */
  const controlToken = options.controlToken ?? randomBytes(32).toString('base64url')
  const brokerToken = randomBytes(32).toString('base64url')

  /** @type {import('./control-client.js').ControlClient | undefined} */
  let controlClient
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let sidecar
  /** @type {ReturnType<typeof createLaunchBroker> | undefined} */
  let broker
  /** @type {{ port: number, origin: string, launchUrl: string } | undefined} */
  let brokerInfo
  let disposed = false
  let lastStartError
  let restartTimer
  let restartAttempt = 0
  let rejectRejectionWarned = false

  /**
   * Publish the control client; waiting management calls pick it up on their
   * next poll.
   * @param {import('./control-client.js').ControlClient} client control client.
   * @returns {void}
   */
  function setControlClient(client) {
    controlClient = client
  }

  /**
   * Drop the control client (the sidecar exited or is restarting).
   * @returns {void}
   */
  function clearControlClient() {
    controlClient = undefined
  }

  /**
   * Upstream URL for the DSH web server this plugin is mounted on.
   * @returns {string | undefined} `http://127.0.0.1:<port>`, or undefined when no port is known.
   */
  function upstreamOrigin() {
    const webServer = ctx !== null && typeof ctx === 'object' ? ctx.webServer : undefined
    const port = Number(webServer?.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined
    return `http://127.0.0.1:${String(port)}`
  }

  /**
   * Turn a public origin into a DSH launch URL, falling back to the origin
   * root when `authenticatedUrl` is unavailable (docs/contracts.md §10).
   * @param {string} origin validated public origin.
   * @returns {Promise<string | undefined>} launch URL.
   */
  async function getLaunchUrl(origin) {
    try {
      const connection = ctx !== null && typeof ctx === 'object' ? ctx.connection : undefined
      if (connection !== undefined && typeof connection.authenticatedUrl === 'function') {
        const url = await connection.authenticatedUrl(origin)
        if (typeof url === 'string' && url !== '') return url
      }
    } catch (error) {
      logger.warn(`authenticatedUrl 调用失败，降级为 origin 根路径：${error instanceof Error ? error.message : String(error)}`)
    }
    return fallbackLaunchUrl(origin)
  }

  /**
   * Forward one sidecar output stream line by line, with truncation.
   * @param {import('node:stream').Readable | null} stream child stream.
   * @param {'info' | 'warn'} level destination log level.
   * @returns {void}
   */
  function attachStream(stream, level) {
    if (stream === null) return
    let buffer = ''
    stream.setEncoding?.('utf8')
    stream.on('data', (chunk) => {
      buffer += String(chunk)
      if (buffer.length > MAX_LOG_BUFFER_CHARS) buffer = buffer.slice(-MAX_LOG_BUFFER_CHARS / 2)
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        const trimmed = line.trim()
        if (trimmed !== '') {
          // Defence in depth: never forward a host/sidecar secret if a future
          // sidecar log line happens to include one.
          const sanitized = trimmed.split(controlToken).join('[redacted]').split(brokerToken).join('[redacted]')
          const text = sanitized.length > MAX_FORWARDED_LOG_CHARS
            ? `${sanitized.slice(0, MAX_FORWARDED_LOG_CHARS)}…（已截断）`
            : sanitized
          logger[level](`sidecar: ${text}`)
        }
        newline = buffer.indexOf('\n')
      }
    })
    stream.on('error', () => {
      // The sidecar is gone; exit handling owns the restart decision.
    })
  }

  /**
   * Environment inherited by the sidecar (docs/contracts.md §1).
   * @param {string} upstream DSH web origin.
   * @returns {NodeJS.ProcessEnv} child environment.
   */
  function buildSidecarEnv(upstream) {
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_REMOTE_V2_STATE_DIR: stateDir,
      DSH_REMOTE_V2_UPSTREAM: upstream,
      DSH_REMOTE_V2_CONTROL_TOKEN: controlToken,
      DSH_REMOTE_V2_BROKER_URL: brokerInfo?.launchUrl ?? '',
      DSH_REMOTE_V2_BROKER_TOKEN: brokerToken,
      DSH_REMOTE_V2_PLUGIN_ROOT: pluginRoot,
      DSH_REMOTE_V2_VERSION: version,
      DSH_REMOTE_V2_HOST_PID: String(process.pid),
    }
  }

  /**
   * Schedule a sidecar restart with capped exponential backoff.
   * @returns {void}
   */
  function scheduleRestart() {
    if (disposed || restartTimer !== undefined) return
    restartAttempt += 1
    const delay = Math.min(1_000 * 2 ** (restartAttempt - 1), 30_000)
    logger.warn(`远程服务进程已退出，${String(delay)}ms 后重启（第 ${String(restartAttempt)} 次）`)
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      if (disposed) return
      void startSidecar()
    }, delay)
    restartTimer.unref?.()
  }

  /**
   * Spawn the sidecar and wait for its control document.
   * @returns {Promise<void>} resolves when the attempt finished (successfully or not).
   */
  async function startSidecar() {
    if (disposed) return
    const upstream = upstreamOrigin()
    if (upstream === undefined) {
      lastStartError = '缺少 DSH web 服务端口'
      logger.warn('无法启动远程服务：ctx.webServer.port 不可用')
      return
    }
    try {
      await removeStaleControlFile(stateDir)
    } catch {
      // A missing/removed stale file is the normal path.
    }
    let spawned
    try {
      spawned = spawn(process.execPath, [join(pluginRoot, 'core', 'sidecar.js')], {
        env: buildSidecarEnv(upstream),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
      })
    } catch (error) {
      lastStartError = `无法启动远程服务：${error instanceof Error ? error.message : String(error)}`
      logger.warn(lastStartError)
      scheduleRestart()
      return
    }
    sidecar = spawned
    attachStream(spawned.stdout, 'info')
    attachStream(spawned.stderr, 'warn')
    spawned.once('error', (error) => {
      lastStartError = `远程服务进程错误：${error.message}`
      logger.warn(lastStartError)
      if (sidecar === spawned) sidecar = undefined
      clearControlClient()
      scheduleRestart()
    })
    spawned.once('exit', (code, signal) => {
      if (sidecar === spawned) sidecar = undefined
      clearControlClient()
      if (disposed) return
      lastStartError = `远程服务已退出（code=${String(code)}, signal=${String(signal)}）`
      logger.warn(lastStartError)
      scheduleRestart()
    })
    try {
      const document = await waitForControlFile({
        stateDir,
        timeoutMs: options.controlTimeoutMs,
        expectedPid: spawned.pid,
        isCancelled: () => disposed || sidecar !== spawned,
      })
      setControlClient(createControlClient({ port: document.port, token: controlToken }))
      restartAttempt = 0
      logger.info(`远程服务已就绪（控制端口 ${String(document.port)}）`)
    } catch (error) {
      if (disposed) return
      lastStartError = error instanceof Error ? error.message : String(error)
      logger.warn(lastStartError)
      await terminateChild(spawned).catch(() => {})
      if (sidecar === spawned) sidecar = undefined
      scheduleRestart()
    }
  }

  /**
   * Boot the broker and sidecar (or the injected test control target).
   * @returns {Promise<void>} resolves once the first boot attempt settles.
   */
  async function boot() {
    try {
      await mkdir(stateDir, { recursive: true })
    } catch (error) {
      logger.warn(`无法创建状态目录 ${stateDir}：${error instanceof Error ? error.message : String(error)}`)
    }
    // The broker is started before the sidecar: the sidecar's gateway needs the
    // launch-URL endpoint during pairing.
    try {
      broker = createLaunchBroker({ token: brokerToken, getLaunchUrl, logger })
      brokerInfo = await broker.start()
      logger.info(`启动 URL 代理已就绪（端口 ${String(brokerInfo.port)}）`)
    } catch (error) {
      broker = undefined
      brokerInfo = undefined
      logger.warn(`启动 URL 代理启动失败（配对跳转将不可用）：${error instanceof Error ? error.message : String(error)}`)
    }
    if (options.skipSidecar) {
      if (options.controlUrl !== undefined) {
        setControlClient(createControlClient({ controlUrl: options.controlUrl, token: controlToken }))
      }
      return
    }
    await startSidecar()
  }

  /**
   * Resolve the control client, waiting out the first start or a restart.
   * @returns {Promise<import('./control-client.js').ControlClient | undefined>} control client, or undefined when unavailable.
   */
  async function getControlClient() {
    if (controlClient !== undefined) return controlClient
    if (disposed) return undefined
    // The sidecar may still be booting its first generation, or restarting
    // after a crash; both publish a control client. Wait up to the same budget
    // the host allows the control file, then report unavailability.
    const deadline = Date.now() + CONTROL_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (controlClient !== undefined || disposed) break
      await sleep(50)
    }
    return controlClient
  }

  /**
   * Answer one management method.
   * @param {string} method management method.
   * @param {unknown} payload method payload.
   * @returns {Promise<{ ok: true, value: unknown } | { ok: false, error: { code: string, message: string } }>} result envelope.
   */
  async function dispatch(method, payload) {
    if (method === 'qrSvg') {
      const record = typeof payload === 'object' && payload !== null ? /** @type {Record<string, unknown>} */ (payload) : undefined
      const text = typeof payload === 'string' ? payload : record?.text
      if (typeof text !== 'string' || text === '') {
        return failure('qr-text-required', '缺少二维码内容')
      }
      if (text.length > MAX_QR_TEXT_LENGTH) {
        return failure('qr-text-too-long', '二维码内容过长')
      }
      try {
        const caption = typeof record?.label === 'string' ? record.label : undefined
        return { ok: true, value: renderQrSvg(text, caption) }
      } catch (error) {
        logger.warn(`二维码生成失败：${error instanceof Error ? error.message : String(error)}`)
        return failure('qr-generation-failed', '二维码生成失败，请刷新配对码后重试')
      }
    }
    const client = await getControlClient()
    if (client === undefined) {
      return failure(
        'sidecar-unavailable',
        lastStartError === undefined ? '远程服务尚未就绪，请稍后重试' : `远程服务不可用：${lastStartError}`,
      )
    }
    if (disposed) return failure('host-disposed', '远程访问插件已关闭')
    // First `start` may download cloudflared (~55 MB) and wait for the tunnel
    // edge; give it minutes instead of the control API's default 15 s. The
    // settings page keeps polling status while this request is in flight.
    const timeoutMs = method === 'start' ? 300_000 : undefined
    return await client.call(method, payload, timeoutMs === undefined ? undefined : { timeoutMs })
  }

  /**
   * Serve one `POST /dsh-remote-v2/api` request.
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @param {import('node:http').ServerResponse} response response to own.
   * @returns {Promise<void>} resolves once the exchange finished.
   */
  async function serveManagement(request, response) {
    try {
      if (disposed) {
        sendJson(response, 503, failure('host-disposed', '远程访问插件已关闭'))
        return
      }
      const connection = ctx !== null && typeof ctx === 'object' ? ctx.connection : undefined
      if (connection !== undefined && typeof connection.requestRejection === 'function') {
        let rejection
        try {
          rejection = connection.requestRejection(request)
        } catch (error) {
          logger.warn(`requestRejection 调用失败：${error instanceof Error ? error.message : String(error)}`)
          rejection = 403
        }
        if (rejection !== undefined) {
          sendText(response, Number(rejection) === 401 ? 401 : 403, Number(rejection) === 401 ? 'unauthorized' : 'forbidden')
          return
        }
      } else if (!rejectRejectionWarned) {
        rejectRejectionWarned = true
        logger.warn('ctx.connection.requestRejection 不可用，管理接口跳过准入校验（请升级 DSH）')
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, failure('method-not-allowed', '管理接口只支持 POST'))
        return
      }
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        sendJson(response, 415, failure('content-type-required', '请求必须是 application/json'))
        return
      }
      let parsed
      try {
        parsed = await readLimitedJsonBody(request, MAX_MANAGEMENT_BODY_BYTES)
      } catch (error) {
        const code = error instanceof Error ? /** @type {Error & { code?: string }} */ (error).code : undefined
        if (code === 'body-too-large') {
          sendJson(response, 413, failure('body-too-large', '请求体过大'))
          return
        }
        sendJson(response, 400, failure('invalid-json', '请求体必须是合法 JSON'))
        return
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        sendJson(response, 400, failure('invalid-body', '请求体必须是 JSON 对象'))
        return
      }
      const envelope = /** @type {{ method?: unknown, payload?: unknown }} */ (parsed)
      if (typeof envelope.method !== 'string' || envelope.method === '') {
        sendJson(response, 400, failure('missing-method', '缺少 method 字段'))
        return
      }
      const result = await dispatch(envelope.method, envelope.payload)
      sendJson(response, 200, result)
    } catch (error) {
      logger.error(`管理接口内部错误：${error instanceof Error ? error.message : String(error)}`)
      if (!response.writableEnded) {
        sendJson(response, 500, failure('internal-error', '管理接口内部错误'))
      }
    }
  }

  // 1. The loopback-only management API route (removed by the disposer).
  addEffect(ctx, () => {
    const webServer = ctx !== null && typeof ctx === 'object' ? ctx.webServer : undefined
    if (webServer === undefined || typeof webServer.register !== 'function') {
      logger.warn('ctx.webServer.register 不可用，跳过管理接口挂载（请升级 DSH）')
      return () => {}
    }
    try {
      const remove = webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (request, response) => {
          void serveManagement(request, response)
        },
      })
      logger.info(`管理接口已挂载：${API_PREFIX}（仅本机可用）`)
      return typeof remove === 'function' ? remove : () => {}
    } catch (error) {
      logger.warn(`管理接口挂载失败：${error instanceof Error ? error.message : String(error)}`)
      return () => {}
    }
  }, 'dsh-remote-v2: management api', logger)

  // 2. Sidecar + broker lifecycle. A DSH reload/shutdown disposes this effect.
  addEffect(ctx, () => {
    void boot().catch((error) => {
      lastStartError = error instanceof Error ? error.message : String(error)
      logger.error(`远程服务启动失败：${lastStartError}`)
    })
    return async () => {
      disposed = true
      if (restartTimer !== undefined) {
        clearTimeout(restartTimer)
        restartTimer = undefined
      }
      const currentSidecar = sidecar
      sidecar = undefined
      clearControlClient()
      await terminateChild(currentSidecar).catch(() => {})
      const currentBroker = broker
      broker = undefined
      brokerInfo = undefined
      if (currentBroker !== undefined) await currentBroker.stop().catch(() => {})
      logger.info('远程访问插件已关闭')
    }
  }, 'dsh-remote-v2: sidecar lifecycle', logger)
}
