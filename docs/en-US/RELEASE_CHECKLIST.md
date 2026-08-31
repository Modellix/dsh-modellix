[English](RELEASE_CHECKLIST.md) | [简体中文](../zh-CN/RELEASE_CHECKLIST.md)

# dsh-modellix 0.2.0 Release and Acceptance Checklist

Use this document for manual product acceptance and for the final release gate. Check each item against the exact package/commit being released.

## 1. Scope

This release is accepted only when all of the following are true:

- Chat is the primary media interface; no standalone Design tab exists.
- The Agent can automatically select explicit Modellix media and Web tools.
- Chat result cards and the right-side Modellix Design panel show the same current task state.
- One task produces one visible chat result card.
- Only successful tasks expose Preview/JSON and media controls.
- Results are isolated to their Harness session.
- English and Chinese documentation/screenshots match the current UI.
- Static, browser, real API/Agent, package, and fresh-install gates pass.

## 2. Test environment

Record before testing:

| Item | Expected |
| --- | --- |
| Package | `dsh-modellix@0.2.0` |
| Harness | `0.1.1-rc.2` |
| Development Node | `24.18.1` |
| pnpm | `11.24.0` |
| Browser capture viewport | `1920×1080`, DPR 1 |
| Credential | Configured through controlled environment or Harness Credential service; never visible in evidence |
| Profile | Isolated acceptance profile unless the operator explicitly chooses the default profile |

Do not record the Key, headers, Credential file, Network/HAR, browser storage, or sensitive request bodies.

## 3. Static preflight

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run verify:pack
```

Accept when:

- environment, typecheck, lint, unit/contract tests, and coverage pass;
- Host and Client bundles build;
- the tarball allowlist contains only published runtime/docs/assets;
- all twelve WebP screenshots decode at the required size with no metadata;
- no source, test, coverage, development plan, Agent instruction, Secret, HAR, or local config enters the package.

## 4. Settings and Credential

1. Open Settings → Modellix.
2. Confirm the Credential shows configured/verified state and source, but never its value.
3. Confirm Design, LLM, and Web switches are present.
4. Confirm LLM catalog status, model count, refresh time, and Refresh action.
5. If the Credential is local/writable, open replacement and verify the input starts empty.
6. Cancel and reopen; the unsaved draft must be empty.
7. Test one 401 recovery path in a controlled non-production environment; concurrent failures must open one dialog.
8. Confirm 402, 429, offline, and 5xx do not report “invalid API Key.”

Screenshot evidence: `settings-ready-en.webp` and `settings-ready-zh.webp`.

## 5. Chat-first image generation

In a new conversation, enter a polished image request without naming tool functions:

> Create a polished 16:9 architectural hero image: a glass botanical research pavilion floating above a dawn cloud sea, connected to an observation bridge, restrained lapis-blue and warm-gold tones, realistic premium materials, no people, no text, no logo, no watermark.

Accept when:

1. The Agent discovers/uses a compatible live model and reads its Schema.
2. Exactly one `modellix_media_generate` submission occurs.
3. At most one `modellix_media_get_result` occurs in the Agent turn.
4. While nonterminal, the card shows status/model only—no Preview/JSON.
5. Assistant prose says submission accepted and delegates current status to the card/panel; it does not say queued/running/generating/processing/pending.
6. Without another Agent call, the original card updates to Succeeded.
7. No second card appears for the result query.
8. Preview shows the image; JSON is reachable by keyboard.

Screenshot evidence: `chat-media-generation-en.webp` and `chat-media-generation-zh.webp`.

## 6. Context-aware image-to-video

In the same conversation:

> Turn the image just completed into a five-second cinematic video. Slowly push the camera forward, add subtle cloud and light movement, and preserve the composition and palette.

Accept when:

1. The Agent chooses an image-to-video model, not text-to-video.
2. It automatically uses the previous image result URL in the live Schema's media input field.
3. One submission and at most one same-turn result read occur.
4. The original video card updates in place to Succeeded.
5. The video loads metadata, reports a finite duration, and current time advances after Play.

## 7. Audio

In the same conversation:

> Generate a calm professional English voiceover as MP3 at 44.1 kHz: “From one idea to images, video, and sound, Modellix Design keeps creation flowing naturally in the conversation.”

Accept when:

1. The Agent reads the live audio Schema and uses a published English voice.
2. One submission and at most one same-turn result read occur.
3. The audio card updates in place to Succeeded.
4. The audio loads duration and current time advances after Play.

Screenshot evidence for video/audio: `media-players-en.webp` and `media-players-zh.webp`.

## 8. Result panel and card interactions

1. Select **Modellix Design** at the far right of the session header.
2. Confirm the panel opens from right to left.
3. At a desktop viewport, measure 360 px internal width and confirm the card content is not squeezed during opening/closing.
4. Confirm Results is expanded by default and the count matches the current conversation.
5. Collapse and expand Results.
6. Collapse and expand each card by selecting its header.
7. Confirm only the current session's image, video, and audio appear.
8. Confirm successful cards have Preview/JSON; running/failed cards do not.
9. Select **Add URL to chat** and confirm the exact resource URL is appended to the composer.
10. Select **Download** and confirm the safe upstream resource opens.
11. Select X and confirm focus returns to the launcher.
12. Confirm no advanced-editor entry is visible.

Screenshot evidence: `design-results-drawer-en.webp` and `design-results-drawer-zh.webp`.

## 9. Image dialog and keyboard

1. Open the image preview using keyboard.
2. Confirm the enlarged dialog has a visible title/accessibility name.
3. Confirm initial focus enters the dialog.
4. Use Tab and Shift+Tab through every focusable control; focus must wrap.
5. Press Escape; confirm the dialog closes and focus returns to the image trigger.
6. Reopen and close using the visible control; focus restoration must also work.

## 10. Automatic Web Search and Fetch

In a new Agent turn, do not name any tool:

> Verify the official Modellix page for alibaba/wan2.7-videoedit. Give its page title, one required parameter and what it means, with a source. Do not answer from memory.

Accept when:

1. Agent automatically calls `modellix_web_search`.
2. Agent automatically calls `modellix_web_fetch` for full-page reading.
3. It does not call the native and explicit tool families for the same operation.
4. The answer includes a direct source and a Schema-supported required field.
5. A failed or unknown request is not automatically repeated.

Screenshot evidence: `web-tools-auto-en.webp` and `web-tools-auto-zh.webp`.

## 11. Modellix LLM

1. Open the Harness model selector.
2. Confirm the Modellix section contains the current live catalog.
3. Select a Modellix model.
4. Send a short no-tool prompt.
5. Confirm a real Agent response from the selected Modellix model.
6. Confirm plugin-level retries are `0`.

Screenshot evidence: `llm-model-selector-en.webp` and `llm-model-selector-zh.webp`.

## 12. Responsive, theme, and accessibility matrix

Check the current UI at:

| Dimension/state | Acceptance |
| --- | --- |
| 320 CSS px | Full-width panel, compact reachable launcher, no horizontal page overflow |
| 560 CSS px | Full-width panel and wrapped actions |
| 768 CSS px | All content/actions reachable |
| 1440 CSS px | Fixed 360 px right panel |
| 200% text scale | No clipped status, URL, label, or action |
| Light/dark | Semantic colors remain legible |
| Forced colors | Borders, focus, state, and controls remain distinguishable |
| Reduced motion | Nonessential transitions are removed |
| Coarse pointer | Primary targets reach 48×48 CSS px |

Inspect the accessibility tree for dialog names, labels/descriptions, invalid/busy state, tab semantics, and live regions. While a modal is open, background controls must not be focusable.

## 13. Console and network health

- Browser Console: 0 errors, 0 warnings for the accepted flow.
- No duplicate generation/upload POST.
- No unbounded status polling.
- No Key or auth header in DOM, Console, screenshot, evidence, or logs.
- Media files load from approved HTTPS result origins.

## 14. Real API/Agent coverage

With explicit authorization for the current run, execute the controlled real test:

```powershell
$env:MODELLIX_ALLOW_BILLED_E2E = '1'
$env:MODELLIX_REAL_AGENT_ATTESTED = '1'
$env:MODELLIX_REAL_E2E_OUTPUT_DIR = 'D:\outside-repo\modellix-real-results'
$env:MODELLIX_API_AGENT_E2E_EVIDENCE_FILE = 'D:\outside-repo\api-agent-evidence.json'
pnpm run test:real:modellix
```

The same acceptance cycle must also contain:

- a real Agent round served by the configured DeepSeek backend; and
- a real Agent round served by a Modellix LLM.

Accept only when catalogs, Schema planning, image, video, audio, LLM Agent, Search, and Fetch all pass. Unknown billed submissions must not be replayed.

## 15. Release evidence

Create Secret-free files outside the repository:

- browser evidence covering onboarding, settings, design, LLM, Web, 401, accessibility, theme, and viewports;
- API/Agent evidence covering catalogs, planner, image, video, audio, LLM Agent, and Web.

Both files must:

- target `dsh-modellix@0.2.0`;
- contain the exact lowercase 40-character Git HEAD;
- use a canonical UTC ISO-8601 completion time no older than 72 hours;
- have status `passed` for every required check;
- contain no unknown fields or Secrets.

Then run:

```sh
pnpm run verify:release
```

`verify:release:static` does not replace real evidence.

## 16. Package, publish, and registry readback

After all checks pass:

1. Commit and push the exact accepted files.
2. Confirm `HEAD` equals `origin/main` and the worktree is clean.
3. Run `pnpm pack`.
4. Publish the tarball with the controlled npm Credential process.
5. Read back:

```sh
npm view dsh-modellix@0.2.0 version dist.integrity dist.shasum --json --registry=https://registry.npmjs.org/ --prefer-online
```

6. From an empty external directory and fresh npm cache, install `dsh-modellix@0.2.0`.
7. Verify the installed version and `dsh --profile <isolated> --dump-config`.
8. Remove temporary npm config, cache, tarball, profile, evidence intermediates, and process variables.

Do not create a Git tag or GitHub Release unless explicitly requested.

## 17. 0.2.0 verification record

The release candidate was exercised on 2026-08-31 with:

- real `openai/gpt-image-2` image generation;
- real `xai/grok-imagine-video-i2v` context-aware video generation;
- real `minimax/speech-2.8-hd` voice generation;
- real automatic Modellix Search and Fetch against public official documentation;
- a real DeepSeek Agent sequence and a real `modellix-ai/free-llm` turn;
- successful native video/audio playback with finite duration and advancing current time;
- three session-scoped drawer results, no duplicate chat card, and synchronized terminal status;
- 0 browser Console errors and 0 warnings;
- passing typecheck, lint, 475 tests, coverage gates, build, and pack verification before final documentation changes.

Re-run the final gates after documentation/version changes and bind release evidence to the final commit.
