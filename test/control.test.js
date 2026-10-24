/**
 * @file Unit tests for `core/control.js`.
 *
 * The real HTTP server is started on `127.0.0.1:0` and exercised with real
 * `node:http` requests, so binding, auth, routing and body limits are tested
 * end-to-end without touching the network.
 *
 * @module test/control.test
 */

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, test } from 'node:test';

import { createControlServer } from '../core/control.js';

const TOKEN = 'test-control-token-0123456789abcdef';

/** Fixtures returned by the runtime stub. */
const STATUS_FIXTURE = {
  running: false,
  phase: 'idle',
  transport: 'quick',
  version: '0.1.0',
  devices: [{ id: 'device-1', createdAt: 1, expiresAt: 2 }],
  pairing: { state: 'none' },
  edge: { ready: false, reconnects: 0 },
};

/**
 * Create a runtime stub recording every call.
 *
 * @param {Record<string, Function>} [overrides]
 * @returns {{runtime: Record<string, Function>, calls: Array<{name: string, args: any[]}>}}
 */
function createRuntimeStub(overrides = {}) {
  /** @type {Array<{name: string, args: any[]}>} */
  const calls = [];
  /**
   * @param {string} name
   * @param {unknown} value
   * @returns {Function}
   */
  const handler = (name, value) => async (...args) => {
    calls.push({ name, args });
    if (typeof value === 'function') return value(...args);
    return value;
  };

  const runtime = {
    status: handler('status', STATUS_FIXTURE),
    start: handler('start', { running: true, phase: 'ready', publicUrl: 'https://quick.trycloudflare.com' }),
    stop: handler('stop', { running: false, phase: 'idle' }),
    pairingRotate: handler('pairingRotate', { code: 'ABCDEFGH', url: 'https://quick.trycloudflare.com/pair#s=secret', expiresAt: 123 }),
    pairingStatus: handler('pairingStatus', { state: 'active', code: 'ABCDEFGH', url: 'https://quick.trycloudflare.com/pair#s=secret' }),
    devices: handler('devices', [{ id: 'device-1' }]),
    revoke: handler('revoke', { revoked: true }),
    revokeAll: handler('revokeAll', { revokedAll: true }),
    configGet: handler('configGet', { transport: 'quick', namedToken: '', publicUrl: '', autoStart: false }),
    configSet: handler('configSet', (patch) => ({ ...patch })),
    diagnostics: handler('diagnostics', { pid: 4242, logs: [] }),
    ...overrides,
  };
  return { runtime, calls };
}

/**
 * Start a control server for one test.
 *
 * @param {{runtime?: Record<string, Function>, maxBodyBytes?: number}} [options]
 * @returns {Promise<{port: number, control: ReturnType<typeof createControlServer>, calls: Array<{name: string, args: any[]}>, runtime: Record<string, Function>}>}
 */
async function startControl(options = {}) {
  const { runtime, calls } = options.runtime ? { runtime: options.runtime, calls: [] } : createRuntimeStub();
  const control = createControlServer({
    token: TOKEN,
    runtime,
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
  });
  const address = await control.start();
  assert.equal(address.host, '127.0.0.1');
  assert.ok(address.port > 0);
  return { port: address.port, control, calls, runtime };
}

/**
 * Perform a real HTTP request against the control server.
 *
 * @param {number} port
 * @param {string} pathname
 * @param {{method?: string, token?: string|undefined, body?: unknown, rawBody?: string, headers?: Record<string, string>}} [options]
 * @returns {Promise<{status: number, headers: Record<string, any>, text: string, json: any}>}
 */
function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    /** @type {Record<string, string>} */
    const headers = { ...(options.headers ?? {}) };
    /** @type {Buffer|undefined} */
    let payload;
    if (options.rawBody !== undefined) {
      payload = Buffer.from(options.rawBody, 'utf8');
    } else if (options.body !== undefined) {
      payload = Buffer.from(JSON.stringify(options.body), 'utf8');
    }
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (payload) {
      headers['content-type'] = headers['content-type'] ?? 'application/json';
      if (headers['content-length'] === undefined) headers['content-length'] = String(payload.length);
    }

    const req = httpRequest(
      { host: '127.0.0.1', port, path: pathname, method: options.method ?? 'GET', headers, agent: false },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('GET /healthz is public and returns ok', async (t) => {
  const { port, control } = await startControl();
  t.after(() => control.stop());

  const response = await request(port, '/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, value: { ok: true } });
  assert.match(String(response.headers['content-type']), /application\/json/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('every other route requires the exact bearer token (timing-safe compare)', async (t) => {
  const { port, control } = await startControl();
  t.after(() => control.stop());

  const missing = await request(port, '/status');
  assert.equal(missing.status, 401);
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.error.code, 'unauthorized');
  assert.match(String(missing.headers['www-authenticate']), /Bearer/);

  const wrong = await request(port, '/status', { token: 'totally-wrong-token-value' });
  assert.equal(wrong.status, 401);

  const wrongLength = await request(port, '/status', { token: 'x' });
  assert.equal(wrongLength.status, 401);

  const noScheme = await request(port, '/status', { headers: { authorization: TOKEN } });
  assert.equal(noScheme.status, 401);

  const ok = await request(port, '/status', { token: TOKEN });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.deepEqual(ok.json.value, STATUS_FIXTURE);
});

test('all contract routes dispatch to runtime with the right argument', async (t) => {
  const { port, control, calls } = await startControl();
  t.after(() => control.stop());

  /** @type {Array<{method: string, path: string, body?: unknown, action: string, arg?: unknown}>} */
  const cases = [
    { method: 'GET', path: '/status', action: 'status' },
    { method: 'POST', path: '/start', body: { transport: 'quick' }, action: 'start', arg: { transport: 'quick' } },
    { method: 'POST', path: '/stop', body: {}, action: 'stop' },
    { method: 'POST', path: '/pairing/rotate', body: {}, action: 'pairingRotate' },
    { method: 'GET', path: '/pairing', action: 'pairingStatus' },
    { method: 'GET', path: '/devices', action: 'devices' },
    { method: 'POST', path: '/devices/revoke', body: { id: 'device-1' }, action: 'revoke', arg: 'device-1' },
    { method: 'POST', path: '/devices/revokeAll', body: {}, action: 'revokeAll' },
    { method: 'GET', path: '/config', action: 'configGet' },
    {
      method: 'POST',
      path: '/config',
      body: { config: { transport: 'named' } },
      action: 'configSet',
      arg: { transport: 'named' },
    },
    { method: 'GET', path: '/diagnostics', action: 'diagnostics' },
  ];

  for (const routeCase of cases) {
    const response = await request(port, routeCase.path, {
      method: routeCase.method,
      token: TOKEN,
      ...(routeCase.body === undefined ? {} : { body: routeCase.body }),
    });
    assert.equal(response.status, 200, `${routeCase.method} ${routeCase.path}`);
    assert.equal(response.json.ok, true, `${routeCase.method} ${routeCase.path}`);
    const recorded = calls.filter((call) => call.name === routeCase.action).pop();
    assert.ok(recorded, `runtime.${routeCase.action} was not called`);
    if (routeCase.arg !== undefined) assert.deepEqual(recorded.args[0], routeCase.arg);
  }

  const startResponse = await request(port, '/start', {
    method: 'POST',
    token: TOKEN,
    body: { transport: 'named', namedToken: 'token', publicUrl: 'https://remote.example.com' },
  });
  assert.deepEqual(startResponse.json.value, {
    running: true,
    phase: 'ready',
    publicUrl: 'https://quick.trycloudflare.com',
  });
});

test('unknown routes and wrong methods are reported consistently', async (t) => {
  const { port, control } = await startControl();
  t.after(() => control.stop());

  const unknown = await request(port, '/does-not-exist', { token: TOKEN });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'not-found');

  const unknownWithoutAuth = await request(port, '/does-not-exist');
  assert.equal(unknownWithoutAuth.status, 401, 'auth is checked before routing');

  const wrongMethod = await request(port, '/status', { method: 'POST', token: TOKEN, body: {} });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.error.code, 'method-not-allowed');
  assert.match(String(wrongMethod.headers.allow), /GET/);

  // Only GET /healthz is a route: other methods on it are unknown (404),
  // but they still require the bearer token (checked above for other paths).
  const healthzPost = await request(port, '/healthz', { method: 'POST', token: TOKEN, body: {} });
  assert.equal(healthzPost.status, 404);

  const badStartBody = await request(port, '/start', { method: 'POST', token: TOKEN, body: [1, 2] });
  assert.equal(badStartBody.status, 400);
  assert.equal(badStartBody.json.error.code, 'invalid-request');

  const badConfigBody = await request(port, '/config', { method: 'POST', token: TOKEN, body: { notConfig: true } });
  assert.equal(badConfigBody.status, 400);
  assert.equal(badConfigBody.json.error.code, 'invalid-request');

  const badRevokeBody = await request(port, '/devices/revoke', { method: 'POST', token: TOKEN, body: {} });
  assert.equal(badRevokeBody.status, 400);
  assert.equal(badRevokeBody.json.error.code, 'invalid-request');
});

test('invalid JSON and oversized bodies are rejected before dispatch', async (t) => {
  const { port, control, calls } = await startControl();
  t.after(() => control.stop());

  const invalidJson = await request(port, '/config', {
    method: 'POST',
    token: TOKEN,
    rawBody: '{ this is not json',
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.json.error.code, 'invalid-json');

  const small = await startControl({ maxBodyBytes: 32 });
  t.after(() => small.control.stop());
  const oversized = await request(small.port, '/config', {
    method: 'POST',
    token: TOKEN,
    rawBody: JSON.stringify({ config: { padding: 'x'.repeat(200) } }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.json.error.code, 'payload-too-large');

  assert.equal(calls.some((call) => call.name === 'configSet'), false);
});

test('runtime errors are mapped to stable HTTP error codes', async (t) => {
  const failingStart = async () => {
    const error = new Error('namedToken is required');
    error.code = 'invalid-settings';
    throw error;
  };
  const failingStatus = async () => {
    throw new Error('unexpected boom');
  };
  const runtime = {
    ...createRuntimeStub().runtime,
    start: failingStart,
    status: failingStatus,
  };
  const { port, control } = await startControl({ runtime });
  t.after(() => control.stop());

  const invalidSettings = await request(port, '/start', {
    method: 'POST',
    token: TOKEN,
    body: { transport: 'named' },
  });
  assert.equal(invalidSettings.status, 400);
  assert.equal(invalidSettings.json.ok, false);
  assert.equal(invalidSettings.json.error.code, 'invalid-settings');
  assert.equal(invalidSettings.json.error.message, 'namedToken is required');

  const generic = await request(port, '/status', { token: TOKEN });
  assert.equal(generic.status, 500);
  assert.equal(generic.json.error.code, 'internal');
  assert.equal(generic.json.error.message, 'unexpected boom');
});

test('stop() closes the listener and is idempotent', async () => {
  const { port, control } = await startControl();
  const before = await request(port, '/healthz');
  assert.equal(before.status, 200);

  await control.stop();
  await control.stop(); // idempotent

  await assert.rejects(request(port, '/healthz'), (error) => error.code === 'ECONNREFUSED');
});
