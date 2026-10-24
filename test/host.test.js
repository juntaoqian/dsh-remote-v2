/**
 * dsh-remote-v2 — host adapter + browser bundle tests.
 *
 * Everything here is local: a fake control server (docs/contracts.md §13)
 * exercises the management dispatch path, and an in-process HTTP relay mounts
 * the exact route object `apply()` registered on a fake `ctx.webServer`. No
 * sidecar is spawned, no real DSH is installed, and no network is touched.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

import { apply, inject, name } from '../lib/index.js'
import { createLaunchBroker } from '../lib/launch-broker.js'

/** Project root, used to copy the host plugin into a fake package root. */
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Start a local HTTP server on an OS-assigned loopback port.
 * @param {http.RequestListener} handler request handler.
 * @returns {Promise<{ server: http.Server, origin: string }>} listener facts.
 */
function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('unexpected listen address'))
        return
      }
      resolve({ server, origin: `http://127.0.0.1:${String(address.port)}` })
    })
  })
}

/**
 * Close an HTTP server and every kept-alive connection.
 * @param {http.Server} server server to close.
 * @returns {Promise<void>} resolves once closed.
 */
function close(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => {
    server.close(() => { resolve() })
  })
}

/**
 * Read a request body as text.
 * @param {http.IncomingMessage} request request.
 * @returns {Promise<string>} body text.
 */
async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Write one JSON response.
 * @param {http.ServerResponse} response response.
 * @param {number} status HTTP status.
 * @param {unknown} body JSON body.
 * @returns {void}
 */
function reply(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(payload)
}

/**
 * Fake sidecar control API (docs/contracts.md §8).
 * @param {string} token expected Bearer token.
 * @returns {Promise<{ origin: string, server: http.Server, requests: Array<{ method: string, path: string, authorization?: string, body?: unknown }>, close: () => Promise<void> }>} fake control server.
 */
async function startFakeControlServer(token) {
  const requests = []
  const { server, origin } = await listen(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const raw = await readBody(request)
    let body
    if (raw !== '') {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    requests.push({ method: request.method ?? '', path, authorization: request.headers.authorization, body })
    if (path !== '/healthz' && request.headers.authorization !== `Bearer ${token}`) {
      reply(response, 401, { ok: false, error: { code: 'unauthorized', message: 'bad token' } })
      return
    }
    if (request.method === 'GET' && path === '/status') {
      reply(response, 200, {
        ok: true,
        value: {
          running: false,
          phase: 'idle',
          transport: 'quick',
          version: '0.1.0',
          devices: [],
          pairing: { state: 'none' },
          edge: { ready: false, reconnects: 0 },
        },
      })
      return
    }
    if (request.method === 'GET' && path === '/pairing') {
      reply(response, 200, { ok: true, value: { state: 'none' } })
      return
    }
    if (request.method === 'GET' && path === '/devices') {
      reply(response, 200, { ok: true, value: [] })
      return
    }
    if (request.method === 'GET' && path === '/config') {
      reply(response, 200, {
        ok: true,
        value: { transport: 'quick', namedToken: '', publicUrl: '', autoStart: false },
      })
      return
    }
    if (request.method === 'GET' && path === '/diagnostics') {
      reply(response, 200, { ok: true, value: { logs: [{ time: 1, level: 'info', message: 'ready' }] } })
      return
    }
    if (request.method === 'POST' && path === '/start') {
      reply(response, 200, { ok: true, value: { running: true, transport: 'quick' } })
      return
    }
    if (request.method === 'POST' && path === '/devices/revoke') {
      reply(response, 200, { ok: true, value: { revoked: true } })
      return
    }
    reply(response, 404, { ok: false, error: { code: 'not-found', message: 'no route' } })
  })
  return { origin, server, requests, close: () => close(server) }
}

/**
 * Fake DSH host context: captures the route and effects apply() registers.
 * @param {object} [options] overrides.
 * @param {(request: http.IncomingMessage) => number | undefined} [options.requestRejection] admission fence.
 * @param {(origin: string) => Promise<string> | string} [options.authenticatedUrl] DSH launch URL mint.
 * @returns {{ ctx: any, routes: Map<string, any>, effects: Array<{ label: string, disposer?: (() => any) }>, logs: string[], dispose: () => Promise<void> }} fake context bundle.
 */
function createFakeCtx(options = {}) {
  const routes = new Map()
  const effects = []
  const logs = []
  let disposed = false
  const ctx = {
    logger: {
      info: (...args) => { logs.push(`info ${args.map(String).join(' ')}`) },
      warn: (...args) => { logs.push(`warn ${args.map(String).join(' ')}`) },
      error: (...args) => { logs.push(`error ${args.map(String).join(' ')}`) },
    },
    webServer: {
      port: 59_999,
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    connection: {
      isLoopback: true,
      requestRejection: options.requestRejection ?? (() => undefined),
      authenticatedUrl: options.authenticatedUrl ?? ((origin) => `${origin}/?token=fake-launch-token`),
    },
    effect(callback, label) {
      const disposer = callback()
      effects.push({ label, disposer: typeof disposer === 'function' ? disposer : undefined })
      return disposer
    },
  }
  return {
    ctx,
    routes,
    effects,
    logs,
    async dispose() {
      if (disposed) return
      disposed = true
      for (const effect of effects) {
        if (typeof effect.disposer === 'function') await effect.disposer()
      }
    },
  }
}

/**
 * Create a temporary state directory.
 * @returns {Promise<{ dir: string, cleanup: () => Promise<void> }>} directory handle.
 */
async function stateDirFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-v2-host-'))
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Mount the route apply() registered behind a real HTTP relay, so the test
 * exercises the handler exactly as the DSH web server would.
 * @param {Map<string, any>} routes fake web server routes.
 * @returns {Promise<{ origin: string, server: http.Server }>} relay facts.
 */
async function startRouteRelay(routes) {
  return await listen((request, response) => {
    const route = routes.get('/dsh-remote-v2/api')
    if (route === undefined) {
      response.writeHead(503)
      response.end('management route is not mounted')
      return
    }
    route.handler(request, response)
  })
}

/**
 * POST one management request against the relay.
 * @param {string} origin relay origin.
 * @param {{ method?: string, payload?: unknown }} body request envelope.
 * @param {Record<string, string>} [headers] extra headers.
 * @returns {Promise<{ status: number, json: any, text: string }>} parsed response.
 */
async function postManagement(origin, body, headers = {}) {
  const response = await fetch(`${origin}/dsh-remote-v2/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text }
}

/** Milliseconds to let fire-and-forget cleanup settle. */
const SETTLE_MS = 150

test('apply() mounts the management route and dispatches status to the control server', async (t) => {
  const fixture = await stateDirFixture()
  const control = await startFakeControlServer('test-control-token')
  const fake = createFakeCtx()
  t.after(async () => {
    await fake.dispose()
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    await control.close()
    await fixture.cleanup()
  })

  assert.equal(name, 'dsh-remote-v2')
  assert.deepEqual(inject, ['connection', 'webServer'])

  assert.doesNotThrow(() => {
    apply(fake.ctx, {
      stateDir: fixture.dir,
      skipSidecar: true,
      controlUrl: control.origin,
      controlToken: 'test-control-token',
    })
  })
  assert.ok(fake.routes.has('/dsh-remote-v2/api'), 'management route must be mounted')

  const relay = await startRouteRelay(fake.routes)
  t.after(() => close(relay.server))

  const result = await postManagement(relay.origin, { method: 'status' })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.value.running, false)
  assert.equal(result.json.value.phase, 'idle')

  const statusRequest = control.requests.find((entry) => entry.path === '/status')
  assert.ok(statusRequest !== undefined, 'control server must receive GET /status')
  assert.equal(statusRequest.method, 'GET')
  assert.equal(statusRequest.authorization, 'Bearer test-control-token')

  // qrSvg is generated locally and must not touch the control server.
  const before = control.requests.length
  const qr = await postManagement(relay.origin, {
    method: 'qrSvg',
    payload: { text: 'https://example.trycloudflare.com/pair#s=secret' },
  })
  assert.equal(qr.status, 200)
  assert.equal(qr.json.ok, true)
  assert.equal(typeof qr.json.value, 'string')
  assert.match(qr.json.value, /^<svg /)
  assert.equal(control.requests.length, before, 'qrSvg must not call the control server')

  const badQr = await postManagement(relay.origin, { method: 'qrSvg', payload: {} })
  assert.equal(badQr.json.ok, false)
  assert.equal(badQr.json.error.code, 'qr-text-required')

  const unknown = await postManagement(relay.origin, { method: 'definitelyNotAMethod' })
  assert.equal(unknown.json.ok, false)
  assert.equal(unknown.json.error.code, 'unknown-method')

  // Dispose removes the route; the fake relay reports it is gone.
  await fake.dispose()
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  assert.equal(fake.routes.has('/dsh-remote-v2/api'), false, 'dispose must remove the route')
  const afterDispose = await fetch(`${relay.origin}/dsh-remote-v2/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'status' }),
  }).then((response) => response.status).catch(() => 0)
  assert.equal(afterDispose, 503)
})

test('management admission honours connection.requestRejection', async (t) => {
  const fixture = await stateDirFixture()
  const control = await startFakeControlServer('test-control-token')
  const fake = createFakeCtx({
    requestRejection: (request) => (request.headers['x-test-auth'] === 'allowed' ? undefined : 401),
  })
  t.after(async () => {
    await fake.dispose()
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    await control.close()
    await fixture.cleanup()
  })

  apply(fake.ctx, {
    stateDir: fixture.dir,
    skipSidecar: true,
    controlUrl: control.origin,
    controlToken: 'test-control-token',
  })
  const relay = await startRouteRelay(fake.routes)
  t.after(() => close(relay.server))

  const denied = await postManagement(relay.origin, { method: 'status' })
  assert.equal(denied.status, 401)
  assert.equal(denied.text, 'unauthorized')
  assert.equal(control.requests.length, 0, 'rejected requests must never reach the sidecar')

  const allowed = await postManagement(relay.origin, { method: 'status' }, { 'x-test-auth': 'allowed' })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.json.ok, true)
})

test('management rejects malformed requests with stable codes', async (t) => {
  const fixture = await stateDirFixture()
  const control = await startFakeControlServer('test-control-token')
  const fake = createFakeCtx()
  t.after(async () => {
    await fake.dispose()
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    await control.close()
    await fixture.cleanup()
  })
  apply(fake.ctx, {
    stateDir: fixture.dir,
    skipSidecar: true,
    controlUrl: control.origin,
    controlToken: 'test-control-token',
  })
  const relay = await startRouteRelay(fake.routes)
  t.after(() => close(relay.server))

  const getResponse = await fetch(`${relay.origin}/dsh-remote-v2/api`)
  assert.equal(getResponse.status, 405)

  const wrongType = await fetch(`${relay.origin}/dsh-remote-v2/api`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{"method":"status"}',
  })
  assert.equal(wrongType.status, 415)

  const badJson = await fetch(`${relay.origin}/dsh-remote-v2/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal(badJson.status, 400)
  assert.equal((await badJson.json()).error.code, 'invalid-json')

  const oversized = await fetch(`${relay.origin}/dsh-remote-v2/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'status', payload: { blob: 'x'.repeat(70 * 1024) } }),
  })
  assert.equal(oversized.status, 413)
  assert.equal((await oversized.json()).error.code, 'body-too-large')

  const missingMethod = await postManagement(relay.origin, { payload: {} })
  assert.equal(missingMethod.status, 400)
  assert.equal(missingMethod.json.error.code, 'missing-method')

  const invalidStart = await postManagement(relay.origin, { method: 'start', payload: { transport: 'bogus' } })
  assert.equal(invalidStart.json.ok, false)
  assert.equal(invalidStart.json.error.code, 'invalid-transport')

  const namedWithoutToken = await postManagement(relay.origin, { method: 'start', payload: { transport: 'named' } })
  assert.equal(namedWithoutToken.json.ok, false)
  assert.equal(namedWithoutToken.json.error.code, 'named-token-required')
})

test('launch broker mints launch URLs, enforces its Bearer token, and falls back', async (t) => {
  let mode = 'ok'
  const broker = createLaunchBroker({
    token: 'broker-token',
    getLaunchUrl: async (origin) => {
      if (mode === 'throw') throw new Error('authenticatedUrl unavailable')
      return `${origin}/?token=launch-token`
    },
  })
  t.after(() => broker.stop())
  const info = await broker.start()

  /**
   * POST one origin to the broker.
   * @param {unknown} origin claimed origin.
   * @param {string} token Bearer token.
   * @returns {Promise<{ status: number, json: any }>} response.
   */
  async function post(origin, token) {
    const response = await fetch(info.launchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ origin }),
    })
    return { status: response.status, json: await response.json() }
  }

  const ok = await post('https://abc.trycloudflare.com', 'broker-token')
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json, { ok: true, url: 'https://abc.trycloudflare.com/?token=launch-token' })

  const denied = await post('https://abc.trycloudflare.com', 'wrong-token')
  assert.equal(denied.status, 401)
  assert.equal(denied.json.error.code, 'unauthorized')

  const invalid = await post('file:///etc/passwd', 'broker-token')
  assert.equal(invalid.status, 400)
  assert.equal(invalid.json.error.code, 'invalid-origin')

  mode = 'throw'
  const fallback = await post('https://abc.trycloudflare.com', 'broker-token')
  assert.equal(fallback.status, 200)
  assert.equal(fallback.json.url, 'https://abc.trycloudflare.com/')

  const health = await fetch(`${info.origin}/healthz`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).ok, true)
})

/**
 * Minimal stand-in for `core/sidecar.js` used by the supervisor test. It
 * publishes `control.json` exactly as the real sidecar does, then serves the
 * control API with a marker so the test can tell it is talking to this process.
 */
const FAKE_SIDECAR_SOURCE = `import http from 'node:http'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const stateDir = process.env.DSH_REMOTE_V2_STATE_DIR
const token = process.env.DSH_REMOTE_V2_CONTROL_TOKEN
const server = http.createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (path === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
    return
  }
  if (request.headers.authorization !== 'Bearer ' + token) {
    response.writeHead(401)
    response.end('unauthorized')
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ ok: true, value: { running: true, phase: 'ready', transport: 'named', marker: 'fake-sidecar', pid: process.pid } }))
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const document = JSON.stringify({ port: address.port, pid: process.pid, startedAt: Date.now(), version: process.env.DSH_REMOTE_V2_VERSION })
  const temporary = join(stateDir, 'control.json.tmp')
  writeFileSync(temporary, document)
  renameSync(temporary, join(stateDir, 'control.json'))
})
setInterval(() => {}, 1000)
`

test('host supervisor spawns a sidecar, restarts it after a crash, and disposes cleanly', { timeout: 40_000 }, async (t) => {
  const fixture = await stateDirFixture()
  const fakeRoot = await mkdtemp(join(tmpdir(), 'dsh-remote-v2-pkg-'))
  const fake = createFakeCtx()
  let relay
  let lastPid
  t.after(async () => {
    await fake.dispose().catch(() => {})
    if (relay !== undefined) await close(relay.server).catch(() => {})
    // Safety net: never leak the fake sidecar process if an assertion failed.
    if (lastPid !== undefined) {
      try {
        process.kill(lastPid)
      } catch {
        // Already gone.
      }
    }
    await rm(fakeRoot, { recursive: true, force: true }).catch(() => {})
    await fixture.cleanup()
  })

  await cp(join(PROJECT_ROOT, 'lib'), join(fakeRoot, 'lib'), { recursive: true })
  await mkdir(join(fakeRoot, 'core'), { recursive: true })
  await writeFile(join(fakeRoot, 'core', 'sidecar.js'), FAKE_SIDECAR_SOURCE, 'utf8')
  const copied = await import(pathToFileURL(join(fakeRoot, 'lib', 'index.js')).href)

  copied.apply(fake.ctx, { stateDir: fixture.dir, controlTimeoutMs: 8_000 })
  relay = await startRouteRelay(fake.routes)

  const first = await postManagement(relay.origin, { method: 'status' })
  assert.equal(first.status, 200)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.value.marker, 'fake-sidecar')
  const firstDoc = JSON.parse(await readFile(join(fixture.dir, 'control.json'), 'utf8'))
  assert.equal(first.json.value.pid, firstDoc.pid)
  lastPid = firstDoc.pid

  // Crash the sidecar; the host must restart it and republish control.json.
  process.kill(firstDoc.pid)
  const deadline = Date.now() + 20_000
  let secondDoc
  while (Date.now() < deadline && secondDoc === undefined) {
    try {
      const document = JSON.parse(await readFile(join(fixture.dir, 'control.json'), 'utf8'))
      if (document.pid !== firstDoc.pid) secondDoc = document
    } catch {
      // The host may have removed the stale document before restarting.
    }
    if (secondDoc === undefined) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(secondDoc !== undefined, 'host must respawn the sidecar after a crash')
  lastPid = secondDoc.pid

  const second = await postManagement(relay.origin, { method: 'status' })
  assert.equal(second.status, 200)
  assert.equal(second.json.ok, true)
  assert.equal(second.json.value.marker, 'fake-sidecar')

  // Disposal must kill the sidecar tree and remove the management route.
  await fake.dispose()
  assert.equal(fake.routes.has('/dsh-remote-v2/api'), false)
  const goneDeadline = Date.now() + 8_000
  let gone = false
  while (Date.now() < goneDeadline && !gone) {
    try {
      process.kill(secondDoc.pid, 0)
      await new Promise((resolve) => setTimeout(resolve, 100))
    } catch {
      gone = true
    }
  }
  lastPid = undefined
  assert.equal(gone, true, 'dispose must terminate the sidecar process')
})

/**
 * Minimal React stand-in for the browser bundle smoke test: hooks return
 * their initial values and `createElement` produces a plain inspectable tree.
 * @returns {{ react: Record<string, any>, resetHooks: () => void }} fake React.
 */
function createFakeReact() {
  /** @type {any[]} */
  const slots = []
  let index = 0
  const react = {
    useState(initial) {
      const position = index
      index += 1
      if (!(position in slots)) slots[position] = typeof initial === 'function' ? initial() : initial
      const setter = (next) => {
        slots[position] = typeof next === 'function' ? next(slots[position]) : next
      }
      return [slots[position], setter]
    },
    useRef(initial) {
      const position = index
      index += 1
      if (!(position in slots)) slots[position] = { current: initial }
      return slots[position]
    },
    useEffect() {
      index += 1
    },
    useMemo(factory) {
      return factory()
    },
    useCallback(callback) {
      return callback
    },
    createElement(type, props, ...children_) {
      const merged = { ...(props ?? {}) }
      if (children_.length > 0) merged.children = children_.length === 1 ? children_[0] : children_
      return { type, props: merged }
    },
    Fragment: Symbol('Fragment'),
  }
  return {
    react,
    resetHooks() {
      index = 0
    },
  }
}

/**
 * Flatten a fake React element tree into text.
 * @param {any} node element, child, or text.
 * @returns {string} concatenated text.
 */
function elementText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(elementText).join(' ')
  if (typeof node === 'object' && node.props !== undefined) {
    return elementText(node.props.children)
  }
  return ''
}

/**
 * Load lib/client.js in a sandbox that mimics the DSH module loader.
 * @returns {Promise<{ plugin: any, registration: { options: any, component: Function }, locale: any }>} loaded plugin facts.
 */
async function loadClientBundle() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  /** @type {any} */
  let loaded
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          loaded = spec
        },
      },
      confirm: () => true,
    },
    navigator: {},
    document: {
      createElement: () => ({ style: {} }),
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => true,
    },
    fetch: async () => {
      throw new Error('the client bundle must not fetch during load/registration')
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  }
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  assert.ok(loaded !== undefined, 'client bundle must call __ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-remote-v2')
  assert.equal(typeof loaded.factory, 'function')

  const fake = createFakeReact()
  const plugin = loaded.factory((requested) => {
    if (requested === 'react') return fake.react
    throw new Error(`unexpected client module: ${requested}`)
  })

  assert.deepEqual([...plugin.inject], ['slots', 'locale', 'connection'])
  assert.equal(typeof plugin.apply, 'function')

  /** @type {{ locale: any, slotName: string | undefined, slotFactory: any }} */
  const captures = { locale: undefined, slotName: undefined, slotFactory: undefined }
  const registrations = []
  const ctx = {
    connection: { isLoopback: true },
    locale: {
      register(namespace, dictionaries) {
        captures.locale = { namespace, dictionaries }
        return () => {}
      },
    },
    slots: {
      inject(slotName, factory) {
        captures.slotName = slotName
        captures.slotFactory = factory
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect(callback) {
      return callback()
    },
  }

  plugin.apply(ctx)
  assert.equal(captures.locale.namespace, 'dsh-remote-v2')
  assert.equal(captures.locale.dictionaries.zh.nav, '远程访问')
  assert.equal(captures.locale.dictionaries.en.nav, 'Remote Access')
  assert.deepEqual(
    Object.keys(captures.locale.dictionaries.zh).sort(),
    Object.keys(captures.locale.dictionaries.en).sort(),
    'zh/en locale dictionaries must expose the same keys',
  )
  assert.equal(captures.slotName, 'settings.section')

  const slotDisposer = captures.slotFactory()
  assert.equal(typeof slotDisposer, 'function')
  assert.equal(registrations.length, 1)
  const registration = registrations[0]
  assert.equal(registration.options.name, 'settings.section')
  assert.equal(registration.options.id, 'remote-access-v2')
  assert.equal(registration.options.order, 2)
  assert.equal(registration.options.label(), '远程访问')
  assert.equal(registration.options.locale, 'dsh-remote-v2')
  assert.equal(typeof registration.options.inject, 'function')
  const injected = registration.options.inject()
  assert.equal(typeof injected.api, 'function')
  assert.equal(injected.isLoopback, true)

  // A host without the expected services must not crash apply().
  assert.doesNotThrow(() => plugin.apply({}))
  assert.doesNotThrow(() => plugin.apply(undefined))

  return { plugin, registration, injected, fake, captures }
}

test('browser bundle registers the settings section and renders both branches', async () => {
  const { registration, fake } = await loadClientBundle()

  // Remote page: only the "manage on the computer" explanation, no QR.
  const remoteTree = registration.component({ api: async () => undefined, isLoopback: false })
  const remoteText = elementText(remoteTree)
  assert.match(remoteText, /远程管理需在电脑端操作/)
  assert.doesNotMatch(remoteText, /配对码/)

  // Loopback page: full management UI on the first frame.
  fake.resetHooks()
  const localTree = registration.component({ api: async () => undefined, isLoopback: true })
  const localText = elementText(localTree)
  assert.match(localText, /远程访问/)
  assert.match(localText, /传输配置/)
  assert.match(localText, /设备配对/)
  assert.match(localText, /已授权设备/)
  assert.match(localText, /诊断/)
  assert.match(localText, /正在读取远程访问状态/)
})
