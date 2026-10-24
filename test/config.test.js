import assert from 'node:assert/strict'
import test from 'node:test'

import { CONFIG_DEFAULTS, normalizeConfig } from '../core/config.js'

test('configuration defaults use a random gateway port', () => {
  assert.equal(CONFIG_DEFAULTS.gatewayPort, 0)
  const config = normalizeConfig({})
  assert.equal(config.transport, 'quick')
  assert.equal(config.gatewayPort, 0)
})

test('named transport requires a fixed gateway port', () => {
  assert.throws(
    () => normalizeConfig({ transport: 'named', namedToken: 'token', publicUrl: 'https://remote.example.com' }),
    /gatewayPort/,
  )
})

test('named transport accepts a fixed port and keeps the token', () => {
  const config = normalizeConfig({
    transport: 'named',
    namedToken: '  eyJhIjoi...  ',
    publicUrl: 'https://remote.example.com/',
    gatewayPort: 26001,
  })
  assert.equal(config.transport, 'named')
  assert.equal(config.namedToken, 'eyJhIjoi...')
  assert.equal(config.publicUrl, 'https://remote.example.com')
  assert.equal(config.gatewayPort, 26001)
})

test('gateway port must be 0 or an unprivileged port', () => {
  for (const gatewayPort of [-1, 1, 1023, 65536, 1.5, '26001']) {
    assert.throws(() => normalizeConfig({ gatewayPort }), /gatewayPort/)
  }
  assert.equal(normalizeConfig({ gatewayPort: 1024 }).gatewayPort, 1024)
  assert.equal(normalizeConfig({ gatewayPort: 65535 }).gatewayPort, 65535)
})
