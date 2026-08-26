[English](USER_GUIDE.md) | [简体中文](../zh-CN/USER_GUIDE.md)

# dsh-modellix User Guide

This guide is for Harness users who install and use `dsh-modellix`. `README.md` is the default English entry, a complete Chinese edition is available alongside it, and plugin UI text follows the current Harness locale.

`dsh-modellix` uses one Modellix API Key for three independently controlled capabilities:

| Capability | Entry point | Purpose |
| --- | --- | --- |
| Design | The Design view in Harness | Select an image, video, or audio model, use a prompt, parameter form, or natural-language adjustment, and review results |
| LLM | The Harness model selector and Modellix settings | Synchronize the live Modellix model catalog and switch models quickly |
| Web | Native Harness Web Tools | Run `web_search` and `web_fetch` through the Modellix provider |

## Installation and verification

### Requirements

- DeepSeek Harness `0.1.1-rc.2`
- Published-package runtime: Node.js `^22.19.0 || >=24.0.0`
- Source development and release verification: Node.js `24.18.1` and pnpm `11.24.0` (see `.nvmrc` and `packageManager`)
- A valid [Modellix API Key](https://docs.modellix.ai/get-started)

The Bundle contains its own Harness integration. `modellix-cli` is neither installed nor invoked as a runtime dependency.

Harness and this plugin currently use prerelease interfaces. Before upgrading Harness, inspect the plugin version, peer dependencies, and repository changelog.

### Install the published package

The examples below use the `web` profile. Replace that name consistently if your profile differs:

```sh
dsh plugin --profile web add dsh-modellix
dsh --profile web --dump-config
dsh --profile web
```

Inspect `--dump-config` and confirm that it contains:

- the `dsh-modellix` Bundle configuration layer;
- a plugin row whose id is `modellix`;
- Web configuration that selects the `modellix` Search/Fetch provider and enables the native Harness Search/Fetch tools.

After installing or updating the Client Bundle, restart the corresponding Harness Web profile. Refreshing the browser alone does not load a new Bundle.

### Install a tarball built from source

Build only from trusted source:

```sh
pnpm install --frozen-lockfile
pnpm run verify:release:static
pnpm pack
dsh plugin --profile web add ./dsh-modellix-0.1.0.tgz
```

`pnpm run check` includes environment verification, type checking, lint, the complete unit/contract suite, global hard coverage thresholds, and file-specific regression floors for the Host runtime and Design parameter planner. `verify:release:static` also performs the production dependency audit, build, exact artifact verification, an isolated Node 24 tarball installation, and a mandatory Node.js `^22.19.0` tarball runtime smoke. It does not replace real-browser and real API/Agent acceptance. Installing TypeScript source directly from Git requires the install phase to create `lib/`. Without a verified `prepare` flow, use the published package or a prebuilt tarball.

### Complete release evidence gate

Before an actual release, commit the final code, documentation, and screenshots and keep the worktree clean. Create the following two Secret-free JSON files outside the repository. Each must be under 32 KiB, target the current package name/version and lowercase 40-character HEAD, and use a canonical UTC ISO-8601 `completedAt` no more than 72 hours old.

Browser evidence must attest onboarding, settings, Design, LLM, Web, 401 Credential recovery, accessibility, themes, and viewport acceptance:

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

Real API/Agent evidence must cover catalogs, parameter planning, image, video, audio, the LLM Agent, and Web. An operator must explicitly trigger every real billed call. The Boolean field records only that authorization; never include a Key, Authorization header, Credential, request header, or other Secret in evidence:

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

For a live run, first complete one Modellix-backed DSH Agent turn in an isolated Web profile. Have the acceptance process provide `MODELLIX_API_KEY` directly from a controlled source, set `MODELLIX_ALLOW_BILLED_E2E=1`, `MODELLIX_REAL_AGENT_ATTESTED=1`, and absolute outside-repository paths in `MODELLIX_REAL_E2E_OUTPUT_DIR` and `MODELLIX_API_AGENT_E2E_EVIDENCE_FILE`, then run `pnpm run test:real:modellix`. The runner uses no Mock transport: it performs live catalogs and Schema planning, submits one image/video/audio POST each, uses bounded task reads, calls real Web Search/Fetch, saves downloaded media for independent decoding checks, and writes Secret-free evidence. It does not accept a Key on the command line.

Run the complete gate with absolute paths:

```sh
MODELLIX_BROWSER_EVIDENCE_FILE=/absolute/path/browser-evidence.json \
MODELLIX_API_AGENT_E2E_EVIDENCE_FILE=/absolute/path/api-agent-evidence.json \
pnpm run verify:release
```

The gate does not execute or retry billed calls. It fails for a missing, failed, or unknown fixed check; in-repository or stale evidence; package/commit mismatch; unavailable Node 22; or a dirty worktree. Node 22 is discovered from NVM or can be supplied by absolute `MODELLIX_NODE22_BINARY`; it is never silently skipped.

## First-time setup

When the plugin has no usable Credential and setup has not been deferred, the Harness Web UI displays the “Connect Modellix” dialog.

![Chinese-language Modellix first-time setup dialog with an empty API Key field and Design, LLM, and Web switches enabled](../assets/onboarding-defaults.webp)

### Standard flow

1. Enter the Key in the “Modellix API Key” field. The field is masked by default.
2. Review the Design, LLM, and Web feature switches. All three are on by default on a fresh installation.
3. Select “Save and enable.” The plugin stores the Key through the Harness Credential boundary before it stores non-secret settings.
4. After a successful save, the draft is cleared. The UI shows only configured status and source; it never reveals the stored Key.

Use the “Show API Key / Hide API Key” button to inspect only the current unsaved draft. The button cannot read a stored Credential.

### Configure later

Selecting “Configure later” stores the current feature switches and closes this onboarding request. It does not create a Credential or mark any Modellix capability as Ready.

- You can configure the Key directly from Modellix settings at any time.
- The next explicit use of an enabled Modellix capability that needs a Credential creates a new recovery request and prompts again.
- A single recovery request displays only one Credential dialog; concurrent 401 responses do not stack dialogs.

A mandatory Credential dialog cannot close implicitly through Escape or the backdrop, but “Configure later” remains visible and keyboard accessible.

## Credential sources and security

### Two sources

| Source | Configuration | Can the UI replace/remove it? | How to update it |
| --- | --- | --- | --- |
| Local Harness Credential | Enter during first-time setup or in Modellix settings | Depends on whether the Credential store is writable; normally yes | Select “Replace API Key” or “Remove API Key” in settings |
| Environment variable | Provide `MODELLIX_API_KEY` in the Harness launch environment | No; it is read-only in the UI | Update the external launch environment or secret manager, then restart Harness |

If a usable environment Credential already exists, first-time setup normally does not ask for another Key. If that environment Key receives an explicit 401, the UI explains that it cannot be overridden. Update the launch environment and restart Harness.

Do not write a Key value directly into documentation, shell history, or launch arguments. Use the operating system, service manager, or a controlled Secret mechanism to inject `MODELLIX_API_KEY` into the Harness process.

### Security boundary

- A stored Key is resolved only inside the Harness Host Credential boundary; the Client never reads its bytes.
- An unsaved draft exists only in the current form state and is cleared on save, cancel, “Configure later,” or component unmount.
- After save, the Credential value never returns to the Client or enters a URL, query, hash, settings document, Design task record, prompt, model context, Tool argument, user-facing diagnostic, DOM, ARIA, log, or screenshot.
- Public model Schema requests carry no Authorization. Authenticated requests are limited to fixed Modellix HTTPS origins.
- Design revalidates the exact Modellix endpoint from the Schema and rejects cross-origin redirects.
- Persisted Design records contain only request/task identifiers, model, state, and result URLs—not the Key or prompt.

Screenshots and issue reports must never contain a real Key, Network request details, HAR, Credential files, sensitive Console context, or persistent recordings of a real-Secret flow.

## Modellix settings

![Chinese-language Modellix settings showing a verified Credential, three feature switches, and LLM catalog status](../assets/settings-ready.webp)

The settings page has three primary cards.

### API Key

The status area shows both Credential source and verification state:

- “Not configured”: no usable Key exists;
- “Configured in the local Credential store”: a local Credential is the source;
- “Configured by a read-only environment variable”: `MODELLIX_API_KEY` is the source;
- “Waiting for verification / Verified / Invalid Key”: the current verification state.

For a writable local Credential, settings always retains a “Configure/Replace API Key” action. A configured local Credential also has “Remove API Key.” After removal, an enabled capability requests configuration on its next explicit call.

An environment-sourced Key cannot be replaced or removed in the UI.

### Feature switches

Design, LLM, and Web can be toggled independently. You must select “Save changes” before an edit takes effect:

- With Design off, the Design view retains an explanation but cannot select models or submit generations.
- With LLM off, the plugin no longer maintains the Modellix LLM catalog and manual refresh is unavailable.
- With Web off, the Modellix Web provider is unavailable.

Disabling a feature does not delete existing upstream tasks, account data, or an external Key.

### LLM model catalog

This card shows catalog health, available model count, and last refresh time. Manual refresh is available only when LLM is enabled and a Credential is configured.

A catalog refresh failure does not create a static replacement list or misreport a 402, 429, network failure, or 5xx as an invalid Key.

## Design: image, video, and audio generation

### Left/right layout

![Chinese-language Modellix Design desktop layout with model, prompt, and parameters on the left and generation results on the right](../assets/design-desktop.webp)

Design uses a “conversation and parameters on the left, results on the right” two-column layout on desktop:

- The left workspace contains model search and filters, model selection, the primary prompt, Schema parameters, the natural-language parameter assistant, and the single primary media-generation action.
- The right results pane contains task states, media previews, expiry, download actions, and diagnostics.

When the Design container is `992px` wide or narrower—for example, because the Harness sidebar reduces the available slot—the columns become one: the workspace comes first and Results follows. A viewport fallback also stacks the layout at `768px` and below. Content scrolls vertically, so horizontal scrolling is not required to reach a key action.

### Select a model

Design uses the current Modellix catalog instead of a static list assumed to remain valid forever.

1. Search by model name, provider, or model id.
2. Filter by All types, Image, Video, or Audio.
3. Select a target in the model list. Models marked featured by the catalog have a star.
4. Select “Refresh models” when you need the latest catalog. If live refresh fails while a cached result remains usable, the UI explicitly states that it is showing the most recent result.

The plugin first restores the most recently selected model if it remains available. Otherwise, it chooses a preferred available model from the current catalog. Select again if a model is removed or becomes unavailable.

### Schema parameters and defaults

After model selection, the plugin reads its public `api_schema` and turns supported structures into a form:

| Schema information | UI behavior |
| --- | --- |
| Primary prompt field | A required multiline prompt field |
| `default` | Materialized into the draft and submitted unless the user overrides it |
| `required` | Marked required; a missing value prevents generation |
| `enum` | Select control |
| `boolean` | Switch |
| `number` / `integer` | Numeric input with minimum, maximum, and step constraints |
| String | Single-line or multiline text input with length constraints |
| Array or object | JSON editor with separate syntax-error and Schema-constraint messages |
| An unsupported structure that cannot be interpreted safely | The field is disabled or the model cannot submit, with an explanation |

Optional parameters are collapsed under “Advanced parameters” by default. The Schema is an invocation contract, not a hint: Design rereads and compares it before generation. If the model definition changed, the old draft is rejected; refresh and confirm parameters again.

### Three editing methods

#### 1. Enter only a prompt

For a model such as GPT Image 2 whose public Schema supplies the other defaults, the common path is:

1. Select the model.
2. Enter a prompt.
3. Review the default parameters.
4. Select “Confirm and generate.”

The live model Schema always determines actual required fields. This guide does not assume that every model needs only a prompt.

#### 2. Edit exact parameters

Directly edit dimensions, aspect ratio, duration, count, format, or other model-advertised parameters. User values override defaults; the plugin does not send arbitrary fields absent from the Schema.

If JSON cannot be parsed, the UI reports a JSON syntax error. If JSON parses but fails the current field constraints, it reports a parameter constraint error. Any invalid field or missing required field disables generation.

#### 3. Adjust parameters in natural language

Under “Adjust parameters by chat,” enter an instruction such as “make it 16:9, eight seconds, and more cinematic,” then select “Propose parameter changes.”

This action:

- uses the same Modellix Key with the fixed `openai/gpt-5.6-luna` model;
- may incur separate LLM usage;
- can change only parameters declared by the current Schema;
- returns a summary, before-and-after field changes, and any conflicts;
- neither applies changes nor starts media generation automatically.

![Chinese-language Design parameter proposal showing before-and-after changes with Apply and Reject actions](../assets/design-proposal.webp)

After review, select “Apply changes” or “Reject.” Resolve conflicts first. If parameters or the Schema changed after proposal creation, the stale proposal is rejected; create another proposal.

### Worked Design example: a premium cliffside library

Use this as a reproducible image-generation pattern, while treating the selected model's live Schema as authoritative:

| Input | Example value |
| --- | --- |
| Model | `openai/gpt-image-2`, only when it is currently listed as available and its live Schema exposes the fields below |
| Prompt used in acceptance | `A premium editorial architectural photograph of a quiet cliffside library above a misty alpine lake at blue hour, carved pale stone arches, warm amber reading lamps, one thoughtful reader, subtle greenery, natural reflections, cinematic but realistic lighting, restrained navy and ivory palette, precise composition, no text, no logo.` |
| `quality` | `high` |
| `size` | `1536x1024` |

1. Select the available image model and wait for its parameters and defaults to load.
2. Enter the prompt. Set `quality` to `high` and `size` to `1536x1024`; leave every unrelated field at the current Schema default.
3. Either edit those controls directly, or enter “Set quality to high and size to 1536x1024” in the parameter assistant. The assistant returns a reviewable two-field proposal; it does not generate the image.
4. Review the proposal and form, apply the changes if needed, and confirm model, output count, balance, and account-side pricing.
5. Select “Confirm and generate” once, then follow the task in the right results pane.

The parameter proposal may incur separate LLM usage. The final media request is also potentially billed and is submitted exactly once; the plugin does not automatically retry it. If the live Schema does not expose `quality`, `size`, or either example value, do not add or force them—use only the controls and values advertised by that model.

The 2026-08-26 real acceptance run used controlled credentials without exposing them to the browser. It completed the high-quality `openai/gpt-image-2` Design flow shown below, a 6-second 768P `minimax/hailuo-2.3-t2v` task, an `alibaba/qwen-audio-3.0-tts-plus` narration, a Modellix-backed DSH Agent turn, real Web Search/Fetch calls, and a separate native `deepseek-official` DSH Agent baseline. The downloaded video decoded as H.264 at 1366×768 and 5.875 seconds; the narration decoded as mono MP3 at 22.05 kHz and 7.94 seconds. Release evidence remains outside the repository and contains no Secret.

### Confirmation and one-shot billed submission

“Confirm and generate” starts the actual media generation and may incur a charge. Before submitting, confirm that:

- the model is correct;
- the prompt and every required field are complete;
- no parameter has a syntax or constraint error;
- the account balance, pricing rules, and expected output count are acceptable.

Each click performs one billed POST. The plugin never retries that POST automatically and never follows a cross-origin redirect. Task status reads are separate read-only operations with bounded safe retries for transient failures.

If the connection ends during submission and the plugin cannot know whether upstream accepted the request, it records “Submission outcome unknown.” This is a replay fence, not proof of failure. Check the right pane or Modellix-side records before deciding whether to start a new generation manually.

### Results, previews, and expiry

![Chinese-language Design results pane showing the image created during real acceptance, its expiry, and download action](../assets/design-results-media.webp)

When you reopen Design or enter a new Harness session, the results pane reloads Host-persisted records, so unexpired resources remain available. Results are sorted by most recent update. The UI shows at most the latest 1,000 current persisted records, grouped as:

- Running: submitted, queued, or in-progress tasks;
- Succeeded: successful tasks with an available resource;
- Diagnostics: failed, canceled, unknown-submission, expired, or refresh-blocked tasks.

Images have a thumbnail and full-image viewer. Video and audio use native browser playback controls. Every available resource has a download action. External links open with no-referrer safety attributes.

Result URLs are upstream Modellix resources:

- An upstream resource or task expiry takes precedence when present.
- If upstream provides no expiry, the plugin uses a seven-day local display limit from completion or the last update.
- After expiry, the resource is no longer presented as available.
- The local limit does not renew, proxy, or permanently store the upstream file.

After replacing an API Key, a running task owned by an earlier Credential epoch may no longer refresh, while its existing non-secret record can still show the appropriate diagnostic.

## LLM: synchronize and switch models

LLM reuses the same Key and does not require a separate Credential per model.

1. In Modellix settings, confirm that LLM is enabled and the Credential is usable.
2. Review “LLM model catalog” status and select “Refresh LLM models” when needed.
3. Open the native Harness model selector.
4. Select a target from the current catalog under the Modellix provider.
5. The new model applies from the next model call.

Switching models does not replay an earlier call. Each new Harness model call may incur Modellix usage, and the provider retry limit remains `0`. If the desired model is missing, refresh the catalog in settings instead of typing an unverified model id.

![English-language Harness model selector expanded to the Modellix provider with multiple LLM models synchronized from the live catalog](../assets/llm-model-selector.webp)

The plugin safely merges the live catalog into the Harness `llm-pi-ai` route while preserving unknown fields and user model metadata it does not own. The protocol configuration is:

- provider id: `modellix`;
- OpenAI Completions-compatible protocol;
- base URL: `https://llm.modellix.ai/v1`;
- default input: text;
- plugin-layer automatic retries: `0`.

When the catalog is unavailable, its status is error or unavailable. The plugin does not guess model ids or build a static fallback catalog. LLM calls may be billed under Modellix account rules.

## Web: native search and fetch

When Web is enabled and a Credential is usable, the plugin registers:

- the Modellix Search provider for native `web_search`;
- the Modellix Fetch provider for native `web_fetch`.

It does not create duplicate custom tools. Harness continues to own tool arguments, presentation, and lifecycle; the Bundle only selects the `modellix` provider.

![English-language Harness conversation showing native web_search and web_fetch completed by the Modellix provider for a Chinese public-documentation request](../assets/web-tools.webp)

For a typical flow, ask Harness to search a public topic, inspect the native `web_search` sources, and then fetch only the result you need with `web_fetch`. The provider is unavailable when Web is disabled, the Key is removed, or the Key is explicitly invalid. Web requests may incur Modellix usage. The provider does not automatically retry a request; when a potentially billed Fetch outcome is unknown, inspect the Harness transcript or Modellix-side record before manually repeating it. Do not put Secrets, private data, or content that should not be sent to a third party in a query or target page.

## States, errors, and recovery

| State or error | Meaning | Recommended action |
| --- | --- | --- |
| Missing API Key | An enabled capability has no usable Credential | Configure it in recovery or Modellix settings, or choose Configure later |
| HTTP 401 / invalid Key | Modellix explicitly rejected the Credential | Replace a local Key; update `MODELLIX_API_KEY` and restart Harness for an environment source |
| HTTP 402 | Billing is unavailable or blocked | Check balance and billing; do not replace an otherwise valid Key to hide the issue |
| HTTP 429 | The request was rate limited | Wait as instructed and retry manually; a billed submission is not replayed automatically |
| Offline or DNS/connection failure | Harness Host cannot currently reach Modellix | Check network, proxy, and fixed HTTPS origins, then retry manually |
| Timeout | The request did not complete within its bound | Retry reads later; for an unknown billed submission, check records first |
| 5xx | Modellix is temporarily unavailable | Retry manually later; the Key is not marked invalid |
| Policy blocked | Account or environment policy rejects the operation | Check Harness and Modellix account policy |
| Schema unavailable/unsupported | The model contract cannot be interpreted safely | Refresh or select another model; do not bypass validation |
| Schema changed | A pre-submit reread found an old draft contract | Reselect/refresh the model and confirm parameters again |
| Submission outcome unknown | The billed POST outcome cannot be determined | Check Results or Modellix-side records before another billed action |
| Resource expired | The upstream URL or local display period ended | The plugin cannot renew it; generate again if needed |
| LLM catalog unavailable | Catalog read or materialization failed | Check switch, Key, network, and policy, then refresh manually |
| Credential changed | The task belongs to an earlier Credential epoch | The old running task may not refresh; inspect diagnostics and do not auto-resubmit |

### Credential recovery flow

1. Only an explicit 401 marks the Key invalid and creates a recovery request. Concurrent 401 responses are coalesced into one Credential dialog.
2. If a local Key editor is already open, it upgrades in place to mandatory recovery wording. If an ordinary plugin dialog such as Remove API Key or the full-image viewer is open, recovery waits until that dialog closes instead of stacking a second modal.
3. For a writable local Credential, enter a replacement and save it. The stored Key remains write-only, and the plugin does not replay the failed or billed operation; retry the intended capability explicitly after recovery.
4. For an environment source, update `MODELLIX_API_KEY` outside Harness and restart the profile because the UI cannot replace it.
5. “Configure later” dismisses only the current request. A timer does not repeatedly steal focus; another prompt appears only after a later explicit capability call still needs a Credential.

A 402, 429, offline failure, timeout, or 5xx remains distinct and does not open invalid-Key recovery.

![Chinese-language Modellix recovery dialog after an invalid API Key with an empty field and Configure later action](../assets/credential-recovery.webp)

## Accessibility, keyboard, and responsive behavior

### Keyboard interaction

- When a Credential dialog opens, initial focus moves to the API Key field.
- `Tab` and `Shift+Tab` wrap inside the dialog while background content is inert.
- Show/Hide Key is a native button with a dynamic accessible name and `aria-pressed` state.
- Enter in the Key field can save. During save, the button retains action text, is marked busy, and blocks duplicate submission.
- Ordinary confirmation dialogs support Escape. A mandatory Credential gate does not close implicitly with Escape, but Configure later remains focusable.
- When a dialog closes, focus returns to the trigger or a reasonable primary-content location.

Fields use real labels; help and errors are linked through stable relationships, and invalid fields expose `aria-invalid`. Asynchronous progress and result changes use polite live regions without treating an entire interactive region as an alert.

### Display and touch

- Design has two columns when its container is wider than `992px`; narrower host slots use one column, with a viewport fallback at `768px`.
- Below `560px`, model tools and action buttons stack and fill available width.
- The layout targets `320 CSS px` and 200% text zoom. Long URLs, environment variable names, and Chinese/English copy can wrap.
- In coarse-pointer environments, inputs, selects, disclosure summaries, links, and action buttons provide at least a 48px target.
- Harness semantic tokens adapt the UI to light, dark, and Windows forced-colors modes.
- `prefers-reduced-motion: reduce` disables unnecessary animation and transitions.

![English-language Modellix Design in a single-column layout at 320 pixels with the workspace above Results](../assets/design-mobile-en.webp)

## Cost and security checklist

Distinguish reads from actions that may incur usage:

| Action | May incur Modellix usage? | Plugin retry behavior |
| --- | --- | --- |
| Save/validate Key, read catalogs, or read public Schema | Normally a read or validation action; current Modellix rules apply | Runs inside the safe boundary and never mixes in a billed generation submission |
| Design natural-language parameter proposal | Yes; it calls a fixed LLM | The model call is not retried automatically |
| Design “Confirm and generate” | Yes; media generation | Exactly one billed POST, no automatic retry |
| Design task status read | Normally read-only | Transient failures may use bounded retries |
| A Modellix LLM call in Harness | Yes | Provider retry limit is `0` |
| `web_search` / `web_fetch` | Possibly | A user or agent should not automatically repeat a sensitive operation after an unknown outcome |

Before every generation, review model, parameters, count, and account-side pricing. Prefer no-cost read APIs during real validation. An operator must explicitly trigger any billed E2E call.

Use only an empty Key or an explicitly fake Key in security reports and documentation screenshots. Do not rely on blurring a captured real Secret later. If a real Key is ever captured, discard the image and rotate the Key under the incident process.

## Troubleshooting

### The first-time setup dialog did not appear

- A local or environment Credential may already exist; inspect Modellix settings.
- You may have selected Configure later. Configure directly in settings, or explicitly open an enabled Modellix capability to create a new recovery request.
- If settings itself failed to load, use Retry in the dialog and inspect the Harness Host connection.

### Design has no models

1. Confirm that the Design switch was saved as enabled.
2. Confirm that a Credential is configured and not in 401 invalid state.
3. Select “Refresh models.”
4. Check Host network access to Modellix over HTTPS.
5. If the catalog works but one model cannot submit, its Schema may not be supported; select another model.

### “Confirm and generate” is unavailable

Check for a missing Key, disabled Design, unavailable model, empty required field, JSON syntax error, Schema constraint violation, or a blocking unsupported Schema structure. The UI displays a nearby reason while the action is unavailable.

### A parameter proposal cannot be applied

- Resolve conflicts shown in the proposal card first.
- If you edited parameters after creating the proposal, reject the old proposal and create another.
- If the Schema or model changed, refresh and enter the instruction again.

### A task stays Running or enters Diagnostics

- A 429, network failure, or 5xx lets safe read-only polling continue later, with a diagnostic in the UI.
- Repeated read failures can reach the polling bound; after connectivity returns, reopen or refresh the view.
- Replacing the Key can stop refresh for a task from an older Credential epoch.
- Do not click the billed generation action again merely because the page did not update immediately.

### A completed result is missing

Check whether the task is under Diagnostics, whether the resource expired, and whether the upstream URL remains available. The plugin stores no media copy and cannot recover an expired resource.

### An LLM model is absent from the selector

Confirm the LLM switch and Key, inspect catalog health in settings, and refresh manually. After successful materialization, reopen the Harness model selector. There is no fabricated fallback catalog after a catalog failure.

### Web Tools are unavailable

Confirm that the Web switch was saved, the Credential is usable, and `dsh --profile web --dump-config` selects `modellix` for Search/Fetch. Restart the profile after updating the Bundle.

### An environment Key cannot be changed in the UI

This is expected. The environment source is read-only. Update `MODELLIX_API_KEY` in the external Harness launch environment or secret manager, then restart Harness.

## Uninstallation

1. For a local writable Credential, select “Remove API Key” in Modellix settings first.
2. For an environment source, revoke `MODELLIX_API_KEY` in the external launch environment or secret manager.
3. Remove the plugin from the target profile and inspect the configuration:

```sh
dsh plugin --profile web remove dsh-modellix
dsh --profile web --dump-config
dsh --profile web
```

4. Confirm that `--dump-config` no longer contains the `dsh-modellix` Bundle layer or `modellix` plugin row.

Uninstallation does not promise to delete upstream Modellix tasks, external environment variables, or every piece of persisted Harness data. If your organization requires complete cleanup, inspect Credential storage, Harness profile data, and Modellix account records separately.

## Current limitations

- The natural-language parameter assistant modifies only fields declared by the current Schema; it does not run an open-ended agent workflow.
- There is no upstream cancellation API, and the UI has no generation cancellation button.
- Results are upstream URLs plus task metadata, not a permanent local media library.
- An unsupported complex Schema blocks submission instead of guessing or silently dropping constraints.
- LLM depends on the live catalog and provides no fabricated model when the catalog is unavailable.
- Web uses the native Harness Tool seam; the plugin has no duplicate custom Tool UI.

## Included screenshots and safe-capture checklist

These images were captured in an isolated acceptance profile and checked for Secrets. Most plugin copy is Chinese; `design-mobile-en.webp` and `llm-model-selector.webp` use English Harness chrome, while `web-tools.webp` uses English Harness chrome around a Chinese public-documentation request and response. Both guides reuse the same safe set with language-appropriate alt text:

| Suggested file | Alt text | Capture focus |
| --- | --- | --- |
| `docs/assets/onboarding-defaults.webp` | Chinese-language Modellix first-time setup dialog with an empty API Key field and Design, LLM, and Web switches enabled | Empty password field, three default switches, Configure later and Save actions |
| `docs/assets/settings-ready.webp` | Chinese-language Modellix settings showing a verified Credential, three feature switches, and LLM catalog status | Show configured status only, never the Key |
| `docs/assets/design-desktop.webp` | Chinese-language Modellix Design desktop layout with model, prompt, and parameters on the left and generation results on the right | 1440px, generic prompt, non-sensitive result |
| `docs/assets/design-proposal.webp` | Chinese-language Design parameter proposal showing before-and-after changes with Apply and Reject actions | No personal data; make clear that a proposal does not generate automatically |
| `docs/assets/design-results-media.webp` | Chinese-language Design results pane showing the image created during real acceptance, its expiry, and download action | The image uses a public test prompt; video and audio passed separate real API acceptance and are not mixed into this screenshot |
| `docs/assets/design-mobile-en.webp` | English-language Modellix Design in a single-column layout at 320 pixels with the workspace above Results | 320px, longest English copy, no clipped key action, and visible English localization |
| `docs/assets/credential-recovery.webp` | Chinese-language Modellix recovery dialog after an invalid API Key with an empty field and Configure later action | Simulated 401 only; never show a real Key |
| `docs/assets/llm-model-selector.webp` | English-language Harness model selector expanded to the Modellix provider with models synchronized from the live catalog | Show only public model names, with no account or call content |
| `docs/assets/web-tools.webp` | English-language Harness conversation showing native web_search and web_fetch completed for a Chinese public-documentation request | Use public documentation; do not show private URLs, Cookies, or request details |

These screenshots show only an empty Key, an explicitly fake Key, public model names, public URLs, and generic test prompts. The real Key was read directly by the acceptance process and never entered the browser, screenshots, Network/HAR, Console, Credential files, or persistent recordings. Future screenshot updates must preserve the same rule.

## References

- [English README](../../README.md)
- [Chinese README](../../README.zh-CN.md)
- [Modellix getting started](https://docs.modellix.ai/get-started)
- [Modellix LLM overview](https://docs.modellix.ai/llm/overview)
- [Modellix GPT Image 2 example](https://www.modellix.ai/zh_CN/models/openai/gpt-image-2)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
