import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import {
  Button,
  Modal,
  StateDot,
  type StateDotState,
} from "@deepseek-ai/dsh-client-ui-primitives";

import { useDialogA11y } from "./a11y.js";
import type {
  ServiceTogglesWire,
  SettingsSnapshotWire,
} from "./contracts.js";
import {
  BusyStatus,
  CredentialModal,
  CredentialStatus,
  ErrorNotice,
  ServiceSwitches,
  useResourceState,
  type ModellixTranslate,
} from "./shared.js";
import type { SettingsController } from "./store.js";

export type ModellixSettingsProps = PropsRuntime<"settings.section"> &
  PropsLocale<"modellix"> & {
    readonly controller: SettingsController;
  };

export function ModellixSettingsSection({
  controller,
  t,
}: ModellixSettingsProps): ReactNode {
  const state = useResourceState(controller.store);
  const snapshot = state.data;
  const [services, setServices] = useState<ServiceTogglesWire | null>(null);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (controller.store.getSnapshot().status !== "idle") return;
    const abort = new AbortController();
    void controller.load(abort.signal);
    return () => abort.abort();
  }, [controller]);

  useEffect(() => {
    if (snapshot !== null) setServices(snapshot.services);
  }, [snapshot?.settingsRevision]);

  const busy = state.pending !== null;
  const saveServices = useCallback((): void => {
    if (snapshot === null || services === null || busy) return;
    setAnnouncement("");
    void controller
      .updateToggles(services, snapshot.settingsRevision)
      .then((accepted) => {
        if (accepted) setAnnouncement(t("saved"));
      });
  }, [busy, controller, services, snapshot, t]);

  if (snapshot === null || services === null) {
    return (
      <div className="mdlx-settings">
        <div className="mdlx-live" role="status" aria-live="polite">
          {state.status === "error" ? t("errorGeneric") : t("loading")}
        </div>
        {state.status === "error" && (
          <Button type="button" variant="outline" onClick={() => { void controller.load(); }}>
            {t("retry")}
          </Button>
        )}
      </div>
    );
  }

  const servicesChanged = !sameServices(snapshot.services, services);
  const credential = snapshot.credential;
  const canWriteCredential = credential.writable && credential.source !== "env";
  const llmRefreshDisabled =
    busy || !snapshot.services.llm || !credential.configured;

  return (
    <div className="mdlx-settings">
      <header className="mdlx-heading">
        <h2>{t("settingsTitle")}</h2>
        <p className="mdlx-muted">{t("settingsDescription")}</p>
      </header>

      <section className="mdlx-card" aria-labelledby="mdlx-credential-title">
        <div className="mdlx-card-head">
          <div className="mdlx-heading">
            <h3 id="mdlx-credential-title">{t("credentialTitle")}</h3>
          </div>
          <CredentialStatus
            configured={credential.configured}
            source={credential.source}
            verification={credential.verification}
            t={t}
          />
        </div>
        {credential.source === "env" && (
          <p className="mdlx-muted">{t("envReadonly")}</p>
        )}
        <div className="mdlx-actions mdlx-actions-start">
          {canWriteCredential && (
            <Button
              type="button"
              variant={credential.verification === "invalid" ? "primary" : "outline"}
              disabled={busy}
              onClick={() => setCredentialOpen(true)}
            >
              {credential.configured ? t("replaceKey") : t("configureKey")}
            </Button>
          )}
          {credential.configured && canWriteCredential && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setRemoveOpen(true)}
            >
              {t("removeKey")}
            </Button>
          )}
        </div>
      </section>

      <section className="mdlx-card" aria-labelledby="mdlx-services-title">
        <div className="mdlx-heading">
          <h3 id="mdlx-services-title">{t("serviceTitle")}</h3>
        </div>
        <ServiceSwitches
          value={services}
          disabled={busy}
          onChange={setServices}
          t={t}
        />
        <div className="mdlx-actions">
          <Button
            type="button"
            variant="primary"
            disabled={busy || !servicesChanged}
            aria-busy={state.pending === "save-toggles"}
            onClick={saveServices}
          >
            {state.pending === "save-toggles" ? t("saving") : t("saveChanges")}
          </Button>
        </div>
      </section>

      <LlmCatalogCard
        snapshot={snapshot}
        busy={state.pending === "refresh-llm"}
        disabled={llmRefreshDisabled}
        onRefresh={() => {
          setAnnouncement("");
          void controller.refreshLlmCatalog().then((accepted) => {
            if (accepted) setAnnouncement(t("saved"));
          });
        }}
        t={t}
      />

      <ErrorNotice code={state.errorCode} t={t} />
      <div className="mdlx-live" role="status" aria-live="polite">
        {announcement}
      </div>

      <CredentialModal
        open={credentialOpen}
        mandatory={credential.verification === "invalid"}
        title={credential.configured ? t("replaceKey") : t("configureKey")}
        description={t("onboardingDescription")}
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
        onSaved={() => {
          setCredentialOpen(false);
          setAnnouncement(t("saved"));
        }}
        onCancel={() => setCredentialOpen(false)}
        t={t}
      />

      <RemoveCredentialDialog
        open={removeOpen}
        busy={state.pending === "remove-credential"}
        errorCode={
          state.errorOperation === "remove-credential" ? state.errorCode : null
        }
        onClose={() => setRemoveOpen(false)}
        onConfirm={() => {
          if (state.pending !== null) return;
          void controller
            .removeCredential(credential.credentialEpoch)
            .then((accepted) => {
              if (!accepted) return;
              setRemoveOpen(false);
              setAnnouncement(t("saved"));
            });
        }}
        t={t}
      />
    </div>
  );
}

function LlmCatalogCard({
  snapshot,
  busy,
  disabled,
  onRefresh,
  t,
}: {
  snapshot: SettingsSnapshotWire;
  busy: boolean;
  disabled: boolean;
  onRefresh: () => void;
  t: ModellixTranslate;
}): ReactNode {
  const text = llmHealthText(snapshot.llm.health, t);
  const dot: StateDotState =
    snapshot.llm.health === "ready"
      ? "done"
      : snapshot.llm.health === "error"
        ? "error"
        : snapshot.llm.health === "unknown"
          ? "ongoing"
          : "warning";
  const refreshedAt = useMemo(
    () =>
      snapshot.llm.refreshedAt === null
        ? null
        : new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(snapshot.llm.refreshedAt)),
    [snapshot.llm.refreshedAt],
  );
  return (
    <section className="mdlx-card" aria-labelledby="mdlx-llm-title">
      <div className="mdlx-card-head">
        <div className="mdlx-heading">
          <h3 id="mdlx-llm-title">{t("llmTitle")}</h3>
        </div>
        <div className="mdlx-status-copy">
          <StateDot state={dot} />
          <span>{text}</span>
        </div>
      </div>
      <p className="mdlx-muted">{t("llmModelCount", { count: snapshot.llm.modelCount })}</p>
      {refreshedAt !== null && (
        <p className="mdlx-muted">{t("llmUpdated", { time: refreshedAt })}</p>
      )}
      <div className="mdlx-actions">
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-busy={busy}
          onClick={onRefresh}
        >
          {busy ? t("refreshingLlm") : t("refreshLlm")}
        </Button>
      </div>
      {disabled && !busy && snapshot.llm.health !== "ready" && (
        <p className="mdlx-help">{text}</p>
      )}
    </section>
  );
}

function RemoveCredentialDialog({
  open,
  busy,
  errorCode,
  onClose,
  onConfirm,
  t,
}: {
  open: boolean;
  busy: boolean;
  errorCode: string | null;
  onClose: () => void;
  onConfirm: () => void;
  t: ModellixTranslate;
}): ReactNode {
  const contentRef = useRef<HTMLDivElement | null>(null);
  useDialogA11y({
    open,
    container: contentRef,
    initialFocusSelector: "[data-mdlx-initial-focus]",
    mandatory: false,
    onEscape: onClose,
  });
  return (
    <Modal
      open={open}
      title={t("removeTitle")}
      closeLabel={t("cancel")}
      onClose={onClose}
      headless
      className="mdlx-modal mdlx-modal-confirm"
    >
      <div ref={contentRef} className="mdlx-modal-content" tabIndex={-1}>
        <div className="mdlx-heading">
          <h2 className="mdlx-modal-title">{t("removeTitle")}</h2>
          <p className="mdlx-modal-description">{t("removeDescription")}</p>
        </div>
        {errorCode !== null && <ErrorNotice code={errorCode} t={t} />}
        <div className="mdlx-actions">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            data-mdlx-initial-focus=""
            onClick={onClose}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            aria-busy={busy}
            onClick={onConfirm}
          >
            {busy ? t("removing") : t("removeConfirm")}
          </Button>
        </div>
        <BusyStatus busy={busy} text={t("removing")} />
      </div>
    </Modal>
  );
}

function sameServices(a: ServiceTogglesWire, b: ServiceTogglesWire): boolean {
  return a.design === b.design && a.llm === b.llm && a.web === b.web;
}

function llmHealthText(
  health: SettingsSnapshotWire["llm"]["health"],
  t: ModellixTranslate,
): string {
  switch (health) {
    case "ready":
      return t("llmReady");
    case "missing":
      return t("llmMissing");
    case "disabled":
      return t("llmDisabled");
    case "error":
      return t("llmError");
    case "policy-blocked":
      return t("llmPolicyBlocked");
    case "unknown":
      return t("llmUnknown");
  }
}
