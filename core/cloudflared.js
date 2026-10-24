/**
 * @file Locate, verify or download the pinned `cloudflared` binary.
 *
 * Contract: `docs/contracts.md` section 6.
 *
 * Resolution order:
 *   1. explicit caller-provided path;
 *   2. `cloudflared` on `PATH` — accepted only when `--version` matches the
 *      pinned version;
 *   3. cached file whose SHA-256 matches the pinned digest;
 *   4. official GitHub release download, SHA-256 verified, atomically cached.
 *
 * The MVP only guarantees Windows x64; every other platform fails closed with
 * `code: 'unsupported-platform'`. The platform/arch and command seams exist so
 * the logic is unit-testable without network access or a real cloudflared.
 *
 * @module core/cloudflared
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

/** Pinned cloudflared release (contract constant). */
export const CLOUDFLARED_VERSION = '2026.8.2';

/** Pinned SHA-256 of `cloudflared-windows-amd64.exe` for {@link CLOUDFLARED_VERSION}. */
export const WIN32_X64_SHA256 = 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5';

/** Release asset file name for the supported platform. */
export const CLOUDFLARED_ASSET = 'cloudflared-windows-amd64.exe';

/** Official release download URL for the pinned version. */
export const CLOUDFLARED_DOWNLOAD_URL =
  `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${CLOUDFLARED_ASSET}`;

/** File name used inside the cache directory. */
export const CACHE_FILE_NAME = 'cloudflared.exe';

const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 15_000;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const VERSION_OUT = /cloudflared\s+version\s+([0-9][0-9A-Za-z.\-+]*)/i;

const execFileAsync = promisify(execFileCallback);

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
 * Compute the lower-case hex SHA-256 of a buffer.
 *
 * @param {Uint8Array|string} data
 * @returns {string} 64-character lower-case hex digest.
 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute the lower-case hex SHA-256 of a file.
 *
 * @param {string} filePath
 * @returns {Promise<string>} 64-character lower-case hex digest.
 */
export async function sha256File(filePath) {
  return sha256Hex(await readFile(filePath));
}

/**
 * Timing-safe comparison of two hex digests (case-insensitive).
 *
 * @param {string} expected
 * @param {string} actual
 * @returns {boolean}
 */
function digestsEqual(expected, actual) {
  const a = Buffer.from(String(expected).toLowerCase(), 'utf8');
  const b = Buffer.from(String(actual).toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Assert the runtime platform is supported by this build.
 *
 * @param {NodeJS.Platform|string} platform
 * @param {string} arch
 * @returns {void}
 * @throws {Error & {code: 'unsupported-platform'}}
 */
export function assertSupportedPlatform(platform, arch) {
  if (platform === 'win32' && arch === 'x64') return;
  throw codedError(
    'unsupported-platform',
    `cloudflared is only managed on win32-x64 by this build (got ${platform}-${arch})`,
  );
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>} True when `filePath` is an existing regular file.
 */
async function isFile(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Default `PATH` lookup: `where cloudflared` on Windows, `which -a` elsewhere.
 *
 * @param {string} command
 * @param {NodeJS.Platform|string} platform
 * @returns {Promise<string[]>} Candidate absolute paths (may be empty).
 */
async function defaultWhich(command, platform = process.platform) {
  const args = platform === 'win32' ? [command] : ['-a', command];
  const binary = platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(binary, args, { timeout: VERSION_TIMEOUT_MS, windowsHide: true });
    return String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Default `--version` probe.
 *
 * @param {string} executable
 * @returns {Promise<string>} Combined stdout/stderr output.
 */
async function defaultExecVersion(executable) {
  const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
    timeout: VERSION_TIMEOUT_MS,
    windowsHide: true,
  });
  return `${stdout ?? ''}\n${stderr ?? ''}`;
}

/**
 * Search `PATH` for a cloudflared matching the pinned version.
 *
 * @param {{
 *   platform: NodeJS.Platform|string,
 *   whichImpl: (command: string, platform: NodeJS.Platform|string) => Promise<string[]>,
 *   execVersionImpl: (executable: string) => Promise<string>,
 *   logger: {info?: Function, warn?: Function},
 * }} options
 * @returns {Promise<string|undefined>} Absolute path of a matching binary.
 */
async function findOnPath(options) {
  const { platform, whichImpl, execVersionImpl, logger } = options;
  const candidates = await whichImpl('cloudflared', platform).catch(() => []);
  for (const candidate of candidates) {
    const raw = typeof candidate === 'string' ? candidate.trim() : '';
    if (!raw) continue;
    const absolute = isAbsolute(raw) ? raw : resolve(raw);
    if (!(await isFile(absolute))) continue;
    let output;
    try {
      output = await execVersionImpl(absolute);
    } catch (error) {
      if (logger.warn) logger.warn('cloudflared.version-probe-failed', { path: absolute, error });
      continue;
    }
    const match = VERSION_OUT.exec(String(output ?? ''));
    const foundVersion = match ? match[1] : undefined;
    if (foundVersion === CLOUDFLARED_VERSION) {
      if (logger.info) logger.info('cloudflared.found-on-path', { path: absolute, version: foundVersion });
      return absolute;
    }
    if (logger.warn) {
      logger.warn('cloudflared.version-mismatch', {
        path: absolute,
        found: foundVersion ?? 'unknown',
        required: CLOUDFLARED_VERSION,
      });
    }
  }
  return undefined;
}

/**
 * Read a fetch `Response` body into a Buffer without relying on a single
 * runtime implementation (tests may inject a minimal stub).
 *
 * @param {any} response Fetch response.
 * @returns {Promise<Buffer>}
 */
async function readResponseBytes(response) {
  if (response && typeof response.arrayBuffer === 'function') {
    return Buffer.from(await response.arrayBuffer());
  }
  if (response && typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    /** @type {Buffer[]} */
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  if (response && response[Symbol.asyncIterator]) {
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const chunk of response) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw codedError('download-failed', 'download response did not expose a readable body');
}

/**
 * Download a file, verify its SHA-256 and atomically materialise it at
 * `destPath` (mode `0o755`). Exported for tests and for future alternative
 * download sources; production code pins `expectedSha256` to
 * {@link WIN32_X64_SHA256}.
 *
 * @param {{
 *   url: string,
 *   expectedSha256: string,
 *   destPath: string,
 *   fetchImpl?: typeof fetch,
 *   logger?: {info?: Function, warn?: Function},
 *   timeoutMs?: number,
 *   maxBytes?: number,
 * }} options
 * @returns {Promise<{path: string, bytes: number, sha256: string}>}
 * @throws {Error & {code: 'invalid-sha256'|'download-failed'|'checksum-mismatch'}}
 */
export async function downloadVerified(options) {
  const { url, expectedSha256, destPath } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger ?? {};
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;

  if (typeof fetchImpl !== 'function') {
    throw codedError('download-failed', 'no fetch implementation available');
  }
  if (typeof expectedSha256 !== 'string' || !SHA256_HEX.test(expectedSha256)) {
    throw codedError('invalid-sha256', 'expectedSha256 must be a 64-character lower-case hex digest');
  }
  if (typeof destPath !== 'string' || !destPath) {
    throw codedError('download-failed', 'destPath is required');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  let bytes;
  try {
    if (typeof logger.info === 'function') logger.info('cloudflared.download-start', { url, timeoutMs });
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': `dsh-remote-v2/${CLOUDFLARED_VERSION}` },
    });
    if (!response || response.ok === false || (typeof response.status === 'number' && (response.status < 200 || response.status > 299))) {
      const status = response && typeof response.status === 'number' ? response.status : 'unknown';
      throw codedError('download-failed', `cloudflared download failed with HTTP status ${status}`);
    }
    bytes = await readResponseBytes(response);
  } catch (error) {
    if (error && /** @type {{code?: string}} */ (error).code) throw error;
    throw codedError('download-failed', `cloudflared download failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  if (bytes.length === 0) throw codedError('download-failed', 'cloudflared download returned an empty body');
  if (bytes.length > maxBytes) {
    throw codedError('download-failed', `cloudflared download exceeded the ${maxBytes}-byte limit`);
  }

  const actualSha256 = sha256Hex(bytes);
  if (!digestsEqual(expectedSha256, actualSha256)) {
    throw codedError(
      'checksum-mismatch',
      `cloudflared SHA-256 mismatch (expected ${expectedSha256}, got ${actualSha256})`,
    );
  }

  const dir = dirname(destPath);
  const tmpPath = `${destPath}.${process.pid}.${Date.now().toString(36)}.download`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(tmpPath, bytes, { mode: 0o755, flag: 'wx' });
    if (process.platform !== 'win32') await chmod(tmpPath, 0o755).catch(() => {});
    await rename(tmpPath, destPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw codedError('download-failed', `could not write cloudflared cache: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  // Re-read the materialised file so a torn write or a platform quirk cannot
  // silently ship an unverified binary.
  const writtenSha256 = await sha256File(destPath);
  if (!digestsEqual(expectedSha256, writtenSha256)) {
    await rm(destPath, { force: true }).catch(() => {});
    throw codedError('checksum-mismatch', `cached cloudflared SHA-256 mismatch after write (got ${writtenSha256})`);
  }

  if (typeof logger.info === 'function') {
    logger.info('cloudflared.download-complete', { path: destPath, bytes: bytes.length, sha256: actualSha256 });
  }
  return { path: destPath, bytes: bytes.length, sha256: actualSha256 };
}

/** In-flight downloads keyed by cache path (deduplicates concurrent calls). */
/** @type {Map<string, Promise<{path: string, bytes: number, sha256: string}>>} */
const inFlightDownloads = new Map();

/**
 * Resolve (and, when necessary, download) a trusted `cloudflared` executable.
 *
 * @param {{
 *   cacheDir?: string,
 *   explicitPath?: string,
 *   logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function},
 *   fetchImpl?: typeof fetch,
 *   platform?: NodeJS.Platform|string,
 *   arch?: string,
 *   whichImpl?: (command: string, platform: NodeJS.Platform|string) => Promise<string[]>,
 *   execVersionImpl?: (executable: string) => Promise<string>,
 *   maxBytes?: number,
 * }} [options]
 * @returns {Promise<string>} Absolute path to a trusted cloudflared executable.
 * @throws {Error} With `code` `unsupported-platform`, `explicit-path-not-found`,
 *   `invalid-cache-dir`, `download-failed`, `checksum-mismatch`.
 */
export async function ensureCloudflared(options = {}) {
  const logger = options.logger ?? {};
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const whichImpl = options.whichImpl ?? defaultWhich;
  const execVersionImpl = options.execVersionImpl ?? defaultExecVersion;

  assertSupportedPlatform(platform, arch);

  if (typeof options.explicitPath === 'string' && options.explicitPath.trim()) {
    const explicit = resolve(options.explicitPath.trim());
    if (!(await isFile(explicit))) {
      throw codedError('explicit-path-not-found', `explicit cloudflared path does not exist: ${explicit}`);
    }
    if (typeof logger.info === 'function') logger.info('cloudflared.explicit', { path: explicit });
    return explicit;
  }

  const onPath = await findOnPath({ platform, whichImpl, execVersionImpl, logger });
  if (onPath) return onPath;

  if (typeof options.cacheDir !== 'string' || !options.cacheDir) {
    throw codedError('invalid-cache-dir', 'cacheDir is required when cloudflared is not available elsewhere');
  }
  const cacheDir = resolve(options.cacheDir);
  const cachePath = join(cacheDir, CACHE_FILE_NAME);

  if (await isFile(cachePath)) {
    const cachedSha256 = await sha256File(cachePath).catch(() => '');
    if (digestsEqual(WIN32_X64_SHA256, cachedSha256)) {
      if (typeof logger.info === 'function') logger.info('cloudflared.cache-hit', { path: cachePath });
      return cachePath;
    }
    if (typeof logger.warn === 'function') {
      logger.warn('cloudflared.cache-invalid', { path: cachePath, sha256: cachedSha256 || 'unreadable' });
    }
    await rm(cachePath, { force: true }).catch(() => {});
  }

  let pending = inFlightDownloads.get(cachePath);
  if (!pending) {
    pending = downloadVerified({
      url: CLOUDFLARED_DOWNLOAD_URL,
      expectedSha256: WIN32_X64_SHA256,
      destPath: cachePath,
      fetchImpl,
      logger,
      maxBytes: options.maxBytes,
    }).finally(() => {
      inFlightDownloads.delete(cachePath);
    });
    inFlightDownloads.set(cachePath, pending);
  }
  const result = await pending;
  return result.path;
}
