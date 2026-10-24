import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDeviceStore } from '../core/devices.js'
import { createGateway } from '../core/gateway.js'
import { createPairingService } from '../core/pairing.js'

function listen(server) {
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise(server.address().port))
  })
}

function close(server) {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()))
}

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { host: 'public.test', ...headers },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.end(body)
    else req.end()
  })
}

async function createHarness({ ready = true, launchUrl } = {}) {
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
  })
  const upstreamPort = await listen(upstream)

  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-v2-gateway-'))
  const devices = await createDeviceStore({ file: join(dir, 'devices.json'), ttlMs: 3600_000 })
  const pairing = createPairingService()

  const origin = { value: ready ? new URL('http://public.test') : undefined }
  const gateway = createGateway({
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
    devices,
    pairing,
    getPublicOrigin: () => origin.value,
    getLaunchUrl:
      launchUrl ??
      (async (publicOrigin) => `${publicOrigin}/?token=test-launch-token`),
    cookieSecure: false,
  })
  const { port } = await gateway.start()

  return {
    upstream,
    upstreamPort,
    dir,
    devices,
    pairing,
    origin,
    gateway,
    port,
    async dispose() {
      await gateway.stop()
      await close(upstream)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('public entry is CLOSED (503) before the tunnel reports an origin', async () => {
  const harness = await createHarness({ ready: false })
  try {
    const response = await request(harness.port, { path: '/api/status' })
    assert.equal(response.status, 503)
  } finally {
    await harness.dispose()
  }
})

test('loopback /healthz answers 200', async () => {
  const harness = await createHarness()
  try {
    const response = await request(harness.port, {
      path: '/healthz',
      headers: { host: `127.0.0.1:${harness.port}` },
    })
    assert.equal(response.status, 200)
    assert.match(response.text, /"status":"ok"/)
  } finally {
    await harness.dispose()
  }
})

test('wrong Host is rejected with 403', async () => {
  const harness = await createHarness()
  try {
    const response = await request(harness.port, {
      path: '/api/status',
      headers: { host: 'evil.test' },
    })
    assert.equal(response.status, 403)
  } finally {
    await harness.dispose()
  }
})

test('unauthenticated requests get 401', async () => {
  const harness = await createHarness()
  try {
    const response = await request(harness.port, { path: '/api/status' })
    assert.equal(response.status, 401)
  } finally {
    await harness.dispose()
  }
})

test('authenticated requests are proxied with rewritten Host/Origin and stripped credentials', async () => {
  const harness = await createHarness()
  try {
    const device = await harness.devices.create('phone', 'test-agent')
    const response = await request(harness.port, {
      path: '/api/echo?x=1',
      headers: {
        cookie: `dsh_remote_v2=${device.token}; other=keep`,
        origin: 'http://public.test',
        'x-forwarded-for': '1.2.3.4',
        'cf-connecting-ip': '1.2.3.4',
        authorization: 'Bearer upstream-secret',
      },
    })
    assert.equal(response.status, 200)
    const seen = JSON.parse(response.text)
    assert.equal(seen.headers.host, `127.0.0.1:${harness.upstreamPort}`)
    assert.equal(seen.headers.origin, `http://127.0.0.1:${harness.upstreamPort}`)
    assert.equal(seen.headers['x-forwarded-for'], undefined)
    assert.equal(seen.headers['cf-connecting-ip'], undefined)
    assert.equal(seen.headers.authorization, undefined)
    assert.match(seen.headers.cookie, /other=keep/)
    assert.doesNotMatch(seen.headers.cookie, /dsh_remote_v2/)
  } finally {
    await harness.dispose()
  }
})

test('management prefix is denied, including percent-encoded forms', async () => {
  const harness = await createHarness()
  try {
    const device = await harness.devices.create()
    const cookie = `dsh_remote_v2=${device.token}`
    for (const path of ['/dsh-remote-v2/api', '/%64sh-remote-v2/api', '/dsh-remote-v2%2fapi']) {
      const response = await request(harness.port, { path, headers: { cookie } })
      assert.equal(response.status, 404, path)
    }
  } finally {
    await harness.dispose()
  }
})

test('state-changing requests require an exact Origin', async () => {
  const harness = await createHarness()
  try {
    const device = await harness.devices.create()
    const cookie = `dsh_remote_v2=${device.token}`
    const missing = await request(harness.port, {
      method: 'POST',
      path: '/api/echo',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(missing.status, 403)

    const wrong = await request(harness.port, {
      method: 'POST',
      path: '/api/echo',
      headers: { cookie, origin: 'https://evil.test', 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(wrong.status, 403)

    const good = await request(harness.port, {
      method: 'POST',
      path: '/api/echo',
      headers: { cookie, origin: 'http://public.test', 'content-type': 'application/json' },
      body: '{"hello":1}',
    })
    assert.equal(good.status, 200)
    assert.equal(JSON.parse(good.text).body, '{"hello":1}')
  } finally {
    await harness.dispose()
  }
})

test('pairing page and claim issue a device cookie; the ticket is single-use', async () => {
  const harness = await createHarness()
  try {
    const ticket = harness.pairing.issue()
    const page = await request(harness.port, { path: '/pair' })
    assert.equal(page.status, 200)
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'/)
    assert.match(page.text, /\/pair\/claim/)

    const claim = await request(harness.port, {
      method: 'POST',
      path: '/pair/claim',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: ticket.secret, name: '我的手机' }),
    })
    assert.equal(claim.status, 200)
    const body = JSON.parse(claim.text)
    assert.equal(body.ok, true)
    assert.match(body.redirect, /token=test-launch-token/)

    const setCookie = String(claim.headers['set-cookie']?.[0] ?? '')
    assert.match(setCookie, /dsh_remote_v2=[A-Za-z0-9_-]{43}/)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Lax/)
    const token = setCookie.match(/dsh_remote_v2=([A-Za-z0-9_-]{43})/)[1]

    const proxied = await request(harness.port, {
      path: '/api/after-pair',
      headers: { cookie: `dsh_remote_v2=${token}` },
    })
    assert.equal(proxied.status, 200)
    assert.equal(harness.devices.list().length, 1)

    const reused = await request(harness.port, {
      method: 'POST',
      path: '/pair/claim',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: ticket.secret }),
    })
    assert.equal(reused.status, 401)
  } finally {
    await harness.dispose()
  }
})
