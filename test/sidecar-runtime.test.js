import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../core/config.js'
import { createSidecarRuntime } from '../core/sidecar.js'

function fakeTunnel(phase = 'idle') {
  return {
    async start() {
      return { publicUrl: 'https://remote.example.com' }
    },
    async stop() {},
    status() {
      return { phase, reconnects: 0 }
    },
  }
}

function createRuntime(overrides = {}) {
  let config = normalizeConfig({})
  let gatewayPort = 25916
  const calls = { rebound: [], persisted: [], ensureTunnelSettings: [] }
  const runtime = createSidecarRuntime({
    env: { version: '0.0.0-test', stateDir: 'C:/tmp/test' },
    initialConfig: config,
    configStore: {
      async get() {
        return config
      },
      async set(next) {
        config = normalizeConfig(next)
        calls.persisted.push(config)
        return config
      },
    },
    devices: { list: () => [] },
    pairing: { peek: () => ({ state: 'none' }), issue: () => ({ id: 'x', secret: 's', code: 'CODE', createdAt: 0, expiresAt: 1 }) },
    logger: { info() {}, warn() {}, error() {}, debug() {}, recent: () => [] },
    ensureTunnel: async (settings) => {
      calls.ensureTunnelSettings.push(settings)
      return fakeTunnel(overrides.tunnelPhase ?? 'idle')
    },
    getTunnel: () => (overrides.tunnelPhase && overrides.tunnelPhase !== 'idle' ? fakeTunnel(overrides.tunnelPhase) : null),
    getPublicOrigin: () => undefined,
    setPublicOrigin() {},
    getCloudflaredPath: () => undefined,
    getGatewayPort: () => gatewayPort,
    rebindGateway: async (port) => {
      gatewayPort = port
      calls.rebound.push(port)
      return port
    },
  })
  return { runtime, calls, getGatewayPort: () => gatewayPort }
}

test('named start rebinds the gateway to the fixed port first', async () => {
  const { runtime, calls } = createRuntime()
  await runtime.start({
    transport: 'named',
    namedToken: 'token',
    publicUrl: 'https://remote.example.com',
    gatewayPort: 26001,
  })
  assert.deepEqual(calls.rebound, [26001])
  assert.equal(calls.persisted.at(-1).gatewayPort, 26001)
  assert.equal(calls.persisted.at(-1).transport, 'named')
})

test('quick start keeps the existing random port', async () => {
  const { runtime, calls } = createRuntime()
  await runtime.start({ transport: 'quick', gatewayPort: 0 })
  assert.deepEqual(calls.rebound, [])
})

test('tailscale start rebinds once and forwards the static public URL', async () => {
  const { runtime, calls } = createRuntime()
  await runtime.start({
    transport: 'tailscale',
    publicUrl: 'https://cxqjt.tail7cbe8.ts.net',
    gatewayPort: 26001,
  })
  assert.deepEqual(calls.rebound, [26001])
  assert.deepEqual(calls.ensureTunnelSettings.at(-1), {
    transport: 'tailscale',
    publicUrl: 'https://cxqjt.tail7cbe8.ts.net',
  })
})

test('a running tunnel refuses configuration changes that need a rebind', async () => {
  const { runtime } = createRuntime({ tunnelPhase: 'ready' })
  await assert.rejects(
    () => runtime.configSet({ gatewayPort: 26001, transport: 'named', namedToken: 'token', publicUrl: 'https://remote.example.com' }),
    /先停止远程访问|stop/i,
  )
  await assert.rejects(() => runtime.start({ transport: 'named', namedToken: 'token', publicUrl: 'https://remote.example.com', gatewayPort: 26001 }), /停止/)
})

test('configuration can change while idle', async () => {
  const { runtime, calls } = createRuntime()
  const saved = await runtime.configSet({ gatewayPort: 26002 })
  assert.equal(saved.gatewayPort, 26002)
  assert.equal(calls.persisted.at(-1).gatewayPort, 26002)
})

test('status exposes the bound local gateway port', () => {
  const { runtime } = createRuntime()
  assert.equal(runtime.status().gatewayPort, 25916)
})
