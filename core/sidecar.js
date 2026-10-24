/**
 * @file Sidecar process entry point.
 *
 * Contract: `docs/contracts.md` sections 1 and 9.
 *
 * Boot sequence:
 * 1. validate `DSH_REMOTE_V2_*` environment variables;
 * 2. create `<stateDir>` and `<stateDir>/logs`, then the JSONL logger;
 * 3. load `config.json`, devices (`devices.json`) and the pairing service;
 * 4. create and start the loopback gateway, then the tunnel manager (lazily,
 *    because resolving cloudflared may download it);
 * 5. create the runtime facade, start the control server on `127.0.0.1:0` and
 *    atomically publish `<stateDir>/control.json`;
 * 6. install SIGINT/SIGTERM graceful shutdown, the host-pid watchdog and
 *    last-resort exception handlers.
 *
 * The module exports {@link main} so the plugin host can supervise it; running
 * the file directly (`node core/sidecar.js`) starts the sidecar.
 *
 * @module core/sidecar
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createControlServer } from './control.js';
import {
  CONFIG_DEFAULTS,
  CONTROL_FILE_NAME,
  atomicWriteJson,
  createConfigStore,
  ensureDir,
  normalizeConfig,
  readSidecarEnv,
} from './config.js';
import { ensureCloudflared } from './cloudflared.js';
import { createDeviceStore } from './devices.js';
import { createGateway } from './gateway.js';
import { createLogger } from './log.js';
import { createPairingService } from './pairing.js';
import { createTunnelManager } from './tunnel.js';

const WATCHDOG_INTERVAL_MS = 2_000;
const BROKER_TIMEOUT_MS = 5_000;

/**
 * Create an `Error` carrying a stable `code`.
 *
 * @param {string} code
 * @param {string} message
 * @param {{cause?: unknown}} [options]
 * @returns {Error & {code: string}}
 */
function codedError(code, message, options) {
  const error = /** @type {Error & {code: string}} */ (new Error(message, options));
  error.code = code;
  return error;
}

/**
 * @param {string} publicUrl
 * @returns {URL|undefined} Parsed URL, or undefined when malformed.
 */
function safeUrl(publicUrl) {
  if (typeof publicUrl !== 'string' || !publicUrl) return undefined;
  try {
    return new URL(publicUrl);
  } catch {
    return undefined;
  }
}

/**
 * Check whether a pid is currently alive.
 *
 * `EPERM` means the process exists but is not inspectable — treated as alive
 * (fail open on liveness only; the watchdog exits when the host is gone).
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {{code?: string}} */ (error)?.code === 'EPERM';
  }
}

/**
 * Runtime facade consumed by {@link createControlServer}. Exported so the
 * wiring can be exercised without spawning the full sidecar.
 *
 * @param {{
 *   env: ReturnType<typeof readSidecarEnv>,
 *   initialConfig: ReturnType<typeof normalizeConfig>,
 *   configStore: ReturnType<typeof createConfigStore>,
 *   devices: Awaited<ReturnType<typeof createDeviceStore>>,
 *   pairing: ReturnType<typeof createPairingService>,
 *   logger: ReturnType<typeof createLogger>,
 *   ensureTunnel: () => Promise<ReturnType<typeof createTunnelManager>>,
 *   getTunnel: () => ReturnType<typeof createTunnelManager>|null,
 *   getPublicOrigin: () => URL|undefined,
 *   setPublicOrigin: (origin: URL|undefined) => void,
 *   getCloudflaredPath: () => string|undefined,
 *   getGatewayPort?: () => number,
 *   rebindGateway?: (port: number) => Promise<number>,
 *   startedAt?: number,
 *   now?: () => number,
 * }} deps
 * @returns {Record<string, Function>}
 */
export function createSidecarRuntime(deps) {
  const {
    env,
    configStore,
    devices,
    pairing,
    logger,
    ensureTunnel,
    getTunnel,
    getPublicOrigin,
    setPublicOrigin,
    getCloudflaredPath,
    getGatewayPort = () => 0,
    rebindGateway,
    startedAt = Date.now(),
    now = Date.now,
  } = deps;

  /** @type {ReturnType<typeof normalizeConfig>} */
  let config = deps.initialConfig ?? { ...CONFIG_DEFAULTS };
  /** @type {'quick'|'named'|null} */
  let lastTransport = null;
  /** @type {{transport: 'quick'|'named'}|null} */
  let pendingStart = null;
  /** @type {string|undefined} */
  let bootError;

  /**
   * @param {string|undefined} publicUrl
   * @returns {{state: string, code?: string, url?: string, expiresAt?: number, consumedAt?: number}}
   */
  function pairingSnapshot(publicUrl) {
    const peek = pairing.peek();
    if (peek && peek.state === 'active' && peek.ticket) {
      /** @type {{state: string, code?: string, url?: string, expiresAt?: number}} */
      const snapshot = { state: 'active' };
      if (typeof peek.ticket.code === 'string') snapshot.code = peek.ticket.code;
      if (typeof peek.ticket.expiresAt === 'number') snapshot.expiresAt = peek.ticket.expiresAt;
      if (publicUrl) snapshot.url = `${publicUrl}/pair#s=${peek.ticket.secret}`;
      return snapshot;
    }
    if (peek && peek.state === 'consumed') {
      return { state: 'consumed', consumedAt: peek.consumedAt };
    }
    if (peek && peek.state === 'expired') {
      return { state: 'expired', expiresAt: peek.expiresAt };
    }
    return { state: 'none' };
  }

  /** @returns {string|undefined} Currently advertised public URL, if any. */
  function currentPublicUrl() {
    const tunnel = getTunnel();
    return tunnel ? tunnel.status().publicUrl : undefined;
  }

  /** @returns {object} Contract section 9 status payload. */
  function status() {
    const tunnel = getTunnel();
    const tunnelStatus = tunnel
      ? tunnel.status()
      : { phase: pendingStart ? 'starting' : 'idle', reconnects: 0 };
    const publicUrl = tunnelStatus.publicUrl;
    const phase = tunnelStatus.phase;
    const activeTransport = pendingStart?.transport ?? lastTransport ?? config.transport;
    /** @type {Record<string, any>} */
    const payload = {
      running: phase === 'starting' || phase === 'ready' || phase === 'reconnecting',
      phase,
      transport: activeTransport,
      version: env.version,
      gatewayPort: getGatewayPort(),
      devices: devices.list(),
      pairing: pairingSnapshot(publicUrl),
      edge: {
        ready: phase === 'ready',
        reconnects: tunnelStatus.reconnects ?? 0,
      },
    };
    if (publicUrl) payload.publicUrl = publicUrl;
    if (tunnelStatus.startedAt !== undefined) payload.edge.since = tunnelStatus.startedAt;
    const lastError = tunnelStatus.lastError ?? bootError;
    if (lastError) {
      payload.lastError = lastError;
      payload.edge.lastError = lastError;
    }
    return payload;
  }

  return {
    status,

    /**
     * Start a tunnel using explicit settings or the saved configuration.
     *
     * @param {{transport?: string, namedToken?: string, publicUrl?: string}} [payload]
     * @returns {Promise<object>} The new status.
     */
    async start(payload = {}) {
      const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      /** @type {Record<string, unknown>} */
      const requested = { ...config };
      if (record.transport !== undefined) requested.transport = record.transport;
      if (record.namedToken !== undefined) requested.namedToken = record.namedToken;
      if (record.publicUrl !== undefined) requested.publicUrl = record.publicUrl;
      if (record.gatewayPort !== undefined) requested.gatewayPort = record.gatewayPort;
      const merged = normalizeConfig(requested);
      if (merged.transport === 'named' && !merged.namedToken) {
        throw codedError('invalid-settings', 'namedToken is required for the named transport');
      }

      // Switching to a fixed port requires rebinding before the Named Tunnel
      // starts; a running tunnel must be stopped first.
      const existing = getTunnel();
      const existingPhase = existing ? existing.status().phase : 'idle';
      if (existingPhase !== 'idle') {
        throw codedError('already-running', '远程访问已在运行，请先停止再修改传输配置');
      }
      if (merged.gatewayPort !== 0 && merged.gatewayPort !== getGatewayPort()) {
        if (typeof rebindGateway !== 'function') {
          throw codedError('internal', 'gateway rebind is unavailable');
        }
        await rebindGateway(merged.gatewayPort);
      }

      pendingStart = { transport: merged.transport };
      try {
        const tunnel = await ensureTunnel();
        const settings = merged.transport === 'quick'
          ? { transport: 'quick' }
          : { transport: 'named', namedToken: merged.namedToken, publicUrl: merged.publicUrl };
        const { publicUrl } = await tunnel.start(settings);
        setPublicOrigin(safeUrl(publicUrl));
        lastTransport = merged.transport;
        bootError = undefined;
        config = await configStore.set(merged);
        logger.info('runtime.started', { transport: merged.transport, publicUrl });
        return status();
      } catch (error) {
        setPublicOrigin(undefined);
        bootError = error instanceof Error ? error.message : String(error);
        logger.error('runtime.start-failed', { error });
        throw error;
      } finally {
        pendingStart = null;
      }
    },

    /**
     * Clear the advertised origin first, then stop the tunnel.
     *
     * @returns {Promise<object>} The new status.
     */
    async stop() {
      setPublicOrigin(undefined);
      lastTransport = null;
      const tunnel = getTunnel();
      if (tunnel) await tunnel.stop();
      logger.info('runtime.stopped');
      return status();
    },

    /**
     * Issue a fresh one-time pairing ticket.
     *
     * @returns {{code: string, url: string|undefined, expiresAt: number}}
     */
    pairingRotate() {
      const ticket = pairing.issue();
      const publicUrl = currentPublicUrl();
      const url = publicUrl ? `${publicUrl}/pair#s=${ticket.secret}` : undefined;
      logger.info('runtime.pairing-rotated', { expiresAt: ticket.expiresAt, hasUrl: Boolean(url) });
      return { code: ticket.code, url, expiresAt: ticket.expiresAt };
    },

    /** @returns {object} Current pairing view (never includes the secret). */
    pairingStatus() {
      return pairingSnapshot(currentPublicUrl());
    },

    /** @returns {object[]} Known devices (tokens are never included). */
    devices() {
      return devices.list();
    },

    /**
     * @param {string} id Device id.
     * @returns {Promise<{revoked: boolean}>}
     */
    async revoke(id) {
      // `devices.revoke()` is a Promise in the device-store implementation
      // (contract-shape tolerant: awaiting a boolean is harmless).
      const revoked = await devices.revoke(id);
      logger.info('runtime.device-revoked', { id, revoked });
      return { revoked: Boolean(revoked) };
    },

    /** @returns {Promise<{revokedAll: true}>} */
    async revokeAll() {
      await devices.revokeAll();
      logger.info('runtime.devices-revoked-all');
      return { revokedAll: true };
    },

    /** @returns {Promise<object>} Persisted configuration. */
    configGet() {
      return configStore.get();
    },

    /**
     * Merge and persist a configuration patch.
     *
     * @param {object} patch
     * @returns {Promise<object>} Persisted configuration.
     */
    async configSet(patch) {
      const record = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
      const next = normalizeConfig({ ...config, ...record });
      const tunnel = getTunnel();
      const phase = tunnel ? tunnel.status().phase : 'idle';
      const running = phase !== 'idle';
      const connectionChanged =
        next.transport !== config.transport ||
        next.namedToken !== config.namedToken ||
        next.publicUrl !== config.publicUrl ||
        next.gatewayPort !== config.gatewayPort;
      if (running && connectionChanged) {
        throw codedError('stop-first', '请先停止远程访问再修改传输配置');
      }
      config = await configStore.set(next);
      logger.info('runtime.config-updated', { transport: config.transport, gatewayPort: config.gatewayPort });
      return config;
    },

    /** @returns {object} Diagnostics payload with recent log entries. */
    diagnostics() {
      const tunnel = getTunnel();
      const tunnelStatus = tunnel ? tunnel.status() : { phase: 'idle', reconnects: 0 };
      return {
        generatedAt: now(),
        uptimeMs: Math.max(0, now() - startedAt),
        pid: process.pid,
        version: env.version,
        stateDir: env.stateDir,
        transport: lastTransport ?? config.transport,
        publicUrl: currentPublicUrl(),
        cloudflaredPath: getCloudflaredPath() ?? null,
        tunnel: tunnelStatus,
        config: {
          transport: config.transport,
          autoStart: config.autoStart,
          publicUrl: config.publicUrl,
          gatewayPort: config.gatewayPort,
        },
        logs: logger.recent(200),
      };
    },
  };
}

/**
 * Start the sidecar.
 *
 * Resolves once the control endpoint is published and the shutdown/watchdog
 * hooks are installed; the process then stays alive until a signal, a watchdog
 * trip or a fatal error.
 *
 * @param {Record<string, string|undefined>} [env] Environment (defaults to `process.env`).
 * @returns {Promise<{
 *   stateDir: string,
 *   controlPort: number,
 *   gatewayPort: number,
 *   runtime: Record<string, Function>,
 *   shutdown(code?: number, reason?: string): Promise<void>,
 * }>}
 */
export async function main(env = process.env) {
  const parsedEnv = readSidecarEnv(env);
  const startedAt = Date.now();

  await ensureDir(parsedEnv.stateDir);
  await ensureDir(parsedEnv.logsDir);
  const logger = createLogger({ dir: parsedEnv.logsDir, name: 'sidecar', level: parsedEnv.logLevel });
  logger.info('sidecar.boot', {
    pid: process.pid,
    version: parsedEnv.version,
    stateDir: parsedEnv.stateDir,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });

  const configStore = createConfigStore({ stateDir: parsedEnv.stateDir, logger });
  const initialConfig = await configStore.load();

  const devices = await createDeviceStore({ file: join(parsedEnv.stateDir, 'devices.json') });
  const pairing = createPairingService();

  /** @type {URL|undefined} */
  let publicOrigin;
  const getPublicOrigin = () => publicOrigin;
  const setPublicOrigin = (origin) => {
    const next = origin ?? undefined;
    const previousHref = publicOrigin ? publicOrigin.href : null;
    publicOrigin = next;
    const nextHref = next ? next.href : null;
    if (previousHref !== nextHref) {
      logger.info('gateway.public-origin', { origin: next ? next.origin : null });
    }
  };

  /**
   * Ask the DSH host broker for an authenticated launch URL.
   *
   * @param {string} origin Public origin of the tunnel.
   * @returns {Promise<string|undefined>}
   */
  async function resolveLaunchUrl(origin) {
    if (!parsedEnv.brokerUrl || !parsedEnv.brokerToken) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BROKER_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetch(parsedEnv.brokerUrl.href, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${parsedEnv.brokerToken}`,
        },
        body: JSON.stringify({ origin }),
        signal: controller.signal,
      });
      if (!response || response.ok === false) {
        logger.warn('launch-url.broker-failed', { status: response?.status });
        return undefined;
      }
      const data = await response.json().catch(() => undefined);
      const url = data && typeof data.url === 'string' ? data.url : undefined;
      if (!url) return undefined;
      const parsed = safeUrl(url);
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return undefined;
      return parsed.href;
    } catch (error) {
      logger.warn('launch-url.failed', { error });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  const gateway = createGateway({
    upstream: parsedEnv.upstream,
    devices,
    pairing,
    logger,
    getPublicOrigin,
    getLaunchUrl: resolveLaunchUrl,
  });
  /** @type {number} */
  let currentGatewayPort = 0;
  let gatewayAddress = { port: 0 };
  try {
    gatewayAddress = await gateway.start(initialConfig.gatewayPort);
  } catch (error) {
    // A fixed port can be occupied by another process. Fail closed for Named
    // Tunnels, but keep Quick Tunnels usable with a random port.
    if (initialConfig.gatewayPort === 0) throw error;
    logger.error('gateway.fixed-port-unavailable', { port: initialConfig.gatewayPort, error });
    gatewayAddress = await gateway.start(0);
  }
  currentGatewayPort = gatewayAddress.port;
  logger.info('gateway.listening', { port: gatewayAddress.port, upstream: parsedEnv.upstream.origin });

  /**
   * Rebind the gateway to a fixed port before a Named Tunnel starts.
   *
   * @param {number} port Fixed loopback port.
   * @returns {Promise<number>} The bound port.
   */
  async function rebindGateway(port) {
    if (port === currentGatewayPort) return currentGatewayPort;
    await gateway.stop();
    const address = await gateway.start(port);
    currentGatewayPort = address.port;
    // The tunnel manager captured the old port; drop it so it is recreated.
    tunnelManager = null;
    logger.info('gateway.rebound', { port: currentGatewayPort });
    return currentGatewayPort;
  }

  /** @type {string|undefined} */
  let cloudflaredPath;
  /** @type {Promise<string>|null} */
  let cloudflaredPromise = null;
  /** @type {ReturnType<typeof createTunnelManager>|null} */
  let tunnelManager = null;

  /**
   * Resolve cloudflared once (memoised) and remember its path.
   *
   * @returns {Promise<string>}
   */
  function resolveCloudflared() {
    if (!cloudflaredPromise) {
      cloudflaredPromise = ensureCloudflared({
        cacheDir: parsedEnv.cacheDir,
        explicitPath: parsedEnv.cloudflaredPath,
        logger,
      }).then(
        (resolvedPath) => {
          cloudflaredPath = resolvedPath;
          logger.info('cloudflared.ready', { path: resolvedPath });
          return resolvedPath;
        },
        (error) => {
          cloudflaredPromise = null;
          throw error;
        },
      );
    }
    return cloudflaredPromise;
  }

  /**
   * Keep the gateway origin in sync with the tunnel state (fail closed: any
   * non-ready phase clears the origin so the gateway answers 503).
   *
   * @param {import('./tunnel.js').TunnelStatus} state
   */
  function handleTunnelState(state) {
    logger.debug('tunnel.state', { state });
    if (state.phase === 'ready' && state.publicUrl) {
      setPublicOrigin(safeUrl(state.publicUrl));
    } else {
      setPublicOrigin(undefined);
    }
  }

  /** @returns {Promise<ReturnType<typeof createTunnelManager>>} */
  async function ensureTunnel() {
    if (tunnelManager) return tunnelManager;
    const resolvedPath = await resolveCloudflared();
    if (!tunnelManager) {
      tunnelManager = createTunnelManager({
        cloudflaredPath: resolvedPath,
        gatewayPort: currentGatewayPort,
        logger,
        onState: handleTunnelState,
      });
    }
    return tunnelManager;
  }

  const runtime = createSidecarRuntime({
    env: parsedEnv,
    initialConfig,
    configStore,
    devices,
    pairing,
    logger,
    ensureTunnel,
    getTunnel: () => tunnelManager,
    getPublicOrigin,
    setPublicOrigin,
    getCloudflaredPath: () => cloudflaredPath,
    getGatewayPort: () => currentGatewayPort,
    rebindGateway,
    startedAt,
  });

  const control = createControlServer({ token: parsedEnv.controlToken, runtime, logger });
  const controlAddress = await control.start();
  const controlFilePath = join(parsedEnv.stateDir, CONTROL_FILE_NAME);
  await atomicWriteJson(controlFilePath, {
    port: controlAddress.port,
    pid: process.pid,
    startedAt,
    version: parsedEnv.version,
  });
  logger.info('control.published', { port: controlAddress.port, file: controlFilePath });

  let shuttingDown = false;
  /** @type {NodeJS.Timeout|null} */
  let watchdogTimer = null;

  /**
   * Graceful shutdown: stop tunnel, gateway and control server, remove the
   * endpoint descriptor and flush logs. Never rejects.
   *
   * @param {number} [code] Process exit code.
   * @param {string} [reason] Diagnostic reason.
   * @returns {Promise<void>}
   */
  async function shutdown(code = 0, reason = 'shutdown') {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('sidecar.shutdown', { code, reason, pid: process.pid });
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    setPublicOrigin(undefined);
    try {
      if (tunnelManager) await tunnelManager.stop();
    } catch (error) {
      logger.error('sidecar.shutdown-tunnel-failed', { error });
    }
    try {
      await gateway.stop();
    } catch (error) {
      logger.error('sidecar.shutdown-gateway-failed', { error });
    }
    try {
      await control.stop();
    } catch (error) {
      logger.error('sidecar.shutdown-control-failed', { error });
    }
    await rm(controlFilePath, { force: true }).catch(() => {});
    await logger.close().catch(() => {});
    process.exit(code);
  }

  const onSigint = () => {
    void shutdown(0, 'SIGINT');
  };
  const onSigterm = () => {
    void shutdown(0, 'SIGTERM');
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  process.on('uncaughtException', (error) => {
    logger.error('sidecar.uncaught-exception', { error });
    void shutdown(1, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('sidecar.unhandled-rejection', { reason });
    void shutdown(1, 'unhandledRejection');
  });

  if (parsedEnv.hostPid && parsedEnv.hostPid !== process.pid) {
    const hostPid = parsedEnv.hostPid;
    watchdogTimer = setInterval(() => {
      if (shuttingDown) return;
      if (!isPidAlive(hostPid)) {
        logger.warn('sidecar.host-gone', { hostPid });
        void shutdown(0, 'host-gone');
      }
    }, WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref?.();
  }

  logger.info('sidecar.ready', { controlPort: controlAddress.port, gatewayPort: gatewayAddress.port });

  return {
    stateDir: parsedEnv.stateDir,
    controlPort: controlAddress.port,
    gatewayPort: gatewayAddress.port,
    runtime,
    shutdown,
  };
}

/**
 * @returns {boolean} True when this module is the process entry point.
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    // The logger may not exist yet (invalid environment), so write directly.
    try {
      process.stderr.write(`[dsh-remote-v2] sidecar failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
