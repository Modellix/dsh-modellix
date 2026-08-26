[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-modellix

A Modellix Profile Bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one Modellix API Key provides schema-driven Design media generation, a live LLM model catalog, and native Web providers.

> Harness and this plugin currently use prerelease interfaces. Before upgrading Harness, check this package's peer dependencies and [CHANGELOG](CHANGELOG.md).

![Chinese-language Modellix Design desktop layout with model, prompt, and parameters on the left and generation results on the right](docs/assets/design-desktop.webp)

## Feature overview

| Feature | User experience | Actual behavior |
| --- | --- | --- |
| Design | Select a model, enter a prompt, and adjust parameters on the left; review tasks and results on the right | Reads the live image, video, and audio catalog and each model's public Schema; submits a billed generation only once |
| LLM | Quickly switch Modellix models in the Harness model selector | Merges the live catalog into the Harness `llm-pi-ai` Modellix provider |
| Web | Use the native Harness `web_search` and `web_fetch` tools | Registers Modellix Search/Fetch providers without creating duplicate custom tools |

The first-run dialog contains an API Key field and Design, LLM, and Web switches. All three switches are on by default and can later be disabled independently in Modellix settings.

## Requirements

- DeepSeek Harness `0.1.1-rc.2`
- Published-package runtime: Node.js `^22.19.0 || >=24.0.0`
- Source development and release verification: Node.js `24.18.1` and pnpm `11.24.0` (see `.nvmrc` and `packageManager`)
- A valid [Modellix API Key](https://docs.modellix.ai/get-started)

`dsh-modellix` contains its own Harness integration. It neither installs nor invokes `modellix-cli` at runtime.

## Installation

Install the published package into the target Web profile, inspect the merged configuration, then start or restart that profile:

```sh
dsh plugin --profile web add dsh-modellix
dsh --profile web --dump-config
dsh --profile web
```

`--dump-config` should show the `dsh-modellix` Bundle layer and a plugin row whose id is `modellix`. Replace `web` if you use a different profile.

You can also build a tarball from trusted source and install the artifact:

```sh
pnpm install --frozen-lockfile
pnpm run verify:release:static
pnpm pack
dsh plugin --profile web add ./dsh-modellix-0.1.0.tgz
```

Installing TypeScript source directly from Git requires the installation phase to produce `lib/`. Until the package provides a verified `prepare` flow, use the published package or a local tarball.

## First-time setup

1. Open the Harness Web UI and wait for the “Connect Modellix” dialog.
2. Enter the API Key and confirm whether the three default-on Design, LLM, and Web switches match your needs.
3. Select “Save and enable.” After a successful save, the browser never displays the Key again; it only shows Credential status and source.
4. Select “Configure later” if you are not ready. This does not mark the plugin as usable; the next explicit use of an enabled Modellix capability that needs a Credential requests it again.

The API Key can come from either source:

- Enter it during first-time setup or in settings, where the Harness Credential service stores it.
- Supply `MODELLIX_API_KEY` in the Harness launch environment. An environment-sourced Key is read-only in the UI; restart Harness after updating it.

Never put a real Key in a repository, command argument, log, screenshot, HAR, recording, or test snapshot.

See the [user guide: first-time setup and Credentials](docs/en-US/USER_GUIDE.md#first-time-setup) for the complete flow.

## Quick use

### Design: generate images, video, or audio

1. Open the **Design** view in Harness.
2. Search, filter by output type, and select a model. The plugin first restores the most recently selected available model; otherwise it chooses a preferred available model from the current catalog.
3. Enter the primary prompt. Many models need only a prompt; all other fields come from the model's current `api_schema`, including public defaults.
4. For exact control, edit enum, switch, numeric, text, or JSON parameters directly. Values that violate the Schema prevent submission.
5. To adjust parameters in natural language, describe the change under “Adjust parameters by chat.” This uses the same Key with the fixed `openai/gpt-5.6-luna` model and may incur LLM usage. It produces a reviewable diff and never starts media generation by itself.
6. Review parameters and the billing notice, then select “Confirm and generate” once. The billed POST is never retried automatically; read-only task status checks use only bounded safe retries.
7. The right results pane groups records as Running, Succeeded, or Diagnostics and supports enlarged images, video/audio playback, and safe downloads.

For example, select an available image model whose live Schema exposes `quality` and `size`, then enter this acceptance prompt:

> A premium editorial architectural photograph of a quiet cliffside library above a misty alpine lake at blue hour, carved pale stone arches, warm amber reading lamps, one thoughtful reader, subtle greenery, natural reflections, cinematic but realistic lighting, restrained navy and ivory palette, precise composition, no text, no logo.

This is the exact prompt used for the documented real-API image, not a placeholder. The screenshot below was captured after the task completed in the real Design results list.

Set `quality` to `high` and `size` to `1536x1024`, leaving other fields at the model's current defaults. You can edit those controls directly or ask the parameter assistant to propose the two changes, then review and apply the diff. The proposal may incur LLM usage but does not generate an image. Only the final “Confirm and generate” action starts the billed media request, and the plugin does not retry it automatically. If the selected model does not advertise either field, do not add it manually—choose values and fields from that model's live Schema.

Results remain accessible only while the upstream resource is valid. If the upstream response has no expiry, the plugin uses a seven-day local display limit. This does not extend the upstream URL or copy media into permanent local storage.

### LLM: switch models quickly

1. Keep LLM enabled and configure a valid Key.
2. In Modellix settings, inspect catalog status, model count, and last refresh time; refresh manually when needed.
3. Select a model under the Modellix provider in the Harness model selector. The choice applies to the next model call.

LLM uses the OpenAI Completions-compatible endpoint `https://llm.modellix.ai/v1`. The plugin sets provider retries to `0` to avoid repeating model calls at the plugin layer; it never fabricates a static model list when the catalog is unavailable.

### Web: search and fetch

When Web is enabled and a Key is available, ask Harness to search the public Web and, when needed, fetch a selected result. The native `web_search` and `web_fetch` tools run through the Modellix provider; the plugin does not add a duplicate Tool UI. The provider is unavailable when Web is disabled or no valid Key exists. Web requests may incur Modellix usage and are not automatically retried by the provider. If a paid Fetch outcome is unknown, inspect the Harness transcript or Modellix-side record before repeating it manually.

## Settings, states, and recovery

The Modellix settings page provides:

- Credential configuration, source, and verification status, plus replacement and removal for a local writable Credential;
- independent Design, LLM, and Web switches;
- LLM catalog health, model count, last refresh time, and manual refresh.

Only an explicit HTTP 401 marks the current Credential invalid and opens recovery. A 402, 429, network failure, or 5xx is not reported as an invalid Key. If an environment-sourced Key is invalid, update `MODELLIX_API_KEY` in the launch environment and restart Harness; the UI cannot override it.

Recovery is coordinated across plugin dialogs: concurrent 401 responses produce one Credential dialog. An already-open local Key editor upgrades in place; if an ordinary removal confirmation or image viewer is open, recovery waits until it closes instead of stacking another modal. Save a replacement Key and retry the intended capability. For an environment-sourced Key, update it outside the UI and restart Harness.

If a disconnected billed submission has an unknown outcome, Design shows “Submission outcome unknown.” Check Results or the Modellix-side record before any manual resubmission to avoid duplicate charges.

## Accessibility and responsive behavior

- Dialogs explicitly manage initial focus, `Tab` / `Shift+Tab` wrapping, background inertness, and focus restoration after closing.
- A mandatory Credential gate cannot close implicitly through Escape or the backdrop, but always has a visible “Configure later” action. Ordinary confirmation dialogs support Escape.
- Fields have visible labels, linked errors, busy states, and live status announcements; state is not conveyed by color alone.
- Design uses a left-workspace/right-results layout when its container is wider than `992px`; narrower host slots stack into one column, with a viewport fallback at `768px`. The implementation targets `320px`, 200% text zoom, light/dark themes, forced colors, 48px coarse-pointer targets, and reduced motion.
- UI text follows the current Harness locale. `README.md` is the default English entry, with a complete Chinese edition alongside it.

## Uninstallation

If the Key is stored in a local writable Credential, remove it from Modellix settings first. Revoke an environment-sourced Key in the external launch environment or secret manager. Then remove the plugin from the target profile and restart it:

```sh
dsh plugin --profile web remove dsh-modellix
dsh --profile web --dump-config
dsh --profile web
```

Uninstalling the plugin does not promise to remove external environment variables, upstream tasks, or every piece of persisted Harness data. Handle each system separately if your policy requires cleanup.

## UI previews and safe screenshots

- [完整中文用户指南](docs/zh-CN/USER_GUIDE.md)
- [Complete English user guide](docs/en-US/USER_GUIDE.md)
- [Chinese README](README.zh-CN.md)

The repository includes nine safety-reviewed UI screenshots. None contains a real account, Key, Network request details, HAR, or Credential file. Both languages reuse the same images. Most plugin copy is Chinese; `design-mobile-en.webp` and `llm-model-selector.webp` use English Harness chrome, while `web-tools.webp` uses English Harness chrome around a Chinese public-documentation request and response:

| Suggested file | Alt text |
| --- | --- |
| `docs/assets/onboarding-defaults.webp` | Chinese-language Modellix first-time setup dialog with an empty API Key field and Design, LLM, and Web switches enabled |
| `docs/assets/settings-ready.webp` | Chinese-language Modellix settings showing a verified Credential, three feature switches, and LLM catalog status |
| `docs/assets/design-desktop.webp` | Chinese-language Modellix Design desktop layout with model, prompt, and parameters on the left and generation results on the right |
| `docs/assets/design-proposal.webp` | Chinese-language Design parameter proposal showing before-and-after changes with Apply and Reject actions |
| `docs/assets/design-results-media.webp` | Chinese-language Design results pane with the image created during real acceptance, its expiry, and download action |
| `docs/assets/design-mobile-en.webp` | English-language Modellix Design in a single-column layout at 320 pixels with the workspace above Results |
| `docs/assets/credential-recovery.webp` | Chinese-language Modellix recovery dialog after an invalid API Key with an empty field and Configure later action |
| `docs/assets/llm-model-selector.webp` | English-language Harness model selector expanded to the Modellix provider with models synchronized from the live catalog |
| `docs/assets/web-tools.webp` | English-language Harness conversation showing native web_search and web_fetch completed by the Modellix provider for a Chinese public-documentation request |

Use only an empty Key or an explicitly fake Key, a generic prompt, and results without personal information. Do not capture Network, HAR, Console, Credential files, or any real-Secret flow.

## Current limitations

- The Design parameter assistant is constrained by the current Schema; it is not an open-ended agent.
- There is no upstream cancellation call, and the UI has no task cancellation button.
- The results pane persists task metadata and upstream resource URLs, not the API Key, prompt, or media copies.
- A complex Schema with a blocking unsupported constraint disables submission instead of guessing parameter meaning.
- LLM materializes only models advertised by the live catalog and does not provide fabricated fallback models.

## Development and verification

```sh
pnpm install --frozen-lockfile
pnpm run verify:env
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
pnpm run verify:pack
pnpm run verify:fresh-install
pnpm run verify:node22-install
pnpm run verify:release:static
```

`pnpm run check` runs environment verification, type checking, lint, the complete unit/contract suite, global hard coverage thresholds, and file-specific regression floors for the Host runtime and Design parameter planner. `verify:pack` checks the exact artifact allowlist, bilingual documentation, nine metadata-free WebP screenshots by actually decoding them, entries, embedded Source Map source, and sensitive-file exclusions. `verify:fresh-install` installs the final tarball in a temporary project, loads Host, executes the Client factory, checks subpath exports, and compiles consumer type smokes. `verify:node22-install` repeats the tarball runtime smoke with an explicitly configured or NVM-discovered Node.js `^22.19.0` binary and fails instead of silently skipping when none exists. `pnpm run verify:release:static` chains these static gates with the production dependency audit.

### Complete release evidence gate

Use `pnpm run verify:release` for an actual release. First commit the final code, documentation, and screenshots and keep the worktree clean. Create two Secret-free JSON files outside the repository. Each must be smaller than 32 KiB, target the current package version and lowercase 40-character HEAD, and use a canonical UTC ISO-8601 `completedAt` no more than 72 hours old. Browser evidence must contain every fixed check below:

```json
{
  "version": 1,
  "kind": "browser",
  "status": "passed",
  "package": { "name": "dsh-modellix", "version": "0.1.0" },
  "commit": "<current-40-character-lowercase-git-head>",
  "completedAt": "<canonical-utc-iso-8601>",
  "checks": {
    "onboarding": "passed",
    "settings": "passed",
    "design": "passed",
    "llm": "passed",
    "web": "passed",
    "401": "passed",
    "a11y": "passed",
    "theme": "passed",
    "viewports": "passed"
  }
}
```

Real API/Agent evidence must cover catalogs, parameter planning, all three media types, the LLM Agent, and Web. `billedCallsExplicitlyAuthorized` attests only that the operator explicitly authorized this run's billed calls; never put a Key, request header, or any other Secret in evidence:

```json
{
  "version": 1,
  "kind": "api-agent",
  "status": "passed",
  "package": { "name": "dsh-modellix", "version": "0.1.0" },
  "commit": "<current-40-character-lowercase-git-head>",
  "completedAt": "<canonical-utc-iso-8601>",
  "checks": {
    "catalogs": "passed",
    "planner": "passed",
    "image": "passed",
    "video": "passed",
    "audio": "passed",
    "llm-agent": "passed",
    "web": "passed"
  },
  "billedCallsExplicitlyAuthorized": true
}
```

To produce this evidence from live services, first complete and verify one Modellix-backed DSH Agent turn in an isolated Web profile. Then let the acceptance process supply `MODELLIX_API_KEY` directly from a controlled environment, file, or Credential and run `pnpm run test:real:modellix` with these non-secret controls:

```powershell
$env:MODELLIX_ALLOW_BILLED_E2E = '1'
$env:MODELLIX_REAL_AGENT_ATTESTED = '1'
$env:MODELLIX_REAL_E2E_OUTPUT_DIR = 'D:\outside-repo\modellix-real-results'
$env:MODELLIX_API_AGENT_E2E_EVIDENCE_FILE = 'D:\outside-repo\api-agent-evidence.json'
pnpm run test:real:modellix
```

The runner performs live authenticated catalogs and Schema planning, submits exactly one billed image, video, and audio POST, polls those tasks with bounded reads, executes real Web Search/Fetch, saves all media outside the repository for independent decoding checks, and writes Secret-free evidence. It refuses to run without both explicit billing authorization and the prior Agent attestation. It never supplies or accepts a Key as a command argument.

Supply both absolute paths and run the gate. Paths may be environment variables; the API Key must not be:

```sh
MODELLIX_BROWSER_EVIDENCE_FILE=/absolute/path/browser-evidence.json \
MODELLIX_API_AGENT_E2E_EVIDENCE_FILE=/absolute/path/api-agent-evidence.json \
pnpm run verify:release
```

Evidence is a strictly shaped acceptance attestation; it does not execute or retry billed calls. The gate fails for a missing, failed, or unknown check, unknown field, in-repository or stale file, package/commit mismatch, or dirty worktree.

## References

- [Modellix getting started](https://docs.modellix.ai/get-started)
- [Modellix LLM overview](https://docs.modellix.ai/llm/overview)
- [Modellix GPT Image 2 example](https://www.modellix.ai/zh_CN/models/openai/gpt-image-2)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## License

See [LICENSE](LICENSE).
