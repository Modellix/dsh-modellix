import { readFileSync } from 'node:fs'

import {
  CRITICAL_COVERAGE_THRESHOLDS,
  criticalCoverageFailures,
} from './critical-coverage-support.mjs'

let summary
try {
  summary = JSON.parse(readFileSync(new URL('../coverage/coverage-summary.json', import.meta.url), 'utf8'))
} catch {
  throw new Error('critical coverage verification failed: coverage/coverage-summary.json is unavailable')
}

const failures = criticalCoverageFailures(summary)
if (failures.length > 0) {
  const detail = failures
    .map(failure => `${failure.file} ${failure.metric} ${String(failure.actual)} < ${String(failure.required)}`)
    .join(', ')
  throw new Error(`critical coverage verification failed: ${detail}`)
}
console.log(
  `Critical coverage verified for ${String(Object.keys(CRITICAL_COVERAGE_THRESHOLDS).length)} runtime files.`,
)
