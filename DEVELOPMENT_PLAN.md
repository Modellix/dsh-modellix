# dsh-modellix 实现与验收合同

本文是首版实现期间的临时工程合同，只记录可直接编码的行为、接口、架构边界、实施依赖和可观测验收条件。

## 0. 范围摘要

本开发计划定义共享 Credential 的 Design、LLM 与 Web Tools 三能力范围：

1. 初始化 Modal 同时提供 Modellix API Key 输入框与 Design、LLM 模型（Provider）、Web Tools 三个开关，三个开关默认全部开启；Design 说明明确其参数助手可能产生 LLM 费用。
2. 三项能力共享同一个 write-only Modellix API Key，但可独立启停、独立呈现服务健康状态。
3. Design 新增动态模型目录和 Schema 驱动参数工作区；<code>openai/gpt-image-2</code> 是首个合同测试样例，而不是唯一硬编码模型。
4. Design 桌面工作区固定左对话/参数、右任务与结果；右侧提供跨会话可恢复的 Running、未过期 Success 结果和有界 Diagnostics，以及参数复用、图片放大、音视频播放和安全下载，宿主窄 Sidepanel 只作详情/入口。
5. LLM 新增 Modellix 模型 Provider，优先复用 Harness <code>llm-pi-ai</code> 的 OpenAI-compatible 能力；一个 Key 即可刷新目录并随时快速切换模型。
6. Web Search/Fetch 保留原生 Web Provider 路线，不注册重名 Tool。
7. Key 验证改用正式无费用接口 <code>GET /api/v1/apikey/validate</code>，正确处理 HTTP 200 且 <code>data.is_valid=false</code>。
8. 状态模型、Credential epoch、保存恢复、401 去重、配置迁移、测试矩阵和交付门禁统一覆盖三项能力。
9. Design 默认模型与输入类型路由在本仓库版本化；实时目录和 Schema 是运行时权威，用户选择始终优先。
10. Design 左侧对话使用同一 Modellix Key 的 Host planner 把提示词转换为 Schema 参数 proposal；proposal 必须先显示 diff 并由用户接受，发送提示词绝不自动提交生成任务。
11. Schema 引擎使用框架无关的确定性 <code>DesignSchemaIR</code> 编译层，以 rawSchemaHash/irContractHash 识别 Schema 与 compiler/mapping 漂移。
12. Design 结果存储使用 retain-input/metadata-only 隐私合同、write-ahead 结果 envelope 预留、RemoteJobCore 和分段原子 manifest；core 提交后的 segment/manifest/oversize 故障不丢 taskId，POST 返回到 core 提交前的未知窗口进入无 taskId 的 submit-unknown。

## 1. 产品目标与完成定义

### 1.1 产品定位

<code>dsh-modellix</code> 是一个 DeepSeek Harness 原生多能力插件，用户只配置一次 Modellix API Key，即可在 Harness 中使用：

| 能力 | 用户可见名称 | 主要能力 | Harness 集成面 |
| --- | --- | --- | --- |
| Design | Design | 动态模型目录、对话式 Schema 参数草稿、异步生成、任务与未过期结果库 | 双栏 Design 工作区、使用 <code>modellix_</code> 唯一命名空间的 Tools/Host actions、可选结果详情 |
| LLM | LLM 模型（Provider） | 一个 Key 下的 Modellix LLM 模型发现、快速切换、流式对话、Tool calling | 原生 LLM Provider 与模型选择器；不代表 Design 内部参数助手开关 |
| Web Tools | Web Tools | Web Search、Web Fetch | 原生 Web Provider 与原生 <code>web_search</code>/<code>web_fetch</code> |

### 1.2 必须完成的需求

| ID | 要求 | v0.1.0 发布属性 |
| --- | --- | --- |
| CORE-01 | 单一 umbrella 插件承载三项能力，共享 Host core 和 Client shell | 阻塞 |
| AUTH-01 | API Key 由 Harness Credentials 持久化，产品中永不回显 | 阻塞 |
| AUTH-02 | 首次 onboarding Modal 同时显示 Key 输入框和三个默认开启的开关 | 阻塞 |
| AUTH-03 | Settings、onboarding、对话入口、运行时 401 共用一个 Secret Modal controller | 阻塞 |
| AUTH-04 | 对话内配置只打开可信 Modal，不把 Key 写进消息、命令参数或模型上下文 | 阻塞 |
| CFG-01 | Design、LLM 模型（Provider）、Web Tools 可独立启停，覆盖全部 8 种组合；Design 参数助手归 Design 而非 LLM Provider 开关 | 阻塞 |
| WEB-01 | Search 适配 Modellix Web Search 并复用 Harness 原生 Tool | 阻塞 |
| WEB-02 | Fetch 适配 Modellix Web Fetch 并明确部分失败与降级语义 | 阻塞 |
| LLM-01 | 注册 Provider ID 为 <code>modellix</code> 的 Modellix LLM Provider | 阻塞 |
| LLM-02 | 一个共享 Key 下完成模型发现、搜索/快速切换、流式 SSE、Tool calling、usage、取消和错误映射 | 阻塞 |
| DSG-01 | 获取并筛选 Modellix 活跃 Design 模型目录，支持搜索、分类、最近使用和刷新 | 阻塞 |
| DSG-02 | 读取所选模型公开 Schema，生成可编辑参数表单并在 Client/Host 双重验证 | 阻塞 |
| DSG-03 | 使用 Schema 给出的精确端点提交任务；<code>gpt-image-2</code> 完成首个真实合同 E2E | 阻塞 |
| DSG-04 | v0.1.0 覆盖图像、视频和 TTS 输出工作流；catalog 宽容识别 live type 字符串。I2I/I2V/V2V/STT/STS 只有各自 File API、媒体 Schema 与结果合同测试通过才开放，否则可见但禁用并说明 | 阻塞 |
| DSG-05 | Design 桌面视图为左侧对话/参数区、右侧结果区；Schema 默认值与用户覆盖值准确组装请求 | 阻塞 |
| DSG-06 | prompt-first 最短路径只要求无默认值的必填输入；可选/高级参数按需展开，确认后才计费提交 | 阻塞 |
| DSG-07 | 用户指定模型优先；未指定时按本仓库默认模型表选择。每次采用前验证实时 catalog/type/Schema；失效时要求用户重选，不静默切换收费模型 | 阻塞 |
| DSG-08 | Design-owned Host planner 把用户提示词转换成受 Schema 约束的可见 parameter proposal；发送不改草稿，显式接受后才写入；隐含推断不覆盖精确设置，最新明确指令可经冲突确认更新对应字段 | 阻塞 |
| MEDIA-01 | 对话与 Design 右侧结果区展示完整 <code>resources[]</code>；支持放大、播放、下载和真实过期提示 | 阻塞 |
| MEDIA-02 | 持久化 Running、未过期 Success 与有界 Diagnostics，跨会话随时查看；参数快照默认支持重新载入，隐私 opt-out 后不保留且禁用再次使用 | 阻塞 |
| OPS-01 | 三服务共享 Credential descriptor/verification，但服务健康、Design job/result、LLM selection、计费和限流彼此隔离 | 阻塞 |
| OBS-01 | 关联 Harness 调用、Modellix request/task、会话和稳定匿名 User ID | 阻塞 |
| REL-01 | format/typecheck/lint/test/build/pack/fresh install、Secret 扫描和真实三能力 E2E 全部通过 | 阻塞 |

### 1.3 v0.1.0 非目标

- 不逐像素复制官网 Playground；Design 使用 Harness primitives 重新实现模型目录、Schema 表单和结果库。
- 不允许用户绕过 Schema 任意 JSON 透传。受支持的公开 Schema 子集动态渲染，未支持关键字或输入类型显式阻断并提供文档链接。
- 本地媒体上传、图片/视频编辑、STT/STS 等输入型模型只有在公开 API-Key File API、Schema 媒体字段和结果合同测试通过后才开放；未通过的模型仍可出现在目录中，但必须以明确原因禁用生成。
- 不把 Design 伪装成 LLM 多模态输出；媒体生成固定走 <code>api.modellix.ai</code> 的异步任务。
- 不默认使用 Remote MCP。
- 不注册名为 <code>web_search</code>、<code>web_fetch</code> 的自定义 Tool。
- 不深度导入 Harness 私有组件，不做 DOM hack，不复制宿主 workspace/Sidepanel 构建产物。
- 不暴露任意生产 Base URL 设置，避免把 Authorization 发往非 Modellix 主机。
- 不提供“保存后显示末四位”“复制 Key”或任何形式的 Secret 回显。

## 2. 运行时、标识与 API 合同

### 2.1 固定运行基线

| 项目 | 合同 |
| --- | --- |
| DeepSeek Harness / DSH | 精确 <code>0.1.1-rc.2</code> |
| Node.js | <code>^22.19.0 &#124;&#124; &gt;=24.0.0</code> |
| pnpm | 精确 <code>11.7.0</code>，并在 <code>package.json#packageManager</code> 声明 |
| <code>@deepseek-ai/*</code> | peer range 只覆盖实际验收版本；开发依赖固定到验收版本 |

插件只使用固定版本公开导出的包、slot、service 与 Settings/Credential seam；禁止 deep import、DOM 注入、monkey patch 或复制宿主构建产物。Client bundle 更新后通过重启对应 Web profile 验收；普通 Settings、Credential reference 和服务开关变更必须在不重启的情况下生效。

### 2.2 插件标识

| 项目 | 固定值 |
| --- | --- |
| package / bundle | <code>dsh-modellix</code> |
| 插件显示名 | <code>Modellix</code> |
| 非 Secret 配置 namespace | <code>modellix</code> |
| Credential ref | <code>MODELLIX_API_KEY</code> |
| LLM Provider route | <code>modellix</code> |
| LLM Settings 路径 | <code>llm-pi-ai.providers.modellix</code> |
| Web Search / Fetch Provider ID | <code>modellix</code> |
| Design Tool / Host action 前缀 | <code>modellix_</code> |
| Design Client 视图 | session-scope <code>conversation.view</code> list entry，ID <code>modellix.design</code> |
| Client/Host RPC 前缀 | <code>modellix.</code> |

Design 只向 <code>conversation.view</code> 注册一个插件自有标签页，不替换 <code>conversation.session</code>，不读取或改写 Chat 私有快照；视图卸载时释放订阅、object URL、焦点与媒体资源，Host-owned job/poll 状态继续存在。

### 2.3 Modellix API

| 服务 | Base URL | 关键端点 | 调用模型 |
| --- | --- | --- | --- |
| Credential 验证 | <code>https://api.modellix.ai</code> | <code>GET /api/v1/apikey/validate</code> | 无费用读取；无效也可能 200 |
| Design catalog | <code>https://api.modellix.ai</code> | <code>GET /api/v1/models</code> | 鉴权读取活跃模型 |
| Design schema | <code>https://www.modellix.ai</code> | <code>GET /models/{provider}/{model}/api_schema</code> | 公开读取，不发送 Key 或 Cookie |
| Design | <code>https://api.modellix.ai</code> | Schema 指定的模型 POST；<code>GET /api/v1/tasks/{task_id}</code> | 异步 task |
| GPT Image 2 | 同上 | <code>POST /api/v1/openai/gpt-image-2</code> | 异步返回 task_id |
| LLM | <code>https://llm.modellix.ai/v1</code> | <code>GET /models</code>、<code>POST /chat/completions</code>、<code>GET /logs</code> | JSON 或 SSE |
| Web Tools | <code>https://tool.modellix.ai</code> | <code>POST /v1/web-search</code>、<code>POST /v1/web-fetch</code> | 同步计费请求 |

实现约束：

1. Design 提交只使用当前公开 Schema 给出的、经 Host allowlist 校验的精确 POST 路径；不猜测或自动尝试 <code>/async</code> alias。
2. catalog 只提供模型描述与展示价格；参数和提交路径必须来自所选模型 Schema。
3. Schema 请求不携带 Authorization/Cookie，尊重 <code>no-store</code>；浏览器不直接请求 catalog、Schema、submit、poll、LLM 或 Web API。
4. Web Fetch 缺少权威的逐页 HTTP status/truncation 时返回显式 unavailable；若 Harness 类型不允许表达 unavailable，则该适配合同为发布阻塞，不伪造值。
5. 所有带 Key 的请求只允许 Host 发往固定 Modellix origin，跨 origin redirect 不转发 Authorization。

## 3. 总体架构

### 3.1 逻辑结构

~~~text
DeepSeek Harness
├─ Host
│  └─ dsh-modellix umbrella bundle
│     ├─ Core
│     │  ├─ Credential Broker + plugin-owned epoch
│     │  ├─ Service Registry + three toggles
│     │  ├─ HTTP policy + error taxonomy
│     │  ├─ stable user/session identity
│     │  └─ health, request correlation, audit metadata
│     ├─ Design
│     │  ├─ namespaced media tools
│     │  ├─ active model catalog + schema resolver
│     │  ├─ schema-constrained parameter draft/provenance engine
│     │  ├─ schema validation + exact endpoint policy
│     │  ├─ paid task submit
│     │  └─ persistent job/result repository + polling
│     ├─ LLM
│     │  ├─ llm-pi-ai route/provider bridge
│     │  ├─ model discovery
│     │  └─ selection ownership + restore
│     └─ Web Tools
│        ├─ native search provider
│        └─ native fetch provider
└─ Client
   ├─ onboarding: Key + three default-on toggles
   ├─ Modellix Settings card
   ├─ trusted conversation setup action
   ├─ single Secret Modal arbiter
   ├─ service/credential health UI
   └─ conversation.view / modellix.design: chat/draft + model picker + schema form + results/media
~~~

### 3.2 Host/Client 安全边界

- Client 只能获得 Credential descriptor：是否配置、来源、是否可写、插件维护的 epoch、verification，不得获得任何 Secret 字符。
- Authorization 只在 Host 的三个固定 Modellix origin 上构造；默认拒绝 redirect 到不同 origin。
- Settings 文档只存开关、最近/收藏、Design lastModel、插件拥有的有界 LLM per-session CAS/route ledger、UI 偏好和非 Secret metadata；不存全局 LLM 当前模型/selectionState，Key 只进 Harness Credentials。
- Tool/Host action result 按该记录的 retentionPolicy 判别：retain-input 可包含用户已知的 prompt/参数摘要；metadata-only 只返回 model、合同 hash/版本、状态、合法 ID、经验证的输出资源、billing/时间、安全错误和 <code>inputRetained=false</code>，不得返回任何输入字段值或输入派生摘要。只有 RemoteJobCore/由其组装的 RemoteJobView 才返回真实 task ID；所有分支都不含 Key、Authorization 或带敏感 query 的内部 URL。
- 对话设置入口只传一个可信 UI action，例如 <code>openModellixSettings</code>，不接收 Key 参数。
- 媒体若可匿名读取，可把验证过的短期 URL 交给 Client；若需要鉴权，必须由 Host 代理 stream，浏览器永远不接触 Key。

### 3.3 单包策略

首版使用一个 umbrella package，原因：

- 三能力共享一个 Credential、一个 onboarding、一个 Settings 卡和一个 Client bundle。
- 用户需求是一次安装、三个独立开关，不是三个独立安装流程。
- 单包能避免三个插件同时竞争 Secret Modal、Provider ownership 和 namespace。

内部按服务拆模块，保持未来拆包能力；v0.1.0 不发布语义重复的 umbrella 包和三个子包。

## 4. 配置、开关与生命周期

### 4.1 配置模型

建议的非 Secret 配置合同：

~~~yaml
schemaVersion: 1
services:
  design:
    enabled: true
    lastModel: null
    plannerModelId: null
    defaultWorkflow: text-to-image
    retentionPolicy: retain-input
    retentionPolicyRevision: 1
    recentModels: []
    favoriteModels: []
  llm:
    enabled: true
    recentModels: []
    favoriteModels: []
  web:
    enabled: true
credential:
  ref: MODELLIX_API_KEY
  epoch: 0
onboarding:
  state: active
  pendingServices: null
  writeIntentId: null
llmOwnership:
  route:
    ownership: none
    baselineRevision: null
    appliedRevision: null
    entries: []
  sessionSelections: {}
~~~

约束：

- 全新安装和首次初始化，三个 <code>enabled</code> 缺省都迁移为 <code>true</code>。
- 用户明确修改后必须持久化，重启不得重置。
- 升级时只填补缺失字段，不覆盖已有值；迁移必须幂等并有 contract test。
- Key 被移除时保留开关偏好，但三能力进入 Credential missing gate。
- 开关关闭不删除 Key，不删除其他服务设置，不清空 Design 未过期 task/result history。
- 生产 UI 不提供任意 Base URL。测试仅通过受控 fixture 或构建时测试注入替换。
- <code>lastModel</code> 只记录用户实际选择/使用过的模型；全新 profile 不把合同 fixture 写成历史选择。初次解析使用第 6.2 节默认路由，并在实时 catalog/Schema 校验后才展示为当前建议。
- <code>services.design.retentionPolicy</code> 是持久、可 CAS 的新任务默认值，只允许 <code>retain-input</code> 或 <code>metadata-only</code>；全新安装默认 retain-input。每次修改原子递增 <code>retentionPolicyRevision</code>，SubmitIntent 在 write-ahead 前快照 policy+revision；修改只影响之后的新提交，不回写既有记录。清理既有输入必须走单独、明确的“删除已保留输入/清除记录”动作。
- 不持久化全局 LLM selectionState。<code>none/selected/stale</code> 必须从当前 Harness Session 的实际选择、当前 catalog/adapter 状态派生；不同 Session 可以同时处于不同状态，catalog ready 不等于任一 Session 已有可调用模型。
- <code>llmOwnership.sessionSelections</code> 是有界 map，key 为稳定非 Secret session ID；value 精确为 <code>{providerId, modelId, previousProviderId?, previousModelId?, appliedSelectionRevision, ownershipRevision}</code>。它只记录插件在用户明确确认后写入的选择，不持久化 state/lastObservedState；当前 none/selected/stale 每次从 Harness Session、catalog 和 adapter 重新派生。用户在原生选择器中的主动选择不归插件所有。
- <code>credential.epoch</code> 是插件 Settings 中的单调非 Secret 整数；每次 Credential reference 更新事件或本插件成功 set/unset 后原子递增。它不是 Harness Credential API 原生 revision，也不承诺跨进程 Secret CAS。
- <code>onboarding.state</code> 只允许 active/saving/completed/deferred。saving 只保存非 Secret pendingServices 与 writeIntentId，用于 Credential 已写入但 Settings 尚未完成时的恢复；不得保存候选 Key 或其派生值。
- <code>llmOwnership.route</code> 是可迁移的字段级 ownership ledger：<code>ownership</code> 仅为 none/created/adopted，保存 baseline/applied revision；每个 <code>entries[]</code> 精确为 <code>{kind: model|field, key: modelId|JSON-Pointer, baselineFingerprint?, appliedFingerprint, appliedRevision}</code>。Fingerprint 只覆盖非 Secret canonical value，绝不包含解析后的 Credential/Authorization。刷新只按 model ID/JSON Pointer 合并插件拥有项并保留手工 models、未知字段和用户 overrides；revision/fingerprint 漂移后停止自动清理并要求重新采纳。关闭/卸载时，采纳的 route 永不整条删除，只移除仍与 applied fingerprint 一致的插件注入项；插件创建的 route 也只有在无用户漂移时才可 CAS 删除。

### 4.2 三开关语义

| 动作 | Design | LLM 模型（Provider） | Web Tools |
| --- | --- | --- | --- |
| 初始默认开启 | 注册 Design 中央视图、Client RPC 与 Agent Tool，允许用户主动提交和显式调用参数助手 | 注册 Provider、准备 catalog 与快速选模 | 注册 Modellix Web Provider |
| 关闭 | 禁止新 Prediction submit 和 Design-owned planner 请求；保留 task_id | 停止 Harness Modellix LLM Provider 新请求并从新选择面移除/标记不可用；不控制 Design 参数助手 | 不再选择或执行 Modellix Web Provider |
| 在途行为 | best-effort Abort planner/upload；Prediction POST 尚未发送则阻断，已发送但尚无 taskId 则按 submit-unknown，已有 taskId 的远端任务仍可能计费并继续；当前 poll GET 完成后暂停 | best-effort Abort 当前 Provider 请求，不自动换模型重发 | best-effort Abort 当前请求，不自动重发 |
| 再开启 | 恢复目录、Schema 表单与未过期结果查询 | 刷新 catalog，恢复快速选模 | 恢复 Provider，不覆盖其他 Provider |
| Credential | 保留 | 保留 | 保留 |

第二个开关在 UI 中固定显示为“LLM 模型”并以帮助文本说明“控制 Harness 中的 Modellix LLM Provider；Design 内的智能参数助手由 Design 控制，并只在显式发送时调用、另行披露费用”。不能只显示模糊的“LLM”后又在关闭时继续产生未解释的 LLM 请求。

LLM Provider 的“开关开启”与“主动切换当前模型”必须分开：

- 保存共享 Key 且 LLM enabled 后，立即注册 Provider、读取 catalog，并把格式验证过的 advertised model IDs 通过 settings CAS 物化到模型选择面；不再出现第二个 LLM Key 配置步骤。远端公布不等于实际 route 可调用，物化失败时 Provider/catalog 与 selection 分别报错，不能伪装“模型已可用”。
- 全新 profile 没有可用当前模型时，引导用户从已加载 Modellix 目录选择一个；除非用户在同一确认动作中明确选定，不按“开关默认 on”自动产生一次模型切换。
- 已有可用模型的升级 profile：注册 Modellix，但不静默替换现有选择；在 UI 提示用户选择。
- 用户可随时搜索/选择其他 Modellix model；切换只改变下一次新请求，当前流不被重启。记录最近使用、收藏和 selection revision，但所有模型仍共用一个 Key。
- 关闭或卸载：逐 Session 处理。只在该 Session 当前选择仍等于插件明确写入值、ownership revision 未漂移时恢复先前选择；用户在原生选择器中主动选中的 Modellix 模型不做全局恢复或静默 fallback，禁用后显示“模型不可用，请选择其他模型”。Provider route 按字段级 ownership ledger 清理，不能用整文档覆盖或删除被采纳 route。
- 无论何种情况都不得静默 fallback 到另一个可能收费模型。

Web Tools 开启时不得无条件覆盖用户选择：

- 若尚无 Web Provider 或当前 Provider 由本插件拥有，可选择 Modellix。
- 若用户已有其他 Provider，只注册 Modellix 并提供明确选择，不静默替换。
- 关闭时只撤销本插件拥有的选择，不触碰后来由用户做出的选择。

### 4.3 全部 8 种组合

以下组合均为正式支持面，不能把某能力暗中依赖 LLM：

| Design | LLM | Web | 期望 |
| --- | --- | --- | --- |
| off | off | off | 插件仅保留设置入口，不发服务请求 |
| on | off | off | Design 可由任意其他兼容 Agent/模型调用 |
| off | on | off | 只提供 Modellix LLM |
| off | off | on | 只提供原生 Modellix Web Provider |
| on | on | off | Modellix LLM 可调用 Design；Web 不可用 |
| on | off | on | 其他模型可使用 Design 与 Modellix Web |
| off | on | on | Modellix LLM 与 Web 可用；无媒体工具 |
| on | on | on | 完整默认体验 |

## 5. Credential、onboarding 与状态模型

### 5.1 Credential 合同

- Credential ref：<code>MODELLIX_API_KEY</code>。
- 支持本地 Credentials 文件来源和环境变量来源。
- 本地来源可 set/unset；环境变量来源只读，只能提示用户在外部修改。
- <code>describe</code> 只返回 descriptor，不返回完整值、掩码、末四位、长度或哈希。
- Harness Credential API 只负责 <code>resolve/describe/set/unset</code> 与 reference 更新事件；插件不得假定它提供 revision 或 CAS。
- Host 对同一 ref 的 set/unset 在进程内串行化，并在插件 Settings 中维护单调 <code>credentialEpoch</code>。每个请求、health 更新、缓存 key 和 401 去重都捕获该 epoch；reference 更新事件必须使 epoch 递增并失效旧请求结果。
- Secret 写入没有跨进程 CAS。若检测到 descriptor/source 或 epoch 在表单流程中漂移，停止当前保存并要求用户重新提交，不覆盖未知并发更新。

### 5.2 正交状态

| 维度 | 值 |
| --- | --- |
| Service toggle | <code>enabled</code>、<code>disabled</code> |
| Credential descriptor | <code>missing</code>、<code>configured</code> |
| Credential source | <code>local</code>、<code>env</code> |
| Verification | <code>unknown</code>、<code>unverified</code>、<code>valid</code>、<code>invalid</code> |
| Client operation | <code>idle</code>、<code>editing</code>、<code>validating</code>、<code>saving</code>、<code>removing</code> |
| Service health | <code>unknown</code>、<code>checking</code>、<code>ready</code>、<code>billing-blocked</code>、<code>rate-limited</code>、<code>offline</code>、<code>server-error</code>、<code>policy-blocked</code> |
| Design planner health | <code>not-configured</code>、<code>unknown</code>、<code>checking</code>、<code>ready</code>、<code>billing-blocked</code>、<code>policy-blocked</code>、<code>rate-limited</code>、<code>offline</code>、<code>server-error</code> |
| Design planner request lifecycle | <code>idle</code>、<code>requesting</code>、<code>succeeded</code>、<code>failed</code>、<code>canceled</code>、<code>timed-out</code> |
| LLM selection | <code>none</code>、<code>selected</code>、<code>stale</code>（per-session） |
| Design upload lifecycle | <code>not-required</code>、<code>idle</code>、<code>uploading</code>、<code>succeeded</code>、<code>failed</code>、<code>canceled</code> |
| Design submit lifecycle | <code>draft</code>、<code>local-validating</code>、<code>intent-persisting</code>、<code>submitting</code>、<code>submitted</code>、<code>submit-unknown</code> |
| Design remote job status | <code>not-created</code>、<code>unqueried</code>、<code>pending</code>、<code>processing</code>、<code>success</code>、<code>failed</code>、<code>unknown-raw</code> |
| Design poll status | <code>idle</code>、<code>active</code>、<code>paused</code>、<code>timed-out</code> |
| Design result status | <code>unavailable</code>、<code>available</code>、<code>expired</code>、<code>removed</code> |
| Design diagnostic reason | 稳定 reasonCode，例如 <code>submit-unknown</code>、<code>credential-mismatch</code>、<code>inaccessible</code>、<code>schema-changed</code>、<code>unknown-remote-status</code>；不是 job/result 枚举 |
| Onboarding | <code>active</code>、<code>saving</code>、<code>completed</code>、<code>deferred</code> |

表单 operation、Credential descriptor/verification、服务健康、plannerHealth、LLM per-session selection、Design upload/submit/remote/poll/result/diagnostic 不能继续压成一个互斥枚举。例如：descriptor=configured 且 verification=valid 时，仍可同时存在 planner rate-limited、一个 remote job=processing、poll=paused、另一个 result=expired、LLM route ready 但当前 Session selection=none、Web rate-limited。

<code>/api/v1/apikey/validate</code> 只证明 Prediction Credential 合同。保存后 Design、LLM、Web health 分别从 unknown/checking 演进：Design 由 catalog/Schema 读取证明，LLM 由远端 catalog→settings CAS→adapter/picker 回读证明；Web 没有无费用 health 合同时保持 unknown，直到首次真实 Search/Fetch 返回，不能为了显示 ready 自动发起计费请求。

### 5.3 首次 onboarding 流程

1. Client 读取 Credential descriptor 与三开关配置。
2. 缺 Key 且 onboarding 未完成时，打开唯一 Modal。
3. Modal 显示：
   - 标题“配置 Modellix”；
   - API Key password 输入框和显示/隐藏草稿按钮；
   - Design、LLM 模型、Web Tools 三个 Switch，初始全部开启；Design 说明包含“智能参数助手可能产生已披露的 LLM 费用”，LLM 模型说明其只控制 Harness Provider；
   - “保存并启用”主按钮；
   - “稍后处理”次操作；
   - “前往 Modellix 创建 API Key”安全外链，固定指向 <code>https://www.modellix.ai/console/api-key</code>。
4. 用户提交后，Host 调用 <code>GET https://api.modellix.ai/api/v1/apikey/validate</code>。
5. HTTP 200 + <code>data.is_valid=true</code>：先用 Settings CAS 写入 <code>onboarding=saving</code>、pendingServices 和随机 writeIntentId；再串行 set Credential、回读 descriptor；最后用 Settings CAS 原子递增 credential epoch、提交三个开关并标记 completed，清空 pending 字段。
6. HTTP 200 + <code>data.is_valid=false</code>：仅标记候选无效，不写 Credential，不改变当前共享 health。
7. 500、断网或超时：不得称 Key 无效。首次没有旧 Key 时，可以提供二次确认“保存并稍后验证”；此动作必须明确风险。替换已有 Key 时不允许覆盖旧 Key。
8. LLM 开启时异步刷新 model catalog；失败只影响 LLM health，不回滚已经安全保存的 Key。
9. 启动或 Client 重连时发现 <code>onboarding=saving</code>：Host 只解析当前已存 Credential 并调用无费用 validate；有效则完成 pendingServices/epoch/completed 的 Settings CAS，无效或不可确定则回到 active/verification unknown 并要求用户处理，绝不重新执行 set 或丢弃既有 Credential。
10. 成功后清空组件局部草稿、关闭 Modal、恢复触发焦点；Design/Web 与 LLM Provider/catalog 在不刷新页面的情况下按配置激活。若当前 Session 尚未选定 LLM 模型，则 selection=none 并进入可操作的待选模状态，不能称模型已就绪。
11. “稍后处理”用 Settings CAS 保存用户当前三个开关和 <code>onboarding=deferred</code>，清空草稿并关闭；不把插件标记 ready，下一次主动使用任一已开启能力时再次引导。

### 5.4 更换与移除

更换 Key：

- 打开时不读取、不回填旧 Key，输入框永远为空。
- 候选验证绑定打开表单时捕获的 descriptor 与 credential epoch；任一漂移都中止保存。
- 候选通过后按 onboarding 相同的 saving intent → 串行 set → describe → Settings CAS 流程替换；成功后递增 credential epoch。
- set 成功但 describe 失败时进入 <code>descriptor=configured + verification=unknown</code> 的恢复分支，不发明组合枚举，也不自动重复 set。
- 候选 401 或 <code>is_valid=false</code> 不改变旧 Credential descriptor/verification。
- 网络不确定时保持旧 Key，候选只留在当前 Modal 草稿，关闭即清除。

移除 Key：

- 只对可写 local source 显示移除。
- 使用简单确认 Modal；成功后三能力进入 missing gate，但开关偏好不变。
- 环境变量来源只显示外部修改说明，不伪装可删除。

### 5.5 对话内配置

“在对话中配置 API Key”定义为可信 UI 行为，而不是聊天协议：

- 首选公开 composer action 或 command-menu action“配置 Modellix”。
- 可提供无参数命令 <code>/modellix</code> 或 <code>/modellix setup</code>，其唯一作用是打开 Modal。
- 禁止 <code>/modellix key ...</code>、禁止让模型索要 Key、禁止把 Key 放入 Tool argument。
- 结构化 missing/invalid result 可以带受信任 action ID，由 Client 映射为按钮；普通文本不能触发 Secret Modal。
- Settings、onboarding、conversation action 和 401 overlay 进入同一个 Modal arbiter，按 missing/invalid 优先级合并，禁止叠窗。

### 5.6 Credential epoch 与 invalid epoch

- 请求发出时捕获插件维护的 <code>credentialEpoch</code>。
- 只有响应 epoch 等于当前 epoch 的明确 HTTP 401，才把共享 verification 更新为 invalid。
- 相同 epoch 的并发 401 合并为一个 invalid epoch，只打开一个 Modal、只播报一次。
- Credential reference 更新后 epoch 递增并关闭旧 invalid epoch；旧请求迟到的 401 被记录但不得改变新状态。
- LLM adapter 必须区分“客户 Key 被 Modellix 拒绝”和“Modellix 上游 Provider 鉴权失败”；只有前者触发全局 Key replacement。

## 6. Design 设计

### 6.1 产品形态

Design 是一个方便用户直接使用 Modellix 模型的动态工作区，不是只为三个默认模型准备的固定表单。桌面端采用稳定的左右形态：

1. **左侧：对话/参数区**。选择/搜索模型，输入 prompt 或主要指令，按该模型 Schema 列出全部受支持参数并带入默认值，用户可直接修改后点击生成。
2. **右侧：任务与结果区**。展示当前提交/轮询进度、未过期 Success 结果，以及有界 Failed/submit-unknown Diagnostics；支持切换详情、下载和“使用这些参数再次创建”。

桌面分栏比例采用 42:58；小于 768px 时按“左侧参数在上、右侧结果在下”的同一阅读顺序堆叠，不改变数据模型，也不把生成按钮与错误隐藏到不可达 Tab。

用户使用任何 Harness 模型时都能打开 Design。直接选择模型、输入主 prompt、采用 Schema 默认值和精确编辑控件不依赖 Modellix LLM。自然语言更新参数由 Design-owned、Host-side Modellix planner 完成：使用同一 Key、归 Design 开关、独立于公开 LLM Provider 开关，并固定 planner model、结构化输出、费用披露和 0 自动重试。Planner 暂不可用时保留 prompt 与精确表单，不丢草稿、不误生成。

交互遵循“简单生成优先、精细控制按需”的渐进披露：

- 首屏只突出模型、prompt/主要输入和“确认并生成”。
- 有 Schema default 的字段直接采用默认值，并以参数摘要/chip 告知用户，不强迫逐项确认。
- 可选参数收进可发现的“参数”区域；用户可以在提交前或从历史结果返回后随时展开修改。
- 必填且无默认值的字段才进入最短路径并阻断生成；按自然顺序逐项提示，不一次倾倒整份 Schema。
- 生成是一项明确的用户确认动作；模型选择、输入文字、改变参数和默认开关 on 都不会自动调用。

### 6.2 活跃模型目录

Host 使用共享 Key 调用：

<code>GET https://api.modellix.ai/api/v1/models</code>

目录合同顶层返回 <code>{ models: [...] }</code>。每个 item 返回：

- <code>slug</code>：<code>provider/model</code>；
- <code>type</code>：按受控长度的非空 string 宽容解析。真实目录当时有 text-to-image、image-to-image、text-to-video、image-to-video、video-to-video、text-to-speech、speech-to-text、speech-to-speech 共 8 种；公开 OpenAPI 的闭合 enum 仍只有 6 种，不能用它拒绝新合法类型；
- <code>docs_url</code>、description；
- 可选展示价格 fixed 或 min/max 与 unit。

目录 UX：

- 默认显示全部 Design 模型，支持按输出类型、输入类型、provider 筛选和关键词搜索。
- “推荐/Featured”通过单独的 <code>GET /api/v1/models?featured=true</code> 取得子集；model item 没有 featured 字段，不能本地臆测。另提供“最近使用”“收藏”，仅存 model slug。
- 选择模型时立即显示 description、类型、价格单位、文档链接和 Schema 加载状态。
- 支持手动刷新；credential epoch 变化时失效缓存；只有服务端实际提供 ETag/Last-Modified 时才条件请求。当前响应没有 ETag、Last-Modified 或 Cache-Control，因此 catalog TTL 固定 5 分钟；按 credentialEpoch+query 做 single-flight，响应携带 request sequence，旧 epoch/旧 sequence 不得覆盖新目录或当前选择。回读完整新集合后才原子替换。
- catalog 暂时不可用时可显示最后一次成功缓存并标记“可能已过期”，但禁止对已经下线且未经重新验证的 endpoint 直接提交。
- capability mapping 由插件版本管理；未知的新 type 仍显示在目录中，但生成按钮禁用并说明“当前插件版本尚未支持此类型”。
- 全目录 census 是有时间戳的证据，不是永久事实。扫描 Schema 时默认最多 4 个并发 GET，尊重 Retry-After，并对只读网络/429/5xx 做最多 2 次有界重试；扫描前后分别回读 catalog 并计算规范化 hash。前后 hash 不同则本轮报告标记非权威并在退避后重扫，发布门禁不得使用漂移中的“不完整全量”报告。

默认选择与路由使用本仓库版本化策略：

| 工作流 | 未指定模型时的默认 slug | v0.1.0 使用条件 |
| --- | --- | --- |
| Text-to-image (T2I) | <code>google/nano-banana-2-lite</code> | 实时 catalog 存在且 Schema 可渲染 |
| Image-to-image (I2I) | <code>google/nano-banana-2-lite-edit</code> | File API 与 image 字段映射通过 |
| Text-to-video (T2V) | <code>bytedance/seedance-2.0-mini-t2v</code> | 实时 catalog 存在且 Schema 可渲染 |
| Image-to-video (I2V) | <code>bytedance/seedance-2.0-fast-i2v</code> | File API 与 image 字段映射通过 |
| Video-to-video (V2V) | <code>bytedance/seedance-2.0-fast-v2v</code> | File API 与 video 字段映射通过 |
| Text-to-speech (TTS) | <code>alibaba/qwen-audio-3.0-tts-flash</code> | 实时 catalog 存在、voice 等必填字段可表达 |
| Speech-to-text (STT) | <code>openai/whisper-1</code> | 目录暴露该类型且音频输入合同通过 |
| Speech-to-speech (STS) | <code>alibaba/cosyvoice-clone</code> | 目录暴露该类型且音频输入合同通过 |

每个工作流独立判定，不能用一个“File API 可用”替代模型级证据：

| 工作流 | 必须通过的合同 | 产品范围 | 失败行为 |
| --- | --- | --- | --- |
| T2I | catalog/type、prompt-first Schema、精确 endpoint、image resources/expiry | v0.1.0 核心 | 任一合同失败则阻塞发布 |
| T2V | catalog/type、prompt-first Schema、精确 endpoint、video resources/expiry | v0.1.0 核心 | 任一合同失败则阻塞发布 |
| TTS | catalog/type、voice/text Schema、精确 endpoint、audio resources/expiry | v0.1.0 核心 | 任一合同失败则阻塞发布 |
| I2I | API-Key File API image upload、Schema 媒体字段映射、image result | 条件开放 | 未全部通过时目录可见并以稳定 reason 禁用 |
| I2V | API-Key File API image upload、Schema 媒体字段映射、video result | 条件开放 | 同上 |
| V2V | API-Key File API video upload、Schema 媒体字段映射、video result | 条件开放 | 同上 |
| STT | API-Key File API audio upload、Schema 映射、权威 text/transcript 输出合同 | 条件开放 | 同上 |
| STS | API-Key File API audio upload、Schema 映射、audio result 及 transcript/metadata 输出合同 | 条件开放 | 同上 |

每条工作流测试记录必须包含 catalog hash、rawSchemaHash/irContractHash、合同结果、reasonCode 与 E2E 结果。条件工作流未满足合同时使用准确的 <code>visible-blocked(reason)</code>；核心 T2I/T2V/TTS 任一合同失败都阻塞发布。

解析顺序固定，不能被“推荐”排序改变：

1. 用户在模型选择器、历史参数或可信 Tool 参数中明确指定的 slug 优先。
2. 未指定模型时，先由用户明确的输出模式与已提供输入媒体确定工作流：纯文本+图片输出为 T2I，图片输入+图片输出为 I2I，纯文本+视频输出为 T2V，图片输入+视频输出为 I2V，视频输入+视频输出为 V2V；音频工作流同理。自然语言可以更新这组可见控件，但付费提交前必须把解析出的工作流、模型和参数展示给用户确认。
3. 若有用户最近一次且类型匹配的模型，可作为可见建议；只有用户选定后才覆盖该工作流默认，不用跨类型的 <code>lastModel</code> 猜测。
4. 自动采用默认 slug 前必须重新确认其仍在鉴权 catalog、type 匹配、公开 Schema 可支持且 endpoint 通过 allowlist。任一条件失败即显示模型选择器和具体原因；不得扫描 catalog 后静默换成另一个可能收费的模型。
5. 全新 Design 默认输出模式为图片，因此无历史选择时建议经过在线验证的 T2I 默认；<code>openai/gpt-image-2</code> 只保留为官方示例和合同 fixture，不再充当产品初始默认。

这些 slug 是受版本管理的产品策略，不是离线模型目录；运行时仍以用户选择与实时 API 为权威。

### 6.3 Schema 获取与可信边界

选择模型后，Host 只读请求公开 Schema：

<code>GET https://www.modellix.ai/models/{provider}/{model}/api_schema</code>

该请求绝不发送 Authorization 或 Cookie。响应当前包含：

- <code>servers[].url</code>：模型精确提交 URL；
- <code>post.requestBody.content.application/json.schema</code>；
- examples、description、operationId 和 responses。

安全规则：

- provider/model 必须来自刚取得的鉴权 catalog，并通过严格 slug 校验，不能接受任意 URL。
- Schema origin 固定为 <code>www.modellix.ai</code>；Authorization 永远只发给 <code>api.modellix.ai</code>。
- Schema 给出的提交 URL 必须是 HTTPS、host 精确为 <code>api.modellix.ai</code>、path 与 catalog slug 匹配；不符合即阻断。
- 不盲信响应的 <code>get_result.url</code>；task poll 由已验证 task_id 构造固定官方路径。
- 对规范化请求 Schema 计算非 Secret <code>rawSchemaHash</code>，再由编译结果和 compiler/mapping/budget policy 版本计算 <code>irContractHash</code>；草稿/Job 保存二者、组成版本、model slug、读取时间和独立的 <code>endpointPolicyVersion/endpointFingerprint</code>，不保存完整 Schema 响应。
- 当前 GPT Image 2 Schema 响应为 <code>Cache-Control: no-store, must-revalidate, no-cache, private</code>，且会返回 Set-Cookie。Host 必须尊重 no-store：不做持久/TTL Schema cache，不启用 cookie jar、不保存或回传 Set-Cookie；只在当前编辑/提交校验所需的短暂内存生命周期使用响应，Job 仅保存上述身份 hash/版本和安全 endpoint 摘要。未来只有响应明确允许缓存时才采用 ETag/Last-Modified。
- 付费 submit 前重新读取当前模型 Schema并用当前 compiler/mapping/budget policy 重编译；<code>rawSchemaHash</code>、<code>irContractHash</code>、<code>endpointPolicyVersion/fingerprint</code> 任一与用户确认的草稿不同，都停止提交、迁移/显示 diff 并再次确认。catalog membership、上述合同身份、endpoint 和 effectiveInput 必须来自同一提交快照，不能被并发刷新拆开。
- Schema 获取失败时显示 docs_url 和重试，不允许退化为任意 JSON 输入框。

### 6.4 Schema 支持矩阵与参数解析

Schema 引擎暴露纯函数 <code>compileDesignSchema(openapi, modelDescriptor, capabilityMapping, budgets, compilerVersion) -&gt; DesignSchemaIR</code>，递归解析 OpenAPI 3.1 / JSON Schema 子集。<code>rawSchemaHash</code> 对规范化请求 Schema 计算；<code>irContractHash</code> 对 <code>{rawSchemaHash, compilerVersion, capabilityMappingVersion, budgetPolicyVersion, canonicalIR}</code> 计算并排除 hash 自身。Host 从实时 OpenAPI 编译版本化 IR，Client 只消费 IR 渲染表单；renderer 不得自行重解 Schema，也不能分别维护两套默认值和校验规则：

| 结构 | UI/校验 |
| --- | --- |
| string + default/description | Input 或 Textarea |
| string + enum | Select/Radio，保留原始值 |
| string + minLength/maxLength/pattern | 输入约束、帮助与错误 |
| integer/number + min/max/step | Number input/slider（只在范围合理时） |
| boolean | Switch/Checkbox |
| array + items/minItems/maxItems | 可增删列表 |
| object + properties/required | 分组递归表单 |
| nullable | 明确“未设置”状态 |
| oneOf/anyOf | 有可靠 title/discriminator 时切换分支 |
| allOf | 仅合并可证明兼容且无冲突的 object properties/required；类型、default、enum 或约束冲突即阻断 |
| local <code>$ref</code> | 解析并防循环 |
| examples/default | 一键载入示例/重置默认 |

原则：

- 编译过程为确定性纯函数；规范化排序、JSON Pointer 解码、循环检测、组合分支与 diagnostics 都有稳定输出。同一 raw Schema、model mapping、budget policy 和 compiler version 必须得到相同 <code>rawSchemaHash/irContractHash/DesignSchemaIR</code>。
- <code>DesignSchemaIR</code> 只描述字段、variant、默认值、约束、widget hint、主要输入和 unsupported diagnostics；服务器 URL/提交路径属于独立 endpoint policy，不因 UI hint 直接获得调用权限。
- Prompt/主要文本字段优先展示，常用参数在前，高级参数折叠但保持可达。
- Client 根据 Schema 即时校验，Host 使用同一规范化 Schema 再校验；Host 是最终权威。
- 未知 annotation-only keyword 可以保留用于诊断且不得影响请求；任何未知或尚未实现、可能约束合法实例集合的 assertion/applicator/content keyword 必须把模型标为 <code>visible-blocked(reason)</code> 并禁用提交，禁止当作 annotation 忽略。
- 不能无歧义解析的 oneOf/anyOf、远程 <code>$ref</code>、<code>const</code>、<code>dependentRequired/dependentSchemas</code>、<code>if/then/else</code>、<code>not</code>、<code>contains</code>、<code>uniqueItems</code>、<code>propertyNames/patternProperties</code>、<code>unevaluatedProperties/unevaluatedItems</code>、任意 additionalProperties 或未获批媒体字段，必须禁用提交并列出不支持项，除非对应关键字已进入版本化支持矩阵且 Host/Client 共用验证通过。
- 不用字段名/description 猜测文件类型作为唯一依据。媒体字段需要明确 format/contentMediaType/vendor metadata 或本仓库版本化映射。
- 对每次 Schema 变更做兼容判断：旧参数快照先迁移/重验，不能直接按旧 schema 重提。

主要输入字段不能只靠字段名猜测。Client 与 Host 共用同一个编译后的 <code>PrimaryInputDescriptor</code>，解析优先级为：

1. 公开 Schema 中明确的 vendor metadata/format/role；
2. 按 model slug/type 版本管理并通过合同测试的映射；
3. 当前激活分支中唯一、无歧义、必填且非 URL/媒体/枚举的文本字段；
4. 仍无法确定时不渲染专用 prompt 槽，按普通必填字段逐项展示并要求用户选择，不能把文本偷偷写进 <code>prompt</code>/<code>text</code>/<code>script</code> 中任意一个。

合成 fixture 必须覆盖字段不叫 prompt、多个必填字符串、嵌套字段、oneOf/anyOf/allOf 分支、转义/循环 ref、组合冲突、falsy 默认值、未知 assertion/applicator，以及文本与媒体混合的 image/video/audio Schema。代表性真实 Schema 只在合同测试中读取，记录 URL、时间、<code>rawSchemaHash/irContractHash</code> 和安全派生结论后丢弃 raw response。还必须覆盖 raw Schema 不变但 compiler/mapping/budget policy 升级导致 irContractHash 变化并使旧 proposal/history stale。切换模型后清除旧模型专属字段；同名通用字段也只有通过新 IR 校验并由用户确认后才迁移。

所有远程 Schema 先过资源预算，再进入 renderer/validator：

| 预算 | v0.1.0 上限/行为 |
| --- | --- |
| HTTP body | 2 MiB，超出阻断 |
| 递归深度 | 16 层 |
| 规范化节点 / 总 properties | 2048 / 1024 |
| 单 object properties / 最终可渲染控件 | 256 / 512 |
| enum | 单字段 500 项且合计文本 256 KiB |
| local <code>$ref</code> | 最多 64 次解析，循环立即阻断 |
| description/example | 单项 16 KiB、总计 256 KiB，展示前清理控制字符 |
| pattern | 最长 512 字符且必须通过安全正则审查；不安全/超预算 pattern 不在输入事件中执行并阻断提交 |
| array editor | 遵守 Schema maxItems；缺失或超过 UI 安全上限时最多渲染 100 项并将超限模型标为需要专用适配 |

预算违规返回稳定的 <code>MODELLIX_SCHEMA_UNSUPPORTED</code> 与具体 reason，不允许“尽量渲染”造成 Client/Host DoS。测试包含超深 object、循环 ref、巨型 enum、危险 pattern、超长 description 和并发 Schema 响应乱序。

<code>openai/gpt-image-2</code> 是首个完整 fixture：

- prompt 必填，1–32000 字符；
- quality 为 low/medium/high，默认 low；
- size 按在线 Schema 枚举，默认 1024x1024；
- 精确 submit URL 为 <code>https://api.modellix.ai/api/v1/openai/gpt-image-2</code>；
- 不支持透明背景时在描述中明确，不静默换收费模型。

### 6.5 媒体输入与 File API

输入型模型需要 API-Key File API：

- <code>POST /api/v1/media/files</code>；
- <code>GET /api/v1/media/files</code>；
- <code>DELETE /api/v1/media/files/{file_id}</code>。

每个输入型工作流必须先通过文件大小、格式、并发、保留期、CORS 和模型字段映射合同。开放后：

- 文件由 Client 选取，但 API Key 只在 Host；由 Host 上传或通过安全、短期、最小权限流程传输。
- Schema 字段最终接收 API 返回的 URL，不把本地路径或 file_id 错当模型输入。
- 上传状态、取消、失败和清理独立于生成 submit。
- 暂不支持的媒体输入模型仍在目录中可见，生成按钮 disabled 并显示具体原因。

### 6.6 对话式参数编排与参数工作区

用户选择模型后可以：

- 搜索并快速切换模型；切换前按 model slug 保存当前本地草稿。
- 左侧顶部固定模型快速选择，主体是轻量对话/状态流，底部固定 prompt/主输入和唯一“确认并生成”操作；发送一条对话只创建 proposal，不更新已接受草稿，也不等同于生成。高级参数区保持可发现但默认收起；键盘、软键盘和窄屏下必须保持主输入、错误与生成操作可达。
- 最短路径只渲染主要 prompt 和必填且无默认值的字段。例如 GPT Image 2 初始只需 prompt；quality=low、size=1024x1024 由 Schema defaults 进入请求。
- 参数摘要以 chip/短行显示当前非空默认与用户覆盖值；点击“参数”后才展开完整受支持控件，查看必填、默认、枚举、限制和说明。
- 用户可以只通过提示词完成生成，也可以精确修改 Schema 控件；二者都写入同一个受验证的 effectiveInput，不引入第二套私有请求格式。
- “重置默认值”“载入示例”“清空可选参数”。
- 在只读 JSON Preview 中检查最终规范化 body；不提供绕过表单的 JSON 编辑。
- 查看价格单位和模型文档；如果能按参数安全估价，可显示“预估”，否则明确“以最终账单为准”。
- 点击唯一主操作“确认并生成”；提交前给出紧凑的模型、预计输出类型和有效参数摘要。开关默认 on、选中模型、输入 prompt 或加载 Schema 本身绝不触发付费调用。
- 从 Results 点击“再次使用”只加载 retention policy 允许且仍存在的原 model + parameter snapshot；若 <code>irContractHash</code> 或 endpoint policy 漂移，先显示 raw Schema/compiler/mapping/budget/endpoint 差异并要求修正。metadata-only 记录不提供该操作。

每条自然语言消息走一次本地草稿编排，不直接调用 Prediction API：

~~~text
user message（显式发送；可能产生当前 Agent/Design planner 的 LLM 费用）
  -> Design-owned planner 读取：工作流、catalog 摘要、当前模型 Schema 子集、当前草稿与字段来源
  -> modellix_design_prepare（Host action 本身只读/本地，不计费 Modellix Prediction）
  -> { action, workflow?, modelSlug?, primaryPrompt?, set, unset, explicitFields, needsClarification?, explanation }
  -> Host 按实时 catalog + irContractHash + endpoint policy 严格校验
  -> Client 显示 proposed/被拒绝字段、来源、完整 diff、冲突和接受/拒绝入口
  -> 用户“确认并生成”后才提交
~~~

编排约束：

- Agent 只拿到非 Secret catalog/Schema 摘要、用户本来就在对话中的文本与非 Secret 草稿；不得拿到 API Key、Authorization 或内部下载 URL。
- 若使用 Design-owned planner，API Key 只在 Host 构造 LLM HTTP Authorization，不进入 planner prompt/tool 参数/结果；对话发送按钮附近和首次使用说明其可能产生 LLM 费用。LLM Provider 开关关闭不禁用此 Design 子能力，但 Design 开关关闭必须禁用。
- Design-owned planner 使用本仓库固定并版本化的精确 model ID，不跟随用户的公开 LLM 当前选择；单次请求只携带当前消息、必要的有界对话摘要、当前草稿和紧凑 Schema allowlist。v0.1.0 硬上限为序列化输入 64 KiB/估算 12,000 input tokens、最多 2,048 output tokens，超过即要求缩小范围或改用精确控件，不截断成可能改变语义的请求。
- Planner 只接受受 JSON Schema 约束的结构化结果，禁用 Tool calling/任意 endpoint，固定 30 秒 timeout；每次用户显式发送最多一个 LLM POST，自动 retry 为 0。所选模型必须通过 structured output、token 参数、Abort 和错误体合同测试。
- Planner 维护独立于 Design generation/catalog 的 <code>plannerHealth</code> 和单次 request lifecycle。明确客户 Key 401 才更新共享 Credential verification；402、403、429、网络和 5xx 分别更新 planner 的 billing-blocked/policy-blocked/rate-limited/offline/server-error，Design service health 不变，403 不改变 Credential；Abort/timeout 只把本次 request 标为 canceled/timed-out，plannerHealth 不变。上述状态不得把整个 Design 标成不可用：prompt-first 直接输入、Schema defaults 和精确控件仍可用，Prediction 健康与计费结果由其自己的调用独立决定。
- <code>set</code>/<code>unset</code> 只能包含当前 Schema 白名单路径；<code>unset</code> 表示恢复未设置/Schema 默认，不能用 <code>null</code> 冒充。Host 不做宽松类型强转，不接受未知字段、任意 endpoint 或 model slug；<code>needsClarification</code> 非空时不产生可提交草稿。
- Planner 返回的 <code>explicitFields</code> 是不可信的解释提示，不能作为覆盖 locked/control-explicit 字段的授权依据，也不能自行证明用户明确提到某字段。Host 只把通过 Schema/catalog 校验的值放入 proposal；涉及锁定值、精确控件值、模型切换或显著计费参数时必须形成逐字段冲突并由用户明确选择。
- 用户说“生成 16:9 高清图”“改成 5 秒竖屏视频”“换成 GPT Image 2”时，相应工作流、模型或字段只作为 proposal/diff 展示；显式接受后才应用。解释文本不能改变请求。
- 每个字段保存 <code>source</code>（schema-default/history/prompt-derived/control-explicit）、<code>interactionRevision</code>、<code>explicitlyMentioned</code> 和可选 <code>locked</code>。参数区用文字/chip 标出“默认”“根据提示词”“你已设置”，不能只靠颜色。
- Agent 的隐含推断只补充 default/unset/prompt-derived 字段，不能覆盖已锁定或 control-explicit 字段。若用户最新消息明确点名要修改一个已设置字段，显示旧值/新值冲突；用户接受该对话更新后提升 revision，最新明确用户动作生效。随后再用控件修改时，控件值再次成为最新值。
- 解析失败、未知 enum、Schema 已变化或 Agent 不可用时保留旧草稿，只显示可操作错误；绝不把未经验证的 Agent JSON 送入模型 endpoint。
- 用户可撤销单次对话补丁、逐字段恢复 Schema 默认、锁定字段不让隐含推断更新，或展开控件精确修改。
- prompt-derived 参数可能影响费用/时长，必须在确认摘要中标明；不因“智能”而隐藏模型切换、质量、时长、输出数量等变化。

每次 prepare 产生独立的 <code>DraftPatchProposal</code>，状态机固定为：

~~~text
proposed -> accepted
         -> rejected
         -> stale       # irContractHash/endpoint policy/model/draftRevision 已变化
         -> superseded  # 新一轮 proposal 取代
~~~

- 发送消息只创建 <code>proposed</code>，不修改 effectiveInput、字段 revision/source 或锁定状态。Proposal 保存 proposalId、baseDraftRevision、<code>rawSchemaHash/irContractHash</code>、compiler/mapping/budget policy 版本、<code>endpointPolicyVersion/endpointFingerprint</code>、model slug、逐字段 old/new/source hint 和 conflicts；Secret 与任意 endpoint URL 不进入记录。
- “应用变更”在 revision/irContractHash/endpointPolicyVersion/endpointFingerprint 未漂移且所有冲突已解决时原子写入 acceptedPromptDerivedPatch，并逐字段提升 revision/source；“拒绝”不改草稿。部分接受必须逐字段可见并生成新的原子 accepted patch，不能保留半应用的隐式状态。
- “应用并生成”只是一项组合确认：先显示完整 diff，原子接受 proposal，再用同一已确认 revision 进入 generate；有 unresolved conflict、stale proposal 或 Host 重验差异时按钮 disabled，不得把发送消息本身视为接受或计费确认。
- locked/control-explicit 字段只有用户在冲突 UI 中明确选择新值才可解锁/覆盖；planner 自报 explicit、解释文本或置信度都无权覆盖。测试必须包含 planner 把隐含推断伪报 explicit、覆盖 locked/control-explicit、旧 proposal 迟到、部分接受和应用并生成 exactly once。

最终请求参数采用确定性合并：

~~~text
effectiveInput = schemaDefaults
  <- acceptedPromptDerivedPatch
  <- userExplicitSelections

若用户主动选择“再次使用历史参数”：
effectiveInput = schemaDefaults
  <- compatibleHistoricalSnapshot
  <- acceptedPromptDerivedPatch
  <- userExplicitSelections
~~~

- <code>acceptedPromptDerivedPatch</code> 已经完成上述按字段 revision/冲突处理；当前用户显式值始终优先，包括显式 false、0、空数组等有效值，不能用 truthy 判断覆盖。用户后来通过对话明确修改时，先更新该字段的当前显式值/来源，再重新计算，不靠调整全局 merge 顺序偷换优先级。
- 未设置且没有 Schema default 的可选字段不进入 body，不能擅自猜值。
- required 字段没有有效值时，Client 和 Host 都阻断 submit，并把焦点移到首个错误字段。
- UI-only 状态、价格、说明、model slug、文件本地路径不得混入 input body。
- 合并后再次按当前 irContractHash 做 Host 校验，并确认 endpointPolicyVersion/fingerprint 未漂移，随后才调用经过 allowlist 校验的 endpoint。

GPT Image 2 最短路径示例：

~~~text
用户选择 GPT Image 2
  -> 左侧只要求输入 prompt
  -> 参数摘要显示 size=1024x1024、quality=low
  -> 用户直接“确认并生成”
  -> body = { prompt, size: "1024x1024", quality: "low" }

若用户展开参数并选择 quality=high：
  -> body = { prompt, size: "1024x1024", quality: "high" }
~~~

<code>primaryPrompt</code> 进入 Schema 定义的 prompt/主要文本字段；对话编排可以从自然语言提出 size、quality、duration、aspect ratio 等参数补丁，但必须显示来源、通过 Schema 校验并在付费前确认，不能在不可见状态下偷偷覆盖。

### 6.7 Tool 与 Host action 合同

动态目录不为每个模型注册硬编码 Tool，固定提供四个 namespaced Tool/Host action：

| Tool | 用途 | 计费 |
| --- | --- | --- |
| <code>modellix_design_models</code> | 搜索目录并读取选定模型的紧凑 Schema 摘要 | 只读 |
| <code>modellix_design_prepare</code> | 把 Agent/planner 提议的 workflow/model/prompt/set/unset 校验成可见草稿；不提交 Prediction | Host action 本地只读；外围 Agent turn 可能计费 |
| <code>modellix_design_generate</code> | 提交 <code>model</code> + <code>input</code>，Host 按当前 Schema 验证 | submit 计费 |
| <code>modellix_design_task</code> | 查询/恢复既有 task | 只读 |

Client Create 面板通过公开 Host actions 复用同一 catalog/schema/submit 服务。约束：

- Tool 只在 Design enabled 时暴露/执行。
- <code>prepare</code> 绝不触发 submit；<code>generate</code> 必须绑定 Harness 的显式用户确认/权限面，不能把一次聊天发送误当成付费确认。
- <code>input</code> 虽是动态 object，但绝不是任意透传；必须按 catalog 中该 model 的当前 Schema 双重验证。
- Tool/schema/result 均不含 API Key、Authorization、任意 callback URL。
- user/session ID 由 Host 注入。
- 计费前参数错误本地阻断；提交后不自动重放。
- Agent 返回的 model slug 也必须存在于当前 catalog。

### 6.8 异步任务与持久 Job Repository

各生命周期保持正交，禁止重新压回单一 job state：

~~~text
upload: not-required | idle -> uploading -> succeeded | failed | canceled
submit: draft -> local-validating -> intent-persisting -> submitting
                                           -> submitted | submit-unknown
remote: not-created -> unqueried -> pending | processing -> success | failed
                                           -> unknown-raw
poll:   idle | active | paused | timed-out
result: unavailable | available | expired | removed
diagnostic: { reasonCode, safeMessage, occurredAt }  # 不改变上面任一枚举
~~~

上传失败只影响 upload lifecycle 并阻断尚未发生的 submit；poll timeout 只把 poll 标为 timed-out，不把 remote job 改成 failed；过期只属于 result；<code>credential-mismatch/inaccessible</code> 只作为 Diagnostics reasonCode。未知远端状态保存经清理的 raw token、标为 <code>unknown-raw</code> 并停止自动状态推断，不伪装 success/failed。

当前公开 Query Task 合同只有 pending、processing、success、failed；Webhook 虽提到 canceled，但没有可验证 cancel API，因此 v0.1 不向用户承诺取消远端任务。

流程：

1. 校验 Design enabled、credential epoch、catalog membership、<code>rawSchemaHash/irContractHash</code>、endpoint policy 和参数。
2. 生成本地 clientRequestId；快照当前 retentionPolicy+revision，且只有 <code>retain-input</code> 才计算非 Secret request fingerprint。先完成容量压缩/结果 envelope 逻辑预留，再在网络调用前以原子写持久化 write-ahead intent（validated model/合同身份、credential epoch、retentionPolicy+revision、状态 <code>submitting</code>，以及策略允许的参数快照），仅用于本地关联，不假定服务端幂等。metadata-only 模式的 body 只存在本次 Host 内存，WAL 不含任何输入字段值、输入媒体 URL/文件 metadata、输入摘要或其派生 fingerprint。原子写、校验或容量预留任一失败都在此阻断，Prediction POST 次数必须为 0。
3. 对 Schema 校验后的精确 endpoint 发起且只发起一次 POST；提交开始后的 Abort、超时、断线、408、冲突、异常 5xx 或无合法 task_id 都按 outcome unknown 处理，不能重放。
4. 成功拿到并校验 task_id 后立即把同一 intent 原子升级为 RemoteJobCore；不得先创建第二条记录。
5. 进程在 POST 与 task_id 持久化之间退出时，重启后把遗留 <code>submitting</code> 标为 <code>submit-unknown</code>。除非合同测试证实 clientRequestId 已被服务端接收并可检索，否则它只能显示为“本地关联号”，不能宣称可在 Console 搜索。无服务端恢复合同只能按已验证的 request ID（如有）、账号、时间窗口和 model 引导用户核实并禁止一键重提，不能伪造已恢复。
6. 以固定 <code>GET /api/v1/tasks/{task_id}</code> 查询，使用 AbortSignal、有界退避、jitter、Retry-After 和页面不可见降频；同一 task 不重叠 poll。
7. success 在已冻结 envelope 内通过完整 ResultSegments manifest 保存全部 resources、billing 和真实 <code>result_expires_at</code>；超限先保住 core/taskId 并进入合同漂移诊断，failed 保存安全错误。
8. 本地 timeout 只暂停自动 poll，不把远端任务判 failed；用户可以在 Results 恢复。
9. Host/Web Client 重启、会话切换或 Design workspace remount 后，从 Repository 恢复 running jobs，不重新 submit。

Poller 由 Host 单实例调度，不由每个组件/Tab 各起 timer：

- 以 taskId 做 single-flight，同一任务最多一个在途 GET；全局并发默认 4，状态变化或 <code>nextPollAt</code> 明显变化时才写盘。
- Client subscription 只上报“有可见订阅者/需要即时刷新”的非 Secret hint；没有订阅者时使用持久化 backoff，不能假定 Host 天然知道页面 visibility。
- Design disabled 后完成当前已发 GET，随后暂停新的自动 poll；保留 job 和 nextPollAt，重新启用或用户明确“恢复查询”时继续，不把暂停写成取消远端任务。
- backoff attempt、lastPolledAt、nextPollAt 与服务端 Retry-After 持久化；重启时加 jitter，避免所有任务同时恢复。

Repository 的**持久 discriminated union** 固定为 <code>SubmitIntent | RemoteJobCore</code>，不能要求尚未取得远端 ID 的 intent 伪造 taskId：

- <code>SubmitIntent</code>：<code>kind=submit-intent</code>，必须有 clientRequestId、model slug/type、<code>rawSchemaHash/irContractHash</code>、compiler/mapping/budget policy 版本、endpoint policy version/fingerprint、createdAt/updatedAt、credential epoch、安全枚举 originSurface、submit lifecycle、<code>retentionPolicy=retain-input|metadata-only</code> 及其 revision；<code>taskId</code> 必须不存在，持久状态为 submitting/submit-unknown。retain-input 分支必须有 validated parameter snapshot/request fingerprint；metadata-only 分支不得出现 parameter snapshot、fingerprint、input summary 或任何动态输入字段值。
- <code>RemoteJobCore</code>：<code>kind=remote-job-core</code>，必须有合法 taskId 和上述本地关联字段，并分别保存 remote job status、poll status、result status、diagnostic、billing、resultExpiresAt、safe error 和可选 <code>committedResultManifestId</code>；它不内嵌 resources。parameter snapshot/fingerprint 仍由同一 retentionPolicy 判别，metadata-only 分支不得在升级或终态时补写输入。
- <code>RemoteJobView</code> 只是 Host 读取时由 RemoteJobCore + **已 CAS 提交**的 Result manifest/segments 组装的版本化 view，不属于持久 union。只有完整 manifest 存在且校验通过时 <code>result=available</code> 并返回完整、经验证的输出 <code>resources[]</code>；pending/写 segment/overflow 时均没有 partial resources。

Repository 使用版本化 schema、原子 replace 与校验，默认最多 1000 条/32 MiB 非媒体 metadata。<code>resultEnvelopePolicyVersion</code> 按服务端合同测试固定每类已支持模型的 <code>maxTaskResponseBytes/maxResources/maxResourceUrlBytes/maxResourceMetadataBytes/maxResultBytes/segmentBytes</code>；没有可验证上限且无法证明完整保留时，该工作流不得开放 submit。每次新 submit 先压缩 expired tombstone/超期 diagnostics，并逻辑预留一个有界 RemoteJobCore 加该工作流最大 ResultEnvelope；不足即拒绝生成且 POST=0，失败任务或移除/过期记录再释放未用预留。网络请求开始后 core 预留不得因配额被丢弃。

RemoteJobCore（至少 taskId、model、合同身份、状态、时间、diagnostic）与输出 ResultSegments 分开原子保存：资源按固定 segment 上限写入，全部 segment 校验成功后才 CAS 提交 manifest，并在同一事务/CAS 中令 <code>result=available</code>；未完成 segment 不得作为完整结果展示。**只有 RemoteJobCore 原子升级已提交之后**，segment/manifest/overflow crash 才保证 taskId/core 可恢复；POST 返回到 core 提交前的 crash 仍按步骤 5 保留无 taskId 的 submit-unknown，除非服务端合同证明可检索恢复。若服务端返回 remote=success 但违反已固定 envelope，持久化 <code>remote=success</code>、<code>result=unavailable</code>、<code>diagnostic=result-storage-overflow</code>，不展示 partial resources；同时把受影响 model/workflow 标为 <code>visible-blocked(result-envelope-drift)</code>，禁止新 submit，直到扩容或取得分页/按 task 重取合同。解析损坏时保留隔离副本并进入可恢复错误，不静默清空；迁移必须幂等。Credential epoch 变化后旧 task 查询的 403/404 标为 <code>credential-mismatch/inaccessible</code>，不得误判 expired 或新 Key invalid。

参数快照可能含 prompt、任意参数值或输入媒体 URL，应只存 Host-owned 本地插件数据，提供“清除记录”和“不要保留输入内容”的隐私选项；绝不包含 Key、文件二进制或日志化的签名 query。默认 retentionPolicy=retain-input 以支持“再次使用”。metadata-only 的持久/RPC allowlist 精确限定为：记录 kind/schema version、policy+revision、clientRequestId/合法 taskId/requestId、model slug/type、合同 hash/版本、时间、credential epoch、安全 originSurface、各正交 lifecycle/status、poll 调度、稳定 diagnostic/error code、billing、resultExpiresAt，以及经验证的**输出** resources；不得保存/返回任何输入参数值、prompt、输入媒体 URL/文件名、proposal/accepted patch、输入摘要或输入派生 fingerprint。请求 body 只驻留当前 Host 调用内存，该记录的“再次使用参数” disabled 并显示 <code>inputRetained=false</code>。四个 crash point、success、Diagnostics、Tool result、Host action RPC 与宿主会话快照都用每个动态输入字段的 sentinel 断言零输入持久化，同时明确允许合法输出 <code>resources[].url</code>。

计费与重试：

- submit 网络结果不确定时进入 <code>submit-unknown</code>，禁止自动第二次 POST。
- task GET 可对网络错误、429、500、503 有界重试。
- “停止查看”只停止本地轮询，不宣称取消远端计费任务。

### 6.9 Results 任务与未过期结果库

Results 是稳定产品入口，不依赖当前会话；右侧“任务与结果”按记录种类定义保留语义：

- 默认按最新排序，分为 Running、Succeeded、Diagnostics；支持模型、类型、状态筛选和搜索。
- Running 没有结果过期时间，始终显示到进入终态或用户移除，并持续/按需刷新；不能称为“未过期结果”。
- Succeeded 只有真实 <code>resultExpiresAt</code> 尚未到期时进入可用结果库；到期后转 Expired，不再加载资源。
- Failed、submit-unknown，以及 remote=success 但 result=unavailable 的 result-storage-overflow 进入 Diagnostics，使用本地有界保留期（默认 7 天、可立即清除）；overflow 仍保留 RemoteJobCore/taskId，不称为未过期结果，也不展示不存在或 partial 的资源。
- 对符合已冻结 result envelope 的 success，必须经完整 manifest 保留并渲染 <code>resources[]</code> 全部条目，不能假设一项或把 partial segments 当成功；envelope 漂移按上节保住 taskId/core 并进入阻塞诊断。
- 使用真实 <code>result_expires_at</code> 显示剩余时间；若旧合同缺失才显示“通常约 7 天”的降级提示。
- Expired 只保留可选最小 tombstone（taskId/model/status/过期时间，不含输入和远程资源 query），供审计或由用户清除；不得继续请求远程资源。
- 支持“刷新状态”“打开详情”“下载全部/单项”“再次使用参数”“移除本地记录”。“复制 task ID”只对 RemoteJobCore/RemoteJobView 显示；无 taskId 的 SubmitIntent 只允许复制明确标注的本地关联号，以及已验证 requestId（如有）。
- “再次使用参数”只在本地参数快照仍存在且按当前 irContractHash/endpoint policy 迁移通过时可用，只回填草稿、不自动生成；用户修改并再次点击生成才产生新计费任务。隐私模式已删除输入时该操作 disabled 并解释。
- 结果库分页或虚拟化，轮询有并发上限；不能为每条历史记录常驻 timer。
- 可提供“按 task ID 恢复”Host action，但必须以当前 Key 查询并校验返回所属权限。

Host 输出版本化记录，资源类型允许 image、video、audio、document：

~~~json
{
  "version": 1,
  "service": "design",
  "kind": "remote-job-view",
  "taskId": "task-public-id",
  "modelId": "provider/model",
  "modelType": "text-to-image",
  "rawSchemaHash": "non-secret",
  "irContractHash": "non-secret",
  "retentionPolicy": "metadata-only",
  "inputRetained": false,
  "status": "success",
  "resources": [
    {
      "url": "validated-https-url",
      "type": "image",
      "width": 1024,
      "height": 1024,
      "duration": 0,
      "size": 0,
      "format": "png",
      "role": "primary"
    }
  ],
  "resultExpiresAt": 1704153600000
}
~~~

### 6.10 左右布局、对话结果与媒体查看

首选 Harness 公开的全宽 workspace/page slot 承载双栏 Design；Tool presentation 和窄 Sidepanel/details 只承载对话摘要、单项结果详情或“打开 Design”入口：

- Design 工作区左栏保持模型/参数上下文，右栏由 Running、未过期 Results 与有界 Diagnostics 组成；选择历史项只替换右侧详情，不清空左侧草稿。
- 对话消息中仍显示紧凑任务卡：model、状态、首个 primary 预览、资源数量和“打开 Design 结果区”；只有 RemoteJobCore/RemoteJobView 才显示真实 task ID，SubmitIntent 显示明确标注的本地关联号。
- 右侧结果详情始终显示全部已完整提交的输出资源、model/合同版本、状态、billing、创建时间和真实过期时间；只有 retain-input 记录显示参数摘要，metadata-only 显示“未保留输入”，不得从 Tool/会话重新推导摘要。
- Image：可访问放大 Dialog，支持缩放/旋转、Escape 和焦点恢复。
- Video/Audio：原生 controls，默认不 autoplay，键盘和屏幕阅读器可操作。
- Document/transcript：安全文本/JSON 预览与下载，不在浏览器执行。
- Download：Host 或受信任直连执行，清理 filename、限制大小、验证 Content-Type，不携带 Key 到 Client。
- Host media proxy 必须支持受控 HEAD/GET、Range/206、Abort、重定向次数与逐项/总大小上限；签名 URL 播放中失效时显示刷新任务结果/重新获取 URL，不自动重提生成。下载全部逐项流式保存，不在内存中拼接大包。
- 多资源用列表/缩略图导航；primary 只决定首选展示，不丢 cover/thumbnail/alternative。
- 320px、200% zoom 时左右栏改为上下顺序；不丢参数、当前进度、结果列表或操作，也不产生双向滚动。
- 页面卸载清理 object URL、media listener 和 Client subscription；Host jobs 继续由 Repository 管理。

Design 主界面使用 session-scope <code>conversation.view</code> 标签页；窄 Sidepanel 只能作为结果详情或打开入口，不得替代双栏主视图。持久结果使用公开插件存储，不使用 DOM 注入或组件局部 timer 假装持久化。

### 6.11 Design 安全与隐私

- prompt、参数和生成结果可能进入 Modellix 服务与请求日志，README/Settings 需说明。
- Schema GET 不带 Key；submit/poll/file API 只在 Host 带 Key。
- 资产 URL 可能是短期签名 URL；日志和错误不得记录完整 query。
- 仅允许 HTTPS 资源；拒绝 userinfo、私网和异常 redirect。允许的媒体 origin 必须由真实资源合同测试写入版本化 allowlist。
- URL、MIME、format、type 不一致时安全失败，不能只信扩展名。
- 下载文件名去除路径、控制字符和 header injection；设置合理 Content-Disposition。
- 限制预览/下载内存，视频不预加载整文件；错误 MIME 不执行。
- CSP/CORS 不兼容时走 Host proxy，不建议用户关闭安全策略。
- 用户清除历史时删除本地参数/资源引用；远端资产删除能力未验证时要明确仅清除本地记录。

## 7. LLM 设计

### 7.1 Provider 路线

首版使用 Harness 自带 <code>llm-pi-ai</code> custom provider，并通过它拥有的 <code>llm-pi-ai</code> Settings namespace 注册 Modellix route：

| 字段 | 值 |
| --- | --- |
| Provider ID | <code>modellix</code> |
| Display name | <code>Modellix</code> |
| Base URL | <code>https://llm.modellix.ai/v1</code> |
| Protocol | <code>openai-completions</code> |
| Auth | 共享 Modellix Credential |
| Model ID | 原样 <code>provider/name</code> |
| Discovery HTTP | <code>GET https://llm.modellix.ai/v1/models</code> |
| Chat HTTP | <code>POST https://llm.modellix.ai/v1/chat/completions</code> |
| Logs HTTP | <code>GET https://llm.modellix.ai/v1/logs</code> |
| Settings namespace | <code>llm-pi-ai</code> |
| Settings route | <code>providers.modellix</code> |
| Credential reference | <code>apiKeyEnv: MODELLIX_API_KEY</code> |
| Provider retry | <code>retryPolicy: { mode: normal, maxRetries: 0 }</code> |

<code>ctx.llm.registerModelDiscovery('llm-pi-ai', ...)</code> 只返回可采纳候选，不会持久化目录。真正可调用的模型来自 <code>llm-pi-ai.providers.modellix.models</code>；插件必须读取 Modellix catalog、构造完整候选 section、通过 Settings revision/CAS 原子写入该 namespace，并等待 <code>adapters-updated</code> 后从原生模型选择器回读。任何一步失败都保留上一份可用 section，不能把“GET models 成功”误报为 Provider ready。

<code>llm-pi-ai</code> 已强制 pi-ai SDK 的内部重试为 0；本 route 还必须显式设置 provider-owned <code>retryPolicy.mode=normal</code>、<code>maxRetries=0</code>，防止 <code>dsh-llm-retry</code> 在 Agent failed-step 上额外重放付费请求。该字段不得省略。

### 7.2 一个 Key、动态目录与快速切换

- Key valid 且 LLM enabled 后调用绝对 URL <code>GET https://llm.modellix.ai/v1/models</code>。
- 远端目录至少读取并严格校验 <code>data[].id</code>，ID 必须符合已验证的 <code>provider/name</code> 形式；目录 item 中实际存在的权威描述字段可按合同读取，但不得由 ID 猜测能力。
- catalog TTL 固定 5 分钟并支持手动刷新；按 credentialEpoch 做 single-flight/request sequence，旧响应不得覆盖新 Key 或新选择。不得把模型价格硬编码为长期事实。每次刷新先校验完整新集合，再以 settings revision/CAS 原子物化；不得先删旧列表再逐项写入。
- 物化成功后等待 adapter 更新事件并从原生每 Session 模型选择器回读；失败保留上一份可用 settings，不把远端 catalog ready 误报为 route ready。
- Provider 注册成功后把同一 Key 解析能力接给整个 advertised catalog，不为 openai/anthropic/google 等模型重复创建 Provider 或重复要求 Key。
- 原生选择器按 provider 分组且选择 per-session；关键词搜索、最近使用和收藏按实际公开能力验收。原生不支持的部分放在插件 Settings/自有 picker，不能虚构原生 UI；Settings 始终提供“刷新模型”和“前往模型选择器”。
- 用户选择 model 后立即保存非 Secret model ID；下一次请求生效。切换不重启 Harness、不重写 Key、不重放当前请求。
- 如果全新 profile 没有当前模型，显示轻量选模引导；不根据当前价格或“免费”标签静默代选。
- <code>/v1/models</code> 不包含上下文、最大输出、Tool calling、多模态、价格或实际 active 状态等完整能力；settings 物化优先使用权威公开元数据。缺失字段只可使用经真实请求合同验证、写入兼容矩阵的保守 route defaults；不能验证时阻塞 LLM 发布，不虚构模型级能力。首次 404/UNKNOWN_MODEL/route unavailable 将该 Session 选择标为 stale 并刷新 catalog，不自动换模。
- catalog 刷新删除当前模型时，不自动切换收费模型；下一次请求显示明确选模错误。
- 检测到用户已有 <code>llm-pi-ai.providers.modellix</code> 时，必须比较全部 wire-affecting 配置和模型描述：base URL、协议、Credential ref、headers、compat flags、transport、timeouts、retryPolicy、models、modelOverrides 与 ownership/revision metadata。只有逐项兼容且用户显式确认时才可 CAS 采纳；否则阻断自动注册并显示字段级合并说明，不能覆盖或建立重复 Provider ID。

### 7.3 请求能力

v0.1.0 必须覆盖：

- OpenAI Chat Completions request/response；
- 非流式和 SSE 流式；
- Tool calling 与多轮 Tool result；
- usage/cached usage 映射；
- AbortSignal 与用户取消；
- 模型参数透传的 allowlist；
- 结构化错误和 Retry-After；
- 多轮 session header；
- 模型更改在下一次请求生效。
- Chat Completions POST 的 provider retry 固定为 0；网络、5xx、partial stream 和空响应均不得自动重发，只有用户显式发起新请求。

Responses API 和 Anthropic Messages 是 Modellix 已支持的协议，但插件 v0.1.0 不同时维护三种 wire protocol；除非 Harness 原生 Provider 明确需要，首版固定 Chat Completions。后续可增量扩展。

### 7.4 Header 与观测

- <code>X-Mdlx-Session-Id</code> 从 Harness session/conversation ID 确定性派生，只允许 8–128 个字母、数字、连字符和下划线。
- <code>X-Mdlx-User-Id</code> 使用同一稳定匿名派生值；Web Search/Fetch 必填，LLM/Design 只有对应公开合同允许时才发送，不能因便于关联擅自增加 header。
- 不把原始 Harness ID、用户邮箱或用户名发送给 Modellix。
- <code>GET https://llm.modellix.ai/v1/logs</code> 只在诊断和真实验收中按最小时间窗口查询；不把完整 input/result 写入插件日志。

### 7.5 LLM 失败语义

- 400：参数/协议错误，修正后重试。
- 401：仅确认客户 Key 被 Modellix 拒绝时触发共享 invalid epoch。
- 402：只标记 LLM billing-blocked。
- 404/UNKNOWN_MODEL：刷新 catalog 或提示选模，不换 Key。
- 429：LLM rate-limited；若已产生流式输出，不自动重发。
- 网络/5xx：LLM offline/server-error；不静默 fallback。
- 用户取消：终止本地 stream；不把已产生 usage 认定为未计费。

## 8. Web Tools 设计

### 8.1 原生 Provider

- 注册 Search Provider ID <code>modellix</code> 和 Fetch Provider ID <code>modellix</code>。
- 复用 Harness 原生 <code>web_search</code>/<code>web_fetch</code>；模型看到的 Tool 名与宿主保持一致。
- Web disabled 时不执行 Modellix Provider；若当前选择属于插件，撤销或提示选择，不覆盖其他 Provider。
- 首版直接调用 REST，不通过 Remote MCP。

### 8.2 Web Search 映射

Modellix：

- <code>POST https://tool.modellix.ai/v1/web-search</code>
- 必填 <code>X-Mdlx-User-Id</code>，8–128 位并匹配 <code>^[A-Za-z0-9_-]+$</code>。
- body 至少包含 <code>query</code>，可包含 <code>depth</code>、<code>max_results</code>、<code>include_domains</code>、<code>exclude_domains</code>、<code>time_range</code>、<code>start_date</code>、<code>end_date</code>、<code>topic</code>、<code>country</code>、<code>include_answer</code>。

适配规则：

- Harness 一个原生 Tool call 中的多个 query 按原顺序拆为多次 Modellix 请求。
- 每个 query 是独立计费单元；UI/README 明确成本语义。
- <code>max_results</code> 限制 1–20；本地校验空白 query、domain 数量、日期顺序和 country。
- 默认 depth 为 standard，除非 Harness/provider settings 明确选择 lite/rich。
- lite 模式强制 <code>include_answer=false</code>。
- 结果映射 title、url、content/summary、score、published_at、favicon；未知字段不透传到模型。
- 一个 Tool call 关联一个 <code>toolCallId</code> 和多个 Modellix request IDs；支持部分 query 失败并保持顺序。
- Search POST 不透明重试；网络未知时显示 request correlation 和日志查询指引。

### 8.3 Web Fetch 映射

Modellix：

- <code>POST https://tool.modellix.ai/v1/web-fetch</code>
- 同样必填 <code>X-Mdlx-User-Id</code>，使用与 Search 相同的稳定匿名派生值和格式校验。
- URL 1–20 个，仅 http/https，禁止 userinfo。
- HTTP 200 仍可能包含 <code>failed_results</code>，并可能全部 URL 失败。

适配规则：

- 本地验证 scheme、userinfo、数量和规范化；服务端继续负责 SSRF 防护。
- 保持输入 URL 顺序，将 results 与 failed_results 合并为逐 URL 结果。
- 部分失败不是整个 Tool transport 失败；所有 URL 失败必须返回结构化可理解错误。
- amount_usd 与 success_count 只用于诊断/展示，不进入模型无关上下文。
- Fetch POST 不自动重试。
- 不伪造每页 statusCode 或 truncated。若 Harness 合同必须要求非空权威值：
  1. 优先推动 Modellix 后端补字段；
  2. 若 Harness 明确允许 unavailable/null，使用显式缺失；
  3. 只有 Harness 文档定义固定适配值时才使用，并在用户文档说明。

### 8.4 Web 错误

- 400：本地/服务端参数错误。
- 401：共享 Credential invalid。
- 402：Web billing-blocked。
- 429：Web rate-limited。
- 503/504：Web server-error/timeout。
- 错误 result 携带稳定插件码、service、requestId 和 retryable，不通过文案匹配触发 Modal。

## 9. 共享 HTTP、错误与重试策略

### 9.1 固定 origin

Host allowlist：

- <code>https://api.modellix.ai</code>
- <code>https://llm.modellix.ai</code>
- <code>https://tool.modellix.ai</code>
- <code>https://www.modellix.ai</code> 仅允许模型 Schema GET，绝不附带 Authorization
- 由真实资源合同测试固定并版本化的媒体 CDN/file origin

Authorization 不随跨 origin redirect 发送。请求日志必须删除 Authorization、Cookie、Secret query、完整媒体签名 query。

### 9.2 稳定错误合同

~~~json
{
  "version": 1,
  "service": "design|llm|web",
  "subsystem": "credential|catalog|planner|generation|llm-provider|web-provider",
  "operation": "validate|prepare|submit|poll|chat|search|fetch",
  "code": "MODELLIX_API_KEY_INVALID",
  "httpStatus": 401,
  "retryable": false,
  "credentialEpoch": 1,
  "requestId": "non-secret-or-null",
  "taskId": "non-secret-or-null",
  "messageKey": "i18n-key"
}
~~~

稳定码至少包括：

| HTTP/事件 | 稳定码 | Credential 影响 | Service health |
| --- | --- | --- | --- |
| 候选 validate 200/false | <code>MODELLIX_CANDIDATE_KEY_INVALID</code> | 不写入、不污染旧值 | 不变 |
| 运行时 401 | <code>MODELLIX_API_KEY_INVALID</code> | 当前 epoch verification=invalid | 不变；由 Credential invalid gate 阻断已启用服务 |
| 402 | <code>MODELLIX_BILLING_BLOCKED</code> | 不变 | billing-blocked |
| 403 | <code>MODELLIX_POLICY_BLOCKED</code> | 不变，除非官方机器码另有明确合同 | policy-blocked |
| 404 model/task | <code>MODELLIX_RESOURCE_NOT_FOUND</code> | 不变 | 不变；刷新对应目录或更新 job/result |
| 429 | <code>MODELLIX_RATE_LIMITED</code> | 不变 | rate-limited |
| Abort | <code>MODELLIX_CANCELED</code> | 不变 | 不变 |
| 网络 | <code>MODELLIX_OFFLINE</code> | 不变 | offline |
| 5xx | <code>MODELLIX_SERVER_ERROR</code> | 不变 | server-error |
| submit 未知 | <code>MODELLIX_SUBMIT_UNKNOWN</code> | 不变 | 不变；Design submit lifecycle=<code>submit-unknown</code> |
| 资产过期 | <code>MODELLIX_ASSET_EXPIRED</code> | 不变 | 不变；Design result=<code>expired</code> |

错误对象必须携带稳定的 <code>service/subsystem/operation</code>，上表的 Service health 默认指所属顶层服务；Design planner 使用以下覆盖，防止一次参数解释失败污染仍可生成的 Design：

| Planner 事件 | Credential | Design service health | plannerHealth | request lifecycle |
| --- | --- | --- | --- | --- |
| 明确客户 Key 401 | 当前 epoch verification=invalid | 不变；由 Credential gate 阻断 | 不变 | failed |
| 402 | 不变 | 不变 | billing-blocked | failed |
| 403 | 不变 | 不变 | policy-blocked | failed |
| 429 | 不变 | 不变 | rate-limited | failed |
| 网络/5xx | 不变 | 不变 | offline/server-error | failed |
| Abort | 不变 | 不变 | 不变 | canceled |
| 30s timeout | 不变 | 不变 | 不变 | timed-out |

### 9.3 重试矩阵

| 操作 | 自动重试 |
| --- | --- |
| Key validate GET | 可，有界 2 次；用户仍能手动重试 |
| LLM models/logs GET | 可，有界退避 |
| Design task GET | 可，遵守 Retry-After 和总时限 |
| Web Search POST | 否 |
| Web Fetch POST | 否 |
| Design submit POST | 否 |
| LLM POST 未收到任何 body | 否；用户显式重新发送才创建新请求 |
| LLM 已有流式输出 | 绝不自动重发 |

## 10. UI、可访问性与视觉

### 10.1 Settings 信息架构

设置页只有一个顶层 Modellix 卡，避免三个卡重复 Credential：

1. 顶部：Modellix 状态、共享 API Key descriptor、指向 <code>https://www.modellix.ai/console/api-key</code> 的创建 Key 外链、更换/移除。
2. Services 区：Design、LLM 模型、Web Tools 三行 Switch，每行有说明和独立 health；Design 行另显示 plannerHealth，LLM 模型行明确只控制 Harness Provider。
3. Design 展开区：catalog/Schema 状态、最近模型、打开左右工作区、资产保留提示，以及默认开启的“保留输入用于再次使用”偏好；关闭后明确“只影响新任务、输出资源仍保留、现有输入需另行清除”，保存时 CAS 更新 retentionPolicyRevision。
4. LLM 展开区：catalog 状态、当前/最近模型、刷新模型和打开原生模型选择器。
5. Web 展开区：depth、max results 等非 Secret设置。
6. 诊断区：非 Secret request/task ID 和文档链接；不显示 Secret 派生值。

同一视图只保留一个实心主操作。Settings 卡无装饰阴影，完全使用 Harness semantic tokens。

### 10.2 Onboarding Modal

- 复用公开 Harness Modal，最大宽约 600px，距 viewport 至少 24px。
- API Key 输入置于三个开关之前，建立“一个 Key 支持三项能力”的层级。
- 每个 Switch 有可见 label、简短说明和默认 on 状态，不能只靠颜色。
- 保存按钮文案随操作变化：“验证并保存”“正在验证…”“正在保存…”。
- 显示/隐藏只控制未保存草稿。
- 强制 missing/invalid gate 不允许 Escape、遮罩、X 隐式关闭，但必须有“稍后处理”。
- 显式实现初始焦点、Tab/Shift+Tab trap、背景 inert 和焦点恢复；通过 DOM 与 accessibility tree 断言 Modal 自身未被 inert。

### 10.3 响应式与主题

- 浅色、深色、forced-colors、reduced-motion。
- 320/560/768/1440px，200% 文本缩放。
- 普通 pointer target 至少 24x24 CSS px；粗指针/触控达到 48x48px。
- 窄屏仍使用同一个响应式 Modal，不虚构未公开 Sheet primitive。
- URL、模型 ID、task ID 和最长中英文文案可换行，不隐藏关键操作。

### 10.4 Live region

- 验证、保存、轮询进度：<code>role=status</code>、polite。
- 不可恢复提交失败：精简 <code>role=alert</code>，按钮不放进 alert 容器。
- Design pending/processing 不反复播报每次 poll，只播报有意义状态变化。
- 媒体完成时播报类型和数量，不朗读完整签名 URL。

## 11. 观测、关联与日志

### 11.1 ID 规范

- 内部统一使用 <code>toolCallId</code>；若 Harness lifecycle 字段名是 <code>callId</code>，入口处仅做一次映射。
- <code>mdlxUserId</code>：从 Harness 稳定 anonymous ID 确定性派生，移除非法字符并加产品前缀；不单独生成/persist UUID。
- <code>mdlxSessionId</code>：从会话 ID 派生，满足 8–128 字符规则。
- <code>requestId</code>：Modellix Web/LLM 返回的请求 ID。
- <code>taskId</code>：Design 异步任务 ID。
- Search 一个 toolCall 对多个 request IDs，存有序数组。

### 11.2 结构化日志

允许：

- service、operation、status、duration、retry count；
- toolCallId、requestId、taskId；
- model ID、资源类型和数量；
- Credential epoch；
- 用户主动启停和 ownership 恢复结果。

禁止：

- Authorization、API Key 及任何掩码/长度/哈希；
- prompt 正文、聊天正文、完整响应正文；
- 完整签名媒体 URL/query；
- 用户邮箱、用户名、原始稳定标识；
- Credential 文件路径和内容。

### 11.3 诊断

- Web：按 request IDs 查询日志，支持 Search 1:N。
- LLM：最小时间窗口调用 <code>GET https://llm.modellix.ai/v1/logs</code>，核对 model、usage、cost 和 status。
- Design：使用 task ID 查询结果/日志，不因为本地 timeout 重提任务。
- 网络未知结果的 UI 给出安全 task/request ID 和“查询日志/恢复任务”入口，不鼓励盲目重试。

## 12. 模块边界

| 模块 | 职责 | 依赖约束 |
| --- | --- | --- |
| package/config | bundle/client 入口、非 Secret schema/default/migration、精确依赖和发布 allowlist | 不包含运行时状态或 Secret |
| core | Credential/epoch、服务注册、HTTP、错误、身份、关联、redaction | 不依赖 Client 或具体服务 |
| Web | Search/Fetch Provider 与合同映射 | 只依赖 core |
| LLM | catalog、<code>llm-pi-ai</code> namespace materializer、route/session ownership | 只依赖 core 和 Harness 公开 LLM/Settings seam |
| Design Host | catalog、Schema compiler/IR、primary input、proposal、endpoint policy、submit/WAL、Repository、poller、resources | 只依赖 core；付费与只读路径分离 |
| Client | onboarding/Settings/Modal、<code>conversation.view</code> Design 标签页、Schema form、Results、media viewer | 只通过公开 Host RPC/actions 和 Harness slots 通信 |
| tests/scripts | unit/contract/integration/browser/security fixtures、package/secret/fresh-install verification | fixture 不进入 tarball |

边界规则：

- 三个 service adapter 共享 core，但不得相互 import。
- Schema compiler/IR 是 Host 与 Client 共用的框架无关模块；renderer 不重新解释 raw Schema。
- 不为模型堆巨型 switch，不把未经 Host 验证的 Schema 或 planner 输出直接变成网络请求。
- Client RPC、Tool、Host action、slot entry 和持久记录都使用插件唯一 namespace。
- package 使用 <code>files</code> allowlist，测试 fixture、raw Schema、日志与本地路径不得进入发布制品。

## 13. 实施顺序

以下顺序只表达实现依赖：

| 顺序 | 交付内容 | 前置依赖 | 可观测退出条件 |
| --- | --- | --- | --- |
| 1 | package/bundle/client 最小入口；配置迁移；Credential Broker；credentialEpoch；共享 HTTP/error/identity | 无 | 固定 DSH profile 可加载；Credential resolve/describe/set/unset、saving recovery、Secret sentinel contract 通过 |
| 2 | onboarding、Settings、三个默认开启的开关、可信对话入口、Modal arbiter、invalid epoch | 1 | 三开关 8 组合、候选 Key、保存中断恢复、并发/迟到 401 和 a11y contract 通过 |
| 3 | Web Search/Fetch Provider | 1–2 | 原生 Tool mock/real E2E 通过，模型侧没有重复 Tool |
| 4 | <code>llm-pi-ai</code> 的 Modellix route、动态目录物化、route ownership、逐 Session 选模 | 1–2 | namespace CAS、两个 Session/两个模型、stream/tool/usage/Abort、provider retry=0 通过 |
| 5 | Design Host：catalog、Schema IR、proposal、endpoint policy、write-ahead、Repository、poller | 1–2 | Schema/hash/budget、exactly-once submit、crash/reload、metadata-only sentinel 与完整 manifest contract 通过 |
| 6 | Design Client：<code>conversation.view</code> 双栏视图、planner 对话、参数 diff、表单、结果库、媒体查看 | 5 | message→proposal→accept→generate、桌面/窄屏、键盘/a11y/media/security 通过 |
| 7 | 跨能力状态、主题、响应式、i18n、性能、升级与卸载硬化 | 3–6 | 自动化、浏览器和真实 E2E 矩阵通过 |
| 8 | build、pack、tarball 校验、fresh install 与文档 | 7 | 发布制品门禁全部通过 |

## 14. 验收测试

### 14.1 单元测试

- 配置 defaults/migration 与三开关 8 组合。
- stable user/session ID 派生与非法字符。
- Credential descriptor、插件 epoch、reference-updated、进程内串行 set/unset 与 onboarding saving 恢复。
- 候选 validate true/false、运行时 401、stale 401、invalid epoch。
- HTTP origin allowlist、redirect、redaction、Retry-After。
- Web Search 多 query 聚合、1:N request IDs、部分失败。
- Web Fetch URL 验证、顺序、部分/全部失败。
- LLM advertised catalog、descriptor 的权威/保守/adapter 三路政策、settings CAS 原子物化、两个 Session 快速切换、现有 route 全 wire config 采纳/冲突、字段级 ownership ledger、逐 Session ownership 恢复、stream event、Tool call、usage 和 POST attempt=1；覆盖刷新保留手工 model/unknown field、用户漂移后停止清理、采纳 route 卸载不整删；搜索/最近/收藏按实际 UI 能力分层测试。
- Design all/Featured catalog 搜索/筛选/5 分钟 cache/single-flight/乱序响应、宽容 type 与全 catalog census；Schema no-store/cookie、rawSchemaHash/irContractHash、endpoint policy、未知 keyword 与资源预算。
- Schema compiler 的确定性 IR/hash、JSON Pointer 转义/循环、defaults/required/enum/nested/array、oneOf/anyOf 显式选支、allOf 冲突、primary input descriptor、用户覆盖和 false/0/空字符串/空数组/未设置语义；字段不叫 prompt、多个必填字符串、嵌套/分支 Schema；未知 assertion/applicator 必须阻断，并覆盖 raw Schema 不变而 compiler/mapping/budget 版本变化的 stale/migration。
- 默认路由表驱动测试：显式 slug > 兼容历史/当前选择 > 工作流默认；默认下线、type 漂移、Schema 不支持均阻断，不静默换模。
- 中文 Design proposal/intent patch 覆盖“改成横屏”“5 秒”“高清”“换模型”“恢复默认”“仅改提示词”、冲突指令、unset、幻觉字段、Schema 注入与模型下架；覆盖 proposed→accepted/rejected/stale/superseded、部分接受、迟到 proposal、伪 explicit 和 locked/control-explicit 越权。Fallback planner 覆盖固定 model、输入/输出预算、结构化输出、tools disabled、timeout/Abort、明确客户 Key 401→共享 verification、402/403/429/5xx→独立 plannerHealth、Abort/timeout→request lifecycle、0 retry。
- Design Job Repository 的 <code>SubmitIntent | RemoteJobCore</code> 持久 union、retentionPolicy+revision、schema migration、容量/compaction/损坏恢复、write-ahead 四个 crash point、跨会话恢复、完整 output resources[]、真实过期、poll backoff、submit-unknown；冻结 result envelope 后覆盖预留失败 POST=0、RemoteJobCore/ResultSegments 原子 manifest、oversized multi-resource 和 crash/capacity。断言 pre-core crash 为无 taskId submit-unknown，post-core crash 保住 taskId，只有完整 manifest 才组装 RemoteJobView/result=available，partial 不冒充完整。Metadata-only 用每个动态输入字段 sentinel 覆盖四 crash point、success、Diagnostics、Tool result、Host action RPC 和宿主会话，断言输入值/输入媒体 URL/input fingerprint 零落盘/RPC，同时允许合法输出 resource URL。对 upload/submit/remote/poll/result/diagnostic 做正交状态组合测试，确保 poll timeout、result expired、credential mismatch 不改写远端 job 事实。
- media URL/MIME/filename/size validation。
- i18n key 完整性。

### 14.2 Contract 测试

使用 mock server 覆盖：

- Credential validate 200 true、200 false、500、timeout。
- Web 400/401/402/429/503/504 与 200 部分失败。
- LLM model list→descriptor policy→settings→adapter、两个 Session 快速切换、existing route 全字段 conflict、inactive/404 stale、JSON、SSE、Tool call、partial stream error、401/402/404/429/5xx 与每次 POST 计数。
- Design active/Featured models、8 种 live type/未知 type、公开 api_schema（无 Authorization/无 cookie 回传/尊重 no-store）、GPT Image 2 与不同 image/video/TTS/input-media/oneOf/anyOf/allOf 合成 schema fixtures；断言 raw Schema 不持久化、编译 IR 可重现、endpoint policy 不由 renderer 绕过。
- Design 正交状态合同：submit lifecycle 的 submit-unknown；remote job 的 pending/processing/success/failed/unknown-raw；poll 的 timed-out；result 的 available/expired；以及 429、完整多资源、oversized envelope 与资源异常。覆盖 write-ahead/idempotency-correlation 合同；canceled 只作为未来/异常远端值兼容，不伪装公开 cancel 能力。
- 同一个 Key 对 api/llm/tool 三个 API host 的 auth header 构造；www schema origin 明确断言无 Authorization。
- 所有响应 fixture 进行未知字段和缺字段测试。

### 14.3 Host/Client 集成

- Host action 返回 descriptor，不返回 Secret。
- onboarding、Settings、conversation、401 同时请求 Modal 时只开一个。
- 切换开关后 Host service registry 与 Client UI 同步，无刷新。
- LLM 一个 Key 把 advertised catalog 原子物化；两个 Session 连续切换模型不要求重新输入 Key，selection/route ownership 不覆盖用户后来选择或手工配置，刷新/关闭/卸载按 ledger 做字段级 CAS；route retry 显式为零。
- 左栏使用 Design-owned Modellix planner（同一 Key、独立于 LLM Provider 开关、费用披露、0 retry）完成 message→proposal→diff→accept→generate exactly once。发送消息不改 effectiveInput，stale/unresolved proposal 不可生成；planner 失败时 prompt-only 和精确控件仍可用。
- Design 左侧 provenance/effectiveInput 与 Host body 完全一致；右侧切换结果不清空左侧草稿，切模只迁移经新 Schema 校验且确认的字段。
- Design write-ahead/task/参数/结果在会话切换和 Client 重载后恢复，不重复 submit；过期记录不再加载远程资源，failed/submit-unknown 按有界 diagnostics 管理。
- Client 卸载清理 subscription、poll、object URL 和 focus state。

### 14.4 浏览器与无障碍

执行浏览器任务前必须先使用 <code>browser-automation-router</code>，检查并复用已有服务和 Chrome Tab。

浏览器矩阵：

- 浅色、深色、forced-colors。
- 320、560、768、1440px。
- 100% 与 200% 文本缩放。
- keyboard-only 正向/反向 Tab、Escape 例外、focus restore。
- onboarding、Settings、conversation setup、401 replace。
- Design 桌面左右布局、窄屏上下布局、proposal diff/接受/拒绝/来源/撤销、prompt-only GPT Image 2、展开参数、用户覆盖默认、任务/结果库、核心 T2I/T2V/TTS 与通用 document 安全兼容、放大、播放、下载、过期；I2I/I2V/V2V/STT/STS 仅在各自合同测试通过后加入真实流程。
- LLM 一个 Key、model discovery、搜索/快速切换、stream/cancel。
- Web 原生 Tool 展示与 console/network。
- reduced-motion 与 coarse pointer 48px。

检查：

- accessibility tree 的 Dialog 名称、label、description、invalid、busy、live region。
- Modal 打开时背景不可聚焦，Modal 自身不被 inert。
- 控制台无错误，网络没有重复付费 submit。
- 截图只使用假 Key或空 password；真实 Secret 场景不截图 Network、不导出 HAR、不录像。

### 14.5 Secret sentinel

使用合成 sentinel，不使用真实 Key，扫描：

- DOM/ARIA、Session、Tool args/result、模型上下文；
- localStorage/sessionStorage/Settings 文档；
- Console、Host logs、errors、Toast、telemetry；
- RPC request/response、test snapshot、browser trace；
- build output、source map、tarball。

任何一处出现 sentinel 即为 release blocker。

### 14.6 真实 API 与 Agent E2E

真实 Key 仅由验收进程直接读取文件或注入环境变量，不进入命令参数和输出。

按由低到高成本执行：

1. Key validate，无费用。
2. LLM model list，无费用读取。
3. Design/Web/LLM request log 最小查询，无费用读取。
4. 以发布候选代码重新执行无费用全 Design catalog census：限制并发/退避，扫描前后 catalog hash 一致；归档时间、catalog hash、总数、每类计数和 supported/blocked/schema-unavailable 分类报告（不持久化 no-store raw Schema），并确认 schema 请求没有 Authorization。随后在线读取 GPT Image 2 public schema 做合同校验，只归档时间/rawSchemaHash/irContractHash/endpoint policy 身份与安全派生结论并丢弃 raw response。
5. Web Search lite 一次与 Fetch 一个 URL。
6. LLM model A 一次短非流式/Tool calling、model B 一次短流式，验证同 Key 快速切换。
7. GPT Image 2 仅 prompt + 默认参数一次，再用用户覆盖参数做 mock 验证，避免无必要重复计费。
8. 从实时 catalog 选取已开放 video/TTS 模型各一次最低允许成本，并验证其动态 Schema；I2I/I2V/V2V/STT/STS 仅在对应合同测试通过时各做一次最低成本 E2E。
9. Agent 完整回合：Modellix LLM 调用 Web Tool 与 Design Tool，并正确呈现结果。

任何真实计费 E2E 都必须记录非 Secret request/task ID、模型、时间和预期上限，禁止自动重跑。

## 15. 需求追踪矩阵

| Requirement | 自动化 | 浏览器/真实证据 | 发布阻塞 |
| --- | --- | --- | --- |
| AUTH-01/02 | Credential + onboarding contract | 首次 Modal、默认三开关 | 是 |
| AUTH-03/04 | Modal arbiter、action tests | Settings/对话/401 去重 | 是 |
| CFG-01 | 8 组合参数化测试 | runtime toggles | 是 |
| WEB-01/02 | provider contract | 原生 Tool real E2E | 是 |
| LLM-01/02 | catalog/两模型切换/stream/tool/usage | 一个 Key + model picker + Agent | 是 |
| DSG-01/02 | catalog/schema engine/default merge | 搜索模型 + prompt-first/高级参数 | 是 |
| DSG-03/04 | exact endpoint/task fixtures | real image/video/audio | 是 |
| DSG-05/06 | layout/effectiveInput tests | 桌面左右 + 窄屏上下 + prompt-only | 是 |
| DSG-07/08 | 默认路由/intent patch/provenance/planner 子健康表驱动测试 | 自然语言改参数→可见 diff→确认一次生成；planner 失败时精确表单仍可用 | 是 |
| MEDIA-01/02 | media security/job repository | 结果库/enlarge/play/download/expired/reload | 是 |
| OPS-01 | health/revision matrix | 401/402/429/offline | 是 |
| OBS-01 | correlation/redaction | logs by request/task | 是 |
| REL-01 | pack/fresh install scripts | clean profile | 是 |

## 16. 构建与发布制品

### 16.1 本地/CI 命令门禁

最终 package scripts 至少提供：

- format check
- typecheck
- lint
- unit
- contract
- integration
- browser
- build
- pack
- verify tarball
- fresh install
- secret scan

小范围修改优先执行目标文件检查、局部 type/lint、组件测试和必要的真实浏览器验证；依赖、入口、bundle、公共类型或发布制品变化必须执行完整 build。

### 16.2 Tarball

- package <code>files</code> allowlist。
- 检查 package name/version/repository/homepage/bugs/packageManager。
- 检查 <code>dsh.bundle</code> 与 <code>dsh.client</code> 指向真实文件。
- 扫描真实/合成 Secret、绝对文件系统路径、测试 fixture、source map。
- 生成版本化 tarball 和稳定别名 <code>dsh-modellix.tgz</code>，并发布 checksum。
- 在空白 <code>DSH_HOME</code> 安装、重启、加载 Client、完成三能力 fresh-install E2E。

### 16.3 README

至少包含：

- 三能力概览和三个默认 on 开关。
- 安装、重启与卸载。
- Key write-only、安全与环境变量来源。
- onboarding、Settings 和对话配置入口。
- LLM 一个 Key、动态目录、快速模型切换与恢复语义。
- Design 左右工作区、自然语言参数 diff/确认、prompt-first、动态 Schema、参数默认/提示词/精确覆盖、Running/Diagnostics/未过期结果库、下载。
- Web Search/Fetch 计费与不自动重试。
- 故障排查与非 Secret request/task ID。
- 数据/隐私说明。
- 兼容矩阵和已知限制。

## 17. 权威资料

- [TAPD 需求](https://www.tapd.cn/tapd_fe/47183901/story/detail/1147183901001091455)
- [Modellix Set Up AI Agents](https://docs.modellix.ai/get-started)
- [Modellix media REST API](https://docs.modellix.ai/ways-to-use/api)
- [Modellix active models](https://docs.modellix.ai/api/list-models)
- [Modellix task result](https://docs.modellix.ai/api/get-task-result)
- [GPT Image 2 public API schema](https://www.modellix.ai/models/openai/gpt-image-2/api_schema)
- [Modellix GPT Image 2](https://www.modellix.ai/zh_CN/models/openai/gpt-image-2)
- [Modellix Validate API Key](https://docs.modellix.ai/api/validate-api-key)
- [Modellix LLM Overview](https://docs.modellix.ai/llm/overview)
- [Modellix LLM API](https://docs.modellix.ai/llm/api/api)
- [Modellix LLM for DeepSeek Harness](https://docs.modellix.ai/llm/agent/deepseek-harness)
- [Modellix Web Search](https://docs.modellix.ai/api/web-search)
- [Modellix Web Fetch](https://docs.modellix.ai/api/web-fetch)
- [DeepSeek Harness UI primitives](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-primitives/README.md)
- [DeepSeek Harness Settings Card Cookbook](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [WAI-ARIA Modal Dialog Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
