import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";

import type { ServiceTogglesWire } from "./contracts.js";
import { CredentialModal, DEFAULT_SERVICES, useResourceState } from "./shared.js";
import type { SettingsController } from "./store.js";

export type ModellixOnboardingProps = PropsRuntime<"settings.onboarding"> &
  PropsLocale<"modellix"> & {
    readonly controller: SettingsController;
  };

export function ModellixOnboarding({
  complete,
  controller,
  t,
}: ModellixOnboardingProps): ReactNode {
  const state = useResourceState(controller.store);
  const [services, setServices] = useState<ServiceTogglesWire>(DEFAULT_SERVICES);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (controller.store.getSnapshot().status !== "idle") return;
    const abort = new AbortController();
    void controller.load(abort.signal);
    return () => abort.abort();
  }, [controller]);

  const snapshot = state.data;
  useEffect(() => {
    if (snapshot === null) return;
    setServices(snapshot.services);
    if (
      snapshot.credential.configured &&
      snapshot.credential.verification !== "invalid" &&
      !snapshot.onboarding.recoveryPending
    ) {
      complete();
    }
  }, [complete, snapshot]);

  const save = useCallback(
    async (apiKey: string): Promise<boolean> => {
      if (snapshot === null) return false;
      return controller.saveOnboarding(
        apiKey,
        services,
        snapshot.credential.credentialEpoch,
      );
    },
    [controller, services, snapshot],
  );

  const defer = useCallback((): void => {
    if (snapshot === null || state.pending !== null) return;
    setOpen(false);
    void controller
      .deferOnboarding(services, snapshot.settingsRevision)
      .then((accepted) => {
        if (accepted) complete();
        else setOpen(true);
      });
  }, [complete, controller, services, snapshot, state.pending]);

  if (snapshot === null) return null;
  if (
    snapshot.credential.configured &&
    snapshot.credential.verification !== "invalid" &&
    !snapshot.onboarding.recoveryPending
  ) {
    return null;
  }

  return (
    <CredentialModal
      open={open}
      mandatory
      title={t("onboardingTitle")}
      description={t("onboardingDescription")}
      services={services}
      onServicesChange={setServices}
      busy={state.pending === "save-onboarding" || state.pending === "defer-onboarding"}
      errorCode={state.errorCode}
      onSave={save}
      onSaved={complete}
      onCancel={defer}
      laterLabel="later"
      t={t}
    />
  );
}
