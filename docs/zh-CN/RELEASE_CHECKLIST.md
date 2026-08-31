[English](../en-US/RELEASE_CHECKLIST.md) | [简体中文](RELEASE_CHECKLIST.md)

# dsh-modellix 0.2.0 发布与验收清单

本文用于人工产品验收和最终发布门禁。每一项都必须针对即将发布的准确包版本与 commit 检查。

## 1. 验收范围

只有全部满足以下条件时才接受本版本：

- Chat 是媒体主界面，不存在独立 Design Tab。
- Agent 能自动选择明确的 Modellix 媒体与 Web 工具。
- 对话结果卡与右侧 Modellix Design 显示同一任务的相同最新状态。
- 一个任务只产生一张可见对话结果卡。
- 只有成功任务显示 Preview/JSON 和媒体控件。
- 结果按 Harness 会话隔离。
- 中英文文档与截图符合当前 UI。
- 静态、浏览器、真实 API/Agent、打包与全新安装门禁全部通过。

## 2. 测试环境

测试前记录：

| 项目 | 预期 |
| --- | --- |
| 包 | `dsh-modellix@0.2.0` |
| Harness | `0.1.1-rc.2` |
| 开发 Node | `24.18.1` |
| pnpm | `11.24.0` |
| 浏览器截图视口 | `1920×1080`、DPR 1 |
| Credential | 由受控环境或 Harness Credential 服务提供，Evidence 中不可见 |
| Profile | 默认使用独立验收 Profile；除非操作者明确选择默认 Profile |

不得记录 Key、请求头、Credential 文件、Network/HAR、浏览器存储或敏感请求体。

## 3. 静态预检

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run verify:pack
```

通过条件：

- 环境、类型、lint、单元/契约测试和覆盖率通过；
- Host 与 Client Bundle 构建成功；
- tarball allowlist 只包含已发布运行时/文档/资产；
- 12 张 WebP 均按要求解码、尺寸正确且不含 metadata；
- source、tests、coverage、开发计划、Agent 规则、Secret、HAR 和本地配置均未进入包。

## 4. 设置与 Credential

1. 打开设置 → Modellix。
2. 确认 Credential 显示已配置/已验证和来源，但不显示值。
3. 确认 Design、LLM、Web 开关存在。
4. 确认 LLM 目录状态、模型数量、刷新时间和刷新操作。
5. 若 Credential 为本地可写，打开更换界面并确认输入框初始为空。
6. 取消后重新打开，未保存草稿仍应为空。
7. 在受控非生产环境测试一次 401 恢复；并发错误只能打开一个弹窗。
8. 确认 402、429、离线和 5xx 不显示“API Key 无效”。

截图 Evidence：`settings-ready-en.webp` 与 `settings-ready-zh.webp`。

## 5. Chat-first 图片生成

新建会话，不写工具名，输入正式图片需求：

> 创建一张精致的 16:9 建筑首页图：玻璃植物研究馆漂浮在晨曦云海上，以观景桥连接，青金蓝与暖金配色，真实高级材质，无人物、无文字、无 Logo、无水印。

通过条件：

1. Agent 发现/选择兼容实时模型并读取 Schema。
2. 只发生一次 `modellix_media_generate` 提交。
3. Agent 回合内最多一次 `modellix_media_get_result`。
4. 非终态时卡片只显示状态/模型，不显示 Preview/JSON。
5. 助手正文只说明提交已接受并把当前状态交给卡片/面板；不写 queued/running/generating/processing/pending 或中文等价词。
6. 不再调用 Agent 工具，原卡片自动更新为已完成。
7. 结果查询不会生成第二张卡。
8. Preview 显示图片，JSON 可通过键盘访问。

截图 Evidence：`chat-media-generation-en.webp` 与 `chat-media-generation-zh.webp`。

## 6. 基于上下文的图生视频

在同一会话输入：

> 把刚完成的图片做成 5 秒电影感视频。镜头缓慢前推，增加轻微云海和灯光动态，保持原构图和配色。

通过条件：

1. Agent 选择图生视频而不是文生视频。
2. 自动把上一张图片结果 URL 放入实时 Schema 的媒体输入字段。
3. 一次提交，回合内最多一次结果读取。
4. 原视频卡就地更新为已完成。
5. 视频加载有限时长，点击播放后 currentTime 推进。

## 7. 音频

在同一会话输入：

> 生成平静专业的英文旁白，MP3、44.1 kHz：“From one idea to images, video, and sound, Modellix Design keeps creation flowing naturally in the conversation.”

通过条件：

1. Agent 读取实时音频 Schema，并使用已公布英文音色。
2. 一次提交，回合内最多一次结果读取。
3. 音频卡就地更新为已完成。
4. 音频读取时长，点击播放后 currentTime 推进。

视频/音频截图 Evidence：`media-players-en.webp` 与 `media-players-zh.webp`。

## 8. 结果面板与卡片交互

1. 点击会话头部最右侧 **Modellix Design**。
2. 确认面板从右向左打开。
3. 桌面视口测量内部宽度为 360px，开合时卡片内容不被压缩。
4. 结果默认展开，数量与当前会话一致。
5. 收起/展开整个结果。
6. 点击每张卡头部收起/展开。
7. 确认只显示当前会话的图片、视频、音频。
8. 成功卡显示 Preview/JSON；生成中/失败卡不显示。
9. 点击 **添加 URL 到对话框**，确认准确资源 URL 写入输入框。
10. 点击 **下载**，确认安全打开上游资源。
11. 点击 X，确认焦点回到入口按钮。
12. 确认页面没有高级编辑器入口。

截图 Evidence：`design-results-drawer-en.webp` 与 `design-results-drawer-zh.webp`。

## 9. 图片弹窗与键盘

1. 用键盘打开图片预览。
2. 确认大图 Dialog 有可见标题/可访问名称。
3. 初始焦点进入 Dialog。
4. 用 Tab 与 Shift+Tab 经过所有控件，焦点应循环。
5. 按 Escape，Dialog 关闭且焦点回到图片入口。
6. 再次打开，用可见关闭控件退出，焦点恢复仍正确。

## 10. 自动 Web Search 与 Fetch

新 Agent 回合中不要写工具名：

> 核对 Modellix 官方网站上 alibaba/wan2.7-videoedit 的 API Schema 页面，告诉我页面标题，并列出一项必填参数及其含义，附上来源。不要凭记忆回答。

通过条件：

1. Agent 自动调用 `modellix_web_search`。
2. 为读取全文自动调用 `modellix_web_fetch`。
3. 同一操作不同时调用原生与明确工具族。
4. 回答含直接来源和 Schema 支持的必填字段。
5. 失败或结果未知时不自动重复。

截图 Evidence：`web-tools-auto-en.webp` 与 `web-tools-auto-zh.webp`。

## 11. Modellix LLM

1. 打开 Harness 模型选择器。
2. 确认 Modellix 分组包含当前实时目录。
3. 选择 Modellix 模型。
4. 发送简短、无需工具的提示。
5. 确认得到所选 Modellix 模型的真实 Agent 回复。
6. 确认插件层重试为 `0`。

截图 Evidence：`llm-model-selector-en.webp` 与 `llm-model-selector-zh.webp`。

## 12. 响应式、主题与可访问性矩阵

检查当前 UI：

| 尺寸/状态 | 验收标准 |
| --- | --- |
| 320 CSS px | 全宽面板、紧凑入口可达、页面无横向溢出 |
| 560 CSS px | 全宽面板，操作自动换行 |
| 768 CSS px | 所有内容和操作可达 |
| 1440 CSS px | 固定 360px 右侧面板 |
| 200% 文本缩放 | 状态、URL、标签和操作不裁切 |
| 浅色/深色 | 语义颜色清晰可读 |
| Forced colors | 边界、焦点、状态与控件可区分 |
| Reduced motion | 非必要动效关闭 |
| 粗指针 | 主要目标达到 48×48 CSS px |

检查 accessibility tree 中的 Dialog 名称、label/description、invalid/busy、Tab 语义和 live region。Modal 打开时背景不可聚焦。

## 13. Console 与网络健康

- 完整流程 Browser Console：0 errors、0 warnings。
- 不出现重复生成/上传 POST。
- 不出现无上限状态轮询。
- DOM、Console、截图、Evidence 和日志中没有 Key 或鉴权头。
- 媒体从批准的 HTTPS 结果域名加载。

## 14. 真实 API/Agent 覆盖

在本轮已明确授权真实调用时执行受控测试：

```powershell
$env:MODELLIX_ALLOW_BILLED_E2E = '1'
$env:MODELLIX_REAL_AGENT_ATTESTED = '1'
$env:MODELLIX_REAL_E2E_OUTPUT_DIR = 'D:\outside-repo\modellix-real-results'
$env:MODELLIX_API_AGENT_E2E_EVIDENCE_FILE = 'D:\outside-repo\api-agent-evidence.json'
pnpm run test:real:modellix
```

同一验收周期还必须包括：

- 由配置的 DeepSeek 后端实际处理的 Agent 回合；
- 由 Modellix LLM 实际处理的 Agent 回合。

只有 catalogs、Schema planning、图片、视频、音频、LLM Agent、Search、Fetch 全部通过才接受。未知计费提交不得重放。

## 15. 发布 Evidence

在仓库外创建不含 Secret 的文件：

- 浏览器 Evidence：onboarding、settings、design、LLM、Web、401、可访问性、主题、视口；
- API/Agent Evidence：catalogs、planner、图片、视频、音频、LLM Agent、Web。

两个文件必须：

- 指向 `dsh-modellix@0.2.0`；
- 包含准确的 40 位小写 Git HEAD；
- 使用不早于 72 小时的规范 UTC ISO-8601 时间；
- 所有必填 check 均为 `passed`；
- 不含未知字段或 Secret。

然后执行：

```sh
pnpm run verify:release
```

`verify:release:static` 不能替代真实 Evidence。

## 16. 打包、发布与 Registry 回读

全部通过后：

1. 提交并推送准确验收文件。
2. 确认 `HEAD` 与 `origin/main` 相同且工作树干净。
3. 执行 `pnpm pack`。
4. 使用受控 npm Credential 流程发布 tarball。
5. 回读：

```sh
npm view dsh-modellix@0.2.0 version dist.integrity dist.shasum --json --registry=https://registry.npmjs.org/ --prefer-online
```

6. 在仓库外空目录和全新 npm cache 中安装 `dsh-modellix@0.2.0`。
7. 检查实际落盘版本和 `dsh --profile <isolated> --dump-config`。
8. 删除临时 npm 配置、cache、tarball、profile、Evidence 中间文件和进程变量。

未经明确要求，不创建 Git Tag 或 GitHub Release。

## 17. 0.2.0 验证记录

2026-08-31 对候选版本执行了：

- 真实 `openai/gpt-image-2` 图片生成；
- 真实 `xai/grok-imagine-video-i2v` 上下文图生视频；
- 真实 `minimax/speech-2.8-hd` 语音生成；
- 针对公开官方文档的真实自动 Modellix Search 与 Fetch；
- 真实 DeepSeek Agent 序列和真实 `modellix-ai/free-llm` 回合；
- 视频/音频有限时长、播放时间推进；
- 抽屉只显示当前会话 3 条结果，对话无重复卡，终态同步；
- Browser Console 0 errors、0 warnings；
- 最终文档修改前，typecheck、lint、475 个测试、覆盖率、build 和 pack 校验通过。

文档与版本变更后必须重新执行最终门禁，并把发布 Evidence 绑定到最终 commit。
