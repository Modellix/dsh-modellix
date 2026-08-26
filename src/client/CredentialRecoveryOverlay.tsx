import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

import { CredentialModal } from "./shared.js";
import { OnboardingReadonlyCredentialDialog } from "./Onboarding.js";
import type { SettingsController } from "./store.js";
import { useResourceState } from "./shared.js";

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
  const [dismissedEpoch, setDismissedEpoch] = useState<number | null>(null);
  const invalidEpoch = snapshot?.credential.verification === "invalid"
    ? snapshot.credential.invalidEpoch
    : null;
  const visible = invalidEpoch !== null && invalidEpoch !== dismissedEpoch;

  useEffect(() => {
    if (visible) return;
    const refresh = (): void => {
      const current = controller.store.getSnapshot();
      if (current.pending !== null || current.status === "loading") return;
      void controller.load();
    };
    refresh();
    const timer = window.setInterval(refresh, RECOVERY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [controller, visible]);

  const dismiss = useCallback((): void => {
    if (invalidEpoch !== null) setDismissedEpoch(invalidEpoch);
  }, [invalidEpoch]);

  if (!visible || snapshot === null) return null;
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
      title={t("replaceKey")}
      description={t("errorKeyInvalid")}
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
      onSaved={() => setDismissedEpoch(null)}
      onCancel={dismiss}
      laterLabel="later"
      t={t}
    />
  );
}
