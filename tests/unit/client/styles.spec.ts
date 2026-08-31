// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installModellixClientStyles,
  MODELLIX_CLIENT_CSS,
} from "../../../src/client/styles.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.querySelectorAll("[data-dsh-modellix='client']").forEach(
    (element) => element.remove(),
  );
});

describe("Modellix Client styles", () => {
  it("installs the complete semantic stylesheet and removes only its own element", () => {
    const existing = document.createElement("style");
    existing.dataset.owner = "host";
    document.head.append(existing);

    const dispose = installModellixClientStyles(document);
    const installed = document.head.querySelector<HTMLStyleElement>(
      "style[data-dsh-modellix='client']",
    );

    expect(installed?.textContent).toBe(MODELLIX_CLIENT_CSS);
    expect(MODELLIX_CLIENT_CSS).toContain("var(--dsw-alias-border-l2)");
    expect(MODELLIX_CLIENT_CSS).toContain("@media (max-width:768px)");
    expect(MODELLIX_CLIENT_CSS).toContain("@media (pointer:coarse)");
    expect(MODELLIX_CLIENT_CSS).toContain("@media (prefers-reduced-motion:reduce)");
    expect(MODELLIX_CLIENT_CSS).toContain("@media (forced-colors:active)");

    dispose();

    expect(document.head.contains(installed)).toBe(false);
    expect(document.head.contains(existing)).toBe(true);
    existing.remove();
  });

  it("uses the ambient document by default and degrades to a harmless disposer without one", () => {
    const disposeAmbient = installModellixClientStyles();
    expect(document.head.querySelector("style[data-dsh-modellix='client']")).not.toBeNull();
    disposeAmbient();

    const ambientDocument = document;
    vi.stubGlobal("document", undefined);
    const disposeMissing = installModellixClientStyles();
    expect(disposeMissing()).toBeUndefined();
    vi.unstubAllGlobals();
    expect(document).toBe(ambientDocument);
  });

  it("gives every plugin-scoped Button a 48px coarse-pointer height without forcing icon width", () => {
    const coarsePointer = MODELLIX_CLIENT_CSS.match(
      /@media \(pointer:coarse\)\{(?<rules>[^@]+)\}/u,
    )?.groups?.rules;

    expect(coarsePointer).toContain(
      ".mdlx-settings button,.mdlx-design button,.mdlx-design-drawer button,.mdlx-tool-result button,.mdlx-modal-content button{min-height:48px}",
    );
    expect(coarsePointer).not.toContain(
      ".mdlx-settings button,.mdlx-design button,.mdlx-design-drawer button,.mdlx-tool-result button,.mdlx-modal-content button{min-width:48px",
    );
    expect(coarsePointer).toContain(
      ".mdlx-input,.mdlx-select,.mdlx-native-input,.mdlx-advanced>summary{min-height:48px}",
    );
    expect(coarsePointer).toContain(
      ".mdlx-switch-row,.mdlx-switch-target,.mdlx-safe-link{min-width:48px;min-height:48px}",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-switch-target{display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center;justify-self:center}",
    );
    expect(coarsePointer).not.toContain(".mdlx-switch,.mdlx-safe-link");
  });

  it("keeps the Harness Input wrapper inside its grid track at every responsive width", () => {
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-input-row{display:grid;grid-template-columns:minmax(0,1fr) max-content;gap:8px",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-input-row>.mdlx-input{width:100%;min-width:0;max-width:100%;box-sizing:border-box}",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-input{height:auto;min-height:40px}.mdlx-input:focus-within",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      "box-sizing:border-box;border-color:var(--dsw-alias-label-tertiary)",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      "border:1px solid var(--dsw-alias-label-tertiary)",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-input-row,.mdlx-model-tools{grid-template-columns:minmax(0,1fr)}",
    );
  });

  it("keeps cards, dialogs, and Design containers aligned without fixed-language overflow", () => {
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-card-head>.mdlx-heading{margin-bottom:0}",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-muted,.mdlx-help{margin:0",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-modal-confirm{width:min(380px,calc(100vw - 48px))}",
    );
    expect(MODELLIX_CLIENT_CSS).toContain("padding:0!important;gap:0!important");
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-modal-content>.mdlx-heading{margin-bottom:0}",
    );
    expect(MODELLIX_CLIENT_CSS).toContain("@container (max-width:992px)");
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-design-launcher{height:32px!important;min-height:32px!important;padding:6px 12px!important;border-radius:18px!important;font-size:13px!important;font-weight:400!important;line-height:20px!important}",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      "@media (pointer:coarse){.mdlx-design-launcher{height:48px!important;min-height:48px!important}",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-design-drawer-viewport{position:fixed;inset:0 0 0 auto;width:360px;max-width:100vw;overflow:hidden;pointer-events:none}",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-design-drawer{position:absolute;inset:0 0 0 auto;width:360px;min-width:360px",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-drawer-close{position:absolute!important;inset-block-start:12px;inset-inline-end:12px;width:36px!important;min-width:36px!important;height:36px!important;min-height:36px!important",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      '.mdlx-design-drawer-viewport[data-closing="true"] .mdlx-design-drawer{transform:translateX(100%);opacity:.72;pointer-events:none}',
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      "@media (min-width:1280px){.mdlx-design-drawer{box-shadow:none}}",
    );
    expect(MODELLIX_CLIENT_CSS).not.toContain("width:520px");
    expect(MODELLIX_CLIENT_CSS).toContain(
      '.mdlx-drawer-header[data-editor-open="true"] .mdlx-drawer-header-reveal{grid-template-rows:1fr;opacity:1;margin-top:12px}',
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-design-editor[hidden]{display:none}",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-drawer-header-reveal[hidden]{display:none!important}",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-result-card-summary{position:relative;display:grid;gap:8px;min-height:72px",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-result-disclosure[open]>.mdlx-result-card-summary::after{transform:rotate(45deg)}",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-drawer-header-reveal{grid-template-rows:1fr;opacity:1;margin-top:12px}",
    );
    expect(MODELLIX_CLIENT_CSS).not.toContain(".mdlx-advanced[open]>summary");
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-label>.mdlx-required,.mdlx-label>.mdlx-muted{margin-inline-start:4px}",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-generate-block{display:grid;gap:8px;min-width:0}",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-input:has(input[aria-invalid=\"true\"])",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(".mdlx-input:has(input:disabled)");
    expect(MODELLIX_CLIENT_CSS).toContain(
      "background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-label-primary)",
    );
    expect(MODELLIX_CLIENT_CSS).not.toContain(
      "background:var(--dsw-alias-state-error-secondary)",
    );
    expect(MODELLIX_CLIENT_CSS).toContain(
      ".mdlx-input,.mdlx-textarea,.mdlx-select,.mdlx-native-input{border-color:CanvasText}",
    );
  });
});
