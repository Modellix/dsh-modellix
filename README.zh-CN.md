[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-modellix

`dsh-modellix` 将 Modellix 媒体生成、LLM 模型和 Web 研究能力接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。配置一个 Modellix API Key 后，即可通过 Chat-first 流程自然表达需求，让图片、视频、音频及其上下文留在同一会话中。

> Harness 与本插件当前都使用预发布接口。升级 Harness 前，请核对本包的 peer dependencies 和 [CHANGELOG](CHANGELOG.md)。

![真实中文 Harness 会话中已完成的 Modellix 图片结果](docs/assets/chat-media-generation-zh.webp)

## 0.2.1 的主要变化

- Web 开关现在只注销 `modellix_web_search` 与 `modellix_web_fetch`。Harness 原生 Web 工具和 Provider 保持可用，关闭 Modellix Web 后会回退到当前 Profile 的默认能力。
- 开发与运行时集成已适配 Harness `0.1.2-alpha.4`，并继续兼容 `0.1.1-rc.2`。

## 0.2.0 的主要变化

- 删除独立 Design Tab，对话成为媒体创作主界面。
- 新增 6 个明确的媒体 Agent 工具，覆盖模型目录、Schema、参数准备、文件上传、生成和结果查询。
- 新增明确的 Modellix Web Search/Fetch 工具，使 Agent 在需要实时信息或来源核验时能够自动调用。
- 将 **Modellix Design** 放在会话右侧面板：桌面端内部宽度固定为 360px，窄屏使用全宽；开合过程中内容不会被压缩变形。
- 新增对话内实时结果卡。提交卡会在后台任务结束后原位更新，一次结果查询不会再渲染第二张重复卡片。
- 新增会话隔离的结果历史、结果列表与单卡折叠、图片放大、视频/音频播放器、**添加 URL 到对话框** 和 **下载**。
- 高级精准参数编辑器代码继续保留，但本版本暂时隐藏入口，优先完成普通用户的无感对话体验。
- UI 不再显示常规付费提醒。配置 Modellix Key 已代表用户具备用量预期，消耗与明细可在 Modellix 查看。

## 功能能力

| 区域 | 用户体验 | 已注册能力 |
| --- | --- | --- |
| 媒体 | 直接让 Agent 创建、编辑、动画化或配音 | `modellix_media_list`、`modellix_media_schema`、`modellix_media_prepare`、`modellix_media_upload_file`、`modellix_media_generate`、`modellix_media_get_result` |
| 结果 | 在对话卡片或会话右侧面板中查看作品 | 实时状态收敛、成功任务 Preview/JSON、图片/视频/音频展示、URL 插入、下载 |
| LLM | 在 Harness 模型选择器中选择实时 Modellix 模型 | Modellix OpenAI 兼容 Provider、实时目录、Provider 重试次数为 `0` |
| Web | 正常提出实时、外部、URL 或来源核验问题 | Agent 自动选择 `modellix_web_search` 和 `modellix_web_fetch` |

## 环境要求

- DeepSeek Harness `0.1.2-alpha.4`（最新支持版本）；继续兼容 `0.1.1-rc.2`
- 已发布包运行时：Node.js `^22.19.0 || >=24.0.0`
- 源码开发与发布校验：Node.js `24.18.1`、pnpm `11.24.0`
- 有效的 [Modellix API Key](https://docs.modellix.ai/get-started)

插件自带 Harness 集成，运行时不会安装或调用 `modellix-cli`。

## 安装

将已发布包安装到目标 Web profile，检查合并后的配置，然后启动或重启该 profile：

```sh
dsh plugin --profile web add dsh-modellix
dsh --profile web --dump-config
dsh --profile web
```

`--dump-config` 应包含 `dsh-modellix` Bundle 层和 id 为 `modellix` 的插件行。若使用其他 profile，请替换命令中的 `web`。

也可以安装可信源码构建出的 tarball：

```sh
pnpm install --frozen-lockfile
pnpm run verify:release:static
pnpm pack
dsh plugin --profile web add ./dsh-modellix-0.2.1.tgz
```

完整 Windows 本地流程见[本地使用指南](docs/zh-CN/LOCAL_USAGE.md)。

## 配置 API Key

首次使用时，在 **连接 Modellix** 中输入 Key，保留需要启用的服务，然后选择 **保存并启用**。已保存 Credential 是 write-only：Client 只会收到配置状态和来源，不会收到已存 Key。

也可以在 Harness 启动环境中提供 `MODELLIX_API_KEY`。环境来源 Credential 在 UI 中只读，更换后需要重启 Harness。

不要把真实 Key 放入仓库、命令参数、URL、浏览器存储、日志、截图、HAR、录像或测试快照。

## Chat-first 媒体流程

用户只需描述目标，不必列出工具顺序。例如：

> 创建一张精致的 16:9 建筑首页图：玻璃植物研究馆漂浮在晨曦云海上，以优雅观景桥连接，青金蓝与暖金配色，真实高级材质，无人物、无文字、无水印。

Agent 会按实际情况：

1. 若尚未知道合适模型，先查询实时媒体模型目录。
2. 读取目标模型的实时 API Schema，只使用公开字段和允许值。
3. 对“继续修改、把上一张图做成视频、保持主体和构图”等请求，自动复用本会话最新相关结果 URL，选择图生图、图片编辑、图生视频或视频编辑模型，而不是退回文生图/文生视频。
4. 当 Schema 要求公开媒体 URL 时，上传本地文件或会话附件。
5. 生成请求只提交一次；未知提交结果不会自动重放。
6. Agent 回合内最多查询一次，之后由后台监听器持续更新现有卡片，不需要 Agent 再调用结果工具。

任务尚未结束时，不可变的助手正文只说明“提交已接受”，并引导查看实时结果卡和 Modellix Design；不会永久留下“生成中”这种过期状态。

### 结果行为

- **生成中与失败：** 只显示简洁的头部和状态；没有成功资源时不显示 Preview/JSON。
- **已完成：** 显示 Preview/JSON。图片可在带焦点管理的弹窗中放大，视频和音频使用原生播放器。
- **一个任务一张卡：** `generate` 卡持有任务展示权；同一任务的 `get_result` 调用不会重复渲染。
- **会话隔离：** 右侧面板只显示当前 Harness 会话所属任务；没有会话归属的旧记录不会注入新会话。
- **快捷操作：** **添加 URL 到对话框** 会把资源 URL 写入输入框；**下载** 安全打开上游资源。
- **有效期：** 优先使用上游有效期；若上游未返回，插件应用七天本地展示期限，但不会延长上游 URL，也不会永久保存媒体副本。

![中文 Modellix Design 右侧面板显示当前会话的三个结果](docs/assets/design-results-drawer-zh.webp)

![真实生成视频在对话中播放，同时保留会话结果面板](docs/assets/media-players-zh.webp)

## Modellix Design 右侧面板

**Modellix Design** 按钮位于会话头部最右侧，与 **Session log** 风格一致。大屏打开分屏侧面板，窄屏改为全宽覆盖。

- 整个结果列表默认展开，可点击收起。
- 每张结果卡默认展开，可点击卡片头部收起。
- 点击 X 关闭后，焦点会回到入口按钮。
- 高级精准参数编辑器已保留，但 `0.2.1` 暂不显示入口；普通用户通过 Chat 使用。
- 560px 及以下使用可用视口全宽；360px 及以下入口变为可触达的紧凑按钮。

## LLM 模型

开启 LLM 后，插件读取 Modellix 实时目录，并将模型加入 Harness 模型选择器。目录不可用时不会虚构回退列表。Modellix 设置页可查看目录健康、模型数量、刷新时间并手动刷新。

![中文 Harness 模型选择器中的 Modellix 实时目录](docs/assets/llm-model-selector-zh.webp)

## 自动 Web Search 与 Fetch

用户不需要说出工具名。遇到实时、变化中、外部或需要来源核验的问题，Agent 会使用 `modellix_web_search`；用户提供公开 URL，或搜索结果需要阅读全文时，会使用 `modellix_web_fetch`。

Web 开启时，插件只注册两个明确的 Modellix 工具，并要求 Agent 在适用任务中优先使用它们。关闭 Web 会注销这两个工具并移除 Modellix Web 路由上下文；Harness 原生 `web_search` / `web_fetch` 及其已配置 Provider 不受影响，仍可被 Agent 自动选择。失败或结果未知的 Modellix Web 请求不会自动重复。

![真实中文 Agent 回合自动使用 Modellix Search 与 Fetch](docs/assets/web-tools-auto-zh.webp)

## 设置与恢复

Modellix 设置页包括：

- Credential 是否已配置、验证状态和来源；
- 本地可写 Credential 的更换与移除；
- Design、LLM、Web 独立开关，每个开关只改变自身的 Modellix 能力；
- LLM 实时目录健康、数量、刷新时间和手动刷新。

只有 HTTP 401 会把 Credential 标记为无效。HTTP 402、429、网络错误和 5xx 使用各自恢复状态。并发 401 会合并为一个 Credential 弹窗。

![中文 Modellix 设置页显示 write-only Credential 状态与实时目录](docs/assets/settings-ready-zh.webp)

## 可访问性与响应式

- Dialog 显式管理初始焦点、Tab/Shift+Tab 循环、背景 inert、允许场景下的 Escape，以及关闭后的焦点恢复。
- 结果 Tab 支持标准键盘导航；任务与结果变化通过 polite live region 播报。
- 状态不只依赖颜色，同时提供文字。
- 已检查 320、560、768、1440 CSS px、200% 文本缩放、浅色/深色、forced-colors、粗指针和 reduced motion。
- 窄屏仍保留全部结果操作，不产生页面横向溢出。

## 文档

- [完整中文用户指南](docs/zh-CN/USER_GUIDE.md)
- [中文发布与验收清单](docs/zh-CN/RELEASE_CHECKLIST.md)
- [Complete English user guide](docs/en-US/USER_GUIDE.md)
- [English release and acceptance checklist](docs/en-US/RELEASE_CHECKLIST.md)
- [本地源码使用](docs/zh-CN/LOCAL_USAGE.md)

仓库包含 6 张英文和 6 张中文 1920×1080 截图，分别来自真实语言会话，覆盖设置、对话生图、结果抽屉、媒体播放器、实时 LLM 模型和自动 Search/Fetch。所有截图均不包含 Key、请求头、Network/HAR、Credential 文件或浏览器存储。

## 开发与发布校验

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run verify:pack
pnpm run verify:fresh-install
pnpm run verify:node22-install
pnpm run verify:release:static
```

`pnpm run verify:release` 还要求仓库外的浏览器与真实 API/Agent Evidence，并绑定准确的包版本和 40 位 Git commit。完整流程见[发布与验收清单](docs/zh-CN/RELEASE_CHECKLIST.md)。

## 当前限制

- 本版本暂时隐藏高级精准参数编辑器入口。
- 尚未暴露上游任务取消能力。
- 结果历史保存任务元数据与上游 URL，不保存永久媒体副本。
- 遇到无法安全支持的复杂 Schema 时阻止提交，不猜测或丢弃约束。
- Modellix LLM 目录没有虚构的离线回退模型。

## 卸载

本地存储的 Credential 应先在 Modellix 设置页移除；环境来源 Credential 应在外部密钥管理器中撤销。然后移除插件并重启 profile：

```sh
dsh plugin --profile web remove dsh-modellix
dsh --profile web --dump-config
dsh --profile web
```

卸载不会删除 Modellix 上游任务、外部环境变量或所有 Harness profile 数据。

## 参考资料

- [Modellix 快速开始](https://docs.modellix.ai/get-started)
- [Modellix LLM 概览](https://docs.modellix.ai/llm/overview)
- [Modellix 模型目录](https://www.modellix.ai/models)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## 许可证

见 [LICENSE](LICENSE)。
