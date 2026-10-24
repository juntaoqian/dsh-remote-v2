import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDeviceStore } from '../core/devices.js'

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-v2-devices-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('create/verify/revoke round trip persists only token hashes', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'devices.json')
    const store = await createDeviceStore({ file, ttlMs: 60_000 })
    const created = await store.create('手机', 'UA/1.0')
    assert.match(created.token, /^[A-Za-z0-9_-]{43}$/)

    const raw = await readFile(file, 'utf8')
    assert.ok(!raw.includes(created.token), 'raw token must never be persisted')
    assert.match(raw, /"tokenHash":"[0-9a-f]{64}"/)

    const verified = await store.verify(created.token)
    assert.equal(verified.id, created.id)
    const listed = store.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].name, '手机')

    assert.equal(await store.revoke(created.id), true)
    assert.equal(await store.verify(created.token), undefined)
    assert.equal(store.list().length, 0)
  })
})

test('expired sessions are not verified and are pruned lazily', async () => {
  await withTempDir(async (dir) => {
    let now = 1_000
    const store = await createDeviceStore({ file: join(dir, 'devices.json'), ttlMs: 1_000, now: () => now })
    const created = await store.create()
    now = 2_500
    assert.equal(await store.verify(created.token), undefined)
    assert.equal(store.list().length, 0)
  })
})

test('revokeAll empties the store durably', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'devices.json')
    const store = await createDeviceStore({ file })
    await store.create('a')
    await store.create('b')
    await store.revokeAll()
    assert.equal(store.list().length, 0)
    const reloaded = await createDeviceStore({ file })
    assert.equal(reloaded.list().length, 0)
  })
})

test('device limit is enforced', async () => {
  await withTempDir(async (dir) => {
    const store = await createDeviceStore({ file: join(dir, 'devices.json'), maxDevices: 1 })
    await store.create('one')
    await assert.rejects(() => store.create('two'), /device limit/)
  })
})

test('corrupt state fails closed', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'devices.json')
    await writeFile(file, '{"version":1,"devices":[{"id":"oops"}]}', 'utf8')
    await assert.rejects(() => createDeviceStore({ file }), /invalid device id/)
  })
})

test('state survives reload with the same token', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'devices.json')
    const store = await createDeviceStore({ file })
    const created = await store.create()
    const reloaded = await createDeviceStore({ file })
    const verified = await reloaded.verify(created.token)
    assert.equal(verified.id, created.id)
  })
})
