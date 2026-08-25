# dsh-modellix

Modellix integration for DeepSeek Harness: one API key for schema-driven media generation, a live LLM model catalog, and native Web providers.

`dsh-modellix` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Modellix Profile Bundle。插件在首次使用时提供一个统一的 API Key 配置入口，并默认开启 Design、LLM 和 Web 三项能力；每项能力都可以在 Modellix 设置中单独关闭。

## 功能

### Design

- 左侧搜索、按类型筛选并选择模型，填写 prompt、编辑精确参数或提交参数变更提议；右侧查看生成任务和未过期结果。
- 从 Modellix 模型目录分页发现图片、视频和音频模型，支持手动刷新，并优先恢复最近选择的模型。
- 每次选择模型时读取其公开 `api_schema`，从 Schema 生成默认值、必填项、枚举、数值范围和 JSON 等输入控件。
- “用对话调整参数”会使用同一个 Key 调用固定的 Modellix LLM，把自然语言转换为当前 Schema 允许的结构化参数提议。提议先显示差异，用户确认后才应用；发送提议不会自动生成媒体。
- 点击“确认并生成”才会发起计费提交。提交请求只发送一次，不自动重试；状态查询是独立、有限重试的只读操作。
- 任务元数据和结果 URL 保存在 Harness Host，结果在 Modellix 返回的有效期内展示，并支持图片放大、音视频播放和安全下载。上游未提供有效期时，插件使用 7 天作为本地展示上限；这不延长上游资源的实际可用期。

### LLM

- 使用同一个 API Key 读取 Modellix 当前模型目录。
- 将模型目录安全合并到 Harness 的 `llm-pi-ai` Modellix Provider，随后可在 Harness 的模型选择器中切换模型。
- 使用 OpenAI Completions 兼容协议和 `https://llm.modellix.ai/v1`；Provider 请求重试上限固定为 `0`，避免插件层重复模型调用。
- 设置页显示目录状态、模型数与最近刷新时间，并支持手动刷新。

### Web

- 为 Harness 原生 `web_search` 和 `web_fetch` seam 注册 Modellix Provider，不创建同名自定义 Tool。
- Bundle 把原生 Search/Fetch Provider 选择为 `modellix`，并启用 Harness 原生 `web_search` 与 `web_fetch` Tool；关闭 Web 开关或缺少有效 Key 时 Provider 不可用。

## 要求

- DeepSeek Harness `0.1.1-rc.2`
- Node.js `^22.19.0 || >=24.0.0`
- 从源码构建时使用 pnpm `11.7.0`
- 一个有效的 [Modellix API Key](https://docs.modellix.ai/get-started)

Harness 与本插件当前都使用预发布接口。升级 Harness 前，请先核对本包的 peer dependencies 和变更记录。

## 安装

安装已发布的包到目标 Web profile，然后重启该 profile：

```sh
dsh plugin --profile web add dsh-modellix
dsh --profile web --dump-config
dsh --profile web
```

`--dump-config` 应显示 `dsh-modellix` Bundle 层，以及 id 为 `modellix` 的插件行。若使用的 profile 不是 `web`，请替换 profile 名称。

也可以先从可信源码构建 tarball，再安装预构建制品：

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm pack
dsh plugin --profile web add ./dsh-modellix-0.1.0.tgz
```

直接从 Git 安装 TypeScript 源码需要安装阶段能够产出 `lib/`。在包未提供经过验证的 `prepare` 流程时，请使用 npm 发布包或本地 tarball。

## 配置

首次打开 Harness Web UI 时，Modellix onboarding 会显示一个 API Key 输入框和三个默认开启的开关：

| 开关 | 作用 |
| --- | --- |
| Design | 模型选择、Schema 参数编辑、媒体生成与结果列表 |
| LLM | Modellix 模型目录与 Harness 模型切换 |
| Web | Modellix 原生 Web Search/Fetch Provider |

API Key 有两种来源：

- 在 onboarding 或 Modellix 设置页输入，由 Harness Credential 服务保存。
- 由运行环境提供 `MODELLIX_API_KEY`。环境来源在 UI 中只读，不能被替换或删除。

保存后 UI 只显示“已配置”状态，不会回显 Key。选择“稍后处理”只关闭当前弹窗；已启用能力下次需要凭据时仍会提示配置。三个功能开关、Key 更换/移除和 LLM 目录刷新均位于 Modellix 设置页。

## 使用

### 生成图片、视频或音频

1. 打开 Harness 中的 **Design** 视图。
2. 选择模型。插件会读取该模型当前的 Schema 并填入公开默认值。
3. 输入 prompt；需要精准控制时，直接修改下方参数。
4. 也可在“用对话调整参数”中输入普通描述；该操作可能产生 LLM 用量，检查差异后再点击“应用变更”。
5. 确认计费提示后点击“确认并生成”。任务状态和未过期资源会显示在右侧结果栏。

只有发布了受支持 Schema 且 Schema 声明了匹配该模型的 Modellix 官方提交地址时，模型才能提交。Schema 发生变化时，旧草稿会被拒绝，需重新加载后确认参数。

### 切换 LLM 模型

1. 保持 LLM 开关开启并配置 API Key。
2. 在 Modellix 设置页确认“LLM 模型目录”为可用；需要时点击“刷新 LLM 模型”。
3. 在 Harness 模型选择器中选择 Modellix Provider 下的目标模型。模型切换从下一次模型调用开始生效。

### 使用 Web

保持 Web 开关开启后，Harness 原生 `web_search` 和 `web_fetch` 会通过 Modellix Provider 执行。Web 能力可能产生 Modellix 用量，请以账户侧规则为准。

## 安全与请求语义

- Key 只在 Harness Host 的 Credential 边界内解析；浏览器端不读取已保存值。
- Key 不进入 URL、设置文档、Design 任务记录、模型上下文、Tool 参数或用户可见诊断。
- 公开模型 Schema 请求不携带 Authorization；带鉴权请求只允许发送到固定 Modellix HTTPS origin。
- Design 提交使用 Schema 返回且再次校验的精确模型地址；跨 origin 重定向会被拒绝。
- 401 只会把当前 Credential epoch 标记为无效；402、429、网络错误和 5xx 不会被误报为 Key 失效。
- Design 的持久任务记录只包含请求/任务标识、模型、状态和结果 URL，不保存 API Key 或 prompt。
- 计费 POST 不自动重放。连接中断导致提交结果未知时，任务会标记为“提交结果未知”，由用户决定后续操作。

不要把真实 API Key 写入仓库、命令参数、日志、截图、HAR 或测试快照。

## 当前限制

- Design 参数提议使用固定的 `openai/gpt-5.6-luna`、严格结构化输出和零自动重试；它只修改当前 Schema 声明的参数，不是开放式 Agent。
- 当前没有上游取消调用；UI 不提供任务取消按钮。
- 结果区保存的是任务元数据和上游资源 URL，不会把媒体文件复制为永久本地资产。
- 复杂或含阻断性未支持约束的 Schema 会关闭提交，而不是猜测参数含义。
- LLM 仅物化 Modellix 实时目录公开的模型；目录不可用时不会编造静态回退列表。

## 本地开发与校验

```sh
pnpm install --frozen-lockfile
pnpm run verify:env
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
pnpm pack
```

`pnpm run check` 依次执行环境、类型、lint 和单元测试；它不包含构建与打包。修改 Client Bundle 后，需要重启用于验收的 Harness Web profile。发布前还应在独立 profile 中完成 tarball fresh-install、真实浏览器流程和受控的真实 API/Agent E2E；真实计费调用必须由操作者明确触发。

## 相关文档

- [Modellix 快速开始](https://docs.modellix.ai/get-started)
- [Modellix LLM 概览](https://docs.modellix.ai/llm/overview)
- [Modellix GPT Image 2 示例](https://www.modellix.ai/zh_CN/models/openai/gpt-image-2)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## 许可证

见 [LICENSE](LICENSE)。
