import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const temporaryBase = realpathSync(tmpdir())
const temporaryPrefix = 'dsh-modellix-fresh-install-'
const runtimeNode = resolveRuntimeNode()

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(`fresh-install verification failed: ${message}`)
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} label
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runPnpm(args, cwd, label) {
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
  return run(command, commandArgs, cwd, label)
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} label
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function run(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error !== undefined) fail(`${label} could not start (${result.error.message})`)
  if (result.status !== 0) {
    const raw = result.stderr.trim() || result.stdout.trim() || `status ${String(result.status)}`
    const detail = raw.length > 4_000 ? raw.slice(-4_000) : raw
    fail(`${label} failed (${detail})`)
  }
  return result
}

/**
 * @param {unknown} value
 * @returns {{ name: string, version: string }}
 */
function packMetadata(value) {
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value
  if (typeof candidate !== 'object' || candidate === null) fail('pack metadata must be an object')
  if (candidate.name !== packageJson.name || candidate.version !== packageJson.version) {
    fail('packed identity differs from package.json')
  }
  return candidate
}

/** @param {string} target */
function assertTemporaryTarget(target) {
  const resolved = resolve(target)
  const inside = relative(temporaryBase, resolved)
  if (
    inside.length === 0 || inside === '..' || inside.startsWith(`..${sep}`) ||
    isAbsolute(inside) || !basename(resolved).startsWith(temporaryPrefix)
  ) {
    fail('refusing to remove an unverified temporary path')
  }
}

/** @param {string | undefined} target */
function cleanup(target) {
  if (target === undefined || !existsSync(target)) return
  assertTemporaryTarget(target)
  rmSync(target, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 })
}

/** @returns {string} */
function resolveRuntimeNode() {
  const configured = process.env.MODELLIX_FRESH_INSTALL_RUNTIME_NODE
  if (configured === undefined || configured.length === 0) return process.execPath
  if (!isAbsolute(configured)) fail('MODELLIX_FRESH_INSTALL_RUNTIME_NODE must be an absolute path')
  let resolved
  try {
    resolved = realpathSync(configured)
  } catch {
    fail('MODELLIX_FRESH_INSTALL_RUNTIME_NODE does not resolve to a readable executable')
  }
  const result = spawnSync(resolved, ['--version'], { encoding: 'utf8', windowsHide: true })
  if (result.error !== undefined || result.status !== 0 || !/^v\d+\.\d+\.\d+\s*$/u.test(result.stdout)) {
    fail('MODELLIX_FRESH_INSTALL_RUNTIME_NODE is not a working Node.js executable')
  }
  return resolved
}

const installedVerifier = String.raw`
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageJsonUrl = import.meta.resolve('dsh-modellix/package.json')
const packageJsonPath = fileURLToPath(packageJsonUrl)
const packageRoot = await realpath(dirname(packageJsonPath))
const installed = JSON.parse(await readFile(packageJsonPath, 'utf8'))

assert.equal(installed.name, 'dsh-modellix')
assert.equal(installed.type, 'module')
assert.equal(installed.main, './lib/index.js')
assert.equal(installed.types, './lib/index.d.ts')
assert.deepEqual(
  Object.keys(installed.exports).sort(),
  ['.', './client', './cordis.patch.yml', './package.json'],
)

const resolved = {
  host: import.meta.resolve('dsh-modellix'),
  client: import.meta.resolve('dsh-modellix/client'),
  patch: import.meta.resolve('dsh-modellix/cordis.patch.yml'),
  package: packageJsonUrl,
}

for (const [label, url] of Object.entries(resolved)) {
  assert.equal(new URL(url).protocol, 'file:', label + ' export must resolve to a file')
  const physical = await realpath(fileURLToPath(url))
  const fromRoot = relative(packageRoot, physical)
  assert.ok(
    fromRoot.length > 0 && fromRoot !== '..' && !fromRoot.startsWith('..' + sep) && !isAbsolute(fromRoot),
    label + ' export escaped the installed tarball',
  )
}

const host = await import(resolved.host)
assert.equal(host.name, 'modellix')
assert.equal(typeof host.apply, 'function')
assert.ok(host.Config !== undefined)

const patch = await readFile(fileURLToPath(resolved.patch), 'utf8')
assert.match(patch, /searchProvider:\s*modellix/u)
assert.match(patch, /fetchProvider:\s*modellix/u)
assert.match(patch, /name:\s*dsh-modellix/u)

console.log('Installed package exports and Host import verified.')
`

const clientVerifier = String.raw`
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const clientUrl = import.meta.resolve('dsh-modellix/client')
const clientPath = fileURLToPath(clientUrl)
const syntax = spawnSync(process.execPath, ['--check', clientPath], {
  encoding: 'utf8',
  windowsHide: true,
})
assert.equal(
  syntax.status,
  0,
  'installed Client bundle failed node --check: ' + (syntax.stderr.trim() || syntax.stdout.trim()),
)

const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(descriptor) {
      registrations.push(descriptor)
    },
  },
}
try {
  await import(clientUrl)
} finally {
  delete globalThis.window
}

assert.equal(registrations.length, 1, 'Client bundle must register exactly once')
const registration = registrations[0]
assert.equal(registration?.id, 'dsh-modellix')
assert.equal(typeof registration?.factory, 'function')

const nativeRequire = createRequire(import.meta.url)
const required = []
const primitiveStub = new Proxy(Object.create(null), {
  get(_target, property) {
    if (property === Symbol.toStringTag) return 'InjectedHarnessPrimitives'
    return function InjectedHarnessPrimitive() { return null }
  },
})
function injectedRequire(specifier) {
  required.push(specifier)
  if (specifier === 'react' || specifier === 'react/jsx-runtime') return nativeRequire(specifier)
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitiveStub
  throw new Error('Client factory requested an undeclared injected module: ' + specifier)
}

const client = registration.factory(injectedRequire)
assert.deepEqual(
  [...new Set(required)].sort(),
  ['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime'],
  'Client factory injection requirements changed',
)
assert.equal(typeof client?.apply, 'function')
assert.deepEqual(client?.inject, ['slots', 'locale', 'connection', 'layout'])
assert.equal(client?.MODELLIX_RPC_CHANNEL, '/modellix')
console.log('Installed Client bundle syntax, ModuleLoader registration, and factory execution verified.')
`

const hostConsumerSource = String.raw`
import {
  Config,
  apply as applyHost,
  inject as injectHost,
  name,
} from 'dsh-modellix'

const pluginName: typeof name = 'modellix'
void [Config, applyHost, injectHost, pluginName]
`

const clientConsumerSource = String.raw`
import {
  MODELLIX_RPC_CHANNEL,
  apply as applyClient,
  inject as injectClient,
} from 'dsh-modellix/client'

const channel: typeof MODELLIX_RPC_CHANNEL = '/modellix'
void [applyClient, injectClient, channel]
`

const hostConsumerTsconfig = Object.freeze({
  compilerOptions: {
    exactOptionalPropertyTypes: true,
    forceConsistentCasingInFileNames: true,
    lib: ['ES2024'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: 'ES2024',
    types: ['node'],
  },
  files: ['consumer-host.ts'],
})

const clientConsumerTsconfig = Object.freeze({
  compilerOptions: {
    exactOptionalPropertyTypes: true,
    forceConsistentCasingInFileNames: true,
    lib: ['ES2024', 'DOM', 'DOM.Iterable'],
    module: 'ESNext',
    moduleResolution: 'Bundler',
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: 'ES2024',
    types: ['node', 'react', 'react-dom'],
  },
  files: ['consumer-client.ts'],
})

/** @param {string} name */
function developmentVersion(name) {
  const version = packageJson.devDependencies?.[name]
  if (typeof version !== 'string' || version.length === 0) {
    fail(`development dependency ${name} is required by the consumer type smoke`)
  }
  return version
}

let temporaryRoot
try {
  temporaryRoot = mkdtempSync(join(temporaryBase, temporaryPrefix))
  assertTemporaryTarget(temporaryRoot)

  const packDirectory = join(temporaryRoot, 'pack')
  const projectDirectory = join(temporaryRoot, 'project')
  mkdirSync(packDirectory)
  mkdirSync(projectDirectory)

  runPnpm(['run', 'build'], packageRoot, 'final worktree build')
  const packResult = runPnpm(
    ['pack', '--config.ignore-scripts=true', '--pack-destination', packDirectory, '--json'],
    packageRoot,
    'tarball pack',
  )
  let metadata
  try {
    metadata = packMetadata(JSON.parse(packResult.stdout))
  } catch (error) {
    if (error instanceof SyntaxError) fail('pnpm pack did not return JSON metadata')
    throw error
  }

  const archives = readdirSync(packDirectory).filter(path => path.endsWith('.tgz'))
  if (archives.length !== 1) fail(`expected one tarball, received ${String(archives.length)}`)
  const archive = archives[0]
  if (archive === undefined) fail('packed tarball is unavailable after the exact-count check')
  const tarballPath = join(packDirectory, archive)
  const relativeTarball = relative(projectDirectory, tarballPath).replaceAll('\\', '/')

  const dependencies = Object.fromEntries([
    ...Object.entries(packageJson.peerDependencies ?? {}),
    // dsh-client-runtime/client's public declarations augment the shared SlotMap
    // from this Harness SDK package. Install it explicitly so the consumer smoke
    // exercises the declaration graph used by a real DSH Client workspace.
    ...[
      'typescript',
      '@types/node',
      '@types/react',
      '@types/react-dom',
      '@deepseek-ai/dsh-client-ui-slots',
      'react',
    ]
      .map(name => [name, developmentVersion(name)]),
    [packageJson.name, `file:${relativeTarball}`],
  ].sort(([left], [right]) => left.localeCompare(right)))
  const isolatedManifest = {
    name: 'dsh-modellix-fresh-install-check',
    version: '0.0.0',
    private: true,
    type: 'module',
    packageManager: packageJson.packageManager,
    dependencies,
  }
  writeFileSync(
    join(projectDirectory, 'package.json'),
    `${JSON.stringify(isolatedManifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  )
  writeFileSync(join(projectDirectory, 'verify-installed.mjs'), installedVerifier, {
    encoding: 'utf8',
    flag: 'wx',
  })
  writeFileSync(join(projectDirectory, 'verify-client.mjs'), clientVerifier, {
    encoding: 'utf8',
    flag: 'wx',
  })
  writeFileSync(join(projectDirectory, 'consumer-host.ts'), hostConsumerSource, {
    encoding: 'utf8',
    flag: 'wx',
  })
  writeFileSync(join(projectDirectory, 'consumer-client.ts'), clientConsumerSource, {
    encoding: 'utf8',
    flag: 'wx',
  })
  writeFileSync(
    join(projectDirectory, 'tsconfig.host.json'),
    `${JSON.stringify(hostConsumerTsconfig, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  )
  writeFileSync(
    join(projectDirectory, 'tsconfig.client.json'),
    `${JSON.stringify(clientConsumerTsconfig, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  )

  runPnpm(
    ['install', '--ignore-scripts', '--no-frozen-lockfile', '--prefer-offline'],
    projectDirectory,
    'isolated tarball install',
  )
  const runtimeVersion = run(runtimeNode, ['--version'], projectDirectory, 'runtime Node verification').stdout.trim()
  run(runtimeNode, ['verify-installed.mjs'], projectDirectory, 'installed package verification')
  run(runtimeNode, ['verify-client.mjs'], projectDirectory, 'installed Client verification')
  runPnpm(
    ['exec', 'tsc', '--project', 'tsconfig.host.json', '--pretty', 'false'],
    projectDirectory,
    'installed Host declaration consumer smoke',
  )
  runPnpm(
    ['exec', 'tsc', '--project', 'tsconfig.client.json', '--pretty', 'false'],
    projectDirectory,
    'installed Client declaration consumer smoke',
  )

  console.log(
    `Fresh install verified on ${runtimeVersion}: ${metadata.name}@${metadata.version}, Host import, ` +
    'executed Client factory, declarations, patch, and package exports.',
  )
} finally {
  cleanup(temporaryRoot)
}
