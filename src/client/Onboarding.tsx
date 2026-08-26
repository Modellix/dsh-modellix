import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";

import { useDialogA11y } from "./a11y.js";
import type { ServiceTogglesWire } from "./contracts.js";
import { shouldPromptOnboarding } from "./onboarding-state.js";
import {
  BusyStatus,
  CredentialModal,
  DEFAULT_SERVICES,
  ErrorNotice,
  useResourceState,
  type ModellixTranslate,
} from "./shared.js";
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
  const [loadRecoveryVisible, setLoadRecoveryVisible] = useState(false);

  useEffect(() => {
    if (controller.store.getSnapshot().status !== "idle") return;
    const abort = new AbortController();
    void controller.load(abort.signal);
    return () => abort.abort();
  }, [controller]);

  const snapshot = state.data;
  const promptRequired = snapshot === null ? false : shouldPromptOnboarding(snapshot);
  useEffect(() => {
    if (snapshot === null && state.status === "error") {
      setLoadRecoveryVisible(true);
    }
  }, [snapshot, state.status]);
  useEffect(() => {
    if (snapshot === null) return;
    setServices(snapshot.services);
    if (!promptRequired) complete();
  }, [complete, promptRequired, snapshot]);

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
    void controller
      .deferOnboarding(services, snapshot.settingsRevision)
      .then((accepted) => {
        if (!accepted) return;
        setOpen(false);
        complete();
      });
  }, [complete, controller, services, snapshot, state.pending]);

  if (snapshot === null) {
    if (!loadRecoveryVisible) return null;
    return (
      <OnboardingLoadRecoveryDialog
        busy={state.pending === "load"}
        errorCode={state.errorOperation === "load" ? state.errorCode : null}
        onRetry={() => { void controller.load(); }}
        onLater={complete}
        t={t}
      />
    );
  }
  if (!promptRequired) return null;

  if (!snapshot.credential.writable) {
    return (
      <OnboardingReadonlyCredentialDialog
        open={open}
        busy={state.pending === "defer-onboarding"}
        errorCode={
          state.errorOperation === "defer-onboarding" ? state.errorCode : null
        }
        description={
          snapshot.credential.source === "env"
            ? t("readonlyEnvInvalid")
            : t("credentialReadonly")
        }
        onLater={defer}
        t={t}
      />
    );
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
      errorCode={
        state.errorOperation === "save-onboarding" ||
          state.errorOperation === "defer-onboarding"
          ? state.errorCode
          : null
      }
      onSave={save}
      onSaved={complete}
      onCancel={defer}
      laterLabel="later"
      t={t}
    />
  );
}

function OnboardingLoadRecoveryDialog({
  busy,
  errorCode,
  onRetry,
  onLater,
  t,
}: {
  busy: boolean;
  errorCode: string | null;
  onRetry: () => void;
  onLater: () => void;
  t: ModellixTranslate;
}): ReactNode {
  const contentRef = useRef<HTMLDivElement | null>(null);
  useDialogA11y({
    open: true,
    container: contentRef,
    initialFocusSelector: "[data-mdlx-initial-focus]",
    mandatory: true,
    onEscape: onLater,
  });
  return (
    <Modal
      open
      title={t("onboardingLoadErrorTitle")}
      onClose={() => undefined}
      headless
      className="mdlx-modal mdlx-modal-confirm"
    >
      <div ref={contentRef} className="mdlx-modal-content" tabIndex={-1}>
        <div className="mdlx-heading">
          <h2 className="mdlx-modal-title">{t("onboardingLoadErrorTitle")}</h2>
          <p className="mdlx-modal-description">{t("onboardingLoadErrorDescription")}</p>
        </div>
        <ErrorNotice code={errorCode} t={t} />
        <div className="mdlx-actions">
          <Button type="button" variant="outline" onClick={onLater}>
            {t("later")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            aria-busy={busy}
            data-mdlx-initial-focus=""
            onClick={onRetry}
          >
            {busy ? t("loading") : t("retry")}
          </Button>
        </div>
        <BusyStatus busy={busy} text={t("loading")} />
      </div>
    </Modal>
  );
}

export function OnboardingReadonlyCredentialDialog({
  open,
  busy,
  errorCode,
  description,
  onLater,
  t,
}: {
  open: boolean;
  busy: boolean;
  errorCode: string | null;
  description: string;
  onLater: () => void;
  t: ModellixTranslate;
}): ReactNode {
  const contentRef = useRef<HTMLDivElement | null>(null);
  useDialogA11y({
    open,
    container: contentRef,
    initialFocusSelector: "[data-mdlx-initial-focus]",
    mandatory: true,
    onEscape: onLater,
  });
  return (
    <Modal
      open={open}
      title={t("readonlyKeyTitle")}
      onClose={() => undefined}
      headless
      className="mdlx-modal mdlx-modal-confirm"
    >
      <div ref={contentRef} className="mdlx-modal-content" tabIndex={-1}>
        <div className="mdlx-heading">
          <h2 className="mdlx-modal-title">{t("readonlyKeyTitle")}</h2>
          <p className="mdlx-modal-description">{description}</p>
        </div>
        <ErrorNotice code={errorCode} t={t} />
        <div className="mdlx-actions">
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            aria-busy={busy}
            data-mdlx-initial-focus=""
            onClick={onLater}
          >
            {busy ? t("saving") : t("later")}
          </Button>
        </div>
        <BusyStatus busy={busy} text={t("saving")} />
      </div>
    </Modal>
  );
}
