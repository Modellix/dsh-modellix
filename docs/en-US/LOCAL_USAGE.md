# Using dsh-modellix locally

English | [简体中文](../zh-CN/LOCAL_USAGE.md)

This guide shows how to build `dsh-modellix` from the current source checkout on Windows, install it into an isolated DeepSeek Harness Web profile, and use Design, LLM, and Web locally. An isolated profile avoids changing an existing Harness setup.

## 1. Prerequisites

You need:

- DeepSeek Harness `0.1.2-alpha.4` (latest supported); `0.1.1-rc.2` remains supported
- Node.js `24.18.1`; the published runtime also supports `^22.19.0`
- pnpm `11.24.0`
- A valid Modellix API Key
- A DeepSeek API Key if a fresh Harness profile first requires initialization of its official model

Check the active tools in PowerShell:

```powershell
node --version
pnpm --version
dsh --version
```

If NVM is installed, select the repository version:

```powershell
nvm use 24.18.1
node --version
pnpm --version
```

## 2. Build a tarball from this checkout

Enter the repository and install the locked dependencies:

```powershell
Set-Location 'D:\work\maas\githup\dsh-modellix'
pnpm install --frozen-lockfile
pnpm run verify:env
pnpm run verify:pack
pnpm pack
```

The repository root will contain a file such as `dsh-modellix-0.2.1.tgz`. Do not ask DSH to install the unbuilt TypeScript checkout directly.

## 3. Create an isolated local Harness environment

Set an independent `DSH_HOME` for the current PowerShell session:

```powershell
$env:DSH_HOME = 'D:\work\maas\.dsh-modellix-local'
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
```

This affects only the current PowerShell process and its children. Omit this step to use an existing Harness environment, but verify its current `DSH_HOME` and target profile first.

## 4. Install the plugin

Install the tarball into the `web` profile and inspect the merged configuration:

```powershell
dsh plugin --profile web add .\dsh-modellix-0.2.1.tgz
dsh --profile web --dump-config
```

The output should contain the `dsh-modellix` Bundle layer and a plugin whose id is `modellix`. Use the actual filename printed by `pnpm pack` when the package version differs.

## 5. Provide credentials

### Recommended: save the Modellix Key in the UI

Enter the Key in the “Connect Modellix” dialog after Harness starts. The local Harness Credential service stores it. After saving, the browser displays only its status and source, never the stored value.

The `modellix-cli` Keychain and Harness Credential service are separate stores. The plugin does not automatically read a CLI login, even when `modellix-cli auth status` reports an authenticated profile.

### Optional: inject controlled files into the launch environment

When an outside-repository controlled file contains only the Key value, PowerShell can read it directly into the child process environment. Do not put the real value in the command, a script, or this repository:

```powershell
$env:DEEPSEEK_API_KEY = (Get-Content -LiteralPath 'D:\secrets\deepseek-key.txt' -Raw).Trim()
$env:MODELLIX_API_KEY = (Get-Content -LiteralPath 'D:\secrets\modellix-key.txt' -Raw).Trim()
```

An environment-sourced Modellix Key is read-only in the UI. Stop and restart Harness after changing its controlled file. Leave `MODELLIX_API_KEY` unset when using only the UI Credential.

## 6. Start the local Web UI

```powershell
dsh --profile web --no-open
```

The terminal prints the actual address, such as `http://127.0.0.1:3080`. Open the printed address; do not assume the port is fixed.

A fresh profile may first show Harness's own DeepSeek initialization dialog. Complete or otherwise handle that step before the plugin presents “Connect Modellix”:

1. Enter the Modellix API Key, or confirm the read-only environment source.
2. Review the Design, LLM, and Web switches; all three start enabled.
3. Select “Save and enable.”

## 7. Use chat-first media creation

1. Open a conversation and describe the image, video, edit, transformation, or voice you want. Do not name tool functions.
2. The Agent searches the live catalog and reads the selected model Schema when needed.
3. For a request based on the previous result, the Agent reuses the latest relevant result URL and selects an edit/image-to-video/video-to-video model.
4. The Agent submits once and checks at most once in that turn.
5. Follow the live card in chat. It updates in place when the background task finishes; no second result card should appear.
6. Select **Modellix Design** at the far right of the session header to see all current-session results.
7. Use Preview/JSON on successful cards, image enlargement, native video/audio players, **Add URL to chat**, and **Download**.

The advanced exact-parameter editor remains internal but its entry is hidden in `0.2.1`. Routine UI flows do not display payment prompts; usage and details remain available in Modellix.

## 8. Use Modellix LLM models

1. Open “Settings → Modellix” and confirm that LLM is enabled and the live catalog is healthy.
2. Return to the conversation and expand the Modellix provider in the model selector.
3. Select a model and send the next message. A new selection applies to the next model call.

The catalog is live. The plugin does not invent fallback models when it cannot load that catalog.

## 9. Use automatic Web Search/Fetch

With Web enabled, ask a current, external, URL, or source-verification question normally. The Agent automatically uses explicit `modellix_web_search` and `modellix_web_fetch` tools when needed; users do not need to name either tool.

With Web disabled, those two explicit tools are unregistered. The plugin does not alter the profile's native `web_search` / `web_fetch` tools or provider selection, so native automatic Web behavior remains available.

## 10. Update the local plugin

After source changes:

1. Press `Ctrl+C` in the Harness terminal.
2. Rebuild, pack, and install the new tarball.
3. Restart the Web profile. Reloading the browser alone does not load a new Client Bundle.

```powershell
Set-Location 'D:\work\maas\githup\dsh-modellix'
pnpm run verify:pack
pnpm pack
dsh plugin --profile web add .\dsh-modellix-0.2.1.tgz
dsh --profile web --dump-config
dsh --profile web --no-open
```

## 11. Troubleshooting

| Symptom | Resolution |
| --- | --- |
| A DeepSeek API Key dialog appears first | This is the fresh Harness profile's base initialization, not the Modellix dialog; complete it before configuring Modellix |
| The CLI is logged in but the plugin still requests a Key | The CLI Keychain and Harness Credential service are separate; save it in the plugin UI or inject `MODELLIX_API_KEY` into the Harness process |
| Modellix Design is missing | Inspect `--dump-config`, confirm Design is enabled, and fully restart the running profile after an update |
| A task remains stale in assistant prose | Current status belongs to the live card and right panel; `0.2.1` updates the card in the background and avoids nonterminal status wording in ordinary prose |
| One task shows two cards | This is not expected in `0.2.1`; record the job/tool call ids without Secrets and report a duplicate-card defect |
| The UI reports an invalid Key | Only an explicit Modellix 401 enters this state; replace a local Credential in settings, or update an environment source and restart |
| Balance is insufficient | A 402 is not treated as an invalid Key; fund the account or change the task before retrying manually |
| Requests are rate-limited | Wait for the 429 window to end before retrying manually |
| A result disappears | Results depend on upstream URLs; the local seven-day display limit used when no expiry is supplied does not extend resource life |
| The port is occupied | Check for an existing usable DSH Web process first and reuse it instead of starting duplicate profiles |

## 12. Stop and uninstall

Press `Ctrl+C` in the service terminal. To uninstall:

```powershell
dsh plugin --profile web remove dsh-modellix
dsh --profile web --dump-config
Remove-Item Env:MODELLIX_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
```

Remove a locally stored Modellix Credential under “Settings → Modellix” first. Uninstalling does not delete upstream tasks, external environment variables, or every Harness data record.

See the [complete English user guide](USER_GUIDE.md) for all feature, state, and security details.
