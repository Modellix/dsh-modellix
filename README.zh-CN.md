[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-modellix

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Modellix Profile Bundle：只需一个 Modellix API Key，即可使用 Schema 驱动的 Design 媒体生成、实时 LLM 模型目录和原生 Web Provider。

> Harness 与本插件当前都使用预发布接口。升级 Harness 前，请核对本包的 peer dependencies 和 [CHANGELOG](CHANGELOG.md)。

![Modellix Design 桌面布局，左侧为模型、提示词和参数，右侧为生成结果列表](docs/assets/design-desktop.webp)

## 功能概览

| 功能 | 用户体验 | 实际行为 |
| --- | --- | --- |
| Design | 左侧选择模型、输入提示词和调整参数，右侧查看任务与结果 | 实时读取图片、视频和音频模型及其公开 Schema；计费生成只提交一次 |
| LLM | 在 Harness 模型选择器中快速切换 Modellix 模型 | 把实时目录合并到 Harness 的 `llm-pi-ai` Modellix Provider |
| Web | 使用 Harness 原生 `web_search` 与 `web_fetch` | 注册 Modellix Search/Fetch Provider，不创建同名自定义 Tool |

首次配置弹窗包含 API Key 输入框以及 Design、LLM、Web 三个开关，三个开关默认全部开启，之后可在 Modellix 设置页分别关闭。

## 环境要求

- DeepSeek Harness `0.1.1-rc.2`
- 已发布包运行时：Node.js `^22.19.0 || >=24.0.0`
- 源码开发与发布校验：Node.js `24.18.1`、pnpm `11.24.0`（以 `.nvmrc` 与 `packageManager` 为准）
- 一个有效的 [Modellix API Key](https://docs.modellix.ai/get-started)

`dsh-modellix` 自带 Harness 集成，运行时不会安装或调用 `modellix-cli`。

## 安装

将已发布包安装到目标 Web profile，检查合并后的配置，然后启动或重启该 profile：

```sh
dsh plugin --profile web add dsh-modellix
dsh --profile web --dump-config
dsh --profile web
```

`--dump-config` 应显示 `dsh-modellix` Bundle 层和 id 为 `modellix` 的插件行。若使用其他 profile，请把命令中的 `web` 替换为对应名称。

也可以从可信源码构建 tarball 后安装：

```sh
pnpm install --frozen-lockfile
pnpm run verify:release:static
pnpm pack
dsh plugin --profile web add ./dsh-modellix-0.1.0.tgz
```

直接从 Git 安装 TypeScript 源码要求安装阶段能生成 `lib/`。包未提供经过验证的 `prepare` 流程时，请使用已发布包或本地 tarball。

## 首次配置

1. 打开 Harness Web UI，等待“连接 Modellix”弹窗。
2. 输入 API Key，并确认 Design、LLM、Web 三个默认开启的开关是否符合需要。
3. 选择“保存并启用”。保存成功后，浏览器不再回显 Key，只显示 Credential 状态和来源。
4. 暂时不配置时可选择“稍后处理”。这不会把插件标记为可用；下次显式使用已开启且需要凭据的 Modellix 能力时会再次提示。

API Key 可以来自两处：

- 在首次配置或设置页输入，由 Harness Credential 服务保存。
- 由 Harness 启动环境中的 `MODELLIX_API_KEY` 提供。环境来源在 UI 中只读；更新后必须重启 Harness。

不要把真实 Key 写入仓库、命令参数、日志、截图、HAR、录像或测试快照。

完整配置说明见[用户指南：首次配置与 Credential](docs/zh-CN/USER_GUIDE.md#首次配置)。

## 快速使用

### Design：生成图片、视频或音频

1. 打开 Harness 的 **Design** 视图。
2. 搜索、按输出类型筛选并选择模型。插件会优先恢复最近选择的可用模型，否则从当前目录中选择推荐的可用模型。
3. 输入主提示词。很多模型只需提示词即可使用；其余字段由模型当前的 `api_schema` 决定，并自动填充公开默认值。
4. 需要精准控制时，直接编辑枚举、开关、数值、文本或 JSON 参数；不满足 Schema 约束的值会阻止提交。
5. 需要自然语言改参时，在“用对话调整参数”中描述修改。该操作使用同一个 Key 调用固定的 `openai/gpt-5.6-luna`，可能产生 LLM 用量；它只生成待确认差异，不会自动生成媒体。
6. 检查参数和计费提示后，点击一次“确认并生成”。计费 POST 不自动重试；只读任务状态查询会在有限范围内安全重试。
7. 右侧结果区按“进行中 / 已完成 / 诊断”展示记录，支持图片放大、视频和音频播放以及安全下载。

例如，选择一个当前 Schema 提供 `quality` 和 `size` 参数的可用图片模型，然后输入本次验收提示词：

> A premium editorial architectural photograph of a quiet cliffside library above a misty alpine lake at blue hour, carved pale stone arches, warm amber reading lamps, one thoughtful reader, subtle greenery, natural reflections, cinematic but realistic lighting, restrained navy and ivory palette, precise composition, no text, no logo.

这就是文档中真实 API 图片实际使用的完整提示词，并非简化占位示例。下方截图是在真实 Design 结果列表显示任务完成后拍摄的。

把 `quality` 设为 `high`、`size` 设为 `1536x1024`，其他字段保留模型当前默认值。可以直接精准修改这两个控件，也可以让参数助手生成两项变更提议，再检查差异并应用。参数提议可能产生 LLM 用量，但不会生成图片；只有最后一次“确认并生成”会发起计费媒体请求，插件不会自动重试。若所选模型的实时 Schema 没有这两个字段，不要手动添加，应只使用该模型实际公开的参数和值。

结果仅在上游资源仍有效时可访问。上游未提供有效期时，插件采用 7 天本地展示上限；这不会延长上游 URL 的真实有效期，也不会把媒体复制成永久本地资产。

### LLM：快速切换模型

1. 保持 LLM 开关开启并配置有效 Key。
2. 在 Modellix 设置页查看目录状态、模型数和最近刷新时间；需要时手动刷新。
3. 在 Harness 模型选择器的 Modellix Provider 下选择目标模型。新选择从下一次模型调用开始生效。

LLM 使用 OpenAI Completions 兼容地址 `https://llm.modellix.ai/v1`。插件将 Provider 自动重试上限设为 `0`，避免在插件层重复模型调用；目录不可用时不会虚构静态模型列表。

### Web：搜索与抓取

Web 开关开启且 Key 可用时，可以让 Harness 先搜索公开网页，再按需抓取某条结果。原生 `web_search` 和 `web_fetch` 通过 Modellix Provider 执行，插件不会新增重复的 Tool UI。关闭 Web 或缺少有效 Key 时 Provider 不可用。Web 请求可能产生 Modellix 用量，Provider 不会自动重试；若一次可能计费的 Fetch 结果未知，应先检查 Harness 对话记录或 Modellix 侧记录，再决定是否手动重复。

## 设置、状态与恢复

Modellix 设置页提供：

- Credential 的配置状态、来源、验证状态，以及本地 Credential 的更换和移除；
- Design、LLM、Web 三个独立开关；
- LLM 目录健康状态、模型数、最近刷新时间和手动刷新。

只有明确的 HTTP 401 才会把当前 Credential 标记为无效并触发恢复提示。402、429、网络错误和 5xx 都不会被误报为 Key 失效。若环境变量来源的 Key 无效，请在启动环境中更新 `MODELLIX_API_KEY` 并重启 Harness；UI 不能覆盖它。

插件统一协调所有恢复弹窗：并发 401 只产生一个 Credential 弹窗；已经打开的本地 Key 编辑器会原位升级为恢复语义；若当前正在显示移除确认或图片预览，恢复会等它关闭后再出现，不会叠窗。保存替换 Key 后，再手动重试原本的能力；环境变量来源则必须在 UI 外更新并重启 Harness。

连接中断导致计费提交结果未知时，Design 会显示“提交结果未知”。请先检查结果列表或 Modellix 侧记录，不要自动或连续重提，以免重复计费。

## 可访问性与响应式

- 弹窗打开时显式管理初始焦点、`Tab` / `Shift+Tab` 循环、背景 inert 和关闭后的焦点恢复。
- 强制 Credential 门禁不会通过 Escape 或遮罩隐式关闭，但始终提供可见的“稍后处理”；普通确认弹窗支持 Escape。
- 字段具有可见标签、错误关联、忙碌状态和实时状态播报；状态不只依赖颜色。
- Design 容器宽于 `992px` 时采用左聊右结果；宿主插槽较窄时自动改为单列，并保留 `768px` 视口兜底。目标覆盖 `320px`、200% 文本缩放、浅色/深色、forced-colors、粗指针 48px 点击区和 reduced motion。
- UI 文案跟随 Harness 当前语言；`README.md` 是默认英文入口，本文件提供完整中文版本。

## 卸载

如果 Key 存在本地可写 Credential 中，建议先在 Modellix 设置页移除；环境变量来源应由外部启动环境或密钥管理器撤销。然后从目标 profile 移除插件并重启：

```sh
dsh plugin --profile web remove dsh-modellix
dsh --profile web --dump-config
dsh --profile web
```

卸载插件不会承诺自动清理外部环境变量、上游任务或所有 Harness 持久化数据；如有合规要求，请分别在对应系统中处理。

## 界面预览与安全截图

- [完整中文用户指南](docs/zh-CN/USER_GUIDE.md)
- [Complete English user guide](docs/en-US/USER_GUIDE.md)
- [English README](README.md)

当前仓库已收录 9 张经过安全检查的界面截图；不包含真实账户、Key、Network 请求详情、HAR 或 Credential 文件。中英文文档复用同一组图片。多数插件文案使用中文；`design-mobile-en.webp` 和 `llm-model-selector.webp` 使用英文 Harness 界面，`web-tools.webp` 则在英文 Harness 界面中展示中文公开文档请求与回答：

| 建议文件 | Alt 文本 |
| --- | --- |
| `docs/assets/onboarding-defaults.webp` | Modellix 首次配置弹窗，API Key 输入框为空，Design、LLM 和 Web 开关均开启 |
| `docs/assets/settings-ready.webp` | Modellix 设置页显示已验证 Credential、三个功能开关和 LLM 目录状态 |
| `docs/assets/design-desktop.webp` | Modellix Design 桌面布局，左侧为模型、提示词和参数，右侧为生成结果列表 |
| `docs/assets/design-proposal.webp` | Design 参数提议卡显示待确认的前后差异和应用、拒绝操作 |
| `docs/assets/design-results-media.webp` | Design 结果区显示真实验收生成的图片结果、有效期和下载入口 |
| `docs/assets/design-mobile-en.webp` | 英文 Modellix Design 在 320 像素宽度下使用单列布局，操作区位于结果区上方 |
| `docs/assets/credential-recovery.webp` | API Key 无效后的 Modellix 恢复弹窗，输入框为空并提供稍后处理 |
| `docs/assets/llm-model-selector.webp` | 英文 Harness 模型选择器展开 Modellix Provider，并列出从实时目录同步的多个 LLM 模型 |
| `docs/assets/web-tools.webp` | 英文 Harness 对话中，Modellix Provider 为中文公开文档请求完成原生 web_search 与 web_fetch |

拍摄时只使用空 Key 或明确的假 Key，使用通用提示词和无个人信息的结果；不要拍摄 Network、HAR、Console、Credential 文件或真实 Secret 场景。

## 当前限制

- Design 参数提议是受当前 Schema 约束的参数助手，不是开放式 Agent。
- 当前没有上游取消调用，UI 不提供任务取消按钮。
- 结果区持久化任务元数据和上游资源 URL，不持久化 API Key、prompt 或媒体副本。
- 复杂或包含阻断性未支持约束的 Schema 会禁用提交，不会猜测参数含义。
- LLM 只物化实时目录公开的模型；目录不可用时不会提供虚构回退模型。

## 开发与校验

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

`pnpm run check` 依次执行环境、类型、lint、全量单元/契约测试、全局覆盖率硬门槛以及 Host runtime 和 Design 参数规划器的文件级回归下限；`verify:pack` 验证精确的制品白名单、双语文档、9 张经过真实解码且不含 metadata 的共享 WebP 截图、入口、Source Map 内嵌源码和敏感文件排除；`verify:fresh-install` 在临时项目中安装最终 tarball，并实际加载 Host、执行 Client factory、检查子路径 exports 和消费端类型；`verify:node22-install` 使用显式指定或 NVM 中自动发现的 Node.js `^22.19.0` 再执行 tarball runtime smoke，找不到兼容版本时失败而不是跳过。`pnpm run verify:release:static` 串联以上静态门禁与生产依赖审计。

### 完整发布 Evidence 门禁

真正发布使用 `pnpm run verify:release`。先把最终代码、文档和截图提交到 Git，并保持工作区 clean；然后在仓库外分别创建两份小于 32 KiB、无 Secret、绑定当前 40 位 HEAD 和当前包版本的 JSON。`completedAt` 必须是规范 UTC ISO-8601，且不得早于执行时间 72 小时。浏览器 evidence 必须包含以下全部检查：

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

真实 API/Agent evidence 必须覆盖目录、参数规划、三类媒体、LLM Agent 和 Web；`billedCallsExplicitlyAuthorized` 只证明操作者明确授权了本次计费调用，不得在 evidence 中记录 Key、请求头或其他 Secret：

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

需要用真实服务生成这份 evidence 时，先在独立 Web Profile 中完成并核对一次使用 Modellix 模型的 DSH Agent 会话；随后由验收进程直接从受控环境、文件或 Credential 提供 `MODELLIX_API_KEY`，并只设置以下非 Secret 控制项后执行 `pnpm run test:real:modellix`：

```powershell
$env:MODELLIX_ALLOW_BILLED_E2E = '1'
$env:MODELLIX_REAL_AGENT_ATTESTED = '1'
$env:MODELLIX_REAL_E2E_OUTPUT_DIR = 'D:\outside-repo\modellix-real-results'
$env:MODELLIX_API_AGENT_E2E_EVIDENCE_FILE = 'D:\outside-repo\api-agent-evidence.json'
pnpm run test:real:modellix
```

该脚本会真实读取鉴权目录和 Schema、完成参数规划，对图片、视频、音频各提交一次计费 POST，以有限只读请求轮询任务，调用真实 Web Search/Fetch，在仓库外保存媒体供独立解码检查，再生成无 Secret evidence。缺少显式计费授权或此前的 Agent 验收证明时，脚本拒绝运行；Key 既不作为命令参数传入，也不会被脚本输出。

通过绝对路径提供两份文件后运行门禁；路径本身可以进入环境变量，API Key 不可以：

```sh
MODELLIX_BROWSER_EVIDENCE_FILE=/absolute/path/browser-evidence.json \
MODELLIX_API_AGENT_E2E_EVIDENCE_FILE=/absolute/path/api-agent-evidence.json \
pnpm run verify:release
```

Evidence 只是一份严格格式的验收证明，不执行或重试任何计费调用。任一固定检查缺失、失败或多出未知字段，文件位于仓库内、过期、版本或 commit 不匹配、工作区不 clean，门禁都会失败。

## 参考资料

- [Modellix 快速开始](https://docs.modellix.ai/get-started)
- [Modellix LLM 概览](https://docs.modellix.ai/llm/overview)
- [Modellix GPT Image 2 示例](https://www.modellix.ai/zh_CN/models/openai/gpt-image-2)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## 许可证

见 [LICENSE](LICENSE)。
