import { describe, expect, it } from "vitest";

import {
  CRITICAL_COVERAGE_THRESHOLDS,
  criticalCoverageFailures,
} from "../../../scripts/critical-coverage-support.mjs";

function metrics(percentage: number) {
  return {
    statements: { pct: percentage },
    branches: { pct: percentage },
    functions: { pct: percentage },
    lines: { pct: percentage },
  };
}

function passingSummary(): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(CRITICAL_COVERAGE_THRESHOLDS).map((path) => [
      `D:\\workspace\\${path.replaceAll("/", "\\")}`,
      metrics(100),
    ]),
  );
}

describe("critical coverage gate", () => {
  it("accepts every critical file at or above its thresholds", () => {
    expect(criticalCoverageFailures(passingSummary())).toEqual([]);
  });

  it("reports a metric below its file-specific floor", () => {
    const summary = passingSummary();
    const runtime = Object.keys(summary).find((path) =>
      path.endsWith("src\\host\\runtime.ts")
    );
    expect(runtime).toBeDefined();
    summary[runtime!] = {
      ...metrics(100),
      branches: { pct: 54.99 },
    };
    expect(criticalCoverageFailures(summary)).toEqual([
      {
        file: "src/host/runtime.ts",
        metric: "branches",
        actual: 54.99,
        required: 55,
      },
    ]);
  });

  it("fails closed when a critical file is absent", () => {
    expect(() => criticalCoverageFailures({ total: metrics(100) }))
      .toThrow(/omits critical file/u);
  });
});
