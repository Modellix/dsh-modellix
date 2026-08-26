import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const expectedFiles = Object.freeze([
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'lib/client.d.ts',
  'lib/client.js',
  'lib/client.js.map',
  'lib/index.d.ts',
  'lib/index.js',
  'lib/index.js.map',
  'package.json',
])

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(`package verification failed: ${message}`)
}

/** @returns {unknown} */
function inspectPack() {
  // pnpm otherwise executes this package's prepack lifecycle. Disabling
  // lifecycle scripts keeps verify:pack from recursively entering prepack.
  const args = ['pack', '--config.ignore-scripts=true', '--dry-run', '--json']
  const npmExecPath = process.env.npm_execpath
  let command
  let commandArgs
  if (typeof npmExecPath === 'string' && npmExecPath.includes('pnpm')) {
    command = process.execPath
    commandArgs = [npmExecPath, ...args]
  } else if (process.platform === 'win32') {
    command = process.env.ComSpec ?? 'cmd.exe'
    commandArgs = ['/d', '/s', '/c', 'pnpm.cmd', ...args]
  } else {
    command = 'pnpm'
    commandArgs = args
  }
  const result = spawnSync(command, commandArgs, {
    cwd: packageRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error !== undefined) fail(`pnpm pack is unavailable (${result.error.message})`)
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `status ${String(result.status)}`
    fail(`pnpm pack inspection failed (${detail})`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    fail('pnpm pack did not return JSON metadata')
  }
}

/**
 * @param {unknown} value
 * @returns {{ name: string, version: string, files: { path: string }[] }}
 */
function packMetadata(value) {
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value
  if (typeof candidate !== 'object' || candidate === null) fail('pack metadata must be an object')
  if (!Array.isArray(candidate.files)) fail('pack metadata is missing files')
  if (typeof candidate.name !== 'string' || typeof candidate.version !== 'string') {
    fail('pack metadata is missing package identity')
  }
  for (const file of candidate.files) {
    if (typeof file !== 'object' || file === null || typeof file.path !== 'string') {
      fail('pack metadata contains an invalid file entry')
    }
  }
  return candidate
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {Set<string>} output
 */
function collectExportTargets(value, label, output) {
  if (typeof value === 'string') {
    if (!value.startsWith('./')) fail(`${label} must target a package-relative path`)
    const path = value.slice(2).replaceAll('\\', '/')
    if (path.length === 0 || path.split('/').includes('..')) fail(`${label} has an unsafe target`)
    output.add(path)
    return
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be a string or conditional export object`)
  }
  for (const [condition, target] of Object.entries(value)) {
    collectExportTargets(target, `${label}.${condition}`, output)
  }
}

const metadata = packMetadata(inspectPack())
if (metadata.name !== packageJson.name || metadata.version !== packageJson.version) {
  fail('pack identity differs from package.json')
}

const packedFiles = metadata.files.map(file => file.path.replaceAll('\\', '/'))
const uniqueFiles = new Set(packedFiles)
if (uniqueFiles.size !== packedFiles.length) fail('pack metadata contains duplicate paths')

const missing = expectedFiles.filter(path => !uniqueFiles.has(path))
const unexpected = packedFiles.filter(path => !expectedFiles.includes(path))
if (missing.length > 0 || unexpected.length > 0) {
  fail(`content mismatch; missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}]`)
}

const entryTargets = new Set()
collectExportTargets(packageJson.main, 'main', entryTargets)
collectExportTargets(packageJson.types, 'types', entryTargets)
collectExportTargets(packageJson.exports, 'exports', entryTargets)
for (const target of entryTargets) {
  if (!uniqueFiles.has(target)) fail(`entry target ${target} is absent from the package`)
}

console.log(`Package verified: ${metadata.name}@${metadata.version}, ${String(packedFiles.length)} files, ${String(entryTargets.size)} entry targets.`)
