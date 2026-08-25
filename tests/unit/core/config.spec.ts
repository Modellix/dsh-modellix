import { describe, expect, it } from "vitest";

import {
  OnboardingSaveConflictError,
  UnsupportedConfigVersionError,
  beginOnboardingSave,
  completeOnboardingSave,
  createDefaultConfig,
  deferOnboarding,
  getServiceToggles,
  markOnboardingCredentialSaved,
  migrateConfig,
  reconcileOnboardingSave,
} from "../../../src/core/config.js";

describe("core config", () => {
  it("defaults all three services on without a Credential", () => {
    const config = createDefaultConfig();

    expect(getServiceToggles(config)).toEqual({
      design: true,
      llm: true,
      web: true,
    });
    expect(config.credentialEpoch).toBe(0);
    expect(config.onboarding).toEqual({ status: "active", saveRecovery: null });
  });

  it("fills missing fields without overwriting explicit false values", () => {
    const config = migrateConfig({
      schemaVersion: 0,
      services: {
        design: { enabled: false },
        web: { enabled: false },
      },
    });

    expect(getServiceToggles(config)).toEqual({
      design: false,
      llm: true,
      web: false,
    });
  });

  it("migrates a legacy Web-only enabled flag idempotently", () => {
    const first = migrateConfig({ enabled: false });
    const second = migrateConfig(first);

    expect(first.services.web.enabled).toBe(false);
    expect(first.services.design.enabled).toBe(true);
    expect(second).toEqual(first);
  });

  it("rejects an unknown future schema instead of silently downgrading", () => {
    expect(() => migrateConfig({ schemaVersion: 2 })).toThrow(
      UnsupportedConfigVersionError,
    );
  });

  it("persists a two-phase onboarding save without candidate Secret data", () => {
    const started = beginOnboardingSave(createDefaultConfig(), {
      operationId: "save_op_1234",
      startedAt: 1_000,
      expectedCredentialRevision: "revision-before",
      intendedServices: { design: true, llm: false, web: true },
    });

    expect(started.onboarding.saveRecovery).toEqual({
      operationId: "save_op_1234",
      phase: "credential-write-pending",
      startedAt: 1_000,
      intendedServices: { design: true, llm: false, web: true },
      expectedCredentialEpoch: 0,
      expectedCredentialRevision: "revision-before",
      confirmedCredentialRevision: null,
    });
    expect(JSON.stringify(started)).not.toContain("apiKey");

    const credentialSaved = markOnboardingCredentialSaved(
      started,
      "save_op_1234",
      "revision-after",
    );
    expect(credentialSaved.credentialEpoch).toBe(1);
    expect(credentialSaved.onboarding.saveRecovery?.phase).toBe(
      "settings-write-pending",
    );

    const completed = completeOnboardingSave(
      credentialSaved,
      "save_op_1234",
    );
    expect(getServiceToggles(completed)).toEqual({
      design: true,
      llm: false,
      web: true,
    });
    expect(completed.onboarding).toEqual({
      status: "completed",
      saveRecovery: null,
    });
    expect(completeOnboardingSave(completed, "save_op_1234")).toBe(completed);
  });

  it("reconciles a crash after the Credential write from revision evidence", () => {
    const started = beginOnboardingSave(createDefaultConfig(), {
      operationId: "save_op_5678",
      startedAt: 2_000,
      expectedCredentialRevision: "old-revision",
      intendedServices: { design: false, llm: true, web: false },
    });

    const unchanged = reconcileOnboardingSave(started, "old-revision");
    expect(unchanged.action).toBe("await-credential-write");
    expect(unchanged.config).toBe(started);

    const recovered = reconcileOnboardingSave(started, "new-revision");
    expect(recovered.action).toBe("commit-intended-settings");
    expect(recovered.config.credentialEpoch).toBe(1);

    const completed = completeOnboardingSave(
      recovered.config,
      "save_op_5678",
    );
    expect(getServiceToggles(completed)).toEqual({
      design: false,
      llm: true,
      web: false,
    });
  });

  it("requires reconciliation when an interrupted write has no revision evidence", () => {
    const started = beginOnboardingSave(createDefaultConfig(), {
      operationId: "save_op_9012",
      startedAt: 3_000,
      expectedCredentialRevision: null,
      intendedServices: { design: true, llm: true, web: false },
    });

    expect(reconcileOnboardingSave(started, null).action).toBe(
      "needs-user-reconciliation",
    );
  });

  it("persists explicit service choices when onboarding is deferred", () => {
    const deferred = deferOnboarding(createDefaultConfig(), {
      design: false,
      llm: true,
      web: false,
    });

    expect(deferred.onboarding.status).toBe("deferred");
    expect(getServiceToggles(deferred)).toEqual({
      design: false,
      llm: true,
      web: false,
    });
  });

  it("does not allow a second save to overwrite recovery state", () => {
    const started = beginOnboardingSave(createDefaultConfig(), {
      operationId: "save_op_3456",
      startedAt: 4_000,
      expectedCredentialRevision: null,
      intendedServices: { design: true, llm: true, web: true },
    });

    expect(() =>
      beginOnboardingSave(started, {
        operationId: "save_op_7890",
        startedAt: 4_001,
        expectedCredentialRevision: null,
        intendedServices: { design: false, llm: false, web: false },
      }),
    ).toThrow(OnboardingSaveConflictError);
  });
});
