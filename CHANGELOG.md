# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog.

## [Unreleased]

## [0.2.1] - 2026-09-02

### Changed

- Limited the Web switch to the explicit `modellix_web_search` and `modellix_web_fetch` capability and its Agent routing context. The plugin no longer overrides, enables, disables, or selects Harness native `web_search` / `web_fetch` tools and providers.
- Updated the authoring baseline and public Client/Host integration to DeepSeek Harness `0.1.2-alpha.4`, including the current Connection RPC, Settings namespace, Client renderer, and Tool JSON type surfaces, while retaining `0.1.1-rc.2` runtime compatibility.

### Fixed

- Disabling Web now unregisters both explicit Modellix Web tools immediately, so a new Agent session falls back to the Harness-native Web capabilities configured by the active profile instead of spending a turn on a disabled Modellix tool.
- Re-enabling Web restores both explicit tools and their Modellix-first routing without changing the independent Design or LLM service state.

### Verification

- Added Host lifecycle regression coverage for enabled → disabled → enabled Web transitions, including preservation of native Search/Fetch tools and providers, continued Design registration, unchanged LLM materialization, and omission of Modellix Web routing while disabled.
- Added tarball cold-install and declaration-consumer verification against both Harness `0.1.2-alpha.4` and `0.1.1-rc.2`.

## [0.2.0] - 2026-08-31

### Added

- Added six explicit, namespaced Agent media tools: live model list, live model Schema, natural-language Schema preparation, session/workspace file upload, one-shot generation, and result lookup.
- Added explicit `modellix_web_search` and `modellix_web_fetch` tools plus Agent routing context so current, external, URL, and source-verification questions can browse automatically without requiring the user to name a tool.
- Added chat-native media result cards with Preview/JSON tabs, image enlargement, native video/audio players, URL insertion, and downloads.
- Added the right-side **Modellix Design** session panel with a fixed 360 px desktop content width, full-width narrow behavior, close/focus restoration, a collapsible result list, and independently collapsible result cards.
- Added background Client job watchers that reconcile submitted cards to terminal state without another Agent result call.
- Added task ownership by Harness session id, legacy WAL migration compatibility, and per-session result filtering.
- Added bilingual release/acceptance checklists and twelve new 1920×1080 real-session screenshots covering the current chat-first workflow.

### Changed

- Removed the standalone Design tab. Natural-language chat is now the primary media creation and transformation interface.
- Kept the advanced exact-parameter editor implementation but hid its entry for this release.
- Moved parameter preparation to the top of the retained advanced editor.
- Instructed media routing to reuse the latest relevant result URL for edits and transformations, preventing source-dependent requests from falling back to text-to-media.
- Changed nonterminal assistant wording to acknowledge submission without embedding immutable queued/running/generating status text.
- Removed routine payment-warning copy from plugin UI flows; account state and usage details remain available in Modellix.
- Replaced previous Design-page documentation and screenshots with current chat result, drawer, media player, model selector, Settings, and automatic Web examples in separate English and Chinese sessions.

### Fixed

- Fixed duplicate media cards when `modellix_media_generate` and the required one-shot `modellix_media_get_result` referenced the same job.
- Fixed completed jobs remaining visually “Running” in chat by reconciling stored tool output with the live session controller.
- Fixed background watchers being disposed during layout slot remounts or temporary drawer closure.
- Fixed cross-session result leakage by persisting and filtering task session ownership.
- Fixed running and failed cards exposing empty Preview/JSON panels; these tabs now appear only for successful results.
- Fixed schema parsing compatibility for current Modellix OpenAPI responses and shared-reference layouts while retaining bounded safety limits.
- Fixed repeated Agent media generation caused by stale nonterminal prose and ambiguous task ownership.

### Security

- Kept Credential data write-only and out of media tools, Client state, task WAL records, screenshots, evidence, and diagnostics.
- Preserved no-automatic-replay behavior for generation and upload submissions with unknown outcomes.
- Restricted local path uploads to regular, non-symlink files within the active session workspace.

### Verification

- Added regression coverage for duplicate-card arbitration, background status convergence, controller retain/release across layout remounts, session isolation, legacy WAL records, explicit Web tools, media uploads, and non-stale Agent routing.
- Verified real image, image-to-video, audio, DeepSeek Agent, Modellix LLM, automatic Web Search/Fetch, native media playback, bilingual 1920×1080 browser flows, responsive behavior, keyboard interactions, and zero browser Console errors/warnings.

## [0.1.1] - 2026-08-26

### Fixed

- Allowed the Modellix credential and removal dialogs to open from inside the Harness Settings modal while retaining external-dialog arbitration and correct focus restoration.
- Cleared transient live-region copy when the Harness locale changes so an English or Chinese view cannot retain a stale message from the previous locale.

### Changed

- Replaced the shared mixed-language screenshot set with twelve separate English and Chinese full-screen captures from a real configured Harness session, including live Design, LLM, image generation, Search, and Fetch results.

## [0.1.0] - 2026-08-26

### Added

- DeepSeek Harness Profile Bundle registration with Host and Web Client entry points.
- Write-only Modellix credential onboarding with Design, LLM, and Web switches enabled by default.
- Settings UI for credential status, replacement/removal, feature switches, and LLM catalog refresh.
- Schema-driven Design workspace with searchable/filterable image, video, and audio model discovery, prompt-first exact parameter editing, reviewed LLM-backed parameter proposals, one-shot generation, task polling, and unexpired result previews.
- Image enlargement, native audio/video playback, safe result downloads, and manual Design catalog refresh.
- Persistent Design task WAL containing replay identifiers, task state, and result metadata without API keys or prompts.
- Dynamic Modellix LLM catalog materialization into the Harness `llm-pi-ai` adapter with zero provider retries.
- Modellix search and fetch providers for the Harness native Web seam, with both native Tools enabled and Modellix selected for both capabilities.
- Chinese and English Client strings, responsive layouts, explicit dialog focus handling, keyboard behavior, and accessible async status feedback.
- An English-default `README.md`, a complete `README.zh-CN.md`, and equivalent English and Chinese user guides covering installation, onboarding, Settings, Design, LLM, Web, billing semantics, recovery, accessibility, troubleshooting, and uninstall.
- A shared nine-image documentation set specification with safe alt text and capture rules; the default screenshots use Chinese UI and one narrow-screen Design capture proves English localization.

### Changed

- Credential recovery now coalesces concurrent 401 responses into one prompt, keeps 402, 429, offline, timeout, and 5xx states distinct, and creates a new prompt only after a later explicit capability request.
- Environment-provided `MODELLIX_API_KEY` remains read-only in the UI and reports the required external update and Harness restart path.
- Design Host diagnostics use stable presentation codes that the Client localizes instead of displaying fixed English notices.
- JSON syntax errors are distinguished from valid JSON that violates the current model Schema; image, video, and audio previews expose localized accessible names.
- Coarse-pointer controls, including inputs, selects, disclosure summaries, links, and actions, use 48px targets while desktop and narrow layouts retain the Harness token system.
- Published artifacts include the English and Chinese README files, both user guides, and their shared documentation assets.

### Security

- Kept saved credentials inside the Harness Host Credential service and out of Client state, settings documents, task records, logs, and user-visible errors.
- Restricted authenticated requests to fixed Modellix HTTPS origins and required Design submissions to match the current model Schema's authoritative endpoint.
- Prevented automatic replay of billed Design submissions; uncertain outcomes remain explicit and require user action.
- Added bounded parsing and response limits for Modellix catalog, Schema, prediction, LLM, and Web contracts.
- Made saved Credentials write-only to the Client, cleared unsaved Key drafts on every exit path, and prohibited Secrets in documentation screenshots, request recordings, diagnostics, and packaged files.
- Added exact tarball allowlisting, bare and quoted Secret-assignment checks (including embedded Source Map source), strict decoded WebP size/dimension/metadata checks, and explicit exclusion of source, tests, coverage, Agent instructions, local configuration, logs, HAR, and development scripts.

### Verification

- Added reproducible environment, type, lint, unit, global and critical-file coverage, Host/Client build, exact pack-content, isolated tarball fresh-install, mandatory Node 22 runtime smoke, and commit-bound release-evidence commands.
- Fresh-install verification builds and packs the final worktree, installs the tarball into a temporary project with the declared Harness peers, imports the Host entry, executes the browser Client factory with its injected public modules, resolves patch/package subpath exports, compiles consumer declarations, and removes the temporary project.
- Pack verification validates every public entry target, bilingual documentation, all nine fully decoded metadata-free WebP screenshots, embedded Source Map sources, and the absence of unexpected or sensitive development artifacts.
- Release verification requires exact Secret-free browser and real API/Agent checklists bound to the final clean Git commit and package version; it records authorization evidence without executing or retrying billed calls.

### Known limitations

- Design parameter proposals use a fixed, schema-constrained Modellix planner rather than an open-ended Agent.
- Upstream generation cancellation is not exposed.
- Result metadata stores upstream URLs, not permanent local media copies.
