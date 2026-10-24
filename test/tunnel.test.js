/**
 * @file Unit tests for `core/tunnel.js` and `core/cloudflared.js`.
 *
 * Every test is offline and deterministic:
 * - cloudflared downloads use an injected `fetchImpl`;
 * - tunnel processes use injected fake children (`EventEmitter` + streams);
 * - metrics readiness uses an injected `fetchImpl`;
 * - loopback metrics ports are random (never a fixed port).
 *
 * @module test/tunnel.test
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';

import {
  CLOUDFLARED_DOWNLOAD_URL,
  CLOUDFLARED_VERSION,
  WIN32_X64_SHA256,
  downloadVerified,
  ensureCloudflared,
} from '../core/cloudflared.js';
import {
  MAX_METRICS_PORT,
  MIN_METRICS_PORT,
  computeBackoffMs,
  createTunnelManager,
  parseTryCloudflareUrl,
} from '../core/tunnel.js';

/** @type {string[]} */
const tempDirs = [];

/** @returns {Promise<string>} A fresh temporary directory (cleaned up after the suite). */
async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-v2-tunnel-'));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Create a minimal ChildProcess-like object for tunnel tests.
 *
 * @returns {any}
 */
function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4_000 + Math.floor(Math.random() * 20_000);
  child.exitCode = null;
  child.killed = null;
  child.kill = (signal = 'SIGTERM') => {
    child.killed = signal;
    setImmediate(() => {
      if (child.exitCode === null) {
        child.exitCode = signal === 'SIGKILL' ? null : 0;
        child.emit('exit', child.exitCode, signal === 'SIGTERM' ? signal : null);
      }
    });
    return true;
  };
  return child;
}

/**
 * Create a spawn stub: cloudflared invocations return fake children, and
 * `taskkill` invocations emit `exit` on the most recent cloudflared child.
 *
 * @param {{onCloudflared?: (child: any, args: string[], index: number) => void}} [options]
 * @returns {((command: string, args: string[], opts?: object) => any) & {calls: any[], children: any[]}}
 */
function createSpawnStub(options = {}) {
  /** @type {any[]} */
  const calls = [];
  /** @type {any[]} */
  const children = [];

  const spawnStub = (command, args, opts = {}) => {
    calls.push({ command, args: [...args], opts });
    if (command === 'taskkill') {
      const killer = new EventEmitter();
      killer.pid = 99_999;
      killer.kill = () => {};
      killer.unref = () => {};
      const target = children[children.length - 1];
      setImmediate(() => {
        if (target && target.exitCode === null) {
          target.exitCode = 0;
          target.emit('exit', 0, null);
        }
      });
      return killer;
    }
    const child = createFakeChild();
    children.push(child);
    options.onCloudflared?.(child, args, children.length - 1);
    return child;
  };
  spawnStub.calls = calls;
  spawnStub.children = children;
  return spawnStub;
}

/**
 * Create a metrics fetch stub.
 *
 * @param {{ready?: boolean}} [options]
 * @returns {((input: any, init?: any) => Promise<any>) & {calls: string[]}}
 */
function createMetricsFetch(options = {}) {
  const ready = options.ready !== false;
  /** @type {string[]} */
  const calls = [];
  const fetchStub = async (input) => {
    const url = String(input);
    calls.push(url);
    if (!url.endsWith('/ready')) throw new Error(`unexpected fetch: ${url}`);
    return { ok: ready, status: ready ? 200 : 503 };
  };
  fetchStub.calls = calls;
  return fetchStub;
}

/**
 * Emit a trycloudflare URL on a fake child's stderr shortly after spawn.
 *
 * @param {any} child
 * @param {number} index
 */
function announceQuickUrl(child, index) {
  setImmediate(() => {
    child.stderr.write(`2026-10-24T00:00:0${index % 10}Z INF |  https://quick-${index}.trycloudflare.com  |\n`);
  });
}

/**
 * @param {() => boolean|Promise<boolean>} predicate
 * @param {{timeout?: number, interval?: number, label?: string}} [options]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, options = {}) {
  const timeout = options.timeout ?? 3_000;
  const interval = options.interval ?? 5;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`timed out waiting for ${options.label ?? 'condition'}`);
}

/**
 * Create a tunnel manager preconfigured for fast, deterministic tests.
 *
 * @param {object} overrides
 * @returns {ReturnType<typeof createTunnelManager>}
 */
function createTestManager(overrides) {
  return createTunnelManager({
    cloudflaredPath: 'C:\\fake\\cloudflared.exe',
    gatewayPort: 12_345,
    logger: null,
    readyPollMs: 5,
    readyTimeoutMs: 2_000,
    backoffBaseMs: 10,
    backoffMaxMs: 40,
    stopTimeoutMs: 500,
    platform: 'win32',
    ...overrides,
  });
}

test('computeBackoffMs follows the 1s -> 30s exponential schedule', () => {
  assert.equal(computeBackoffMs(1), 1_000);
  assert.equal(computeBackoffMs(2), 2_000);
  assert.equal(computeBackoffMs(3), 4_000);
  assert.equal(computeBackoffMs(4), 8_000);
  assert.equal(computeBackoffMs(5), 16_000);
  assert.equal(computeBackoffMs(6), 30_000);
  assert.equal(computeBackoffMs(1_000), 30_000);
  assert.equal(computeBackoffMs(3, 10, 30), 30);
  assert.equal(computeBackoffMs(0), 1_000);
});

test('parseTryCloudflareUrl extracts quick tunnel URLs from noisy output', () => {
  assert.equal(
    parseTryCloudflareUrl('INF |  https://happy-panda-123.trycloudflare.com  |'),
    'https://happy-panda-123.trycloudflare.com',
  );
  assert.equal(
    parseTryCloudflareUrl('https://UPPER-CASE.trycloudflare.com'),
    'https://upper-case.trycloudflare.com',
  );
  assert.equal(parseTryCloudflareUrl('https://example.com'), undefined);
  assert.equal(parseTryCloudflareUrl('https://evil.trycloudflare.com.attacker.test'), undefined);
  assert.equal(parseTryCloudflareUrl(''), undefined);
});

test('quick tunnel: metrics /ready + parsed URL make it ready; stop kills the tree', async () => {
  const spawnStub = createSpawnStub({
    onCloudflared: (child, _args, index) => announceQuickUrl(child, index),
  });
  const fetchStub = createMetricsFetch({ ready: true });
  /** @type {any[]} */
  const states = [];
  const manager = createTestManager({
    spawnImpl: spawnStub,
    fetchImpl: fetchStub,
    onState: (state) => states.push(state),
  });

  const result = await manager.start({ transport: 'quick' });
  assert.equal(result.publicUrl, 'https://quick-0.trycloudflare.com');

  const status = manager.status();
  assert.equal(status.phase, 'ready');
  assert.equal(status.publicUrl, 'https://quick-0.trycloudflare.com');
  assert.equal(status.reconnects, 0);
  assert.equal(typeof status.startedAt, 'number');
  assert.ok(status.metricsPort >= MIN_METRICS_PORT && status.metricsPort <= MAX_METRICS_PORT);

  assert.equal(spawnStub.calls.length, 1);
  const spawnCall = spawnStub.calls[0];
  assert.equal(spawnCall.command, 'C:\\fake\\cloudflared.exe');
  assert.deepEqual(spawnCall.args.slice(0, 3), ['tunnel', '--url', 'http://127.0.0.1:12345']);
  assert.ok(spawnCall.args.includes('--no-autoupdate'));
  const metricsIndex = spawnCall.args.indexOf('--metrics');
  assert.ok(metricsIndex > 0);
  assert.equal(spawnCall.args[metricsIndex + 1], `127.0.0.1:${status.metricsPort}`);
  assert.ok(fetchStub.calls.some((url) => url.endsWith('/ready')));

  const phases = states.map((state) => state.phase);
  assert.equal(phases[0], 'starting');
  assert.ok(phases.includes('ready'));

  await manager.stop();
  assert.equal(manager.status().phase, 'idle');
  assert.equal(manager.status().publicUrl, undefined);

  const taskkillCall = spawnStub.calls.find((call) => call.command === 'taskkill');
  assert.ok(taskkillCall, 'expected taskkill to be used on win32');
  assert.deepEqual(taskkillCall.args, ['/PID', String(spawnStub.children[0].pid), '/T', '/F']);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(spawnStub.calls.filter((call) => call.command !== 'taskkill').length, 1);
});

test('named tunnel: token args and configured https public URL', async () => {
  const spawnStub = createSpawnStub();
  const manager = createTestManager({
    gatewayPort: 5_555,
    spawnImpl: spawnStub,
    fetchImpl: createMetricsFetch({ ready: true }),
  });

  const result = await manager.start({
    transport: 'named',
    namedToken: 'secret-named-token',
    publicUrl: 'https://remote.example.com',
  });
  assert.equal(result.publicUrl, 'https://remote.example.com');

  const { args } = spawnStub.calls[0];
  assert.deepEqual(args.slice(0, 4), ['tunnel', 'run', '--token', 'secret-named-token']);
  assert.ok(args.includes('--no-autoupdate'));

  await manager.stop();
  assert.equal(manager.status().phase, 'idle');
});

test('start rejects invalid settings without spawning', async () => {
  const spawnStub = createSpawnStub();
  const manager = createTestManager({ spawnImpl: spawnStub, fetchImpl: createMetricsFetch() });

  await assert.rejects(manager.start({ transport: 'bogus' }), { code: 'invalid-settings' });
  await assert.rejects(manager.start({ transport: 'named' }), { code: 'invalid-settings' });
  await assert.rejects(
    manager.start({ transport: 'named', namedToken: 'token', publicUrl: 'http://remote.example.com' }),
    { code: 'invalid-public-url' },
  );
  await assert.rejects(manager.start({ transport: 'named', namedToken: 'token', publicUrl: 'not a url' }), {
    code: 'invalid-public-url',
  });

  assert.equal(spawnStub.calls.length, 0);
  assert.equal(manager.status().phase, 'idle');
});

test('initial cloudflared exit before ready rejects start and never reconnects', async () => {
  const spawnStub = createSpawnStub({
    onCloudflared: (child) => {
      setImmediate(() => {
        child.exitCode = 1;
        child.emit('exit', 1, null);
      });
    },
  });
  const manager = createTestManager({
    spawnImpl: spawnStub,
    fetchImpl: createMetricsFetch({ ready: false }),
    readyTimeoutMs: 500,
  });

  await assert.rejects(manager.start({ transport: 'quick' }), { code: 'cloudflared-exited' });
  assert.equal(manager.status().phase, 'error');
  assert.equal(manager.status().reconnects, 0);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(spawnStub.calls.filter((call) => call.command !== 'taskkill').length, 1);
});

test('readiness timeout rejects start and kills the process tree', async () => {
  const spawnStub = createSpawnStub();
  const manager = createTestManager({
    spawnImpl: spawnStub,
    fetchImpl: createMetricsFetch({ ready: false }),
    readyPollMs: 5,
    readyTimeoutMs: 30,
  });

  await assert.rejects(manager.start({ transport: 'quick' }), { code: 'ready-timeout' });
  assert.equal(manager.status().phase, 'error');

  await waitFor(() => spawnStub.calls.some((call) => call.command === 'taskkill'), { label: 'taskkill' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(spawnStub.calls.filter((call) => call.command !== 'taskkill').length, 1);

  await manager.stop();
  assert.equal(manager.status().phase, 'idle');
});

test('abnormal exit after ready reconnects with backoff and becomes ready again', async () => {
  const spawnStub = createSpawnStub({
    onCloudflared: (child, _args, index) => announceQuickUrl(child, index),
  });
  const manager = createTestManager({
    spawnImpl: spawnStub,
    fetchImpl: createMetricsFetch({ ready: true }),
    backoffBaseMs: 10,
    backoffMaxMs: 40,
  });

  const first = await manager.start({ transport: 'quick' });
  assert.equal(first.publicUrl, 'https://quick-0.trycloudflare.com');

  const firstChild = spawnStub.children[0];
  firstChild.exitCode = 1;
  firstChild.emit('exit', 1, null);

  assert.equal(manager.status().phase, 'reconnecting');
  assert.equal(manager.status().reconnects, 1);

  await waitFor(() => spawnStub.children.length === 2, { label: 'second cloudflared spawn' });
  await waitFor(
    () => manager.status().phase === 'ready'
      && manager.status().publicUrl === 'https://quick-1.trycloudflare.com',
    { label: 'reconnected ready' },
  );
  assert.equal(manager.status().reconnects, 1);

  await manager.stop();
  assert.equal(manager.status().phase, 'idle');
  assert.equal(manager.status().publicUrl, undefined);
});

test('stop during a scheduled reconnect prevents any further spawn', async () => {
  const spawnStub = createSpawnStub({
    onCloudflared: (child, _args, index) => announceQuickUrl(child, index),
  });
  const manager = createTestManager({
    spawnImpl: spawnStub,
    fetchImpl: createMetricsFetch({ ready: true }),
    backoffBaseMs: 60,
    backoffMaxMs: 60,
  });

  await manager.start({ transport: 'quick' });
  const child = spawnStub.children[0];
  child.exitCode = 1;
  child.emit('exit', 1, null);
  assert.equal(manager.status().phase, 'reconnecting');

  await manager.stop();
  assert.equal(manager.status().phase, 'idle');

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(spawnStub.children.length, 1);
});

test('non-Windows stop uses SIGTERM instead of taskkill', async () => {
  const spawnStub = createSpawnStub({
    onCloudflared: (child, _args, index) => announceQuickUrl(child, index),
  });
  const manager = createTestManager({
    spawnImpl: spawnStub,
    fetchImpl: createMetricsFetch({ ready: true }),
    platform: 'linux',
  });

  await manager.start({ transport: 'quick' });
  const child = spawnStub.children[0];
  await manager.stop();

  assert.equal(child.killed, 'SIGTERM');
  assert.equal(spawnStub.calls.some((call) => call.command === 'taskkill'), false);
});

test('ensureCloudflared rejects unsupported platforms', async () => {
  const cacheDir = await makeTempDir();
  await assert.rejects(
    ensureCloudflared({
      cacheDir,
      platform: 'darwin',
      arch: 'arm64',
      whichImpl: async () => [],
      fetchImpl: async () => {
        throw new Error('network must not be used');
      },
    }),
    { code: 'unsupported-platform' },
  );
});

test('ensureCloudflared prefers an explicit existing path', async () => {
  const dir = await makeTempDir();
  const explicit = join(dir, 'cloudflared.exe');
  await writeFile(explicit, 'fake binary');

  const resolved = await ensureCloudflared({
    cacheDir: join(dir, 'cache'),
    explicitPath: explicit,
    platform: 'win32',
    arch: 'x64',
    whichImpl: async () => [],
    fetchImpl: async () => {
      throw new Error('network must not be used');
    },
  });
  assert.equal(resolved, explicit);
});

test('ensureCloudflared rejects a missing explicit path', async () => {
  const dir = await makeTempDir();
  await assert.rejects(
    ensureCloudflared({
      cacheDir: join(dir, 'cache'),
      explicitPath: join(dir, 'does-not-exist.exe'),
      platform: 'win32',
      arch: 'x64',
      whichImpl: async () => [],
      fetchImpl: async () => {
        throw new Error('network must not be used');
      },
    }),
    { code: 'explicit-path-not-found' },
  );
});

test('ensureCloudflared accepts a PATH candidate with the pinned version', async () => {
  const dir = await makeTempDir();
  const onPath = join(dir, 'cloudflared.exe');
  await writeFile(onPath, 'fake binary');

  const resolved = await ensureCloudflared({
    cacheDir: join(dir, 'cache'),
    platform: 'win32',
    arch: 'x64',
    whichImpl: async () => [onPath],
    execVersionImpl: async () => `cloudflared version ${CLOUDFLARED_VERSION} (built 2026-08-01)`,
    fetchImpl: async () => {
      throw new Error('network must not be used');
    },
  });
  assert.equal(resolved, onPath);
});

test('ensureCloudflared ignores a wrong PATH version and rejects a checksum mismatch', async () => {
  const dir = await makeTempDir();
  const onPath = join(dir, 'cloudflared.exe');
  await writeFile(onPath, 'fake binary');

  /** @type {string|undefined} */
  let requestedUrl;
  const fetchImpl = async (url) => {
    requestedUrl = String(url);
    const bytes = Buffer.from('not the real cloudflared binary');
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };

  await assert.rejects(
    ensureCloudflared({
      cacheDir: join(dir, 'cache'),
      platform: 'win32',
      arch: 'x64',
      whichImpl: async () => [onPath],
      execVersionImpl: async () => 'cloudflared version 2025.1.0',
      fetchImpl,
    }),
    { code: 'checksum-mismatch' },
  );

  assert.equal(requestedUrl, CLOUDFLARED_DOWNLOAD_URL);
  const cacheEntries = await readdir(join(dir, 'cache')).catch(() => []);
  assert.deepEqual(cacheEntries, []);

  // A stale/invalid cache file must be removed before downloading.
  await writeFile(join(dir, 'cache', 'cloudflared.exe'), 'stale').catch(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'cache'), { recursive: true });
    await writeFile(join(dir, 'cache', 'cloudflared.exe'), 'stale');
  });
  await assert.rejects(
    ensureCloudflared({
      cacheDir: join(dir, 'cache'),
      platform: 'win32',
      arch: 'x64',
      whichImpl: async () => [],
      execVersionImpl: async () => '',
      fetchImpl,
    }),
    { code: 'checksum-mismatch' },
  );
  const entriesAfter = await readdir(join(dir, 'cache')).catch(() => []);
  assert.deepEqual(entriesAfter, []);
  assert.equal(WIN32_X64_SHA256.length, 64);
});

test('downloadVerified verifies SHA-256 and atomically writes the cache file', async () => {
  const dir = await makeTempDir();
  const destPath = join(dir, 'bin', 'cloudflared.exe');
  const bytes = Buffer.from('fake cloudflared binary payload');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });

  const result = await downloadVerified({
    url: 'https://example.invalid/cloudflared.exe',
    expectedSha256: sha256,
    destPath,
    fetchImpl,
  });

  assert.equal(result.path, destPath);
  assert.equal(result.sha256, sha256);
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(await readFile(destPath), bytes);
  const leftovers = (await readdir(join(dir, 'bin'))).filter((name) => name !== 'cloudflared.exe');
  assert.deepEqual(leftovers, []);
});

test('downloadVerified rejects checksum mismatches and leaves no file behind', async () => {
  const dir = await makeTempDir();
  const destPath = join(dir, 'bin', 'cloudflared.exe');
  const bytes = Buffer.from('tampered payload');
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });

  await assert.rejects(
    downloadVerified({
      url: 'https://example.invalid/cloudflared.exe',
      expectedSha256: WIN32_X64_SHA256,
      destPath,
      fetchImpl,
    }),
    { code: 'checksum-mismatch' },
  );

  const entries = await readdir(join(dir, 'bin')).catch(() => []);
  assert.deepEqual(entries, []);
  assert.equal(CLOUDFLARED_VERSION, '2026.8.2');
});

test('downloadVerified maps HTTP failures to download-failed', async () => {
  const dir = await makeTempDir();
  const destPath = join(dir, 'cloudflared.exe');
  await assert.rejects(
    downloadVerified({
      url: 'https://example.invalid/cloudflared.exe',
      expectedSha256: WIN32_X64_SHA256,
      destPath,
      fetchImpl: async () => ({ ok: false, status: 404 }),
    }),
    { code: 'download-failed' },
  );
  assert.deepEqual(await readdir(dir).catch(() => []), []);
});
