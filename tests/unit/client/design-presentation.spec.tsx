import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DesignResourceWire } from "../../../src/client/contracts.js";
import {
  designDiagnosticMessageKey,
  designFieldDisabledMessageKey,
  designModelUnavailableMessageKey,
  designNoticeMessageKey,
  jsonParameterIssueMessageKey,
  parseJsonParameterText,
} from "../../../src/client/design-presentation.js";
import { DesignResultPreview } from "../../../src/client/DesignResultPreview.js";
import { en, zh, type ModellixLocaleKey } from "../../../src/client/locales.js";
import type { ModellixTranslate } from "../../../src/client/shared.js";
import { MODELLIX_CLIENT_CSS } from "../../../src/client/styles.js";

const translateZh = ((key: ModellixLocaleKey) => zh[key]) as ModellixTranslate;
const translateEn = ((key: ModellixLocaleKey) => en[key]) as ModellixTranslate;

function resource(kind: DesignResourceWire["kind"]): DesignResourceWire {
  return {
    id: `resource-${kind}`,
    kind,
    url: `https://cdn.example/${kind}`,
    downloadUrl: `https://cdn.example/${kind}`,
    expiresAt: null,
  };
}

describe("Modellix Design presentation", () => {
  it("gives generated video and audio controls localized accessible names", () => {
    expect(
      renderToStaticMarkup(<DesignResultPreview resource={resource("video")} t={translateZh} />),
    ).toContain('aria-label="生成视频结果预览"');
    expect(
      renderToStaticMarkup(<DesignResultPreview resource={resource("audio")} t={translateEn} />),
    ).toContain('aria-label="Generated audio result preview"');
  });

  it("distinguishes malformed JSON from a valid value rejected by the Schema", () => {
    expect(parseJsonParameterText('{"size":', () => true)).toEqual({
      status: "invalid",
      issue: "syntax",
    });
    expect(parseJsonParameterText('{"size":0}', () => false)).toEqual({
      status: "invalid",
      issue: "constraint",
    });
    expect(parseJsonParameterText('{"size":1}', () => true)).toEqual({
      status: "valid",
      value: { size: 1 },
    });
    expect(parseJsonParameterText("  ", () => false)).toEqual({ status: "empty" });
    expect(jsonParameterIssueMessageKey("syntax")).toBe("invalidJson");
    expect(jsonParameterIssueMessageKey("constraint")).toBe("invalidParameter");
  });

  it("maps every Host presentation category through Client locale keys", () => {
    expect(zh[designNoticeMessageKey("catalog-stale")]).toContain("最近一次");
    expect(en[designModelUnavailableMessageKey("removed-from-catalog")]).toContain(
      "no longer",
    );
    expect(zh[designFieldDisabledMessageKey("unsupported-schema-field")]).toContain(
      "无法编辑",
    );
    expect(en[designDiagnosticMessageKey("task-inaccessible")]).toContain(
      "no longer accessible",
    );
    expect(zh.diagnosticRetryable).toContain("只读状态查询");
    expect(zh.proposalSummary).toBe("已建议 {count} 项参数变更。");
    expect(en.proposalConflictsSummary).toContain("Revise the instruction");
  });

  it("raises coarse-pointer targets to at least 48 CSS pixels", () => {
    const coarseRule = MODELLIX_CLIENT_CSS.match(/@media \(pointer:coarse\)\{([^}]|\}(?!\s*@media))*\}/u)?.[0] ?? "";
    for (const selector of [
      ".mdlx-settings button,.mdlx-design button,.mdlx-design-drawer button,.mdlx-tool-result button,.mdlx-modal-content button",
      ".mdlx-input",
      ".mdlx-select",
      ".mdlx-native-input",
      ".mdlx-advanced>summary",
    ]) {
      expect(coarseRule).toContain(selector);
    }
    expect(coarseRule).toContain("min-height:48px");
  });
});
