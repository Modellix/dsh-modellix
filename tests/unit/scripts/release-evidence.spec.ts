import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  RELEASE_EVIDENCE_CHECKS,
  RELEASE_EVIDENCE_MAX_AGE_MS,
  validateReleaseEvidence,
} from "../../../scripts/release-evidence-support.mjs";

const NOW = Date.UTC(2026, 7, 26, 8, 0, 0);
const COMMIT = "a".repeat(40);

function evidence(kind: "browser" | "api-agent"): Record<string, unknown> {
  return {
    version: 1,
    kind,
    status: "passed",
    package: { name: "dsh-modellix", version: "0.1.0" },
    commit: COMMIT,
    completedAt: new Date(NOW - 60_000).toISOString(),
    checks: Object.fromEntries(
      RELEASE_EVIDENCE_CHECKS[kind].map((check) => [check, "passed"]),
    ),
    ...(kind === "api-agent"
      ? { billedCallsExplicitlyAuthorized: true }
      : {}),
  };
}

function expected(kind: "browser" | "api-agent") {
  return {
    kind,
    packageName: "dsh-modellix",
    packageVersion: "0.1.0",
    commit: COMMIT,
    now: NOW,
  } as const;
}

describe("release evidence validation", () => {
  it("accepts fresh browser and explicitly authorized API/Agent evidence", () => {
    expect(validateReleaseEvidence(evidence("browser"), expected("browser")))
      .toEqual({
        kind: "browser",
        completedAt: new Date(NOW - 60_000).toISOString(),
      });
    expect(validateReleaseEvidence(evidence("api-agent"), expected("api-agent")))
      .toMatchObject({ kind: "api-agent" });
  });

  it("binds evidence to the package release and exact Git commit", () => {
    expect(() =>
      validateReleaseEvidence(
        { ...evidence("browser"), commit: "b".repeat(40) },
        expected("browser"),
      )
    ).toThrow(/another Git commit/u);
    expect(() =>
      validateReleaseEvidence(
        {
          ...evidence("browser"),
          package: { name: "another-package", version: "0.1.0" },
        },
        expected("browser"),
      )
    ).toThrow(/another package release/u);
  });

  it("rejects stale evidence and API evidence without explicit billing authorization", () => {
    expect(() =>
      validateReleaseEvidence(
        {
          ...evidence("browser"),
          completedAt: new Date(NOW - RELEASE_EVIDENCE_MAX_AGE_MS - 1).toISOString(),
        },
        expected("browser"),
      )
    ).toThrow(/older than 72 hours/u);
    expect(() =>
      validateReleaseEvidence(
        {
          ...evidence("api-agent"),
          billedCallsExplicitlyAuthorized: false,
        },
        expected("api-agent"),
      )
    ).toThrow(/explicit billed-call authorization/u);
  });

  it("requires the complete fixed check set for each evidence kind", () => {
    const browser = evidence("browser");
    const browserChecks = { ...(browser.checks as Record<string, unknown>) };
    delete browserChecks.viewports;
    expect(() =>
      validateReleaseEvidence(
        { ...browser, checks: browserChecks },
        expected("browser"),
      )
    ).toThrow(/checks fields must be exactly/u);

    expect(() =>
      validateReleaseEvidence(
        {
          ...evidence("api-agent"),
          checks: {
            ...(evidence("api-agent").checks as Record<string, unknown>),
            audio: "failed",
          },
        },
        expected("api-agent"),
      )
    ).toThrow(/check audio did not pass/u);
  });

  it("rejects unknown root, package, and check fields", () => {
    expect(() =>
      validateReleaseEvidence(
        { ...evidence("browser"), notes: "not part of the attestation" },
        expected("browser"),
      )
    ).toThrow(/evidence fields must be exactly/u);
    expect(() =>
      validateReleaseEvidence(
        {
          ...evidence("browser"),
          package: {
            name: "dsh-modellix",
            version: "0.1.0",
            channel: "latest",
          },
        },
        expected("browser"),
      )
    ).toThrow(/package identity fields must be exactly/u);
    expect(() =>
      validateReleaseEvidence(
        {
          ...evidence("browser"),
          checks: {
            ...(evidence("browser").checks as Record<string, unknown>),
            screenshots: "passed",
          },
        },
        expected("browser"),
      )
    ).toThrow(/checks fields must be exactly/u);
  });

  it("rejects Secret-shaped evidence fields before inspecting their values", () => {
    expect(() =>
      validateReleaseEvidence(
        { ...evidence("browser"), apiKey: "synthetic-test-value" },
        expected("browser"),
      )
    ).toThrow(/must not contain Secret-shaped fields/u);
  });

  it("fails explicitly when controlled evidence is absent", () => {
    const environment = { ...process.env };
    delete environment.MODELLIX_BROWSER_EVIDENCE_FILE;
    delete environment.MODELLIX_API_AGENT_E2E_EVIDENCE_FILE;
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-release-evidence.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: environment,
        windowsHide: true,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODELLIX_BROWSER_EVIDENCE_FILE");
    expect(result.stderr).toContain("verify:release:static");
  });
});
