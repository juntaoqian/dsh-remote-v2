#!/usr/bin/env node
/**
 * Development installer for dsh-remote-v2.
 *
 * Copies this repository into a DSH profile's node_modules and registers the
 * bundle. It intentionally does NOT use pnpm: the profile may contain git
 * dependencies that require network access pnpm cannot always satisfy.
 *
 * Usage:
 *   node scripts/install.mjs [--profile desktop] [--dsh-home <dir>] [--uninstall]
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-remote-v2'
const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')

function parseArgs(argv) {
  const options = { profile: 'desktop', uninstall: false, dshHome: process.env.DSH_HOME || join(homedir(), '.dsh') }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') options.profile = argv[++index]
    else if (arg === '--dsh-home') options.dshHome = argv[++index]
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/install.mjs [--profile <name>] [--dsh-home <dir>] [--uninstall]')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function urlSafeStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const profileDir = join(options.dshHome, 'profiles', options.profile)
  const manifestPath = join(profileDir, 'package.json')

  try {
    await stat(manifestPath)
  } catch {
    throw new Error(`profile not initialized: ${manifestPath}`)
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const backupPath = `${manifestPath}.bak-${PACKAGE}-${urlSafeStamp()}`
  await cp(manifestPath, backupPath, { force: true })

  const profilePluginDir = join(profileDir, 'node_modules', PACKAGE)

  if (options.uninstall) {
    if (manifest.dependencies) delete manifest.dependencies[PACKAGE]
    const bundles = manifest.dsh?.profile?.bundles
    if (Array.isArray(bundles)) manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await rm(profilePluginDir, { recursive: true, force: true })
    console.log(`uninstalled ${PACKAGE} from ${profileDir}`)
    console.log('restart DeepSeek Harness to unload it')
    return
  }

  await rm(profilePluginDir, { recursive: true, force: true })
  await mkdir(profilePluginDir, { recursive: true })
  for (const entry of ['lib', 'core', 'docs', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE', 'NOTICE']) {
    const source = join(PLUGIN_ROOT, entry)
    try {
      await stat(source)
    } catch {
      continue
    }
    await cp(source, join(profilePluginDir, entry), { recursive: true, force: true })
  }

  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dependencies[PACKAGE] = `file:${profilePluginDir.replace(/\\/g, '/')}`
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  if (!bundles.includes(PACKAGE)) bundles.push(PACKAGE)
  manifest.dsh.profile.bundles = bundles

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`installed ${PACKAGE} into ${profilePluginDir}`)
  console.log(`profile manifest updated (backup: ${backupPath})`)
  console.log('fully quit and reopen DeepSeek Harness, then open 设置 → 远程访问')
}

main().catch((error) => {
  console.error(`install failed: ${error.message}`)
  process.exit(1)
})
