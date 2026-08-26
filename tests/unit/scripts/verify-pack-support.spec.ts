import { posix } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DOCUMENTATION_SCREENSHOT_RULES,
  findSensitiveContent,
  findSensitiveSourceMapContent,
  resolveLocalMarkdownImage,
  SCREENSHOT_FILES,
  verifyDocumentationImages,
  visibleMarkdownImageReferences,
} from "../../../scripts/verify-pack-support.mjs";

describe("package verification support", () => {
  it("collects only visible Markdown images", () => {
    const markdown = [
      "![Visible](docs/assets/visible.webp)",
      "[ordinary link](docs/assets/not-an-image.webp)",
      "<!-- ![Commented](docs/assets/commented.webp) -->",
      "`![Inline code](docs/assets/inline.webp)`",
      "```md",
      "![Fenced](docs/assets/fenced.webp)",
      "```",
      "![Reference][hero]",
      "",
      "[hero]: docs/assets/reference.webp",
    ].join("\n");

    expect(visibleMarkdownImageReferences(markdown)).toEqual([
      "docs/assets/visible.webp",
      "docs/assets/reference.webp",
    ]);
  });

  it("resolves portable relative images without allowing package escapes", () => {
    expect(
      resolveLocalMarkdownImage(
        "docs/en-US/USER_GUIDE.md",
        "../assets/design-desktop.webp?download=1#preview",
      ),
    ).toBe("docs/assets/design-desktop.webp");
    expect(
      resolveLocalMarkdownImage("README.md", "https://example.test/safe.webp"),
    ).toBeNull();
    expect(() =>
      resolveLocalMarkdownImage(
        "docs/en-US/USER_GUIDE.md",
        "../../../outside.webp",
      )
    ).toThrow(/escapes the package/u);
    expect(() =>
      resolveLocalMarkdownImage(
        "docs/en-US/USER_GUIDE.md",
        "%2e%2e/%2e%2e/%2e%2e/outside.webp",
      )
    ).toThrow(/escapes the package/u);
    expect(() =>
      resolveLocalMarkdownImage("README.md", "docs\\assets\\image.webp")
    ).toThrow(/non-portable/u);
    expect(() =>
      resolveLocalMarkdownImage("README.md", "http://example.test/image.webp")
    ).toThrow(/package-relative or HTTPS/u);
  });

  it("requires one README hero and the complete screenshot set in both guides", () => {
    const guide = SCREENSHOT_FILES.map((path) => {
      const reference = posix.relative("docs/en-US", path);
      return `![Screenshot](${reference})`;
    }).join("\n");
    const documents = {
      "README.md": "![Design](docs/assets/design-desktop.webp)",
      "README.zh-CN.md": "![Design](docs/assets/design-desktop.webp)",
      "docs/en-US/USER_GUIDE.md": guide,
      "docs/zh-CN/USER_GUIDE.md": guide,
    };

    expect(
      verifyDocumentationImages(documents, new Set(SCREENSHOT_FILES)),
    ).toHaveProperty("size", Object.keys(DOCUMENTATION_SCREENSHOT_RULES).length);
  });

  it("does not let a commented image satisfy policy and rejects unpacked local images", () => {
    const rules = { "README.md": ["docs/assets/design-desktop.webp"] };
    expect(() =>
      verifyDocumentationImages(
        {
          "README.md":
            "<!-- ![Design](docs/assets/design-desktop.webp) -->",
        },
        new Set(["docs/assets/design-desktop.webp"]),
        rules,
      )
    ).toThrow(/omits visible screenshots/u);
    expect(() =>
      verifyDocumentationImages(
        {
          "README.md": [
            "![Design](docs/assets/design-desktop.webp)",
            "![Unknown](docs/assets/not-packed.webp)",
          ].join("\n"),
        },
        new Set(["docs/assets/design-desktop.webp"]),
        rules,
      )
    ).toThrow(/unpacked local image/u);
  });

  it("detects quoted, unquoted, and JSON Secret assignments while allowing placeholders", () => {
    expect(
      findSensitiveContent(
        'MODELLIX_API_KEY="synthetic-scanner-value-123"',
      ),
    ).toEqual({ label: "literal MODELLIX_API_KEY assignment" });
    expect(
      findSensitiveContent("MODELLIX_API_KEY=synthetic-scanner-value-456"),
    ).toEqual({ label: "literal MODELLIX_API_KEY assignment" });
    expect(
      findSensitiveContent('{"apiKey":"synthetic-scanner-value-789"}'),
    ).toEqual({ label: "literal JSON Secret assignment" });
    expect(
      findSensitiveContent(
        '{"MODELLIX_API_KEY":"synthetic-scanner-value-json"}',
      ),
    ).toEqual({ label: "literal MODELLIX_API_KEY assignment" });
    expect(
      findSensitiveContent(
        '{"authorization":"synthetic-scanner-authorization"}',
      ),
    ).toEqual({ label: "literal JSON Secret assignment" });
    expect(
      findSensitiveContent("apiKey: 'synthetic-scanner-value-abc'"),
    ).toEqual({ label: "literal JSON Secret assignment" });
    expect(
      findSensitiveContent("apiKey: synthetic-scanner-value-bare"),
    ).toEqual({ label: "literal JSON Secret assignment" });
    expect(
      findSensitiveContent("credential: 'synthetic-scanner-credential'"),
    ).toEqual({ label: "literal JSON Secret assignment" });
    expect(
      findSensitiveContent("token: synthetic-scanner-token-bare"),
    ).toEqual({ label: "literal JSON Secret assignment" });
    expect(findSensitiveContent("apiKey: credential.value")).toBeNull();
    expect(findSensitiveContent("credential: runtime.credential")).toBeNull();
    expect(findSensitiveContent("apiKey: input.apiKey")).toBeNull();
    expect(findSensitiveContent('MODELLIX_API_KEY="<YOUR_MODELLIX_API_KEY>"'))
      .toBeNull();
    expect(findSensitiveContent('{"apiKey":"TEST_SCANNER_PLACEHOLDER"}'))
      .toBeNull();
  });

  it("scans unescaped sourcesContent inside Source Maps", () => {
    const map = JSON.stringify({
      version: 3,
      sources: ["../src/example.ts"],
      sourcesContent: [
        'const MODELLIX_API_KEY = "synthetic-scanner-value-in-map"',
      ],
    });

    expect(findSensitiveContent(map)).toBeNull();
    expect(findSensitiveSourceMapContent(map)).toEqual({
      label: "literal MODELLIX_API_KEY assignment in Source Map source",
    });
    expect(() => findSensitiveSourceMapContent("not-json"))
      .toThrow(/valid JSON/u);
    expect(() =>
      findSensitiveSourceMapContent(
        JSON.stringify({ version: 3, sourcesContent: [42] }),
      )
    ).toThrow(/strings or null/u);
  });
});
