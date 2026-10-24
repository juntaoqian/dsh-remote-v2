/**
 * @file JSONL logger with an in-memory ring buffer for diagnostics.
 *
 * Contract: `docs/contracts.md` section 0 (`core/log.js`).
 *
 * The logger is intentionally dependency-free and never throws into callers:
 * a broken log stream degrades to an in-memory buffer plus an optional stderr
 * mirror, because logging must not take the sidecar down.
 *
 * @module core/log
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Numeric levels used for threshold filtering. */
export const LOG_LEVELS = Object.freeze(
  /** @type {{debug: number, info: number, warn: number, error: number, silent: number}} */ ({
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100,
  }),
);

/** Default JSONL file name written into the log directory. */
export const LOG_FILE_NAME = 'sidecar.jsonl';

const DEFAULT_CAPACITY = 500;
const DEFAULT_MAX_STRING = 4096;
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;

/**
 * Truncate a string to at most `limit` UTF-16 code units, appending `…`.
 *
 * @param {string} value
 * @param {number} [limit]
 * @returns {string}
 */
function truncate(value, limit = DEFAULT_MAX_STRING) {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Recursively convert a log field value into a JSON-safe, bounded structure.
 *
 * Handles `Error`, `BigInt`, circular references, functions and deeply nested
 * objects. Output is deterministic for the same input.
 *
 * @param {unknown} value Raw value.
 * @param {number} [depth] Current recursion depth.
 * @param {WeakSet<object>} [seen] Objects on the current path (cycle detection).
 * @param {number} [maxString] Maximum serialised string length.
 * @returns {unknown} JSON-safe projection.
 */
function sanitize(value, depth = 0, seen = new WeakSet(), maxString = DEFAULT_MAX_STRING) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'string') return truncate(/** @type {string} */ (value), maxString);
  if (type === 'bigint') return value.toString();
  if (type === 'function') return '[function]';
  if (type === 'symbol') return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(value.message, maxString),
      ...(/** @type {{code?: unknown}} */ (value).code !== undefined
        ? { code: sanitize(/** @type {{code?: unknown}} */ (value).code, depth + 1, seen, maxString) }
        : {}),
      ...(value.stack ? { stack: truncate(value.stack, maxString) } : {}),
    };
  }
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1, seen, maxString));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }
  if (typeof value === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value);
    if (seen.has(object)) return '[circular]';
    seen.add(object);
    /** @type {Record<string, unknown>} */
    const output = {};
    let count = 0;
    for (const key of Object.keys(object)) {
      if (count >= MAX_OBJECT_KEYS) {
        output.truncated = `[+${Object.keys(object).length - MAX_OBJECT_KEYS} more keys]`;
        break;
      }
      output[truncate(key, 128)] = sanitize(object[key], depth + 1, seen, maxString);
      count += 1;
    }
    seen.delete(object);
    return output;
  }
  return String(value);
}

/**
 * Create a fixed-capacity ring buffer of log entries.
 *
 * @param {{capacity?: number}} [options]
 * @returns {{
 *   push(entry: object): void,
 *   toArray(limit?: number): object[],
 *   clear(): void,
 *   readonly size: number,
 *   readonly capacity: number,
 * }}
 */
export function createRingBuffer(options = {}) {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError('ring buffer capacity must be a positive integer');
  }
  /** @type {object[]} */
  const items = [];

  return {
    push(entry) {
      items.push(entry);
      if (items.length > capacity) items.splice(0, items.length - capacity);
    },
    toArray(limit = capacity) {
      const count = Math.max(0, Math.min(Math.trunc(limit) || 0, items.length));
      return count === 0 ? [] : items.slice(items.length - count);
    },
    clear() {
      items.length = 0;
    },
    get size() {
      return items.length;
    },
    get capacity() {
      return capacity;
    },
  };
}

/**
 * No-op logger used when a caller does not supply one (e.g. focused tests).
 * @type {ReturnType<typeof buildLogger>}
 */
export const NOOP_LOGGER = buildLogger({
  enabled: false,
  threshold: LOG_LEVELS.silent,
  name: 'sidecar',
  ring: createRingBuffer({ capacity: 1 }),
  stream: null,
  now: () => Date.now(),
  mirrorToConsole: false,
  maxString: DEFAULT_MAX_STRING,
});

/**
 * Return `logger` when it looks like a logger, otherwise {@link NOOP_LOGGER}.
 *
 * @param {unknown} logger
 * @returns {ReturnType<typeof buildLogger>}
 */
export function resolveLogger(logger) {
  if (logger && typeof (/** @type {{info?: unknown}} */ (logger).info) === 'function') {
    return /** @type {ReturnType<typeof buildLogger>} */ (logger);
  }
  return NOOP_LOGGER;
}

/**
 * Build a logger instance (internal factory shared by the public factory and
 * {@link NOOP_LOGGER}).
 *
 * @param {{
 *   enabled: boolean,
 *   threshold: number,
 *   name: string,
 *   ring: ReturnType<typeof createRingBuffer>,
 *   stream: import('node:fs').WriteStream|null,
 *   now: () => number,
 *   mirrorToConsole: boolean,
 *   maxString: number,
 *   extra?: Record<string, unknown>,
 *   getStream?: () => import('node:fs').WriteStream|null,
 * }} state
 */
function buildLogger(state) {
  /**
   * @param {string} level
   * @param {unknown} message Either a human-readable message, or (when `fields`
   *   is omitted and the value is a plain object) an event-shaped fields object
   *   such as `{ event: 'upstream_error', ... }` as used by the Lead modules.
   * @param {Record<string, unknown>|undefined} fields
   */
  function log(level, message, fields) {
    if (!state.enabled) return;
    const numeric = LOG_LEVELS[/** @type {keyof typeof LOG_LEVELS} */ (level)];
    if (numeric === undefined || numeric < state.threshold) return;

    /** @type {unknown} */
    let messageText = message;
    /** @type {Record<string, unknown>|undefined} */
    let fieldObject = fields;
    if (message instanceof Error && fields === undefined) {
      fieldObject = { error: message };
      messageText = message.message;
    } else if (message !== null && typeof message === 'object' && !Array.isArray(message) && fields === undefined) {
      fieldObject = /** @type {Record<string, unknown>} */ (message);
      const eventName = fieldObject.event ?? fieldObject.msg ?? fieldObject.message;
      messageText = typeof eventName === 'string' ? eventName : 'event';
    }

    /** @type {Record<string, unknown>} */
    const entry = {
      ts: new Date(state.now()).toISOString(),
      level,
      name: state.name,
      msg: truncate(typeof messageText === 'string' ? messageText : String(messageText), state.maxString),
    };
    if (fieldObject && typeof fieldObject === 'object') {
      Object.assign(entry, /** @type {Record<string, unknown>} */ (sanitize(fieldObject, 0, new WeakSet(), state.maxString)));
    }
    // Reserved keys cannot be overridden by fields.
    entry.ts = new Date(state.now()).toISOString();
    entry.level = level;
    entry.name = state.name;

    if (state.extra) Object.assign(entry, state.extra, { ts: entry.ts, level, name: state.name });

    state.ring.push(entry);

    const stream = state.getStream ? state.getStream() : state.stream;
    if (stream) {
      try {
        stream.write(`${JSON.stringify(entry)}\n`);
      } catch {
        /* logging must never throw */
      }
    }
    if (state.mirrorToConsole) {
      try {
        const line = `${entry.ts} ${level.toUpperCase()} ${entry.msg}`;
        if (level === 'error') process.stderr.write(`${line}\n`);
        else process.stdout.write(`${line}\n`);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
    log,
    /** Return a child logger that prefixes every entry with `fields`. */
    child(fields) {
      return buildLogger({ ...state, extra: { ...(state.extra ?? {}), ...(fields ?? {}) } });
    },
    /** @param {number} [limit] @returns {object[]} The newest entries, oldest first. */
    recent(limit = 100) {
      return state.ring.toArray(limit);
    },
    /** @returns {Promise<void>} Flush and close the underlying JSONL stream. */
    async close() {
      const stream = state.getStream ? state.getStream() : state.stream;
      if (!stream) return;
      await new Promise((resolve) => {
        try {
          stream.end(() => resolve());
        } catch {
          resolve();
        }
      });
    },
    get ring() {
      return state.ring;
    },
    get name() {
      return state.name;
    },
  };
}

/**
 * Create a JSONL logger writing to `<dir>/<file>` plus an in-memory ring buffer.
 *
 * @param {{
 *   dir?: string,
 *   file?: string,
 *   name?: string,
 *   level?: keyof typeof LOG_LEVELS|string,
 *   capacity?: number,
 *   maxStringChars?: number,
 *   now?: () => number,
 *   mirrorToConsole?: boolean,
 * }} [options]
 * @returns {{
 *   debug(message: unknown, fields?: Record<string, unknown>): void,
 *   info(message: unknown, fields?: Record<string, unknown>): void,
 *   warn(message: unknown, fields?: Record<string, unknown>): void,
 *   error(message: unknown, fields?: Record<string, unknown>): void,
 *   log(level: string, message: unknown, fields?: Record<string, unknown>): void,
 *   child(fields: Record<string, unknown>): any,
 *   recent(limit?: number): object[],
 *   close(): Promise<void>,
 *   ring: ReturnType<typeof createRingBuffer>,
 *   name: string,
 * }}
 */
export function createLogger(options = {}) {
  const dir = options.dir;
  const file = options.file ?? LOG_FILE_NAME;
  const name = options.name ?? 'sidecar';
  const level = options.level ?? 'info';
  const threshold = LOG_LEVELS[/** @type {keyof typeof LOG_LEVELS} */ (level)] ?? LOG_LEVELS.info;
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const maxString = options.maxStringChars ?? DEFAULT_MAX_STRING;
  const now = options.now ?? Date.now;
  const mirrorToConsole = options.mirrorToConsole === true;

  /** @type {import('node:fs').WriteStream|null} */
  let stream = null;
  let failed = false;

  function getStream() {
    if (!dir || failed) return null;
    if (stream) return stream;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      stream = createWriteStream(join(dir, file), { flags: 'a', mode: 0o600 });
      stream.on('error', () => {
        failed = true;
        stream = null;
      });
      return stream;
    } catch {
      failed = true;
      return null;
    }
  }

  return buildLogger({
    enabled: true,
    threshold,
    name,
    ring: createRingBuffer({ capacity }),
    stream: null,
    getStream,
    now,
    mirrorToConsole,
    maxString,
  });
}
