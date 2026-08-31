# Modellix Chat-first 插件优化开发计划

> 状态：可行性方案，尚未进入实现  
> 编制日期：2026-08-31  
> 当前实现基线：`dsh-modellix@0.1.1`、DeepSeek Harness `0.1.1-rc.2`  
> 目标建议版本：`dsh-modellix@0.2.0`

## 1. 目标与结论

本次优化的产品方向应从“单独打开 Design 页面完成媒体生成”调整为“以 Harness 对话为主、Modellix 工具在上下文中自然工作、专业参数编辑按需展开”。

三个试用问题都可以得到实质改善：

1. Web Search 与 Web Fetch 改为 Modellix 自有、模型可直接发现的 Tool，并通过工具描述和会话级路由上下文引导 Agent 在需要实时信息、来源核验或网页正文时主动调用。
2. 移除产品界面、工具审批和普通使用流程中的费用预告与逐次付费确认。用户配置 Modellix Key 后，正常调用直接执行；仅在真实 `402`、余额不可用等异常发生时给出恢复操作。未知提交仍禁止自动重放，避免重复生成。
3. 删除独立 Design Tab。对话继续作为主界面，媒体结果进入对话历史并可在右侧 Modellix Design 抽屉中集中查看；高级参数编辑器默认收起，仅专业用户按需打开。

需要明确两个实现边界：

- **不能从插件侧保证所有模型 100% 自动调用 Tool。** Harness 当前公开的 Tool 合约允许注册名称、描述、参数和结果，但最终 Tool 选择仍由当前对话模型与宿主策略决定。可通过专用 Tool、清晰描述、会话级 Modellix 路由上下文和回归用例显著提高自动触发率，但不能把它描述成硬性强制。
- **不能直接向宿主原生右侧 Details 列追加业务面板。** 当前 `details` 是单占位，已由 Harness 工具详情面板占用；插件若注册会整体替换宿主详情能力。可行方案是由会话标题操作按钮打开挂载在 `shell.overlay` 的右侧非模态抽屉，视觉上位于对话右侧，又不深度导入或接管宿主私有实现。

## 2. 当前实现与问题根因

### 2.1 Web Tool 只注册 Provider

当前 `src/web/provider.ts` 只为 Harness 原生 `web_search` 和 `web_fetch` 注册 Modellix Provider，`cordis.patch.yml` 再启用宿主 `tool-web`。插件本身没有注册带 Modellix 语义和主动使用说明的 Tool。

因此：

- Modellix 只决定“原生 Web Tool 被调用后走哪个 Provider”；
- 是否调用仍取决于原生 Tool 描述、模型能力和系统策略；
- 用户说“查一下”“确认最新信息”时可能触发，但普通事实问题或给出 URL 时不一定自动触发；
- 单纯更换 Provider 无法改变 Agent 的路由偏好。

### 2.2 产品同时存在 Chat 工具与独立 Design Tab

当前 `src/host/design-tool.ts` 已注册四个 Agent Tool：

- `modellix_design_models`
- `modellix_design_prepare`
- `modellix_design_generate`
- `modellix_design_task`

当前 `src/client/index.tsx` 又把 `ModellixDesignView` 注册为 `conversation.view`，形成一个单独的 Design Tab。`DesignView.tsx` 在同一个页面同时渲染左侧输入区和右侧结果区。

这会造成：

- 普通用户不知道应在 Chat 还是 Design 操作；
- 在 Design 页面填写的自然语言和参数没有成为普通对话消息；
- Chat 虽然能调用生成 Tool，但其结果只使用通用 Tool 卡片，媒体展示能力没有完全复用；
- 用户为了查看结果或调整参数需要在视图之间切换；
- 左侧完整表单长期占据大面积空间，简单生成路径显得过重。

### 2.3 逐次费用提示打断流程

当前存在三类费用相关干扰：

1. `tools/pre-execute` 对 `prepare` 和 `generate` 强制返回 `ask`；
2. Design 表单在 prepare 和 generate 附近显示费用说明；
3. Tool 描述、错误、README 和用户指南反复强调 paid/billed/费用与逐次确认。

这些设计适合“Key 可选、用户可能没有付费预期”的插件，但不符合现在“必须先配置 Modellix Key、用户已建立使用预期、消耗明细在 Modellix 查看”的产品定位。

## 3. 目标用户流程

### 3.1 普通用户：只使用 Chat

示例：

1. 用户输入“生成一张雨夜上海街头的电影感照片”。
2. Agent 自动判断为新图生成，主动调用 Modellix 媒体 Tool。
3. Tool 结果在当前对话中显示任务状态；完成后直接显示图片。
4. 用户输入“把刚才那张改成水彩，保留构图”。
5. Agent 从前序 Tool 结果取得作品 URL，判断这是图生图/图片编辑，而不是重新文生图。
6. Agent 自动选择兼容的编辑模型，生成新结果并继续显示在同一对话中。

整个过程不要求用户打开 Modellix Design，不显示逐次费用确认，也不要求用户说出 Tool 名称。

### 3.2 使用网页信息

示例：

1. 用户询问时效性事实、要求核验来源、比较当前产品信息，或要求总结一个 URL。
2. Agent 根据会话级路由规则自动调用 `modellix_web_search` 或 `modellix_web_fetch`。
3. Tool 结果进入当前对话，并由 Agent 基于来源继续回答。

用户仍可明确说“不要联网”，此时不得调用 Web Tool。

### 3.3 高级用户：打开右侧 Modellix Design 抽屉

1. 会话标题区增加“Modellix Design”按钮。
2. 点击后从右侧打开非模态抽屉，对话区仍可查看和操作。
3. 抽屉首先展示当前会话结果；高级编辑器默认收起。
4. 展开高级编辑器后，最顶部是 Prepare 自然语言参数区，其下依次是模型选择、Schema 表单、精确参数与生成操作。
5. 高级用户可应用 Prepare 提议、手动精修参数并直接生成。
6. 抽屉生成的任务同样写入当前会话对应的结果仓库；后续 Chat 可通过任务 Tool 获取并继续使用。

## 4. Tool 方案

Tool 必须保持命名空间，避免与宿主或其他插件冲突。建议统一使用 `modellix_media_*` 与 `modellix_web_*`，不注册无命名空间的 `list`、`schema`、`generate` 等通用名称。

### 4.1 `modellix_media_list`

用途：获取实时媒体模型目录。

建议输入：

- `query?: string`
- `output_type?: "image" | "video" | "audio"`
- `task_type?: string`，例如 text-to-image、image-to-image、image-to-video、video-to-video、text-to-speech
- `limit?: number`

建议输出：

- 精确 `provider/model` slug
- 展示名
- 输出媒体类型
- 原始/规范化任务类型
- 可用状态
- featured/recommended 信息
- Schema URL 或内部 Schema 标识
- 是否被截断

关键改造：当前目录层只保留 image/video/audio 三类，需继续保留并规范化模型原始任务类型，供 Agent 区分文生图、图生图、图生视频、视频编辑等能力。

### 4.2 `modellix_media_schema`

用途：按 `modellix_media_list` 返回的精确 slug 获取当前模型 Schema。

示例真源：

- `https://www.modellix.ai/models/alibaba/wan2.7-videoedit/api_schema`

该 URL 当前返回 JSON Schema/OpenAPI 片段，含实际 server URL、请求体字段、必填项、枚举、约束和示例。

建议输入：

- `model: string`
- `detail?: "compact" | "full"`，默认 compact

建议输出：

- `model`
- `endpoint`
- `schema_url`
- `contract_hash`
- `primary_input_path`
- 规范化字段列表：path、类型、必填、描述、枚举、范围、媒体类型、数组限制
- 路由摘要：需要哪类输入媒体、适合什么任务、明确不适合什么任务
- `truncated`

不建议默认把完整原始 OpenAPI 无限制塞入模型上下文。`full` 也必须有 JSON 深度、节点数和字节上限；超限时返回可分页或压缩后的规范化 Schema，而不是截断成无效 JSON。

### 4.3 `modellix_media_prepare`

用途：将自然语言转换为符合选中模型 Schema 的参数提议，主要服务 Modellix Design 高级抽屉。

建议输入：

- `model: string`
- `instruction: string`
- `current_input?: object`

建议输出：

- `proposed_input`
- `changes`
- `conflicts`
- `contract_hash`
- `requires_review: true`

调整原则：

- 不再弹费用确认；
- 不自动提交生成；
- 抽屉中移动到高级编辑器顶部；
- 普通 Chat 路径不要求先 prepare，简单 prompt 可直接 generate。

### 4.4 `modellix_media_upload_file`

用途：把本地媒体或当前会话图片上传到 Modellix File API，返回可用于模型字段的临时 URL。

官方接口：

- `POST https://api.modellix.ai/api/v1/media/files`
- `multipart/form-data`
- 字段名固定为 `file`
- 返回 `file_id`、`type`、`url`、`filename`、`size` 等
- 默认最大文件 16 MB、每团队 10 个、并发上传 2 个、保留约 7 天

建议输入采用互斥来源：

- `attachment_id?: string`：当前 Harness 会话中的图片附件
- `path?: string`：用户明确给出的工作区内文件路径

建议输出：

- `file_id`
- `type`
- `url`
- `filename`
- `size`
- 可用期限或保守的本地过期时间
- `no_automatic_retry: true`

安全边界：

- `attachment_id` 必须在当前 Agent 会话历史中找到完整 `ImageAttachmentRef`，再通过 Harness 公开 `ctx.attachments.readImage()` 读取；不得允许模型凭一个任意摘要读取其他会话附件。
- `path` 默认只允许当前 Session `cwd` 内的普通文件；解析真实路径后再次确认仍位于工作区，拒绝目录、设备文件、符号链接逃逸和不支持的扩展名。
- 在上传前校验扩展名、内容类型、文件签名和大小；不得把 API Key 发到 Client。
- 上传是有外部副作用的 POST。即使不计费，也不能在响应未知时自动重放，以免重复占用文件配额。

首版限制：

- Harness 原生 Composer 当前只支持图片附件，因此会话附件直传首版只能覆盖图片。
- 视频和音频首版通过用户明确给出的工作区路径上传。
- 若要让纯浏览器用户直接选择视频/音频，需要新增 Client→Host 分块上传通道或受控临时文件协议；单次 JSON RPC Base64 会放大请求体并增加内存风险，不能未经协议设计直接实现。该能力列入第二阶段增强。

### 4.5 `modellix_media_generate`

用途：调用一次媒体模型。

建议输入：

- `model: string`
- `prompt?: string`
- `input?: object`

行为：

- 精确读取当前模型 Schema；
- 只接受 Schema 声明字段或精确 RFC 6901 path；
- 将 prompt 映射到当前 Schema 的 primary input；
- 提交前重新校验 contract hash 和参数；
- 只提交一次；
- 不再注册逐次 approval gate；
- 响应未知时记录 `submit-unknown`，后续只允许查询，禁止自动重放。

Tool 描述应明确给 Agent 的路由原则：

- 用户要全新图片且没有引用素材：选择 text-to-image；
- 用户要修改前序图片或附件：选择 image edit/image-to-image；
- 用户要让图片动起来：选择 image-to-video；
- 用户要修改现有视频：选择 video edit/video-to-video；
- 用户明确指定模型时优先使用该模型，但仍校验任务兼容性；
- Modellix 已生成且未过期的 URL 可直接作为后续模型输入，不重复上传。

### 4.6 `modellix_media_get_result`

用途：获取生成任务状态与结果。

建议输入：

- `task_id: string`

建议输出：

- task/model/status/created/updated
- 图片、视频或音频资源 URL
- 过期时间
- 安全、稳定的诊断代码

当前 `modellix_design_task` 只查询插件本地登记任务。新实现可先查本地仓库；本地不存在时，再通过固定 Modellix Task endpoint 查询同一 Key 所属任务，并把安全结果纳入当前会话上下文。不得接受任意结果 URL，也不得根据服务端返回的任意 host 发起 Credential-bearing 请求。

### 4.7 `modellix_web_search`

用途：主动搜索需要实时、外部或来源核验的信息。

Tool 描述必须写清：

- 当前信息、新闻、价格、时间表、软件版本、法规、产品状态、事实核验和用户要求来源时主动使用；
- 用户明确禁止联网时不得使用；
- 对不稳定事实优先搜索，不要求用户说出“web search”。

实现复用现有 `ModellixWebSearchProvider` 的传输、安全和错误映射，不复制第二套 HTTP 逻辑。

### 4.8 `modellix_web_fetch`

用途：抓取用户给出的公开 URL，或继续读取 search 结果中的目标页面。

Tool 描述必须写清：

- 用户给出 URL 并要求阅读、总结、比较、核验时主动使用；
- Search 摘要不足以完成任务时主动 Fetch；
- 保留当前 SSRF、重定向、响应大小、超时和 Credential-bearing redirect 防护。

### 4.9 旧 Tool 迁移

建议在 `0.2.0` 直接用新 Tool 替换旧四个 Tool，不同时暴露八个重复媒体入口。映射如下：

| 旧名称 | 新名称 |
| --- | --- |
| `modellix_design_models` | `modellix_media_list` + `modellix_media_schema` |
| `modellix_design_prepare` | `modellix_media_prepare` |
| `modellix_design_generate` | `modellix_media_generate` |
| `modellix_design_task` | `modellix_media_get_result` |

旧对话中的 Tool 事件仍由 Harness 通用卡片回放，不需要修改历史记录；本地任务仓库格式应尽量保持兼容。

## 5. 自动路由方案

### 5.1 会话级 Modellix 路由上下文

仅依靠 Tool 名称仍不足以稳定改善自动触发。Host 应在 Agent 会话开始时注入一段简短、可追踪的 Modellix 路由上下文：

- 当 Web 开关和 Key 可用时，对时效性、外部事实、来源核验和 URL 内容主动使用 Modellix Web Tool；
- 当 Design 开关和 Key 可用时，对图片、视频、音频生成或编辑需求主动使用 Modellix Media Tool；
- 普通用户不需要知道 Tool 名称；
- 使用当前对话中的附件与未过期媒体 URL 判断 T2I、I2I、I2V、V2V 等任务；
- 不在用户明确禁止联网或明确要求只分析已有内容时调用 Web；
- 不自动重试结果未知的生成或上传 POST。

建议使用同一 producer 的 `snapshot` 形式上下文，内容包含当前功能开关状态。开关或 Credential 状态变化时发布新快照，避免旧的“已启用”指令长期误导 Agent。

实现不得每轮重复注入相同大段文本。目标控制在约 150–250 个中英文等价 Token，并用单元测试锁定最大长度。

### 5.2 Tool 描述与输出共同辅助路由

- `list` 输出保留任务类型和输入模态；
- `schema` 输出明确 routing/limitations；
- `generate` 描述明确上下文选择规则；
- `get_result` 输出完整资源类型与 URL；
- `upload_file` 输出明确临时 URL 可作为后续输入。

这些信息进入 Harness 原生 Tool 结果历史，Agent 后续回合可以引用，不另建第二套聊天历史。

### 5.3 不采用的方案

- 不用正则在 Client 端拦截所有用户文本并绕过 Agent 直接生成，因其无法可靠理解上下文、否定语义、模型偏好和复杂编辑意图。
- 不强制每个用户问题都 Web Search，会增加延迟、噪音和不必要的外部请求。
- 不 monkey patch Harness 的系统 Prompt、Tool chooser 或内部 DOM。
- 不依赖 Design Tab 中的本地表单状态作为 Chat 的隐式上下文；上下文必须来自会话 Tool 结果、附件和持久任务记录。

## 6. 费用文案与执行策略

### 6.1 产品运行时删除内容

删除或改写：

- prepare 前“可能产生费用”说明；
- generate 前“将产生费用/确认并生成”说明；
- `tools/pre-execute` 中 prepare/generate 的 `ask`；
- Tool 描述中的 paid/billed/charge；
- README 和用户指南中的逐次付费确认步骤；
- 普通错误文案中的“paid request”，改成“generation request”或“request outcome unknown”。

按钮建议使用：

- “生成” / “Generate”
- “应用参数” / “Apply parameters”
- “调整参数” / “Prepare parameters”

### 6.2 必须保留的错误边界

- `401`：Key 失效，进入 Credential 恢复；
- `402`：当前账户无法完成请求，提供“前往 Modellix 查看账户状态”的恢复动作；
- `429`：请求受限，显示稍后重试；
- 网络/5xx：临时不可用；
- `submit-unknown`：结果未知，提示查询结果，不自动重新生成；
- 生成和上传 POST 不因超时、断网或未知响应自动重放。

不主动显示费用预告，不等于吞掉真实账户错误。

### 6.3 产品行为与发布验收授权分离

产品运行时可以取消逐次确认；但仓库 `AGENTS.md` 规定的真实计费 E2E 授权仍然有效。开发和发布验收若要实际调用图片、视频、音频、LLM 或 Web 计费接口，必须从实施任务的用户指令取得当轮明确授权，并继续使用受控 Key 文件和仓库外 evidence。

## 7. 对话界面与右侧抽屉

### 7.1 Slot 组合

移除：

- `conversation.view` / `modellix.design`

新增：

- `conversation.session.header.actions`：Modellix Design 开关按钮；
- `shell.overlay`：右侧抽屉容器；
- `tool.call.toolview`：为 Modellix 媒体 Tool 注册专用对话卡片；
- 如需要快速入口，可选 `conversation.input.right`：紧凑的 Modellix 按钮，但首选标题操作区，避免挤压 Composer。

不注册或替换：

- `details`
- `conversation.session`
- `conversation`
- `conversation.details.tool`

### 7.2 抽屉行为

桌面：

- 从 viewport 右侧进入，宽度建议 `min(520px, calc(100vw - 48px))`；
- 非模态，不给背景加 inert，用户可继续查看和操作 Chat；
- 默认展示当前会话 Results；
- 高级编辑器默认折叠；
- 支持 Escape、显式关闭按钮和焦点恢复；
- 按钮带 `aria-expanded`、`aria-controls`；
- 抽屉使用 `role="complementary"` 和可见标题，而不是伪装成强制 Modal。

窄屏：

- 小于 560px 时占据安全区域内的可用宽度；
- 对话会被视觉覆盖，因此抽屉按临时 surface 处理，关闭后恢复触发按钮焦点；
- 内容内部单轴滚动，操作区保持可达；
- 320px 宽和 200% 文本缩放下不得丢失字段或按钮。

样式继续只使用 Harness `--dsw-*` / `--ds-*` 语义 Token，并支持浅色、深色、forced-colors 与 reduced-motion。

### 7.3 抽屉结构

建议顺序：

1. 标题：Modellix Design
2. 当前会话 Results
3. “高级编辑” disclosure，默认关闭
4. 高级编辑内最顶部：Prepare 自然语言参数区
5. 模型搜索、类型筛选、刷新
6. Schema-driven 字段
7. Advanced parameters
8. 唯一实心主操作“生成”

Prepare 生成的是可审查参数提议，仍需用户应用；它不会直接触发生成。

## 8. 对话内媒体结果

### 8.1 专用 Tool 卡片

为以下 Tool 注册 `tool.call.toolview`：

- `modellix_media_generate`
- `modellix_media_get_result`
- 可选为 list/schema/prepare/upload/web 提供紧凑专用卡片；没有必要时保留通用卡片。

媒体卡片直接消费已持久化的 Tool result，不单独查询或重建对话历史。

### 8.2 图片

- 卡片内按容器宽度展示；
- 点击图片或“放大”打开可访问图片查看器；
- 查看器支持 Escape、焦点移入/恢复、显式关闭；
- 使用 `referrerPolicy="no-referrer"`；
- 资源 URL 必须通过现有安全 URL 解析。

### 8.3 视频

- 原生 `<video controls playsInline preload="metadata">`；
- 不自动播放；
- 有清晰可访问名称；
- 失败时保留下载/打开链接和状态文案。

### 8.4 音频

- 原生 `<audio controls preload="metadata">`；
- 不自动播放；
- 有清晰可访问名称；
- 失败时保留下载/打开链接和状态文案。

### 8.5 一键添加 URL 到对话框

Harness 已公开会话级 `useInput` 与 `inputActions.setDraft(text)`，因此可以直接实现，不需要操作 DOM。

行为：

- 点击“添加到对话”只写入当前 Draft，不自动发送；
- 保留用户已有草稿；
- 在已有文本和 URL 之间插入一个可预测的换行；
- 不重复插入完全相同、紧邻的 URL；
- 写入后把焦点交回 Composer；若公开 API 无聚焦方法，只更新草稿，不查找或强行聚焦宿主 textarea DOM；
- URL 作为普通文本进入下一条用户消息，Agent 可结合上下文决定继续编辑、动画化或切换模型。

### 8.6 下载

- 保留 `<a download>`、`noopener noreferrer`、`no-referrer`；
- 验证 Modellix CDN 是否通过响应头支持直接下载；
- 若跨域响应导致浏览器忽略 `download`，则文案改为“下载/打开原文件”，不得伪造已保存成功；
- 不通过 Client 获取 Key，也不为下载代理 Credential-bearing 请求。

## 9. 状态与数据一致性

### 9.1 会话关联

所有媒体 Tool 使用 `exec.agent.id` 作为会话身份；抽屉使用当前 Harness `sessionId`。二者必须映射到同一 Design session key，避免 Chat 生成的结果在抽屉不可见。

需要增加契约测试证明：

- Chat `generate` 后，当前会话抽屉的 `design/read` 能看到同一任务；
- 切换会话后只显示该会话关联结果；
- 任务仓库仍可跨重启恢复；
- 旧版任务记录可读取。

### 9.2 轮询

- Host 继续集中轮询 running task；
- Client 抽屉打开时可按现有 5 秒节奏回读状态；
- 抽屉关闭后不需要额外 Client timer；
- Chat Tool 卡片是已记录结果的回放，不应自己无限轮询；
- 若 Agent 需要最新结果，应调用 `modellix_media_get_result`，这样新状态会进入对话上下文。

### 9.3 URL 过期

- 继续记录上游 expires_at；
- 上游没有过期时间时，可使用当前七天本地显示上限，但必须明确这不延长真实 URL；
- 过期作品不再展示可误导的播放器；
- Agent 路由上下文不得把过期 URL作为编辑输入。

## 10. 代码改造清单

### 10.1 Host/Domain

建议新增或重构：

- `src/host/media-tool.ts`：八个新 Tool 中的媒体 Tool 注册与输出契约；
- `src/host/web-tool.ts`：Web Search/Fetch Tool 包装；
- `src/design/media-upload-client.ts`：Modellix File API；
- `src/design/media-context.ts`：从当前 Session 历史解析附件与最近媒体资源；
- `src/host/agent-routing-context.ts`：会话级 Modellix 路由快照；
- `src/host/design-controller.ts`：拆分 list/schema、扩展 get result、保持任务关联；
- `src/design/catalog.ts`：保留规范化 task type 与输入模态；
- `src/design/model-schema.ts` / `schema-ir.ts`：输出独立 Schema Tool 所需的受限结构；
- `src/host/runtime.ts`：注册新 Tool、注入路由上下文、移除 approval gate。

可能新增 peer/inject：

- `@deepseek-ai/dsh-agent`：会话生命周期与 Agent context；
- `@deepseek-ai/dsh-attachment`：读取当前会话图片附件；

正式引入前必须以当前 Harness 公开导出为准，不深度导入 `src/*` 私有实现。

### 10.2 Client

建议拆分：

- `src/client/ModellixDesignLauncher.tsx`
- `src/client/ModellixDesignDrawer.tsx`
- `src/client/DesignAdvancedEditor.tsx`
- `src/client/DesignResults.tsx`
- `src/client/ModellixMediaToolView.tsx`
- `src/client/composer-url.ts`
- `src/client/design-drawer-store.ts`

复用：

- `DesignResultPreview.tsx`
- 现有 Schema field renderer
- Credential 对话协调器
- 结果状态与本地化映射

删除或停止注册：

- `ModellixDesignView` 作为 `conversation.view`
- `registration.ts` 中 `modellix.design` Tab 记录

### 10.3 文案与文档

实施后同步：

- `src/client/locales.ts`
- `README.md`
- `README.zh-CN.md`
- `docs/en-US/USER_GUIDE.md`
- `docs/zh-CN/USER_GUIDE.md`
- `docs/en-US/LOCAL_USAGE.md`
- `docs/zh-CN/LOCAL_USAGE.md`
- `CHANGELOG.md`
- `SECONDARY_DEVELOPMENT_REFERENCE.md`
- `screenshots.json` 与真实中英文截图（若 UI 截图变化）

文档统一改为 Chat-first 流程，并说明消耗与明细在 Modellix 查看；不再把逐次费用确认作为使用步骤。

## 11. 实施阶段

### 阶段 A：Tool 契约与迁移护栏

1. 先写新 Tool 名称、参数、输出 Schema 和模型可见描述的契约测试。
2. 将 models 拆为 list/schema。
3. 将 task 扩展为 get result。
4. 重命名 prepare/generate。
5. 删除 prepare/generate 的自定义 `ask` gate。
6. 增加 Web Search/Fetch Tool，底层复用现有 Provider。
7. 保证开关关闭或 Key 不可用时 Tool roster 同步撤销。

完成标准：八个名称准确、没有旧重复 Tool、没有费用审批、所有只读/写入边界测试通过。

### 阶段 B：上传与上下文路由

1. 实现 File API client。
2. 支持当前会话图片 `attachment_id`。
3. 支持工作区内图片/视频/音频 `path`。
4. 增加会话级 Modellix 路由上下文。
5. 增强 catalog 的 task type/input modality。
6. 增加前序媒体 URL 复用规则。

完成标准：附件/路径不能越权读取；上传未知结果不重试；连续“生成→修改刚才作品”能自动选择编辑链路。

### 阶段 C：Chat-first UI

1. 提取 Results 和 Advanced Editor。
2. 注册标题按钮和 `shell.overlay` 抽屉。
3. 删除 Design Tab。
4. 抽屉默认 Results，高级编辑默认收起。
5. 把 Prepare 移到高级编辑顶部。
6. 注册媒体 Tool 专用对话卡片。
7. 实现图片放大、视频/音频播放器、下载和添加 URL 到 Draft。

完成标准：普通媒体流程不离开 Chat；高级用户可打开抽屉精修；无宿主私有 API 或 DOM 注入。

### 阶段 D：文案、文档与迁移

1. 删除运行时和公开文档中的逐次费用提示。
2. 保留 402、429、offline、5xx、submit-unknown 恢复说明。
3. 更新中英文 README/用户指南/本地使用说明。
4. 更新二次开发参考的工具地图与 UI 入口。
5. 用真实浏览器重拍中英文截图并更新 `screenshots.json`。

### 阶段 E：发布

因为这是公开 Tool、运行行为、Client bundle 和文档的变化，实施时需要：

1. 版本提升到建议的 `0.2.0`；
2. 完成完整发布验收；
3. 提交并推送 `main`；
4. `pnpm pack`；
5. 使用隔离 npm 配置发布 tarball；
6. 回读 Registry；
7. 从空环境远端安装验收；
8. 检查 Awesome DSH Plugin 现有条目/PR，只在 URL、分类或描述确实变化时更新。

不自动创建 Git Tag 或 GitHub Release。

## 12. 测试与验收矩阵

### 12.1 单元测试

- 新旧 Tool roster 与名称；
- list 过滤、任务类型和截断；
- schema 精确 slug、受限 full/compact 输出、Schema 变化；
- generate 字段校验、Schema hash、只提交一次、submit-unknown；
- get result 本地命中、远端回读、未知 task；
- upload attachment/path、大小/格式、路径逃逸、未知响应、401/413/429；
- Web Tool 输入/输出、SSRF、redirect、超时和错误映射；
- 路由上下文的 enabled/disabled/credential snapshot 与长度上限；
- 无任何 prepare/generate 自定义 approval gate；
- 无普通费用提示字符串；
- URL 加入 Draft 时保留原文、正确分隔、不自动提交；
- 新 Slot 注册、旧 Design Tab 不再注册；
- 图片、视频、音频 Tool view 与安全 URL fallback。

### 12.2 契约测试

- Chat Tool 与抽屉使用相同 session key；
- Tool result 能被 Harness 记录并在重放时稳定渲染；
- 旧任务仓库兼容；
- 旧 Tool 历史回放使用通用卡片，不崩溃；
- Client RPC 不出现 Key、Authorization 或 Credential 派生信息；
- Modellix File API 只向固定受信 host 发送 Credential。

### 12.3 浏览器验收

所有浏览器验收先执行 `browser-automation-router`，先复用已有 DSH Web 服务和真实 Chrome。

覆盖：

- 无 Design Tab；
- 标题按钮开关抽屉；
- 抽屉桌面/窄屏、浅色/深色；
- 320/560/768/1440px；
- 200% 文本缩放；
- Escape、焦点恢复、按钮 aria-expanded；
- 抽屉打开时桌面 Chat 仍可操作；
- Prepare 位于高级编辑顶部；
- 图片放大；
- 视频与音频播放器；
- 添加 URL 到已有 Draft；
- 下载/打开原文件；
- missing、ready、401、402、429、offline、5xx、submit-unknown；
- Console 无错误，Network 无 Key 泄露；
- 截图只使用空 Key 或假 Key。

### 12.4 Agent E2E

建议用例：

1. “今天某项公开信息是什么？”——不提 Web Tool，仍调用 search。
2. “总结这个 URL”——不提 fetch，仍调用 fetch。
3. “不要联网，只根据下面文字回答”——不得调用 Web。
4. “生成一张……”——自动进入文生图。
5. “把刚才那张改成……”——复用前序 URL，进入图片编辑。
6. 上传图片后说“让它动起来”——读取会话附件、上传、选择图生视频。
7. 指定工作区视频并说“改成夜景”——上传视频、选择视频编辑模型。
8. 结果仍在 running 时——调用 get result，不重复 generate。
9. submit-unknown——只查询，不重放。

“自动触发”验收应定义为受控模型与测试提示集上的行为目标，例如关键用例 100% 命中、扩展提示集达到约定阈值；不能写成对所有未来模型的协议保证。

真实生成和 Web E2E 需按仓库规则取得当轮计费授权，并生成与精确 Git HEAD、版本绑定的仓库外 evidence。

## 13. 风险与缓解

### 风险 1：Tool 数量增加导致模型选择混乱

缓解：新名称按媒体/Web 分组；list/schema 职责单一；移除旧重复 Tool；描述使用明确触发条件和否定边界。

### 风险 2：会话路由上下文增加 Token

缓解：采用短 snapshot；状态不变不重复注入；用测试限制长度；详细协议留在 Tool description，不复制到每个回合。

### 风险 3：自动 Web 过度调用

缓解：规则限定为时效性、外部事实、来源核验和 URL 阅读；尊重“不要联网”；测试稳定常识与纯文本总结不会无理由联网。

### 风险 4：媒体编辑模型选错

缓解：list 保留 task type；schema 输出 routing/limitations；明确模型优先级；不兼容时重新选模型，而不是强塞字段。

### 风险 5：上传工具读取不应上传的文件

缓解：只接受当前会话附件或用户给出的工作区内路径；真实路径复核；类型/大小/签名校验；无任意 URL 带 Credential 转发。

### 风险 6：跨域下载行为不一致

缓解：真实浏览器验证 CDN 响应；不承诺浏览器已保存；必要时使用“打开原文件”兜底。

### 风险 7：抽屉与宿主层级冲突

缓解：只使用 `shell.overlay` 公开 Slot 与语义 Token；不替换 `details`；验证 z-index、pointer-events、窄屏和 forced-colors。

## 14. 本轮不实施内容

本计划生成阶段不执行以下动作：

- 不修改功能源码；
- 不启动或重启 DSH Web；
- 不调用任何真实图片、视频、音频、LLM 或 Web 计费接口；
- 不读取任何 API Key；
- 不发布 npm；
- 不更新默认用户 Profile；
- 不创建 Tag 或 Release。

## 15. 最终建议

建议按“Tool 契约 → 上下文路由与上传 → Chat-first UI → 文档与发布”四个主批次实施，不先做纯视觉搬移。这样可以先解决真正影响普通用户的自动路由与对话上下文，再让右侧抽屉成为高级能力的自然补充。

首版承诺应表述为：

> 配置 Modellix Key 后，用户可直接在 Chat 中自然地搜索网页、读取页面、生成或继续编辑图片/视频/音频；插件会根据当前请求、前序媒体结果和附件主动选择 Modellix 工具。Modellix Design 抽屉保留给需要精确模型与 Schema 参数控制的高级用户。

不应表述为“任何模型、任何问题都会强制调用 Web 或媒体 Tool”，因为这超出当前 Harness Tool 扩展协议能保证的范围。

