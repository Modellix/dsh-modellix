import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DOCUMENTATION_FILES,
  findSensitiveContent,
  findSensitiveSourceMapContent,
  SCREENSHOT_FILES,
  verifyDocumentationImages,
} from './verify-pack-support.mjs'
import { verifySafeDocumentationWebp } from './webp-verifier.mjs'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const expectedFiles = Object.freeze([
  'CHANGELOG.md',
  'LICENSE',
  ...DOCUMENTATION_FILES,
  ...SCREENSHOT_FILES,
  'cordis.patch.yml',
  'lib/client.d.ts',
  'lib/client.js',
  'lib/client.js.map',
  'lib/index.d.ts',
  'lib/index.js',
  'lib/index.js.map',
  'package.json',
].sort())

const requiredFileSelectors = Object.freeze([
  'lib/**',
  'cordis.patch.yml',
  'README.md',
  'README.zh-CN.md',
  'docs/**',
  'CHANGELOG.md',
  'LICENSE',
])

const forbiddenPathPatterns = Object.freeze([
  { label: 'source', pattern: /^(?:src|source)\//iu },
  { label: 'test', pattern: /^(?:test|tests|__tests__)\//iu },
  { label: 'coverage', pattern: /^coverage\//iu },
  { label: 'development script', pattern: /^scripts\//iu },
  { label: 'dependency tree', pattern: /^node_modules\//iu },
  { label: 'Agent instruction', pattern: /(?:^|\/)AGENTS\.md$/iu },
  { label: 'planning memory', pattern: /(?:^|\/)(?:DEVELOPMENT_PLAN|PROJECT_MEMORY)\.md$/iu },
  { label: 'environment file', pattern: /(?:^|\/)\.env(?:\..*)?$/iu },
  { label: 'package-manager configuration', pattern: /(?:^|\/)\.npmrc$/iu },
  { label: 'lockfile', pattern: /(?:^|\/)(?:npm-shrinkwrap\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/iu },
  { label: 'test module', pattern: /(?:^|\/)[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/iu },
  { label: 'diagnostic capture', pattern: /\.(?:har|log)$/iu },
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
  const result = runPnpm(['pack', '--config.ignore-scripts=true', '--dry-run', '--json'])
  try {
    return JSON.parse(result.stdout)
  } catch {
    fail('pnpm pack did not return JSON metadata')
  }
}

/**
 * @param {string[]} args
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runPnpm(args) {
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
  if (result.error !== undefined) fail(`pnpm is unavailable (${result.error.message})`)
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `status ${String(result.status)}`
    fail(`pnpm pack inspection failed (${detail})`)
  }
  return result
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
 * @param {string} value
 * @returns {string}
 */
function packagePath(value) {
  const normalized = value.replaceAll('\\', '/')
  if (
    normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    fail('pack metadata contains an unsafe path')
  }
  return normalized
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {Set<string>} output
 */
function collectExportTargets(value, label, output) {
  if (typeof value === 'string') {
    if (!value.startsWith('./')) fail(`${label} must target a package-relative path`)
    const path = packagePath(value.slice(2))
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

function verifyManifestSelectors() {
  if (!Array.isArray(packageJson.files)) fail('package.json files must be an array')
  const selectors = new Set(packageJson.files)
  const missing = requiredFileSelectors.filter(selector => !selectors.has(selector))
  if (missing.length > 0) fail(`package.json files omits [${missing.join(', ')}]`)
  if (packageJson.dsh?.bundle?.patch !== './cordis.patch.yml') {
    fail('the DSH Bundle patch must resolve to ./cordis.patch.yml')
  }
  if (packageJson.dsh?.client?.platform !== 'web') {
    fail('the DSH Client entry must target the web platform')
  }
}

/** @param {readonly string[]} packedFiles */
function verifyForbiddenPaths(packedFiles) {
  for (const path of packedFiles) {
    const blocked = forbiddenPathPatterns.find(candidate => candidate.pattern.test(path))
    if (blocked !== undefined) fail(`${blocked.label} file must not be packed (${path})`)
  }
}

/** @param {readonly string[]} packedFiles */
function verifyCasePortablePaths(packedFiles) {
  const folded = new Set()
  for (const path of packedFiles) {
    const key = path.toLocaleLowerCase('en-US')
    if (folded.has(key)) fail(`case-insensitive duplicate path (${path})`)
    folded.add(key)
  }
}

async function verifyScreenshots() {
  for (const path of SCREENSHOT_FILES) {
    const bytes = readFileSync(join(packageRoot, ...path.split('/')))
    try {
      await verifySafeDocumentationWebp(bytes, path)
    } catch (error) {
      fail(error instanceof Error ? error.message : `documentation screenshot is invalid (${path})`)
    }
  }
}

/** @param {ReadonlySet<string>} packedFiles */
function verifyDocumentationReferences(packedFiles) {
  const documents = Object.fromEntries(DOCUMENTATION_FILES.map(path => [
    path,
    readFileSync(join(packageRoot, ...path.split('/')), 'utf8'),
  ]))
  try {
    verifyDocumentationImages(documents, packedFiles)
  } catch (error) {
    fail(error instanceof Error ? error.message : 'documentation image verification failed')
  }
}

/** @param {readonly string[]} packedFiles */
function verifyNoSensitiveText(packedFiles) {
  for (const path of packedFiles) {
    if (path.endsWith('.webp')) continue
    const text = readFileSync(join(packageRoot, ...path.split('/')), 'utf8')
    let finding = findSensitiveContent(text)
    if (finding === null && path.endsWith('.map')) {
      try {
        finding = findSensitiveSourceMapContent(text)
      } catch (error) {
        fail(error instanceof Error ? `${error.message} (${path})` : `invalid Source Map (${path})`)
      }
    }
    if (finding !== null) fail(`${finding.label} detected in ${path}`)
  }
}

verifyManifestSelectors()

const metadata = packMetadata(inspectPack())
if (metadata.name !== packageJson.name || metadata.version !== packageJson.version) {
  fail('pack identity differs from package.json')
}

const packedFiles = metadata.files.map(file => packagePath(file.path))
const uniqueFiles = new Set(packedFiles)
if (uniqueFiles.size !== packedFiles.length) fail('pack metadata contains duplicate paths')
verifyCasePortablePaths(packedFiles)
verifyForbiddenPaths(packedFiles)

const missing = expectedFiles.filter(path => !uniqueFiles.has(path))
const unexpected = packedFiles.filter(path => !expectedFiles.includes(path))
if (missing.length > 0 || unexpected.length > 0) {
  fail(`content mismatch; missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}]`)
}

const entryTargets = new Set()
collectExportTargets(packageJson.main, 'main', entryTargets)
collectExportTargets(packageJson.types, 'types', entryTargets)
collectExportTargets(packageJson.exports, 'exports', entryTargets)
collectExportTargets(packageJson.dsh.bundle.patch, 'dsh.bundle.patch', entryTargets)
for (const target of entryTargets) {
  if (!uniqueFiles.has(target)) fail(`entry target ${target} is absent from the package`)
}

await verifyScreenshots()
verifyDocumentationReferences(uniqueFiles)
verifyNoSensitiveText(packedFiles)

console.log(
  `Package verified: ${metadata.name}@${metadata.version}, ${String(packedFiles.length)} files, ` +
  `${String(entryTargets.size)} entry targets, ${String(SCREENSHOT_FILES.length)} shared screenshots.`,
)
