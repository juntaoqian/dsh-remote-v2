/**
 * @file Loopback control API for the dsh-remote-v2 sidecar.
 *
 * Contract: `docs/contracts.md` section 8.
 *
 * Security properties:
 * - binds `127.0.0.1:0` only (random port, never a public interface);
 * - every route except `GET /healthz` requires `Authorization: Bearer <token>`,
 *   compared with `crypto.timingSafeEqual`;
 * - request bodies are capped at 1 MiB by default;
 * - responses are JSON, `Cache-Control: no-store`, with a uniform error shape
 *   `{ok:false, error:{code, message}}` and success shape `{ok:true, value}`.
 *
 * @module core/control
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { resolveLogger } from './log.js';

/** Default maximum request body size (1 MiB, per contract). */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

const MAX_ERROR_MESSAGE_CHARS = 500;

const STATUS_BY_CODE = Object.freeze(
  /** @type {Record<string, number>} */ ({
    'invalid-request': 400,
    'invalid-json': 400,
    'invalid-config': 400,
    'invalid-settings': 400,
    'invalid-public-url': 400,
    'invalid-transport': 400,
    unauthorized: 401,
    forbidden: 403,
    'not-found': 404,
    'method-not-allowed': 405,
    'already-running': 409,
    'not-running': 409,
    stopped: 409,
    conflict: 409,
    'payload-too-large': 413,
    'unsupported-platform': 501,
    'download-failed': 502,
    'checksum-mismatch': 502,
    'cloudflared-exited': 502,
    'tunnel-start-failed': 502,
    'ready-timeout': 504,
  }),
);

/**
 * Create an `Error` carrying a stable `code`.
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function codedError(code, message) {
  const error = /** @type {Error & {code: string}} */ (new Error(message));
  error.code = code;
  return error;
}

/**
 * Truncate a message for the wire.
 *
 * @param {unknown} message
 * @returns {string}
 */
function truncateMessage(message) {
  const text = typeof message === 'string' ? message : String(message ?? '');
  return text.length > MAX_ERROR_MESSAGE_CHARS ? `${text.slice(0, MAX_ERROR_MESSAGE_CHARS - 1)}…` : text;
}

/**
 * Send a JSON response. Safe to call once; ignores already-ended responses.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {unknown} payload
 * @returns {void}
 */
function sendJson(res, statusCode, payload) {
  if (res.writableEnded || res.destroyed) return;
  let body;
  try {
    body = Buffer.from(JSON.stringify(payload));
  } catch {
    body = Buffer.from(JSON.stringify({ ok: false, error: { code: 'internal', message: 'response serialisation failed' } }));
  }
  try {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
  } catch {
    // The peer may have aborted while the handler was running; dropping the
    // response is the only safe action and must never crash the sidecar.
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, error: {code: string, message: string}}}
 */
function errorPayload(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * Read and JSON-parse a request body with a hard size cap.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{maxBodyBytes: number}} options
 * @returns {Promise<{ok: true, value: any} | {ok: false, status: number, error: object}>}
 */
function readJsonBody(req, res, options) {
  const maxBodyBytes = options.maxBodyBytes;
  return new Promise((resolve) => {
    /** Ensure an oversized request cannot keep the socket busy indefinitely. */
    const rejectOversized = () => {
      res.once('finish', () => {
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
      });
    };

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      rejectOversized();
      req.resume();
      resolve({
        ok: false,
        status: 413,
        error: errorPayload('payload-too-large', `request body exceeds the ${maxBodyBytes}-byte limit`),
      });
      return;
    }

    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };
    /** @param {{ok: false, status: number, error: object}} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(/** @type {any} */ (result));
    };
    /** @param {Error} error */
    const onError = (error) => {
      finish({
        ok: false,
        status: 400,
        error: errorPayload('invalid-request', truncateMessage(error.message || 'request stream error')),
      });
    };
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        req.pause();
        rejectOversized();
        finish({
          ok: false,
          status: 413,
          error: errorPayload('payload-too-large', `request body exceeds the ${maxBodyBytes}-byte limit`),
        });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        finish({ ok: true, value: {} });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(text) });
      } catch {
        finish({ ok: false, status: 400, error: errorPayload('invalid-json', 'request body is not valid JSON') });
      }
    };

    const onAborted = () => {
      finish({ ok: false, status: 400, error: errorPayload('invalid-request', 'request aborted') });
    };
    const onClose = () => {
      if (!req.complete) onAborted();
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}

/**
 * Create the control server.
 *
 * @param {{
 *   token: string,
 *   runtime: Record<string, Function>,
 *   logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function},
 *   maxBodyBytes?: number,
 * }} options
 * @returns {{start(): Promise<{port: number, host: string}>, stop(): Promise<void>}}
 */
export function createControlServer(options) {
  const { token, runtime } = options ?? {};
  if (typeof token !== 'string' || token.length === 0) {
    throw codedError('invalid-token', 'a non-empty control token is required');
  }
  if (!runtime || typeof runtime !== 'object') {
    throw codedError('invalid-runtime', 'runtime object is required');
  }
  const maxBodyBytes = Number.isInteger(options?.maxBodyBytes) && options.maxBodyBytes > 0
    ? options.maxBodyBytes
    : DEFAULT_MAX_BODY_BYTES;
  const log = resolveLogger(options?.logger);
  const tokenBuffer = Buffer.from(token, 'utf8');

  /** @type {import('node:http').Server|null} */
  let server = null;
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();

  /**
   * Constant-time bearer-token check.
   *
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  function isAuthorized(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
    if (!match) return false;
    const provided = Buffer.from(match[1], 'utf8');
    if (provided.length !== tokenBuffer.length) return false;
    try {
      return timingSafeEqual(provided, tokenBuffer);
    } catch {
      return false;
    }
  }

  /** @type {Array<{method: string, path: string, action: string}>} */
  const routes = [
    { method: 'GET', path: '/status', action: 'status' },
    { method: 'POST', path: '/start', action: 'start' },
    { method: 'POST', path: '/stop', action: 'stop' },
    { method: 'POST', path: '/pairing/rotate', action: 'pairingRotate' },
    { method: 'GET', path: '/pairing', action: 'pairingStatus' },
    { method: 'GET', path: '/devices', action: 'devices' },
    { method: 'POST', path: '/devices/revoke', action: 'revoke' },
    { method: 'POST', path: '/devices/revokeAll', action: 'revokeAll' },
    { method: 'GET', path: '/config', action: 'configGet' },
    { method: 'POST', path: '/config', action: 'configSet' },
    { method: 'GET', path: '/diagnostics', action: 'diagnostics' },
  ];

  /**
   * Apply a route-level body contract, returning the argument to pass to the
   * runtime method.
   *
   * @param {{method: string, path: string, action: string}} route
   * @param {any} body Parsed JSON body.
   * @returns {any}
   */
  function buildArgument(route, body) {
    const record = body === null || body === undefined ? {} : body;
    if (Array.isArray(record) || typeof record !== 'object') {
      throw codedError('invalid-request', 'body must be a JSON object');
    }
    switch (route.action) {
      case 'start':
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          throw codedError('invalid-request', 'body must be a JSON object');
        }
        return record;
      case 'configSet':
        if (!record || typeof record !== 'object' || Array.isArray(record) || !record.config
          || typeof record.config !== 'object' || Array.isArray(record.config)) {
          throw codedError('invalid-request', '"config" object is required');
        }
        return record.config;
      case 'revoke': {
        if (!record || typeof record !== 'object' || Array.isArray(record)
          || typeof record.id !== 'string' || !record.id.trim()) {
          throw codedError('invalid-request', '"id" is required');
        }
        return record.id.trim();
      }
      case 'stop':
      case 'pairingRotate':
      case 'revokeAll':
        return record;
      default:
        return record;
    }
  }

  /**
   * Map an error thrown by a runtime method onto an HTTP response.
   *
   * @param {unknown} error
   * @param {string} path
   * @returns {{status: number, payload: object}}
   */
  function mapError(error, path) {
    const rawCode = typeof (/** @type {{code?: unknown}} */ (error)?.code) === 'string'
      ? String(/** @type {{code?: unknown}} */ (error).code)
      : 'internal';
    const known = Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, rawCode) || rawCode === 'invalid-env';
    const code = known ? rawCode : 'internal';
    const status = STATUS_BY_CODE[code] ?? 500;
    const message = truncateMessage(
      error instanceof Error ? error.message : error === undefined ? 'internal error' : error,
    );
    log.error('control.handler-failed', { path, code, message });
    return { status, payload: errorPayload(code, message) };
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<void>}
   */
  async function handleRequest(req, res) {
    const method = req.method ?? 'GET';
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      sendJson(res, 400, errorPayload('invalid-request', 'malformed request target'));
      return;
    }

    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true, value: { ok: true } });
      return;
    }

    if (!isAuthorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, 401, errorPayload('unauthorized', 'invalid or missing control token'));
      return;
    }

    const matching = routes.filter((route) => route.path === pathname);
    if (matching.length === 0) {
      sendJson(res, 404, errorPayload('not-found', `unknown route: ${pathname}`));
      return;
    }
    const route = matching.find((candidate) => candidate.method === method);
    if (!route) {
      res.setHeader('Allow', matching.map((candidate) => candidate.method).join(', '));
      sendJson(res, 405, errorPayload('method-not-allowed', `${method} is not allowed on ${pathname}`));
      return;
    }

    /** @type {any} */
    let body = {};
    if (method === 'POST') {
      const parsed = await readJsonBody(req, res, { maxBodyBytes });
      if (!parsed.ok) {
        sendJson(res, parsed.status, parsed.error);
        return;
      }
      body = parsed.value;
    } else {
      req.resume();
    }

    const runtimeMethod = runtime[route.action];
    if (typeof runtimeMethod !== 'function') {
      sendJson(res, 501, errorPayload('not-implemented', `runtime.${route.action} is not available`));
      return;
    }

    try {
      const argument = buildArgument(route, body);
      const value = await runtimeMethod(argument);
      sendJson(res, 200, { ok: true, value: value === undefined ? {} : value });
    } catch (error) {
      const mapped = mapError(error, pathname);
      sendJson(res, mapped.status, mapped.payload);
    }
  }

  return {
    /**
     * Bind loopback port 0 and resolve the chosen port.
     *
     * @returns {Promise<{port: number, host: string}>}
     */
    async start() {
      if (server) throw codedError('already-started', 'control server is already listening');
      const httpServer = createServer((req, res) => {
        handleRequest(req, res).catch((error) => {
          log.error('control.unhandled', { error });
          sendJson(res, 500, errorPayload('internal', truncateMessage(error instanceof Error ? error.message : error)));
        });
      });
      httpServer.requestTimeout = 30_000;
      httpServer.headersTimeout = 15_000;
      httpServer.keepAliveTimeout = 5_000;
      httpServer.maxHeadersCount = 64;
      httpServer.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      server = httpServer;

      await new Promise((resolve, reject) => {
        const onError = (error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve(undefined);
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(0, '127.0.0.1');
      });

      const address = httpServer.address();
      if (!address || typeof address === 'string') {
        throw codedError('internal', 'control server did not expose a TCP address');
      }
      log.info('control.listening', { host: '127.0.0.1', port: address.port });
      return { port: address.port, host: '127.0.0.1' };
    },

    /**
     * Stop accepting connections and destroy remaining sockets.
     *
     * @returns {Promise<void>}
     */
    async stop() {
      const httpServer = server;
      if (!httpServer) return;
      server = null;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(fallback);
          resolve();
        };
        const fallback = setTimeout(finish, 2_000);
        fallback.unref?.();
        httpServer.close(() => finish());
        httpServer.closeAllConnections?.();
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
        }
        sockets.clear();
      });
      log.info('control.stopped');
    },
  };
}
