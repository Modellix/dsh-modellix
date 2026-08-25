# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog.

## [0.1.0] - 2026-08-25

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

### Security

- Kept saved credentials inside the Harness Host Credential service and out of Client state, settings documents, task records, logs, and user-visible errors.
- Restricted authenticated requests to fixed Modellix HTTPS origins and required Design submissions to match the current model Schema's authoritative endpoint.
- Prevented automatic replay of billed Design submissions; uncertain outcomes remain explicit and require user action.
- Added bounded parsing and response limits for Modellix catalog, Schema, prediction, LLM, and Web contracts.

### Known limitations

- Design parameter proposals use a fixed, schema-constrained Modellix planner rather than an open-ended Agent.
- Upstream generation cancellation is not exposed.
- Result metadata stores upstream URLs, not permanent local media copies.
