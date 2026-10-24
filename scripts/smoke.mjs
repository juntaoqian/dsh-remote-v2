#!/usr/bin/env node
/**
 * Manual end-to-end smoke test (network required).
 *
 * Starts a fake DSH upstream, launches the sidecar with the real Quick Tunnel
 * transport (downloads cloudflared on first run), pairs a client through the
 * public HTTPS entry, proxies one authenticated request, then stops everything.
 *
 * Usage: node scripts/smoke.mjs [--timeout-ms 300000]
 * This file is NOT part of `node --test test/`.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT = Number(readArg('--timeout-ms') ?? 300_000)

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function log(...parts) {
  console.log('[smoke]', ...parts)
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/**
 * Retry a public-URL request: a fresh trycloudflare hostname may need a few
 * seconds of DNS/edge propagation after cloudflared reports ready.
 * @param {string} url request URL
 * @param {RequestInit} [options] fetch options (signal is replaced per attempt)
 * @param {{ attempts?: number, delayMs?: number, timeoutMs?: number }} [retry] retry policy
 * @returns {Promise<Response>} first successful response
 */
async function fetchRetry(url, options = {}, retry = {}) {
  const attempts = retry.attempts ?? 30
  const delayMs = retry.delayMs ?? 2_000
  const timeoutMs = retry.timeoutMs ?? 30_000
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      lastError = error
      log(`public fetch attempt ${attempt}/${attempts} failed: ${error?.cause?.code ?? error?.message ?? error}`)
      if (attempt < attempts) await sleep(delayMs)
    }
  }
  throw lastError ?? new Error('public fetch failed')
}

/** Read the gateway port the sidecar logged at startup. */
async function readGatewayPort(stateDir) {
  const text = await readFile(join(stateDir, 'logs', 'sidecar.jsonl'), 'utf8').catch(() => '')
  const lines = text.split('\n').filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index])
      if (entry.msg === 'gateway.listening' && Number.isInteger(entry.port)) return entry.port
    } catch {
      // skip malformed lines
    }
  }
  throw new Error('gateway port not found in sidecar log')
}

/**
 * Minimal HTTP request to the loopback gateway with a spoofed Host header.
 * @param {number} port gateway port
 * @param {string} path request path
 * @param {{ method?: string, host: string, headers?: Record<string,string>, body?: string }} options
 * @returns {Promise<{ status: number, headers: Record<string, any>, text: string }>}
 */
function loopbackRequest(port, path, options) {
  return new Promise((resolvePromise, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host, ...(options.headers ?? {}) },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    request.on('error', reject)
    request.end(options.body)
  })
}

async function waitForControlFile(stateDir, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`sidecar exited early (code=${child.exitCode})`)
    try {
      const parsed = JSON.parse(await readFile(join(stateDir, 'control.json'), 'utf8'))
      if (Number.isInteger(parsed.port) && parsed.port > 0) return parsed
    } catch {
      // not written yet
    }
    await sleep(250)
  }
  throw new Error('timed out waiting for control.json')
}

async function main() {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-remote-v2-smoke-'))
  const controlToken = randomBytes(32).toString('base64url')

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null }))
  })
  await new Promise((resolvePromise) => upstream.listen(0, '127.0.0.1', resolvePromise))
  const upstreamPort = upstream.address().port
  log(`fake DSH upstream on 127.0.0.1:${upstreamPort}`)

  const env = {
    ...process.env,
    DSH_REMOTE_V2_STATE_DIR: stateDir,
    DSH_REMOTE_V2_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    DSH_REMOTE_V2_CONTROL_TOKEN: controlToken,
    DSH_REMOTE_V2_PLUGIN_ROOT: ROOT,
    DSH_REMOTE_V2_VERSION: '0.1.0-smoke',
    DSH_REMOTE_V2_HOST_PID: String(process.pid),
    DSH_REMOTE_V2_LOG_LEVEL: 'info',
  }

  const child = spawn(process.execPath, [join(ROOT, 'core', 'sidecar.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let sidecarLog = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    sidecarLog += chunk
    for (const line of String(chunk).split('\n')) if (line.trim()) log('sidecar:', line.trim().slice(0, 300))
  })
  child.stderr.on('data', (chunk) => {
    sidecarLog += chunk
    for (const line of String(chunk).split('\n')) if (line.trim()) log('sidecar-err:', line.trim().slice(0, 300))
  })

  const base = () => `http://127.0.0.1:${control.port}`
  let control
  const call = async (method, payload = {}, path = `/${method}`, timeoutMs = TIMEOUT) => {
    const response = await fetch(base() + path, {
      method: method === 'status' || method === 'pairing' || method === 'devices' || method === 'config' || method === 'diagnostics' ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
      body: method === 'status' || method === 'pairing' || method === 'devices' || method === 'config' || method === 'diagnostics'
        ? undefined
        : JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.json()
    if (!body.ok) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`)
    return body.value ?? body
  }

  try {
    control = await waitForControlFile(stateDir, child, 20_000)
    log(`control API on 127.0.0.1:${control.port}`)
    const initial = await call('status')
    log(`initial phase=${initial.phase} running=${initial.running}`)

    log('starting quick tunnel (may download cloudflared, ~55 MB on first run)…')
    const started = await call('start', { transport: 'quick' }, '/start')
    log(`tunnel ready: ${started.publicUrl}`)

    const pairing = await call('pairingRotate', {}, '/pairing/rotate')
    const secret = String(pairing.url ?? '').split('#s=')[1]
    if (!secret) throw new Error('pairing rotate returned no fragment secret')
    log(`pairing code=${pairing.code}`)

    const publicHost = new URL(started.publicUrl).host
    let mode = 'public'
    let gatewayPort
    const page = await fetchRetry(`${started.publicUrl}/pair`, {}, { attempts: 3, delayMs: 1_500 }).catch(async (error) => {
      log(`public URL unreachable from this machine (${error?.cause?.code ?? error?.message}); falling back to loopback + Host header`)
      mode = 'loopback'
      gatewayPort = await readGatewayPort(stateDir)
      return await loopbackRequest(gatewayPort, '/pair', { host: publicHost })
    })
    const pageText = typeof page.text === 'function' ? await page.text() : page.text
    log(`/pair status=${page.status} hasClaim=${pageText.includes('/pair/claim')} mode=${mode}`)

    let claimStatus
    let claimBody
    let setCookie = ''
    if (mode === 'public') {
      const claim = await fetchRetry(`${started.publicUrl}/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret, name: 'smoke-test' }),
      })
      claimStatus = claim.status
      claimBody = await claim.json()
      setCookie = claim.headers.get('set-cookie') ?? ''
    } else {
      const claim = await loopbackRequest(gatewayPort, '/pair/claim', {
        method: 'POST',
        host: publicHost,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret, name: 'smoke-test' }),
      })
      claimStatus = claim.status
      claimBody = JSON.parse(claim.text)
      setCookie = String(claim.headers['set-cookie']?.[0] ?? '')
    }
    const token = setCookie.match(/dsh_remote_v2=([A-Za-z0-9_-]{43})/)?.[1]
    log(`claim status=${claimStatus} ok=${String(claimBody.ok)} cookie=${token ? 'yes' : 'no'}`)
    if (!token) throw new Error('claim did not set a device cookie')

    let proxiedStatus
    let proxiedBody
    if (mode === 'public') {
      const proxied = await fetchRetry(`${started.publicUrl}/api/smoke`, {
        headers: { cookie: `dsh_remote_v2=${token}` },
      })
      proxiedStatus = proxied.status
      proxiedBody = await proxied.json()
    } else {
      const proxied = await loopbackRequest(gatewayPort, '/api/smoke', {
        host: publicHost,
        headers: { cookie: `dsh_remote_v2=${token}` },
      })
      proxiedStatus = proxied.status
      proxiedBody = JSON.parse(proxied.text)
    }
    log(`authenticated proxy status=${proxiedStatus} upstreamHost=${proxiedBody.host}`)
    if (proxiedStatus !== 200) throw new Error('proxied request was not 200')

    const devices = await call('devices', {}, '/devices')
    log(`devices=${devices.length}`)
    if (devices.length !== 1) throw new Error('expected exactly one paired device')

    await call('stop', {}, '/stop')
    log('stopped')
    console.log('[smoke] PASS')
  } catch (error) {
    console.error('[smoke] FAIL:', error.message)
    console.error('[smoke] sidecar log tail:\n' + sidecarLog.split('\n').slice(-40).join('\n'))
    process.exitCode = 1
  } finally {
    try {
      child.kill()
    } catch {
      // ignore
    }
    await new Promise((resolvePromise) => upstream.close(() => resolvePromise()))
    await rm(stateDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error('[smoke] fatal:', error)
  process.exit(1)
})
