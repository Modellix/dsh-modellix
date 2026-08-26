export const RELEASE_EVIDENCE_MAX_AGE_MS = 72 * 60 * 60 * 1_000

export const RELEASE_EVIDENCE_CHECKS = Object.freeze({
  browser: Object.freeze([
    'onboarding',
    'settings',
    'design',
    'llm',
    'web',
    '401',
    'a11y',
    'theme',
    'viewports',
  ]),
  'api-agent': Object.freeze([
    'catalogs',
    'planner',
    'image',
    'video',
    'audio',
    'llm-agent',
    'web',
  ]),
})

const FORBIDDEN_EVIDENCE_KEY = /(?:api[-_]?key|authorization|credential|password|secret|token)/iu

/**
 * @typedef {'browser' | 'api-agent'} ReleaseEvidenceKind
 */

/**
 * Validate a Secret-free, commit-bound release attestation.
 *
 * @param {unknown} value
 * @param {{
 *   readonly kind: ReleaseEvidenceKind,
 *   readonly packageName: string,
 *   readonly packageVersion: string,
 *   readonly commit: string,
 *   readonly now: number,
 * }} expected
 * @returns {{ readonly kind: ReleaseEvidenceKind, readonly completedAt: string }}
 */
export function validateReleaseEvidence(value, expected) {
  assertNoSecretFields(value)
  const root = record(value, `${expected.kind} evidence`)
  assertExactKeys(
    root,
    expected.kind === 'api-agent'
      ? [
          'version',
          'kind',
          'status',
          'package',
          'commit',
          'completedAt',
          'checks',
          'billedCallsExplicitlyAuthorized',
        ]
      : ['version', 'kind', 'status', 'package', 'commit', 'completedAt', 'checks'],
    `${expected.kind} evidence`,
  )
  if (root.version !== 1) throw new Error(`${expected.kind} evidence version must be 1`)
  if (root.kind !== expected.kind) throw new Error(`${expected.kind} evidence kind is invalid`)
  if (root.status !== 'passed') throw new Error(`${expected.kind} evidence did not pass`)

  const packageIdentity = record(root.package, `${expected.kind} package identity`)
  assertExactKeys(packageIdentity, ['name', 'version'], `${expected.kind} package identity`)
  if (
    packageIdentity.name !== expected.packageName ||
    packageIdentity.version !== expected.packageVersion
  ) {
    throw new Error(`${expected.kind} evidence targets another package release`)
  }
  if (root.commit !== expected.commit || !/^[0-9a-f]{40}$/u.test(expected.commit)) {
    throw new Error(`${expected.kind} evidence targets another Git commit`)
  }
  if (typeof root.completedAt !== 'string') {
    throw new Error(`${expected.kind} evidence completedAt is invalid`)
  }
  const completedAt = Date.parse(root.completedAt)
  if (!Number.isFinite(completedAt) || new Date(completedAt).toISOString() !== root.completedAt) {
    throw new Error(`${expected.kind} evidence completedAt must be canonical UTC ISO-8601`)
  }
  if (completedAt > expected.now + 5 * 60 * 1_000) {
    throw new Error(`${expected.kind} evidence is dated in the future`)
  }
  if (expected.now - completedAt > RELEASE_EVIDENCE_MAX_AGE_MS) {
    throw new Error(`${expected.kind} evidence is older than 72 hours`)
  }
  validateChecks(root.checks, expected.kind)
  if (
    expected.kind === 'api-agent' &&
    root.billedCallsExplicitlyAuthorized !== true
  ) {
    throw new Error('api-agent evidence must attest explicit billed-call authorization')
  }
  return Object.freeze({ kind: expected.kind, completedAt: root.completedAt })
}

/**
 * @param {unknown} value
 * @param {ReleaseEvidenceKind} kind
 */
function validateChecks(value, kind) {
  const checks = record(value, `${kind} checks`)
  const required = RELEASE_EVIDENCE_CHECKS[kind]
  assertExactKeys(checks, required, `${kind} checks`)
  for (const check of required) {
    if (checks[check] !== 'passed') {
      throw new Error(`${kind} evidence check ${check} did not pass`)
    }
  }
}

/**
 * @param {unknown} value
 * @param {Set<unknown>} [seen]
 */
function assertNoSecretFields(value, seen = new Set()) {
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretFields(item, seen)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_EVIDENCE_KEY.test(key)) {
      throw new Error('release evidence must not contain Secret-shaped fields')
    }
    assertNoSecretFields(child, seen)
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} expected
 * @param {string} label
 */
function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields must be exactly [${wanted.join(', ')}]`)
  }
}
