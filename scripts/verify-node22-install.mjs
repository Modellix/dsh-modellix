import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const configured = process.env.MODELLIX_NODE22_BINARY

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Error(`Node 22 tarball verification failed: ${message}`)
}

/** @param {string} executable @returns {{ path: string, version: readonly [number, number, number] } | null} */
function inspectNode(executable) {
  let path
  try {
    path = realpathSync(executable)
  } catch {
    return null
  }
  const result = spawnSync(path, ['--version'], { encoding: 'utf8', windowsHide: true })
  if (result.error !== undefined || result.status !== 0) return null
  const match = /^v(\d+)\.(\d+)\.(\d+)\s*$/u.exec(result.stdout)
  if (match === null) return null
  const version = /** @type {const} */ ([Number(match[1]), Number(match[2]), Number(match[3])])
  if (version[0] !== 22 || version[1] < 19) return null
  return { path, version }
}

/** @param {string | undefined} root @param {Set<string>} candidates */
function addNvmCandidates(root, candidates) {
  if (typeof root !== 'string' || root.length === 0 || !existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^v?22\.\d+\.\d+$/u.test(entry.name)) continue
    candidates.add(join(root, entry.name, process.platform === 'win32' ? 'node.exe' : 'bin/node'))
  }
}

const candidates = new Set()
if (configured !== undefined && configured.length > 0) {
  if (!isAbsolute(configured)) fail('MODELLIX_NODE22_BINARY must be an absolute path')
  candidates.add(configured)
} else {
  candidates.add(process.execPath)
  addNvmCandidates(process.env.NVM_HOME, candidates)
  addNvmCandidates(process.env.NVM_DIR, candidates)
  if (typeof process.env.NVM_DIR === 'string' && process.env.NVM_DIR.length > 0) {
    addNvmCandidates(join(process.env.NVM_DIR, 'versions', 'node'), candidates)
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (typeof localAppData === 'string' && localAppData.length > 0) {
      addNvmCandidates(join(localAppData, 'nvm'), candidates)
    }
  }
}

const compatible = [...candidates]
  .map(inspectNode)
  .filter(candidate => candidate !== null)
  .sort((left, right) =>
    left.version[0] - right.version[0] ||
    left.version[1] - right.version[1] ||
    left.version[2] - right.version[2] ||
    left.path.localeCompare(right.path),
  )

const selected = compatible[0]
if (selected === undefined) {
  fail(
    configured === undefined
      ? 'no Node.js ^22.19.0 executable was found; install it with NVM or set MODELLIX_NODE22_BINARY'
      : 'MODELLIX_NODE22_BINARY is not a working Node.js ^22.19.0 executable',
  )
}

const result = spawnSync(process.execPath, ['scripts/verify-fresh-install.mjs'], {
  cwd: packageRoot,
  encoding: 'utf8',
  env: { ...process.env, MODELLIX_FRESH_INSTALL_RUNTIME_NODE: selected.path },
  maxBuffer: 16 * 1024 * 1024,
  windowsHide: true,
})
if (result.stdout.length > 0) process.stdout.write(result.stdout)
if (result.status !== 0) {
  const detail = result.stderr.trim() || `status ${String(result.status)}`
  fail(detail.length > 4_000 ? detail.slice(-4_000) : detail)
}
console.log(`Node ${selected.version.join('.')} tarball runtime gate passed.`)
