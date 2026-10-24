/**
 * @file Configuration, state-directory, environment and atomic-file helpers
 * for the dsh-remote-v2 sidecar.
 *
 * Contract: `docs/contracts.md` sections 1, 9 and 12.
 *
 * All helpers use Node built-ins only (no npm dependencies) and are ESM.
 * Every validation failure throws an `Error` carrying a stable `code`
 * property, per the repository-wide error convention.
 *
 * @module core/config
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Transport flavours supported by the sidecar. @typedef {'quick'|'named'} Transport */

/** Default persisted configuration (contract section 12). @type {Readonly<{transport: Transport, namedToken: string, publicUrl: string, autoStart: boolean}>} */
export const CONFIG_DEFAULTS = Object.freeze({
  transport: /** @type {Transport} */ ('quick'),
  namedToken: '',
  publicUrl: '',
  autoStart: false,
});

/** Default state directory, relative to the user's home directory. */
export const DEFAULT_STATE_DIR_NAME = join('.dsh', 'plugins', 'dsh-remote-v2');

/** Default file name (inside the state dir) for the control endpoint descriptor. */
export const CONTROL_FILE_NAME = 'control.json';

/** Default file name for the persisted configuration. */
export const CONFIG_FILE_NAME = 'config.json';

const MAX_TOKEN_CHARS = 8192;
const MAX_URL_CHARS = 2048;

/**
 * Create an `Error` with a stable machine-readable `code`.
 *
 * @param {string} code Machine-readable error code (e.g. `invalid-config`).
 * @param {string} message Human-readable message (safe to surface locally).
 * @param {{cause?: unknown}} [options] Optional `Error` options.
 * @returns {Error & {code: string}}
 */
export function createConfigError(code, message, options) {
  const error = /** @type {Error & {code: string}} */ (new Error(message, options));
  error.code = code;
  return error;
}

/**
 * Resolve the sidecar state directory from the environment.
 *
 * `DSH_REMOTE_V2_STATE_DIR` is contractually an absolute path; a relative value
 * is resolved against the current working directory so a misconfigured host
 * still produces a predictable location instead of throwing at boot.
 *
 * @param {Record<string, string|undefined>} [env] Environment map (defaults to `process.env`).
 * @param {string} [home] Home directory override (test seam).
 * @returns {string} Absolute state-directory path.
 */
export function resolveStateDir(env = process.env, home = homedir()) {
  const raw = env.DSH_REMOTE_V2_STATE_DIR;
  if (typeof raw === 'string' && raw.trim()) {
    return isAbsolute(raw.trim()) ? raw.trim() : resolve(raw.trim());
  }
  return join(home, DEFAULT_STATE_DIR_NAME);
}

/**
 * Validate and normalise an `https` public URL for a named tunnel.
 *
 * Credentials, query strings and fragments are rejected (they would corrupt
 * host/pairing URLs built from this value). A single trailing slash is removed
 * so callers can append `/pair` safely.
 *
 * @param {unknown} raw Candidate URL.
 * @param {{code?: string}} [options] Error code to throw (defaults to `invalid-config`).
 * @returns {string} Normalised absolute `https://` URL without a trailing slash.
 */
export function normalizeHttpsPublicUrl(raw, options = {}) {
  const code = options.code ?? 'invalid-config';
  if (typeof raw !== 'string' || !raw.trim()) {
    throw createConfigError(code, 'publicUrl must be a non-empty https URL');
  }
  if (raw.length > MAX_URL_CHARS) {
    throw createConfigError(code, `publicUrl must be at most ${MAX_URL_CHARS} characters`);
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch (error) {
    throw createConfigError(code, 'publicUrl must be an absolute https URL', { cause: error });
  }
  if (url.protocol !== 'https:') {
    throw createConfigError(code, 'publicUrl must use the https: scheme');
  }
  if (!url.hostname) {
    throw createConfigError(code, 'publicUrl must include a hostname');
  }
  if (url.username || url.password) {
    throw createConfigError(code, 'publicUrl must not embed credentials');
  }
  if (url.search) {
    throw createConfigError(code, 'publicUrl must not contain a query string');
  }
  if (url.hash) {
    throw createConfigError(code, 'publicUrl must not contain a fragment');
  }
  const href = url.href.endsWith('/') ? url.href.slice(0, -1) : url.href;
  return href;
}

/**
 * Validate and normalise a configuration object, merging absolute defaults.
 *
 * Unknown keys are intentionally dropped so an older/newer client cannot smuggle
 * arbitrary values into `config.json`.
 *
 * @param {unknown} input Raw configuration object.
 * @returns {{transport: Transport, namedToken: string, publicUrl: string, autoStart: boolean}}
 * @throws {Error & {code: 'invalid-config'}} When a field is invalid.
 */
export function normalizeConfig(input = {}) {
  if (input === null || input === undefined) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw createConfigError('invalid-config', 'config must be a plain object');
  }
  const record = /** @type {Record<string, unknown>} */ (input);

  const transport = record.transport === undefined ? CONFIG_DEFAULTS.transport : record.transport;
  if (transport !== 'quick' && transport !== 'named') {
    throw createConfigError('invalid-config', 'transport must be "quick" or "named"');
  }

  const rawNamedToken = record.namedToken === undefined ? '' : record.namedToken;
  if (typeof rawNamedToken !== 'string') {
    throw createConfigError('invalid-config', 'namedToken must be a string');
  }
  if (rawNamedToken.length > MAX_TOKEN_CHARS) {
    throw createConfigError('invalid-config', `namedToken must be at most ${MAX_TOKEN_CHARS} characters`);
  }

  const rawPublicUrl = record.publicUrl === undefined ? '' : record.publicUrl;
  if (typeof rawPublicUrl !== 'string') {
    throw createConfigError('invalid-config', 'publicUrl must be a string');
  }
  const publicUrl = rawPublicUrl.trim() ? normalizeHttpsPublicUrl(rawPublicUrl) : '';

  const rawAutoStart = record.autoStart === undefined ? CONFIG_DEFAULTS.autoStart : record.autoStart;
  if (typeof rawAutoStart !== 'boolean') {
    throw createConfigError('invalid-config', 'autoStart must be a boolean');
  }

  return {
    transport: /** @type {Transport} */ (transport),
    namedToken: rawNamedToken.trim(),
    publicUrl,
    autoStart: rawAutoStart,
  };
}

/**
 * Create the directory (recursive) with owner-only permissions by default.
 *
 * @param {string} dir Absolute directory path.
 * @param {{mode?: number}} [options] Creation mode (defaults to `0o700`).
 * @returns {Promise<string>} The directory path.
 */
export async function ensureDir(dir, options = {}) {
  const mode = options.mode ?? 0o700;
  await mkdir(dir, { recursive: true, mode });
  return dir;
}

/**
 * Atomically write a file: write a uniquely named temporary sibling, fsync-free
 * `rename` into place, and clean the temporary file on failure.
 *
 * `rename(2)`/`MoveFileExW` replace the destination atomically on the same
 * volume, so a reader never observes a partially written file.
 *
 * @param {string} filePath Absolute destination path.
 * @param {string|Buffer|Uint8Array} data File contents.
 * @param {{mode?: number, encoding?: BufferEncoding}} [options] Creation mode (defaults to `0o600`).
 * @returns {Promise<string>} The destination path.
 */
export async function atomicWriteFile(filePath, data, options = {}) {
  const mode = options.mode ?? 0o600;
  const encoding = options.encoding ?? 'utf8';
  await ensureDir(dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(tmpPath, data, { mode, flag: 'wx', encoding });
    await rename(tmpPath, filePath);
    return filePath;
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Atomically write a JSON document with a trailing newline and `0o600` mode.
 *
 * @param {string} filePath Absolute destination path.
 * @param {unknown} value JSON-serialisable value.
 * @param {{mode?: number}} [options] Creation mode (defaults to `0o600`).
 * @returns {Promise<string>} The destination path.
 */
export function atomicWriteJson(filePath, value, options = {}) {
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: options.mode ?? 0o600,
  });
}

/**
 * Read and parse a JSON file.
 *
 * @param {string} filePath Absolute JSON file path.
 * @param {{fallback?: unknown}} [options] Value returned when the file does not exist.
 * @returns {Promise<any>} Parsed JSON, or `options.fallback` on `ENOENT`.
 * @throws {Error & {code: 'invalid-json'}} When the file exists but is not valid JSON.
 */
export async function readJsonFile(filePath, options = {}) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (/** @type {{code?: string}} */ (error).code === 'ENOENT') return options.fallback;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw createConfigError('invalid-json', `invalid JSON in ${filePath}`, { cause: error });
  }
}

/**
 * Persisted configuration store backed by `<stateDir>/config.json`.
 *
 * A missing file yields {@link CONFIG_DEFAULTS}. A corrupt file is logged and
 * treated as defaults (never an insecure configuration) until the next `set()`.
 *
 * @param {{stateDir: string, file?: string, logger?: {warn?: Function}}} [options]
 * @returns {{load(): Promise<object>, get(): Promise<object>, set(patch: object): Promise<object>, path: string}}
 */
export function createConfigStore(options = {}) {
  const stateDir = options.stateDir;
  if (typeof stateDir !== 'string' || !stateDir) {
    throw createConfigError('invalid-config-store', 'stateDir is required');
  }
  const file = options.file ?? join(stateDir, CONFIG_FILE_NAME);
  const logger = options.logger && typeof options.logger.warn === 'function' ? options.logger : null;

  /** @type {ReturnType<typeof normalizeConfig>} */
  let current = { ...CONFIG_DEFAULTS };
  let loaded = false;
  /** @type {Promise<void>|null} */
  let loading = null;

  async function ensureLoaded() {
    if (loaded) return;
    if (!loading) {
      loading = (async () => {
        try {
          const raw = await readJsonFile(file, { fallback: null });
          if (raw !== null && raw !== undefined) current = normalizeConfig(raw);
        } catch (error) {
          if (logger) logger.warn('config.load-failed', { file, error });
          current = { ...CONFIG_DEFAULTS };
        } finally {
          loaded = true;
        }
      })();
    }
    await loading;
  }

  return {
    path: file,

    /** Load the persisted configuration once. @returns {Promise<object>} */
    async load() {
      await ensureLoaded();
      return { ...current };
    },

    /** @returns {Promise<object>} A defensive copy of the current configuration. */
    async get() {
      await ensureLoaded();
      return { ...current };
    },

    /**
     * Merge a partial configuration, validate it and persist atomically.
     *
     * @param {object} patch Partial configuration fields.
     * @returns {Promise<object>} The persisted configuration.
     * @throws {Error & {code: 'invalid-config'}} When the merged configuration is invalid.
     */
    async set(patch) {
      await ensureLoaded();
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw createConfigError('invalid-config', 'config patch must be a plain object');
      }
      const merged = normalizeConfig({ ...current, ...patch });
      await atomicWriteJson(file, merged);
      current = merged;
      return { ...current };
    },
  };
}

/**
 * Validate and normalise the sidecar environment (contract section 1).
 *
 * Extensions (not part of the frozen contract, all optional):
 * - `DSH_REMOTE_V2_CLOUDFLARED`: explicit cloudflared executable path.
 * - `DSH_REMOTE_V2_LOG_LEVEL`: `debug|info|warn|error`.
 *
 * @param {Record<string, string|undefined>} [env] Environment map (defaults to `process.env`).
 * @param {{home?: string}} [options] Test seam for the home directory.
 * @returns {{
 *   stateDir: string,
 *   logsDir: string,
 *   cacheDir: string,
 *   upstream: URL,
 *   controlToken: string,
 *   brokerUrl: URL|undefined,
 *   brokerToken: string|undefined,
 *   pluginRoot: string|undefined,
 *   version: string,
 *   hostPid: number|undefined,
 *   cloudflaredPath: string|undefined,
 *   logLevel: string,
 * }}
 * @throws {Error & {code: 'invalid-env'}} When required variables are missing or malformed.
 */
export function readSidecarEnv(env = process.env, options = {}) {
  const home = options.home ?? homedir();
  const stateDir = resolveStateDir(env, home);

  const upstreamRaw = env.DSH_REMOTE_V2_UPSTREAM;
  if (typeof upstreamRaw !== 'string' || !upstreamRaw.trim()) {
    throw createConfigError('invalid-env', 'DSH_REMOTE_V2_UPSTREAM is required');
  }
  let upstream;
  try {
    upstream = new URL(upstreamRaw.trim());
  } catch (error) {
    throw createConfigError('invalid-env', 'DSH_REMOTE_V2_UPSTREAM must be an absolute URL', { cause: error });
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw createConfigError('invalid-env', 'DSH_REMOTE_V2_UPSTREAM must use http: or https:');
  }

  const controlToken = env.DSH_REMOTE_V2_CONTROL_TOKEN;
  if (typeof controlToken !== 'string' || controlToken.trim().length < 16) {
    throw createConfigError(
      'invalid-env',
      'DSH_REMOTE_V2_CONTROL_TOKEN is required (at least 16 characters, 32 random bytes expected)',
    );
  }

  const brokerUrlRaw = env.DSH_REMOTE_V2_BROKER_URL;
  let brokerUrl;
  if (typeof brokerUrlRaw === 'string' && brokerUrlRaw.trim()) {
    try {
      brokerUrl = new URL(brokerUrlRaw.trim());
    } catch (error) {
      throw createConfigError('invalid-env', 'DSH_REMOTE_V2_BROKER_URL must be an absolute URL', { cause: error });
    }
    if (brokerUrl.protocol !== 'http:' || !isLoopbackHostname(brokerUrl.hostname)) {
      throw createConfigError('invalid-env', 'DSH_REMOTE_V2_BROKER_URL must be a loopback http URL');
    }
  }

  const brokerToken = typeof env.DSH_REMOTE_V2_BROKER_TOKEN === 'string' && env.DSH_REMOTE_V2_BROKER_TOKEN.trim()
    ? env.DSH_REMOTE_V2_BROKER_TOKEN.trim()
    : undefined;
  if (brokerUrl && !brokerToken) {
    throw createConfigError('invalid-env', 'DSH_REMOTE_V2_BROKER_TOKEN is required when a broker URL is configured');
  }

  let hostPid;
  const hostPidRaw = env.DSH_REMOTE_V2_HOST_PID;
  if (typeof hostPidRaw === 'string' && hostPidRaw.trim()) {
    const parsed = Number.parseInt(hostPidRaw.trim(), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw createConfigError('invalid-env', 'DSH_REMOTE_V2_HOST_PID must be a positive integer');
    }
    hostPid = parsed;
  }

  const pluginRoot = typeof env.DSH_REMOTE_V2_PLUGIN_ROOT === 'string' && env.DSH_REMOTE_V2_PLUGIN_ROOT.trim()
    ? resolve(env.DSH_REMOTE_V2_PLUGIN_ROOT.trim())
    : undefined;
  const version = typeof env.DSH_REMOTE_V2_VERSION === 'string' && env.DSH_REMOTE_V2_VERSION.trim()
    ? env.DSH_REMOTE_V2_VERSION.trim()
    : '0.1.0';
  const logLevel = typeof env.DSH_REMOTE_V2_LOG_LEVEL === 'string' && env.DSH_REMOTE_V2_LOG_LEVEL.trim()
    ? env.DSH_REMOTE_V2_LOG_LEVEL.trim()
    : 'info';
  const cloudflaredPath = typeof env.DSH_REMOTE_V2_CLOUDFLARED === 'string' && env.DSH_REMOTE_V2_CLOUDFLARED.trim()
    ? resolve(env.DSH_REMOTE_V2_CLOUDFLARED.trim())
    : undefined;

  return {
    stateDir,
    logsDir: join(stateDir, 'logs'),
    cacheDir: pluginRoot ? join(pluginRoot, 'bin') : join(stateDir, 'bin'),
    upstream,
    controlToken,
    brokerUrl,
    brokerToken,
    pluginRoot,
    version,
    hostPid,
    cloudflaredPath,
    logLevel,
  };
}

/**
 * @param {string} hostname
 * @returns {boolean} True for loopback host names.
 */
export function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}
