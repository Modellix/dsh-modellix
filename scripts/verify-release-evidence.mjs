import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateReleaseEvidence } from './release-evidence-support.mjs'

const packageRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
/** @type {readonly { readonly kind: 'browser' | 'api-agent', readonly environment: string }[]} */
const evidenceInputs = Object.freeze([
  { kind: 'browser', environment: 'MODELLIX_BROWSER_EVIDENCE_FILE' },
  { kind: 'api-agent', environment: 'MODELLIX_API_AGENT_E2E_EVIDENCE_FILE' },
])

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(`release evidence gate failed: ${message}`)
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  const result = spawnSync('git', args, {
    cwd: packageRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error !== undefined) fail(`Git could not start (${result.error.message})`)
  if (result.status !== 0) fail(`Git exited with status ${String(result.status)}`)
  return result.stdout.trim()
}

/**
 * @param {string} environment
 * @returns {unknown}
 */
function readEvidence(environment) {
  const configured = process.env[environment]
  if (typeof configured !== 'string' || configured.length === 0) {
    fail(
      `set ${environment} to a Secret-free JSON attestation outside the repository; ` +
      'run verify:release:static when browser or real API/Agent evidence is not yet available',
    )
  }
  if (!isAbsolute(configured)) fail(`${environment} must be an absolute path`)
  let evidencePath
  try {
    evidencePath = realpathSync(configured)
  } catch {
    fail(`${environment} does not resolve to a readable file`)
  }
  const fromPackage = relative(packageRoot, evidencePath)
  if (
    fromPackage.length === 0 ||
    (fromPackage !== '..' && !fromPackage.startsWith(`..${sep}`) && !isAbsolute(fromPackage))
  ) {
    fail(`${environment} must remain outside the repository`)
  }
  if (statSync(evidencePath).size > 32 * 1_024) fail(`${environment} exceeds 32 KiB`)
  try {
    return JSON.parse(readFileSync(evidencePath, 'utf8'))
  } catch {
    fail(`${environment} must contain valid JSON`)
  }
}

const commit = git(['rev-parse', 'HEAD'])
const now = Date.now()
for (const input of evidenceInputs) {
  const evidence = readEvidence(input.environment)
  try {
    validateReleaseEvidence(evidence, {
      kind: input.kind,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      commit,
      now,
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : `${input.kind} evidence is invalid`)
  }
}

if (git(['status', '--porcelain=v1', '--untracked-files=normal']).length > 0) {
  fail('the Git worktree must be clean so evidence remains bound to the exact release commit')
}

console.log(
  `Release evidence verified for ${packageJson.name}@${packageJson.version} at commit ${commit}.`,
)
