/**
 * One-time pairing tickets.
 *
 * A ticket holds two equivalent credentials derived from one issuance:
 *   - `secret`: 32 random bytes (base64url, 43 chars) for the QR fragment;
 *   - `code`:   8 characters from a confusion-reduced 31-character alphabet
 *               (≈39.6 bits) for manual entry.
 *
 * Security properties:
 *   - single-use: the ticket is removed synchronously at claim time;
 *   - per-ticket attempt cap: 5 wrong attempts lock the ticket;
 *   - global short-window budget bounds online guessing and abuse;
 *   - constant-time comparison of both credentials;
 *   - consumed/expired states never expose the secret or code.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const PAIRING_CODE_LENGTH = 8
export const PAIRING_SECRET_BYTES = 32
export const DEFAULT_TICKET_TTL_MS = 5 * 60_000
export const DEFAULT_MAX_ATTEMPTS = 5
export const DEFAULT_WINDOW_MS = 60_000
export const DEFAULT_MAX_PER_WINDOW = 120

const ALPHABET_LENGTH = PAIRING_CODE_ALPHABET.length // 31
const REJECTION_LIMIT = Math.floor(256 / ALPHABET_LENGTH) * ALPHABET_LENGTH // 248

/** One unbiased alphabet index (rejection sampling; 256 % 31 != 0). */
function uniformIndex() {
  for (;;) {
    const byte = randomBytes(1)[0]
    if (byte < REJECTION_LIMIT) return byte % ALPHABET_LENGTH
  }
}

/** Random pairing code of `length` characters over the pairing alphabet. */
export function issueCode(length = PAIRING_CODE_LENGTH) {
  let code = ''
  while (code.length < length) code += PAIRING_CODE_ALPHABET[uniformIndex()]
  return code
}

/** 32-byte base64url secret for QR / deep-link delivery. */
export function issueSecret() {
  return randomBytes(PAIRING_SECRET_BYTES).toString('base64url')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * @param {{
 *   ttlMs?: number,
 *   maxAttempts?: number,
 *   windowMs?: number,
 *   maxPerWindow?: number,
 *   now?: () => number,
 * }} [options]
 */
export function createPairingService(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TICKET_TTL_MS
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const maxPerWindow = options.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW
  const now = options.now ?? (() => Date.now())

  /** @type {null | { id: string, secret: string, code: string, createdAt: number, expiresAt: number, attempts: number }} */
  let current = null
  /** @type {null | { id: string, consumedAt: number }} */
  let consumed = null
  /** @type {null | { id: string, expiresAt: number }} */
  let expired = null
  let windowStart = 0
  let windowCount = 0

  function active(nowMs) {
    if (current === null) return null
    if (current.expiresAt <= nowMs) {
      expired = { id: current.id, expiresAt: current.expiresAt }
      current = null
      return null
    }
    return current
  }

  return {
    /** Issue a fresh ticket; the previous ticket becomes invalid immediately. */
    issue() {
      const createdAt = now()
      const ticket = {
        id: randomBytes(16).toString('hex'),
        secret: issueSecret(),
        code: issueCode(),
        createdAt,
        expiresAt: createdAt + ttlMs,
        attempts: 0,
      }
      current = ticket
      consumed = null
      expired = null
      return { id: ticket.id, secret: ticket.secret, code: ticket.code, createdAt, expiresAt: ticket.expiresAt }
    },

    /**
     * Atomically redeem the current ticket by secret or code.
     * @param {string} credential
     * @returns {{ ok: true, ticket: { id: string, secret: string, code: string, createdAt: number, expiresAt: number } } | { ok: false, reason: 'rejected' | 'rate-limited' | 'locked' }}
     */
    claim(credential) {
      if (typeof credential !== 'string' || credential.length === 0 || credential.length > 128) {
        return { ok: false, reason: 'rejected' }
      }
      const nowMs = now()
      if (nowMs - windowStart >= windowMs) {
        windowStart = nowMs
        windowCount = 0
      }
      windowCount += 1
      if (windowCount > maxPerWindow) return { ok: false, reason: 'rate-limited' }

      const ticket = active(nowMs)
      if (ticket === null) return { ok: false, reason: 'rejected' }

      const codeUpper = credential.toUpperCase()
      const secretHit = safeEqual(credential, ticket.secret)
      const codeHit = safeEqual(codeUpper, ticket.code)
      if (secretHit || codeHit) {
        // Delete before reporting success: one ticket can never be used twice.
        current = null
        consumed = { id: ticket.id, consumedAt: nowMs }
        expired = null
        return {
          ok: true,
          ticket: {
            id: ticket.id,
            secret: ticket.secret,
            code: ticket.code,
            createdAt: ticket.createdAt,
            expiresAt: ticket.expiresAt,
          },
        }
      }

      ticket.attempts += 1
      if (ticket.attempts >= maxAttempts) {
        expired = { id: ticket.id, expiresAt: ticket.expiresAt }
        current = null
        return { ok: false, reason: 'locked' }
      }
      return { ok: false, reason: 'rejected' }
    },

    /** Read the lifecycle state without creating or consuming anything. */
    peek() {
      const nowMs = now()
      const ticket = active(nowMs)
      if (ticket !== null) {
        // The gateway process is the only consumer and stays inside the
        // loopback trust boundary; the settings UI needs the secret/code to
        // render the QR and manual code for the CURRENT ticket only.
        return {
          state: 'active',
          ticket: {
            id: ticket.id,
            secret: ticket.secret,
            code: ticket.code,
            createdAt: ticket.createdAt,
            expiresAt: ticket.expiresAt,
          },
        }
      }
      if (consumed !== null) return { state: 'consumed', id: consumed.id, consumedAt: consumed.consumedAt }
      if (expired !== null) return { state: 'expired', id: expired.id, expiresAt: expired.expiresAt }
      return { state: 'none' }
    },

    /** Drop every live ticket (tunnel stop, origin change, restart). */
    invalidateAll() {
      current = null
      consumed = null
      expired = null
    },

    /** Number of live tickets (0 or 1). */
    count() {
      return active(now()) === null ? 0 : 1
    },
  }
}
