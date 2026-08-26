# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog.

## [Unreleased]

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
