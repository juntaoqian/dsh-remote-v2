import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../core/config.js'
import { createTunnelManager } from '../core/tunnel.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, recent: () => [] }

test('tailscale config requires an https public URL and a fixed port', () => {
  assert.throws(() => normalizeConfig({ transport: 'tailscale', gatewayPort: 26001 }), /publicUrl/)
  assert.throws(() => normalizeConfig({ transport: 'tailscale', publicUrl: 'https://cxqjt.tail7cbe8.ts.net' }), /gatewayPort/)
  const config = normalizeConfig({
    transport: 'tailscale',
    publicUrl: 'https://cxqjt.tail7cbe8.ts.net/',
    gatewayPort: 26001,
    namedToken: '',
  })
  assert.equal(config.transport, 'tailscale')
  assert.equal(config.publicUrl, 'https://cxqjt.tail7cbe8.ts.net')
  assert.equal(config.gatewayPort, 26001)
})

test('tailscale transport becomes ready without spawning cloudflared', async () => {
  let spawned = 0
  const manager = createTunnelManager({
    cloudflaredPath: undefined,
    gatewayPort: 26001,
    logger: silentLogger,
    spawnImpl: () => {
      spawned += 1
      throw new Error('must not spawn for tailscale')
    },
  })

  const started = await manager.start({ transport: 'tailscale', publicUrl: 'https://cxqjt.tail7cbe8.ts.net' })
  assert.equal(started.publicUrl, 'https://cxqjt.tail7cbe8.ts.net')
  assert.equal(spawned, 0)
  assert.equal(manager.status().phase, 'ready')
  assert.equal(manager.status().publicUrl, 'https://cxqjt.tail7cbe8.ts.net')

  await manager.stop()
  assert.equal(manager.status().phase, 'idle')
  assert.equal(manager.status().publicUrl, undefined)
})

test('tailscale start rejects a non-https public URL', async () => {
  const manager = createTunnelManager({
    cloudflaredPath: undefined,
    gatewayPort: 26001,
    logger: silentLogger,
  })
  await assert.rejects(
    () => manager.start({ transport: 'tailscale', publicUrl: 'http://cxqjt.tail7cbe8.ts.net' }),
    /https/i,
  )
})
