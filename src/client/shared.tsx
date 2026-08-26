import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { TranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import {
  Button,
  IconRightUpOutline14,
  Input,
  Modal,
  StateDot,
  type StateDotState,
} from "@deepseek-ai/dsh-client-ui-primitives";

import {
  clearSecretInput,
  useDialogA11y,
  useExternalDialogGate,
} from "./a11y.js";
import { presentClientError } from "./client-errors.js";
import type { ServiceTogglesWire } from "./contracts.js";
import type { ModellixLocaleKey } from "./locales.js";
import type { ResourceState, SnapshotSource } from "./store.js";

export type ModellixTranslate = TranslateNS<"modellix">;

export const DEFAULT_SERVICES: ServiceTogglesWire = Object.freeze({
  design: true,
  llm: true,
  web: true,
});

export function useResourceState<T>(
  source: SnapshotSource<ResourceState<T>>,
): ResourceState<T> {
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

export function ErrorNotice({ code, t }: { code: string | null; t: ModellixTranslate }): ReactNode {
  if (code === null) return null;
  const message = t(presentClientError(code).messageKey);
  return (
    <div className="mdlx-error" role="alert">
      {message}
    </div>
  );
}

export function BusyStatus({ busy, text }: { busy: boolean; text: string }): ReactNode {
  return (
    <div className="mdlx-live" role="status" aria-live="polite">
      {busy ? text : ""}
    </div>
  );
}

export function ServiceSwitches({
  value,
  disabled = false,
  onChange,
  t,
}: {
  value: ServiceTogglesWire;
  disabled?: boolean;
  onChange: (value: ServiceTogglesWire) => void;
  t: ModellixTranslate;
}): ReactNode {
  const idPrefix = useId();
  return (
    <div className="mdlx-service-list">
      <ServiceSwitch
        id={`${idPrefix}-design`}
        label={t("serviceDesign")}
        description={t("serviceDesignDescription")}
        checked={value.design}
        disabled={disabled}
        onChange={(design) => onChange({ ...value, design })}
      />
      <ServiceSwitch
        id={`${idPrefix}-llm`}
        label={t("serviceLlm")}
        description={t("serviceLlmDescription")}
        checked={value.llm}
        disabled={disabled}
        onChange={(llm) => onChange({ ...value, llm })}
      />
      <ServiceSwitch
        id={`${idPrefix}-web`}
        label={t("serviceWeb")}
        description={t("serviceWebDescription")}
        checked={value.web}
        disabled={disabled}
        onChange={(web) => onChange({ ...value, web })}
      />
    </div>
  );
}

function ServiceSwitch({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): ReactNode {
  const descriptionId = `${id}-description`;
  return (
    <label className="mdlx-switch-row" htmlFor={id}>
      <span className="mdlx-switch-copy">
        <strong>{label}</strong>
        <span id={descriptionId}>{description}</span>
      </span>
      <input
        id={id}
        className="mdlx-switch"
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={descriptionId}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

export function CredentialStatus({
  configured,
  source,
  verification,
  t,
}: {
  configured: boolean;
  source: "local" | "env" | null;
  verification: "unknown" | "unverified" | "valid" | "invalid";
  t: ModellixTranslate;
}): ReactNode {
  const text = !configured
    ? t("notConfigured")
    : source === "env"
      ? t("configuredEnv")
      : t("configuredLocal");
  const verificationText =
    verification === "valid"
      ? t("verificationValid")
      : verification === "invalid"
        ? t("verificationInvalid")
        : t("verificationPending");
  const dot: StateDotState = !configured
    ? "warning"
    : verification === "invalid"
      ? "error"
      : verification === "valid"
        ? "done"
        : "ongoing";
  return (
    <div className="mdlx-status-copy">
      <StateDot state={dot} />
      <span>{text} · {verificationText}</span>
    </div>
  );
}

export interface CredentialModalProps {
  readonly open: boolean;
  readonly mandatory: boolean;
  readonly title: string;
  readonly description: string;
  readonly services?: ServiceTogglesWire;
  readonly onServicesChange?: (value: ServiceTogglesWire) => void;
  readonly busy: boolean;
  readonly errorCode: string | null;
  readonly onSave: (apiKey: string) => Promise<boolean>;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
  readonly laterLabel?: ModellixLocaleKey;
  readonly t: ModellixTranslate;
}

export function CredentialModal(props: CredentialModalProps): ReactNode {
  const {
    open,
    mandatory,
    title,
    description,
    services,
    onServicesChange,
    busy,
    errorCode,
    onSave,
    onSaved,
    onCancel,
    laterLabel = "cancel",
    t,
  } = props;
  const [draft, setDraft] = useState("");
  const [visible, setVisible] = useState(false);
  const [displayedErrorCode, setDisplayedErrorCode] = useState<string | null>(
    errorCode,
  );
  const contentRef = useRef<HTMLFormElement | null>(null);
  const draftRef = useRef("");
  const keyId = useId();
  const helpId = `${keyId}-help`;
  const errorId = `${keyId}-error`;
  const errorPresentation =
    displayedErrorCode === null ? null : presentClientError(displayedErrorCode);
  const surfaceOpen = useExternalDialogGate(open);

  const clear = useCallback((): void => {
    draftRef.current = "";
    setDraft("");
    setVisible(false);
    setDisplayedErrorCode(null);
    clearSecretInput(contentRef.current);
  }, []);
  const close = useCallback((): void => {
    clear();
    onCancel();
  }, [clear, onCancel]);
  useDialogA11y({
    open: surfaceOpen,
    container: contentRef,
    initialFocusSelector: "[data-mdlx-initial-focus]",
    mandatory,
    onEscape: close,
  });
  useEffect(() => () => {
    draftRef.current = "";
    clearSecretInput(contentRef.current);
  }, []);
  useEffect(() => {
    setDisplayedErrorCode(errorCode);
  }, [errorCode]);

  const submit = async (): Promise<void> => {
    const candidate = draftRef.current.trim();
    if (candidate.length === 0 || busy) return;
    const saved = await onSave(candidate);
    if (!saved) return;
    clear();
    onSaved();
  };

  return (
    <Modal
      open={surfaceOpen}
      title={title}
      onClose={mandatory ? () => undefined : close}
      headless
      className="mdlx-modal"
    >
      <form
        ref={contentRef}
        className="mdlx-modal-content"
        data-mdlx-dialog-surface=""
        tabIndex={-1}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="mdlx-heading">
          <h2 className="mdlx-modal-title">{title}</h2>
          <p className="mdlx-modal-description">{description}</p>
        </div>
        <div className="mdlx-field">
          <label className="mdlx-label" htmlFor={keyId}>{t("keyLabel")}</label>
          <div className="mdlx-input-row">
            <Input
              id={keyId}
              name="modellix-api-key"
              className="mdlx-input"
              type={visible ? "text" : "password"}
              value={draft}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={t("keyPlaceholder")}
              aria-describedby={`${helpId}${errorPresentation?.credentialFieldInvalid === true ? ` ${errorId}` : ""}`}
              aria-invalid={errorPresentation?.credentialFieldInvalid || undefined}
              data-mdlx-secret=""
              data-mdlx-initial-focus=""
              onChange={(event) => {
                const value = event.currentTarget.value;
                draftRef.current = value;
                setDraft(value);
                setDisplayedErrorCode(null);
              }}
            />
            <Button
              type="button"
              variant="outline"
              aria-label={visible ? t("hideKey") : t("showKey")}
              aria-pressed={visible}
              onClick={() => setVisible((current) => !current)}
            >
              {visible ? t("hideKey") : t("showKey")}
            </Button>
          </div>
          <span id={helpId} className="mdlx-help">{t("keyHelp")}</span>
        </div>
        {services !== undefined && onServicesChange !== undefined && (
          <ServiceSwitches
            value={services}
            disabled={busy}
            onChange={onServicesChange}
            t={t}
          />
        )}
        {errorPresentation !== null && (
          <div id={errorId} className="mdlx-error" role="alert">
            {t(errorPresentation.messageKey)}
          </div>
        )}
        <a
          className="mdlx-safe-link"
          href="https://docs.modellix.ai/get-started"
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
        >
          {t("docs")} <IconRightUpOutline14 size={14} />
        </a>
        <div className="mdlx-actions">
          <Button type="button" variant="outline" disabled={busy} onClick={close}>
            {t(laterLabel)}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || draft.trim().length === 0}
            aria-busy={busy}
          >
            {busy ? t("saving") : t("saveEnable")}
          </Button>
        </div>
        <BusyStatus busy={busy} text={t("saving")} />
      </form>
    </Modal>
  );
}

export function formatClientValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") return "—";
    return text.length > 512 ? `${text.slice(0, 509)}…` : text;
  } catch {
    return "—";
  }
}
