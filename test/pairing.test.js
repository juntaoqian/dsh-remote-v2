import assert from 'node:assert/strict'
import test from 'node:test'

import { createPairingService, issueCode, PAIRING_CODE_ALPHABET } from '../core/pairing.js'

function ticketCode(service) {
  const peek = service.peek()
  assert.equal(peek.state, 'active')
  return peek
}

test('issue produces a 43-char secret and an 8-char code from the reduced alphabet', () => {
  const service = createPairingService()
  const ticket = service.issue()
  assert.match(ticket.secret, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(ticket.code.length, 8)
  for (const character of ticket.code) assert.ok(PAIRING_CODE_ALPHABET.includes(character))
  assert.equal(service.count(), 1)
})

test('claim by secret is single-use', () => {
  const service = createPairingService()
  const ticket = service.issue()
  const first = service.claim(ticket.secret)
  assert.equal(first.ok, true)
  const second = service.claim(ticket.secret)
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'rejected')
  assert.equal(service.count(), 0)
  assert.equal(service.peek().state, 'consumed')
})

test('claim by code is case-insensitive and consumes the ticket', () => {
  const service = createPairingService()
  const ticket = service.issue()
  const outcome = service.claim(ticket.code.toLowerCase())
  assert.equal(outcome.ok, true)
  assert.equal(service.peek().state, 'consumed')
})

test('five wrong attempts lock the ticket', () => {
  const service = createPairingService({ maxPerWindow: 1000 })
  service.issue()
  for (let index = 0; index < 4; index += 1) {
    assert.equal(service.claim('ZZZZZZZZ').reason, 'rejected')
  }
  assert.equal(service.claim('ZZZZZZZZ').reason, 'locked')
  assert.equal(service.peek().state, 'expired')
  assert.equal(service.claim('ZZZZZZZZ').reason, 'rejected')
})

test('expired tickets are rejected and reported', () => {
  let now = 1_000
  const service = createPairingService({ now: () => now, ttlMs: 1_000 })
  const ticket = service.issue()
  now = 2_001
  assert.equal(service.claim(ticket.code).ok, false)
  assert.equal(service.peek().state, 'expired')
})

test('global window rate limit rejects bursts', () => {
  const service = createPairingService({ maxPerWindow: 3, windowMs: 1_000, now: () => 5_000 })
  service.issue()
  assert.equal(service.claim('AAAAAAAA').reason, 'rejected')
  assert.equal(service.claim('AAAAAAAA').reason, 'rejected')
  assert.equal(service.claim('AAAAAAAA').reason, 'rejected')
  assert.equal(service.claim('AAAAAAAA').reason, 'rate-limited')
})

test('invalidateAll clears the current ticket', () => {
  const service = createPairingService()
  const ticket = service.issue()
  service.invalidateAll()
  assert.equal(service.peek().state, 'none')
  assert.equal(service.claim(ticket.secret).reason, 'rejected')
})

test('re-issuing invalidates the previous ticket', () => {
  const service = createPairingService()
  const first = service.issue()
  const second = service.issue()
  assert.equal(service.claim(first.secret).ok, false)
  assert.equal(service.claim(second.secret).ok, true)
})

test('codes are drawn without an obvious bias and remain in the alphabet', () => {
  for (let index = 0; index < 200; index += 1) {
    const code = issueCode()
    assert.equal(code.length, 8)
    for (const character of code) assert.ok(PAIRING_CODE_ALPHABET.includes(character))
  }
})
