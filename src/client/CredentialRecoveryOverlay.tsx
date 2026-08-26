import { useCallback, useEffect, type ReactNode } from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

import { CredentialModal } from "./shared.js";
import { OnboardingReadonlyCredentialDialog } from "./Onboarding.js";
import type { SettingsController } from "./store.js";
import { useResourceState } from "./shared.js";
import {
  RECOVERY_CREDENTIAL_DIALOG_OWNER,
  credentialDialogCoordinatorFor,
  useCredentialDialogSnapshot,
} from "./credential-dialog.js";

const RECOVERY_REFRESH_MS = 5_000;

export type CredentialRecoveryOverlayProps = PropsRuntime<"shell.overlay"> &
  PropsLocale<"modellix"> & {
    readonly controller: SettingsController;
  };

/** Persistent root seat that turns the first current-epoch 401 into one Modal. */
export function CredentialRecoveryOverlay({
  controller,
  t,
}: CredentialRecoveryOverlayProps): ReactNode {
  const state = useResourceState(controller.store);
  const snapshot = state.data;
  const dialogCoordinator = credentialDialogCoordinatorFor(controller);
  const dialog = useCredentialDialogSnapshot(dialogCoordinator);
  const invalidEpoch = snapshot?.credential.verification === "invalid"
    ? snapshot.credential.invalidEpoch
    : null;
  const recoveryRequestId = snapshot?.onboarding.recoveryRequestId ?? null;
  const recoveryToken = recoveryRequestId ?? (
    invalidEpoch === null ? null : `invalid:${String(invalidEpoch)}`
  );
  const needsCredential = snapshot !== null && (
    !snapshot.credential.configured || snapshot.credential.verification === "invalid"
  );
  const recoveryPresented =
    needsCredential &&
    recoveryToken !== null &&
    recoveryToken === dialog.recoveryToken &&
    recoveryToken !== dialog.dismissedRecoveryToken;

  useEffect(() => {
    if (!needsCredential || recoveryToken === null) {
      dialogCoordinator.clearRecovery();
      return;
    }
    dialogCoordinator.presentRecovery(recoveryToken);
  }, [dialogCoordinator, needsCredential, recoveryToken]);

  useEffect(() => {
    if (recoveryPresented) return;
    const refresh = (): void => {
      const current = controller.store.getSnapshot();
      if (current.pending !== null || current.status === "loading") return;
      void controller.load();
    };
    refresh();
    const timer = window.setInterval(refresh, RECOVERY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [controller, recoveryPresented]);

  useEffect(
    () => () => dialogCoordinator.release(RECOVERY_CREDENTIAL_DIALOG_OWNER),
    [dialogCoordinator],
  );

  const dismiss = useCallback((): void => {
    dialogCoordinator.dismissCredential(RECOVERY_CREDENTIAL_DIALOG_OWNER);
  }, [dialogCoordinator]);

  if (
    !recoveryPresented ||
    dialog.activeOwner !== RECOVERY_CREDENTIAL_DIALOG_OWNER ||
    snapshot === null
  ) {
    return null;
  }
  const credential = snapshot.credential;
  if (!credential.writable || credential.source === "env") {
    return (
      <OnboardingReadonlyCredentialDialog
        open
        busy={false}
        errorCode={null}
        description={
          credential.source === "env"
            ? t("readonlyEnvInvalid")
            : t("credentialReadonly")
        }
        onLater={dismiss}
        t={t}
      />
    );
  }

  return (
    <CredentialModal
      open
      mandatory
      title={credential.configured ? t("replaceKey") : t("onboardingTitle")}
      description={credential.configured ? t("errorKeyInvalid") : t("keyRequired")}
      busy={state.pending === "replace-credential"}
      errorCode={
        state.errorOperation === "replace-credential" ? state.errorCode : null
      }
      onSave={(apiKey) =>
        controller.replaceCredential(
          apiKey,
          credential.credentialEpoch,
          snapshot.services,
        )
      }
      onSaved={() =>
        dialogCoordinator.completeCredential(RECOVERY_CREDENTIAL_DIALOG_OWNER)
      }
      onCancel={dismiss}
      laterLabel="later"
      t={t}
    />
  );
}
