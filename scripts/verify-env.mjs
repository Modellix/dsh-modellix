import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const expected = Object.freeze({
  node: '24.18.1',
  nodeEngine: '^22.19.0 || >=24.0.0',
  pnpm: '11.24.0',
  dsh: '0.1.1-rc.2',
  cordis: '4.0.1',
  schemastery: '3.18.1',
})

const harnessPeers = Object.freeze([
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-anonymous-user-id',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-host-apiproxy',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-web',
])

const authoringOnly = Object.freeze([
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
])

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(`environment verification failed: ${message}`)
}

/**
 * @param {string} command
 * @param {string[]} [args]
 * @returns {string}
 */
function commandVersion(command, args = ['--version']) {
  const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : command
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', `${command}.cmd`, ...args]
    : args
  const result = spawnSync(executable, commandArgs, {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error !== undefined) fail(`${command} is unavailable (${result.error.message})`)
  if (result.status !== 0) fail(`${command} exited with status ${String(result.status)}`)
  return result.stdout.trim()
}

/** @returns {string} */
function activePnpmVersion() {
  const userAgent = process.env.npm_config_user_agent
  const match = typeof userAgent === 'string' ? /^pnpm\/([^\s]+)(?:\s|$)/u.exec(userAgent) : null
  return match?.[1] ?? commandVersion('pnpm')
}

/**
 * @param {string} label
 * @param {unknown} actual
 * @param {string} wanted
 */
function assertVersion(label, actual, wanted) {
  if (actual !== wanted) fail(`${label} must be ${wanted}, received ${actual}`)
}

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

assertVersion('Node.js', process.versions.node, expected.node)
assertVersion('pnpm', activePnpmVersion(), expected.pnpm)
assertVersion('DSH', commandVersion('dsh'), expected.dsh)
assertVersion('packageManager', packageJson.packageManager, `pnpm@${expected.pnpm}`)
assertVersion('engines.node', packageJson.engines?.node, expected.nodeEngine)
assertVersion('engines.pnpm', packageJson.engines?.pnpm, expected.pnpm)
assertVersion('devEngines.runtime.version', packageJson.devEngines?.runtime?.version, expected.node)
assertVersion('devEngines.packageManager.version', packageJson.devEngines?.packageManager?.version, expected.pnpm)
assertVersion('dependencies.@deepseek-ai/schemastery', packageJson.dependencies?.['@deepseek-ai/schemastery'], expected.schemastery)
assertVersion('peerDependencies.@deepseek-ai/cordis', packageJson.peerDependencies?.['@deepseek-ai/cordis'], expected.cordis)
assertVersion('devDependencies.@deepseek-ai/cordis', packageJson.devDependencies?.['@deepseek-ai/cordis'], expected.cordis)

for (const name of harnessPeers) {
  assertVersion(`peerDependencies.${name}`, packageJson.peerDependencies?.[name], expected.dsh)
  assertVersion(`devDependencies.${name}`, packageJson.devDependencies?.[name], expected.dsh)
}

const uncheckedHarnessPeers = Object.keys(packageJson.peerDependencies ?? {})
  .filter(name => name.startsWith('@deepseek-ai/dsh-') && !harnessPeers.includes(name))
if (uncheckedHarnessPeers.length > 0) {
  fail(`runtime DSH peers must be added to fixed verification: ${uncheckedHarnessPeers.join(', ')}`)
}

for (const name of authoringOnly) {
  assertVersion(`devDependencies.${name}`, packageJson.devDependencies?.[name], expected.dsh)
  if (packageJson.peerDependencies?.[name] !== undefined) fail(`${name} must remain authoring-only, not a runtime peer`)
}

if (packageJson.dependencies?.['@deepseek-ai/dsh'] !== undefined || packageJson.devDependencies?.['@deepseek-ai/dsh'] !== undefined) {
  fail('@deepseek-ai/dsh must be provisioned as the acceptance CLI, not installed into the plugin dependency graph')
}

console.log(`Environment verified: Node ${expected.node}, pnpm ${expected.pnpm}, DSH ${expected.dsh}.`)
