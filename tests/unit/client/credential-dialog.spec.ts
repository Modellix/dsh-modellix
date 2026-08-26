import { describe, expect, it, vi } from "vitest";

import {
  CredentialDialogCoordinator,
  RECOVERY_CREDENTIAL_DIALOG_OWNER,
  credentialDialogCoordinatorFor,
} from "../../../src/client/credential-dialog.js";
import type { SettingsController } from "../../../src/client/store.js";

describe("Credential dialog coordinator", () => {
  it("keeps one lease, queues recovery, and transfers it after an ordinary Modal closes", () => {
    const coordinator = new CredentialDialogCoordinator();
    const listener = vi.fn();
    const unsubscribe = coordinator.subscribe(listener);

    coordinator.open("settings-remove");
    coordinator.open("design-image");
    expect(coordinator.getSnapshot().activeOwner).toBe("settings-remove");

    coordinator.presentRecovery("recovery_current");
    expect(coordinator.getSnapshot()).toMatchObject({
      activeOwner: "settings-remove",
      recoveryToken: "recovery_current",
    });

    coordinator.close("settings-remove");
    expect(coordinator.getSnapshot().activeOwner).toBe(
      RECOVERY_CREDENTIAL_DIALOG_OWNER,
    );
    coordinator.release(RECOVERY_CREDENTIAL_DIALOG_OWNER);
    expect(coordinator.getSnapshot().activeOwner).toBeNull();

    coordinator.presentRecovery("recovery_current");
    expect(coordinator.getSnapshot().activeOwner).toBe(
      RECOVERY_CREDENTIAL_DIALOG_OWNER,
    );
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("dismisses only the current recovery token and accepts a later token", () => {
    const coordinator = new CredentialDialogCoordinator();
    coordinator.presentRecovery("recovery_first");
    coordinator.dismissCredential(RECOVERY_CREDENTIAL_DIALOG_OWNER);
    expect(coordinator.getSnapshot()).toMatchObject({
      activeOwner: null,
      recoveryToken: null,
      dismissedRecoveryToken: "recovery_first",
    });

    coordinator.presentRecovery("recovery_first");
    expect(coordinator.getSnapshot().activeOwner).toBeNull();
    coordinator.presentRecovery("recovery_second");
    expect(coordinator.getSnapshot()).toMatchObject({
      activeOwner: RECOVERY_CREDENTIAL_DIALOG_OWNER,
      recoveryToken: "recovery_second",
      dismissedRecoveryToken: null,
    });
    coordinator.completeCredential(RECOVERY_CREDENTIAL_DIALOG_OWNER);
    expect(coordinator.getSnapshot().dismissedRecoveryToken).toBe("recovery_second");
    coordinator.clearRecovery();
    expect(coordinator.getSnapshot()).toMatchObject({
      recoveryToken: null,
      dismissedRecoveryToken: null,
    });
  });

  it("lets an explicit credential editor adopt a queued shell recovery", () => {
    const coordinator = new CredentialDialogCoordinator();
    coordinator.presentRecovery("missing:1");

    coordinator.openCredential("settings-editor");

    expect(coordinator.getSnapshot()).toMatchObject({
      activeOwner: "settings-editor",
      recoveryToken: "missing:1",
    });
    coordinator.release("settings-editor");
    expect(coordinator.getSnapshot().activeOwner).toBe(
      RECOVERY_CREDENTIAL_DIALOG_OWNER,
    );
  });

  it("preserves a proactive owner when recovery clears and shares one instance per controller", () => {
    const coordinator = new CredentialDialogCoordinator();
    coordinator.open("settings-editor");
    coordinator.presentRecovery("recovery_transient");
    coordinator.clearRecovery();
    expect(coordinator.getSnapshot()).toMatchObject({
      activeOwner: "settings-editor",
      recoveryToken: null,
    });
    coordinator.release("settings-editor");
    expect(coordinator.getSnapshot().activeOwner).toBeNull();

    const firstController = {} as SettingsController;
    const secondController = {} as SettingsController;
    expect(credentialDialogCoordinatorFor(firstController)).toBe(
      credentialDialogCoordinatorFor(firstController),
    );
    expect(credentialDialogCoordinatorFor(secondController)).not.toBe(
      credentialDialogCoordinatorFor(firstController),
    );
  });
});
