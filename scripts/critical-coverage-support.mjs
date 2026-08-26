export const CRITICAL_COVERAGE_THRESHOLDS = Object.freeze({
  'src/host/runtime.ts': Object.freeze({
    statements: 65,
    branches: 55,
    functions: 69,
    lines: 68,
  }),
  'src/design/parameter-planner.ts': Object.freeze({
    statements: 64,
    branches: 54,
    functions: 73,
    lines: 65,
  }),
})

/**
 * @param {unknown} value
 * @returns {readonly { readonly file: string, readonly metric: string, readonly actual: number, readonly required: number }[]}
 */
export function criticalCoverageFailures(value) {
  if (!isRecord(value)) throw new Error('coverage summary must be an object')
  const files = new Map(
    Object.entries(value)
      .filter(([key]) => key !== 'total')
      .map(([key, summary]) => [key.replaceAll('\\', '/'), summary]),
  )
  const failures = []
  for (const [requiredFile, thresholds] of Object.entries(CRITICAL_COVERAGE_THRESHOLDS)) {
    const match = [...files.entries()].find(([path]) => path.endsWith(`/${requiredFile}`) || path === requiredFile)
    if (match === undefined) throw new Error(`coverage summary omits critical file ${requiredFile}`)
    const summary = record(match[1], `coverage for ${requiredFile}`)
    for (const [metric, required] of Object.entries(thresholds)) {
      const metricSummary = record(summary[metric], `${requiredFile} ${metric}`)
      const actual = metricSummary.pct
      if (typeof actual !== 'number' || !Number.isFinite(actual)) {
        throw new Error(`${requiredFile} ${metric} coverage percentage is invalid`)
      }
      if (actual < required) failures.push({ file: requiredFile, metric, actual, required })
    }
  }
  return Object.freeze(failures.map(failure => Object.freeze(failure)))
}

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function record(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
