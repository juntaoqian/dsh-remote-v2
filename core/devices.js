/**
 * Device sessions for the pairing gateway.
 *
 * Security model:
 *   - the raw 256-bit device token exists only in the browser cookie;
 *   - the state file persists only `sha256(token)`, never the token itself;
 *   - writes are atomic (unique temp file + rename, mode 0600);
 *   - mutation is serialized so a stale snapshot can never overwrite a newer one;
 *   - a corrupt/unreadable state file throws (fail closed) instead of silently
 *     starting with an empty device set.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DEVICE_COOKIE = 'dsh_remote_v2'
export const DEVICE_TOKEN_BYTES = 32
export const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
export const DEFAULT_DEVICE_MAX = 20
export const DEFAULT_DEVICE_TTL_MS = 7 * 24 * 3600_000

const DEVICE_ID_RE = /^[0-9a-f]{32}$/
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function validateState(raw, file) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`device state is not valid JSON: ${file}`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`device state must be an object: ${file}`)
  if (parsed.version !== 1 || !Array.isArray(parsed.devices)) {
    throw new Error(`device state has an unsupported schema: ${file}`)
  }
  const devices = new Map()
  const ids = new Set()
  for (const entry of parsed.devices) {
    if (typeof entry !== 'object' || entry === null) throw new Error(`device state contains a non-object: ${file}`)
    const { id, tokenHash, createdAt, expiresAt, name, ua, lastSeen } = entry
    if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) throw new Error(`invalid device id: ${file}`)
    if (typeof tokenHash !== 'string' || !TOKEN_HASH_RE.test(tokenHash)) throw new Error(`invalid token hash: ${file}`)
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) throw new Error(`invalid device dates: ${file}`)
    if (ids.has(id) || devices.has(tokenHash)) throw new Error(`duplicate device: ${file}`)
    ids.add(id)
    devices.set(tokenHash, {
      id,
      tokenHash,
      createdAt,
      expiresAt,
      ...(typeof name === 'string' ? { name: name.slice(0, 64) } : {}),
      ...(typeof ua === 'string' ? { ua: ua.slice(0, 200) } : {}),
      ...(Number.isFinite(lastSeen) ? { lastSeen } : {}),
    })
  }
  return devices
}

function serialize(devices) {
  return JSON.stringify({ version: 1, devices: [...devices.values()] })
}

function summary(device) {
  return {
    id: device.id,
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    ...(device.name === undefined ? {} : { name: device.name }),
    ...(device.ua === undefined ? {} : { ua: device.ua }),
    ...(device.lastSeen === undefined ? {} : { lastSeen: device.lastSeen }),
  }
}

/**
 * @param {{
 *   file: string,
 *   ttlMs?: number,
 *   maxDevices?: number,
 *   now?: () => number,
 * }} options
 */
export async function createDeviceStore(options) {
  const file = options.file
  const ttlMs = options.ttlMs ?? DEFAULT_DEVICE_TTL_MS
  const maxDevices = options.maxDevices ?? DEFAULT_DEVICE_MAX
  const now = options.now ?? (() => Date.now())

  let devices
  try {
    devices = validateState(await readFile(file, 'utf8'), file)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      devices = new Map()
    } else {
      throw error
    }
  }

  async function persist(map) {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${String(process.pid)}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, serialize(map), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temp, file)
    } finally {
      await rm(temp, { force: true }).catch(() => {})
    }
  }

  let queue = Promise.resolve()
  function mutate(fn) {
    const run = queue.then(async () => {
      const outcome = fn(devices)
      await persist(outcome.next)
      devices = outcome.next
      return outcome.result
    })
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    /** Create a session; the returned raw token is the only copy. */
    create(name, ua) {
      return mutate((current) => {
        if (current.size >= maxDevices) {
          const error = new Error('device limit reached')
          error.code = 'device-limit'
          throw error
        }
        const token = randomBytes(DEVICE_TOKEN_BYTES).toString('base64url')
        const tokenHash = sha256Hex(token)
        const timestamp = now()
        const device = {
          id: randomBytes(16).toString('hex'),
          tokenHash,
          createdAt: timestamp,
          expiresAt: timestamp + ttlMs,
          ...(typeof name === 'string' && name.trim() !== '' ? { name: name.trim().slice(0, 64) } : {}),
          ...(typeof ua === 'string' && ua !== '' ? { ua: ua.slice(0, 200) } : {}),
          lastSeen: timestamp,
        }
        const next = new Map(current)
        next.set(tokenHash, device)
        return { next, result: { id: device.id, token } }
      })
    },

    /** Verify a raw token; expired sessions are dropped lazily. */
    async verify(token) {
      if (typeof token !== 'string' || !DEVICE_TOKEN_RE.test(token)) return undefined
      const tokenHash = sha256Hex(token)
      const device = devices.get(tokenHash)
      if (device === undefined) return undefined
      const timestamp = now()
      if (device.expiresAt <= timestamp) {
        await mutate((current) => {
          const next = new Map(current)
          next.delete(tokenHash)
          return { next, result: undefined }
        }).catch(() => {})
        return undefined
      }
      devices.set(tokenHash, { ...device, lastSeen: timestamp })
      return { ...device, lastSeen: timestamp }
    },

    /** Revoke one device; resolves true only after the removal is persisted. */
    revoke(id) {
      if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) return Promise.resolve(false)
      return mutate((current) => {
        let hash
        for (const [candidateHash, device] of current) {
          if (device.id === id) {
            hash = candidateHash
            break
          }
        }
        if (hash === undefined) return { next: current, result: false }
        const next = new Map(current)
        next.delete(hash)
        return { next, result: true }
      })
    },

    /** Revoke every device; resolves only after the empty set is persisted. */
    revokeAll() {
      return mutate(() => ({ next: new Map(), result: undefined }))
    },

    /** Non-secret device view for the settings UI. */
    list() {
      return [...devices.values()]
        .filter((device) => device.expiresAt > now())
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(summary)
    },
  }
}
