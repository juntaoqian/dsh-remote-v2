/**
 * @file Cloudflare tunnel lifecycle manager (quick and named tunnels).
 *
 * Contract: `docs/contracts.md` section 7.
 *
 * Responsibilities:
 * - spawn the pinned `cloudflared` with a random loopback metrics port
 *   (`--metrics 127.0.0.1:<port>`);
 * - parse the public `https://*.trycloudflare.com` URL from cloudflared output
 *   for quick tunnels, or use the configured `https://` URL for named tunnels;
 * - consider the tunnel ready only when the metrics endpoint
 *   `GET http://127.0.0.1:<metrics>/ready` answers `200` **and** a public URL
 *   is known;
 * - reconnect with exponential backoff (1s → 30s cap) after abnormal exits,
 *   until the caller calls {@link TunnelManager.stop};
 * - kill the whole process tree on stop (Windows `taskkill /PID <pid> /T /F`,
 *   other platforms `SIGTERM`) and clean up every timer.
 *
 * @module core/tunnel
 */

import { spawn as spawnChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { resolveLogger } from './log.js';
import { normalizeHttpsPublicUrl } from './config.js';

/** Minimum random loopback metrics port. */
export const MIN_METRICS_PORT = 20_000;
/** Maximum random loopback metrics port. */
export const MAX_METRICS_PORT = 65_000;

/** Default interval between `/ready` probes. */
export const DEFAULT_READY_POLL_MS = 300;
/** Default time allowed for a tunnel to become ready. */
export const DEFAULT_READY_TIMEOUT_MS = 90_000;
/** Base reconnect delay. */
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
/** Reconnect delay cap. */
export const DEFAULT_BACKOFF_MAX_MS = 30_000;
/** Time to wait for a killed process tree to disappear. */
export const DEFAULT_STOP_TIMEOUT_MS = 5_000;

const MAX_OUTPUT_TAIL_CHARS = 8_192;
const TRY_CLOUDFLARE_URL_PATTERN = /https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com(?![a-z0-9.-])/i;

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
 * Compute the exponential reconnect delay for a 1-based attempt number.
 *
 * Attempt 1 → `base`, 2 → `2*base`, … capped at `max`.
 *
 * @param {number} attempt 1-based reconnect attempt.
 * @param {number} [baseMs] Base delay (defaults to 1000 ms).
 * @param {number} [maxMs] Cap (defaults to 30000 ms).
 * @returns {number} Delay in milliseconds.
 */
export function computeBackoffMs(attempt, baseMs = DEFAULT_BACKOFF_BASE_MS, maxMs = DEFAULT_BACKOFF_MAX_MS) {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : DEFAULT_BACKOFF_BASE_MS;
  const cap = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : DEFAULT_BACKOFF_MAX_MS;
  if (safeAttempt > 30) return cap;
  return Math.min(cap, base * 2 ** (safeAttempt - 1));
}

/**
 * Extract the first `https://*.trycloudflare.com` URL from cloudflared output.
 *
 * @param {unknown} text Raw stdout/stderr text (may be a partial line).
 * @returns {string|undefined} Lower-case public URL.
 */
export function parseTryCloudflareUrl(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const match = TRY_CLOUDFLARE_URL_PATTERN.exec(text);
  return match ? match[0].toLowerCase() : undefined;
}

/**
 * @typedef {{phase: 'idle'|'starting'|'ready'|'reconnecting'|'error', publicUrl?: string, reconnects: number, lastError?: string, startedAt?: number, metricsPort?: number}} TunnelStatus
 */

/**
 * @typedef {{transport: 'quick'} | {transport: 'named', namedToken: string, publicUrl: string}} TunnelSettings
 */

/**
 * Validate and normalise tunnel start settings.
 *
 * @param {unknown} input Raw settings object.
 * @returns {TunnelSettings}
 * @throws {Error & {code: 'invalid-settings'|'invalid-public-url'}}
 */
function normalizeSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw codedError('invalid-settings', 'settings object is required');
  }
  const record = /** @type {Record<string, unknown>} */ (input);
  if (record.transport !== 'quick' && record.transport !== 'named') {
    throw codedError('invalid-settings', 'transport must be "quick" or "named"');
  }
  if (record.transport === 'quick') return { transport: 'quick' };
  if (typeof record.namedToken !== 'string' || !record.namedToken.trim()) {
    throw codedError('invalid-settings', 'namedToken is required for the named transport');
  }
  const publicUrl = normalizeHttpsPublicUrl(record.publicUrl, { code: 'invalid-public-url' });
  return { transport: 'named', namedToken: record.namedToken.trim(), publicUrl };
}

/**
 * Wait for a child process to emit `exit`, with a bounded timeout.
 *
 * @param {any} proc Child process (or test double).
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} True when the process was observed exiting.
 */
function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (!proc || typeof proc.once !== 'function') {
      resolve(true);
      return;
    }
    if (proc.exitCode !== undefined && proc.exitCode !== null) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.removeListener?.('exit', onExit);
      } catch {
        /* ignore */
      }
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    proc.once('exit', onExit);
  });
}

/**
 * Create the tunnel manager.
 *
 * @param {{
 *   cloudflaredPath: string,
 *   gatewayPort: number,
 *   logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function},
 *   onState?: (state: TunnelStatus) => void,
 *   spawnImpl?: (command: string, args: string[], options: object) => any,
 *   now?: () => number,
 *   fetchImpl?: typeof fetch,
 *   platform?: NodeJS.Platform|string,
 *   readyPollMs?: number,
 *   readyTimeoutMs?: number,
 *   backoffBaseMs?: number,
 *   backoffMaxMs?: number,
 *   stopTimeoutMs?: number,
 *   randomPort?: () => number,
 * }} options
 * @returns {{
 *   start(settings: TunnelSettings): Promise<{publicUrl: string}>,
 *   stop(): Promise<void>,
 *   status(): TunnelStatus,
 * }}
 */
export function createTunnelManager(options) {
  const {
    cloudflaredPath,
    gatewayPort,
    onState,
    spawnImpl = spawnChildProcess,
    now = Date.now,
    fetchImpl = globalThis.fetch,
    platform = process.platform,
    readyPollMs = DEFAULT_READY_POLL_MS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    randomPort = () => randomInt(MIN_METRICS_PORT, MAX_METRICS_PORT + 1),
  } = options ?? {};

  if (typeof cloudflaredPath !== 'string' || !cloudflaredPath) {
    throw codedError('invalid-options', 'cloudflaredPath is required');
  }
  if (!Number.isInteger(gatewayPort) || gatewayPort <= 0 || gatewayPort > 65_535) {
    throw codedError('invalid-options', 'gatewayPort must be a valid TCP port number');
  }
  if (typeof spawnImpl !== 'function') {
    throw codedError('invalid-options', 'spawnImpl must be a function');
  }
  if (typeof onState !== 'undefined' && typeof onState !== 'function') {
    throw codedError('invalid-options', 'onState must be a function');
  }

  const log = resolveLogger(options?.logger);

  /** @type {'idle'|'starting'|'ready'|'reconnecting'|'error'} */
  let phase = 'idle';
  /** @type {string|undefined} */
  let publicUrl;
  let reconnects = 0;
  /** @type {string|undefined} */
  let lastError;
  /** @type {number|undefined} */
  let startedAt;
  /** @type {number|undefined} */
  let metricsPort;
  /** @type {TunnelSettings|null} */
  let settings = null;
  /** @type {any} */
  let child = null;
  let stoppedByUser = false;
  let hadReady = false;
  let attemptToken = 0;
  let stderrTail = '';
  /** @type {NodeJS.Timeout|null} */
  let readyTimer = null;
  /** @type {NodeJS.Timeout|null} */
  let reconnectTimer = null;
  /** @type {{promise: Promise<{publicUrl: string}>, resolve: Function, reject: Function, settled: boolean}|null} */
  let startWaiter = null;
  /** @type {Promise<void>|null} */
  let stoppingPromise = null;
  /** @type {Set<Promise<void>>} In-flight process-tree kills (tracked so stop() can drain them). */
  const pendingKills = new Set();

  /**
   * Track a fire-and-forget process-tree kill.
   *
   * @param {Promise<void>} promise
   * @returns {Promise<void>}
   */
  function trackKill(promise) {
    const tracked = promise.catch((error) => {
      log.warn('tunnel.kill-failed', { error });
    });
    pendingKills.add(tracked);
    void tracked.finally(() => pendingKills.delete(tracked));
    return tracked;
  }

  /**
   * @returns {TunnelStatus} Current immutable status snapshot.
   */
  function status() {
    /** @type {TunnelStatus} */
    const snapshot = { phase, reconnects };
    if (publicUrl !== undefined) snapshot.publicUrl = publicUrl;
    if (lastError !== undefined) snapshot.lastError = lastError;
    if (startedAt !== undefined) snapshot.startedAt = startedAt;
    if (metricsPort !== undefined) snapshot.metricsPort = metricsPort;
    return snapshot;
  }

  /** Notify the observer about the current state. Never throws. */
  function emit() {
    if (!onState) return;
    try {
      onState(status());
    } catch (error) {
      log.warn('tunnel.on-state-failed', { error });
    }
  }

  /**
   * @param {'idle'|'starting'|'ready'|'reconnecting'|'error'} next
   * @param {boolean} [forceEmit]
   */
  function setPhase(next, forceEmit = false) {
    const changed = phase !== next;
    phase = next;
    if (changed || forceEmit) emit();
  }

  function clearReadyTimer() {
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /** Settle a pending `start()` promise successfully (first ready only). */
  function settleStart(value) {
    const waiter = startWaiter;
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    startWaiter = null;
    waiter.resolve(value);
  }

  /** Settle a pending `start()` promise with an error. */
  function settleStartError(error) {
    const waiter = startWaiter;
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    startWaiter = null;
    waiter.reject(error);
  }

  /** @returns {string} The loopback metrics `/ready` URL for the current attempt. */
  function metricsReadyUrl() {
    return `http://127.0.0.1:${metricsPort}/ready`;
  }

  /** @returns {string[]} cloudflared arguments for the current settings. */
  function buildArgs() {
    if (!settings) throw codedError('invalid-settings', 'tunnel settings are not initialised');
    const args = settings.transport === 'quick'
      ? ['tunnel', '--url', `http://127.0.0.1:${gatewayPort}`]
      : ['tunnel', 'run', '--token', settings.namedToken];
    args.push('--metrics', `127.0.0.1:${metricsPort}`, '--no-autoupdate');
    return args;
  }

  /**
   * @param {string[]} args
   * @returns {string[]} Arguments with the tunnel token redacted for logging.
   */
  function redactArgs(args) {
    const copy = [...args];
    const tokenIndex = copy.indexOf('--token');
    if (tokenIndex >= 0 && tokenIndex + 1 < copy.length) copy[tokenIndex + 1] = '<redacted>';
    return copy;
  }

  /** Mark the current attempt as ready, settle `start()` and notify the observer. */
  function markReady() {
    clearReadyTimer();
    hadReady = true;
    setPhase('ready');
    log.info('tunnel.ready', { transport: settings?.transport, publicUrl, metricsPort });
    settleStart({ publicUrl: /** @type {string} */ (publicUrl) });
  }

  /**
   * Poll the loopback metrics endpoint until it reports ready and a public URL
   * is known, the attempt fails or the deadline elapses.
   *
   * @param {number} token Attempt token.
   */
  function scheduleReadyPoll(token) {
    clearReadyTimer();
    const deadline = now() + readyTimeoutMs;
    const poll = async () => {
      readyTimer = null;
      if (token !== attemptToken || stoppedByUser) return;
      if (!child) return; // exit/error handler owns the failure path
      let ready = false;
      try {
        const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(Math.max(1_000, readyPollMs * 4))
          : undefined;
        const response = await fetchImpl(metricsReadyUrl(), { method: 'GET', signal });
        ready = Boolean(response && response.status === 200);
      } catch {
        ready = false;
      }
      if (token !== attemptToken || stoppedByUser) return;
      if (ready && publicUrl) {
        markReady();
        return;
      }
      if (now() >= deadline) {
        failAttempt(codedError('ready-timeout', `cloudflared did not become ready within ${readyTimeoutMs} ms`));
        return;
      }
      readyTimer = setTimeout(poll, readyPollMs);
      readyTimer.unref?.();
    };
    readyTimer = setTimeout(poll, readyPollMs);
    readyTimer.unref?.();
  }

  /**
   * Attach stdout/stderr parsing for the current attempt.
   *
   * @param {any} proc Child process.
   * @param {number} token Attempt token.
   */
  function attachOutput(proc, token) {
    /** @param {unknown} chunk */
    const onChunk = (chunk) => {
      if (token !== attemptToken) return;
      const text = String(chunk ?? '');
      stderrTail = `${stderrTail}${text}`.slice(-MAX_OUTPUT_TAIL_CHARS);
      if (!settings || settings.transport !== 'quick') return;
      const url = parseTryCloudflareUrl(text) ?? parseTryCloudflareUrl(stderrTail);
      if (url && url !== publicUrl) {
        publicUrl = url;
        log.info('tunnel.public-url', { publicUrl });
        if (phase === 'ready') emit();
      }
    };
    if (proc.stderr && typeof proc.stderr.on === 'function') proc.stderr.on('data', onChunk);
    if (proc.stdout && typeof proc.stdout.on === 'function') proc.stdout.on('data', onChunk);
  }

  /**
   * Kill the cloudflared process tree, waiting (bounded) for the exit.
   *
   * @param {any} proc Child process.
   * @returns {Promise<void>}
   */
  async function killProcessTree(proc) {
    const pid = proc?.pid;
    log.info('tunnel.kill', { pid, platform, strategy: platform === 'win32' ? 'taskkill' : 'SIGTERM' });
    const exited = waitForExit(proc, stopTimeoutMs);

    if (platform === 'win32') {
      if (Number.isInteger(pid) && pid > 0) {
        try {
          const killer = spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          if (killer && typeof killer.on === 'function') {
            killer.on('error', (error) => log.warn('tunnel.taskkill-failed', { error }));
          }
          killer?.unref?.();
        } catch (error) {
          log.warn('tunnel.taskkill-spawn-failed', { error });
          try {
            proc?.kill?.('SIGKILL');
          } catch {
            /* ignore */
          }
        }
      } else {
        try {
          proc?.kill?.();
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        proc?.kill?.('SIGTERM');
      } catch (error) {
        log.warn('tunnel.sigterm-failed', { error });
      }
    }

    const didExit = await exited;
    if (!didExit) {
      log.warn('tunnel.kill-timeout', { pid, stopTimeoutMs });
      try {
        proc?.kill?.('SIGKILL');
      } catch {
        /* ignore */
      }
      await waitForExit(proc, 1_000);
    }
  }

  /** Schedule an exponential-backoff reconnect attempt. */
  function scheduleReconnect() {
    clearReconnectTimer();
    clearReadyTimer();
    reconnects += 1;
    const delayMs = computeBackoffMs(reconnects, backoffBaseMs, backoffMaxMs);
    log.info('tunnel.reconnect-scheduled', { attempt: reconnects, delayMs });
    emit();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stoppedByUser || stoppingPromise) return;
      spawnAttempt();
    }, delayMs);
    reconnectTimer.unref?.();
  }

  /**
   * Handle a failed attempt (spawn error, readiness timeout, cloudflared error
   * event): abandon the process, settle/reconnect and log the cause.
   *
   * @param {unknown} error
   */
  function failAttempt(error) {
    const normalized = error instanceof Error
      ? error
      : codedError('tunnel-error', String(error));
    clearReadyTimer();
    attemptToken += 1;
    const proc = child;
    child = null;
    if (proc) trackKill(killProcessTree(proc));
    lastError = normalized.message;
    log.error('tunnel.attempt-failed', {
      code: /** @type {{code?: string}} */ (normalized).code,
      message: normalized.message,
      stderr: stderrTail.slice(-2_000),
    });
    if (!hadReady) {
      setPhase('error');
      settleStartError(normalized);
      return;
    }
    setPhase('reconnecting');
    scheduleReconnect();
  }

  /**
   * Spawn one cloudflared attempt.
   *
   * @returns {void}
   */
  function spawnAttempt() {
    if (!settings) return;
    const token = ++attemptToken;
    metricsPort = randomPort();
    stderrTail = '';
    if (settings.transport === 'named') publicUrl = settings.publicUrl;
    log.info('tunnel.spawn', {
      transport: settings.transport,
      metricsPort,
      args: redactArgs(buildArgs()),
    });
    let proc;
    try {
      proc = spawnImpl(cloudflaredPath, buildArgs(), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      failAttempt(error instanceof Error ? error : codedError('spawn-failed', String(error)));
      return;
    }
    if (!proc || typeof proc.on !== 'function') {
      failAttempt(codedError('spawn-failed', 'spawnImpl did not return a ChildProcess-like object'));
      return;
    }
    child = proc;
    attachOutput(proc, token);
    proc.on('error', (error) => {
      if (token !== attemptToken) return;
      failAttempt(error instanceof Error ? error : codedError('spawn-failed', String(error)));
    });
    proc.on('exit', (code, signal) => {
      if (token !== attemptToken) return;
      attemptToken += 1;
      clearReadyTimer();
      child = null;
      const description = `cloudflared exited (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})`;
      lastError = description;
      log.warn('tunnel.exited', { code, signal, stderr: stderrTail.slice(-2_000) });
      if (!hadReady) {
        setPhase('error');
        settleStartError(codedError('cloudflared-exited', description));
        return;
      }
      setPhase('reconnecting');
      scheduleReconnect();
    });
    scheduleReadyPoll(token);
  }

  /**
   * Start (or restart) a tunnel.
   *
   * @param {TunnelSettings} rawSettings
   * @returns {Promise<{publicUrl: string}>} Resolves once the tunnel is ready.
   * @throws {Error} `invalid-settings`, `invalid-public-url`, `ready-timeout`,
   *   `cloudflared-exited`, `spawn-failed`, `stopped`.
   */
  async function start(rawSettings) {
    const nextSettings = normalizeSettings(rawSettings);
    if (stoppingPromise) await stoppingPromise;
    if (child || phase === 'starting' || phase === 'ready' || phase === 'reconnecting') {
      await stop();
    }

    stoppedByUser = false;
    settings = nextSettings;
    reconnects = 0;
    startedAt = now();
    publicUrl = nextSettings.transport === 'named' ? nextSettings.publicUrl : undefined;
    lastError = undefined;
    metricsPort = undefined;
    hadReady = false;
    attemptToken += 1;

    const waiter = {
      /** @type {Promise<{publicUrl: string}>} */
      promise: /** @type {any} */ (null),
      /** @type {(value: {publicUrl: string}) => void} */
      resolve: () => {},
      /** @type {(error: Error) => void} */
      reject: () => {},
      settled: false,
    };
    waiter.promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    startWaiter = /** @type {any} */ (waiter);

    setPhase('starting');
    spawnAttempt();
    return waiter.promise;
  }

  /**
   * Stop the tunnel, kill the process tree and clear every timer.
   * Idempotent; never reconnects afterwards until `start()` is called again.
   *
   * @returns {Promise<void>}
   */
  function stop() {
    if (stoppingPromise) return stoppingPromise;
    stoppingPromise = (async () => {
      stoppedByUser = true;
      clearReadyTimer();
      clearReconnectTimer();
      const proc = child;
      child = null;
      attemptToken += 1;
      settleStartError(codedError('stopped', 'tunnel stopped before becoming ready'));
      if (proc) await killProcessTree(proc);
      if (pendingKills.size > 0) await Promise.allSettled([...pendingKills]);
      metricsPort = undefined;
      publicUrl = undefined;
      startedAt = undefined;
      settings = null;
      // `lastError` is intentionally retained so diagnostics can explain why the
      // tunnel stopped; it is cleared by the next successful start().
      setPhase('idle');
      log.info('tunnel.stopped');
    })().finally(() => {
      stoppingPromise = null;
      stoppedByUser = false;
    });
    return stoppingPromise;
  }

  return { start, stop, status };
}
