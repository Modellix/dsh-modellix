# dsh-modellix 本地使用指南

[English](../en-US/LOCAL_USAGE.md) | 简体中文

本文说明如何在 Windows 上从当前源码构建 `dsh-modellix`，安装到独立的 DeepSeek Harness Web Profile，并在本机使用 Design、LLM 和 Web 功能。独立 Profile 可以避免影响已有 Harness 配置。

## 1. 准备环境

需要：

- DeepSeek Harness `0.1.1-rc.2`
- Node.js `24.18.1`；运行已发布包也支持 `^22.19.0`
- pnpm `11.24.0`
- 有效的 Modellix API Key
- 若全新 Harness Profile 先要求初始化官方模型，还需要 DeepSeek API Key

在 PowerShell 中检查当前环境：

```powershell
node --version
pnpm --version
dsh --version
```

本机安装了 NVM 时，可以按项目固定版本切换：

```powershell
nvm use 24.18.1
node --version
pnpm --version
```

## 2. 从当前源码构建 tarball

进入仓库并安装锁文件指定的依赖：

```powershell
Set-Location 'D:\work\maas\githup\dsh-modellix'
pnpm install --frozen-lockfile
pnpm run verify:env
pnpm run verify:pack
pnpm pack
```

完成后，仓库根目录会生成类似 `dsh-modellix-0.1.1.tgz` 的文件。不要直接把未构建的 TypeScript 源码交给 DSH 安装。

## 3. 创建独立的本地 Harness 环境

推荐在当前 PowerShell 会话中指定独立 `DSH_HOME`：

```powershell
$env:DSH_HOME = 'D:\work\maas\.dsh-modellix-local'
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
```

这个设置只影响当前 PowerShell 及其子进程。若希望安装到已有 Harness 环境，可省略本步骤；执行前应确认当前 `DSH_HOME` 和目标 Profile。

## 4. 安装插件

把刚生成的 tarball 安装到 `web` Profile：

```powershell
dsh plugin --profile web add .\dsh-modellix-0.1.1.tgz
dsh --profile web --dump-config
```

合并配置中应出现 `dsh-modellix` Bundle 层和 id 为 `modellix` 的插件。若实际文件版本不同，请使用 `pnpm pack` 输出的文件名。

## 5. 准备 Key

### 推荐：在 UI 中保存 Modellix Key

启动 Harness 后，在“连接 Modellix”弹窗输入 Key。Key 会交给本机 Harness Credential 服务保存，保存后浏览器只显示配置状态，不会回显已存值。

`modellix-cli` 的 Keychain 与 Harness Credential 是两个独立存储。即使 `modellix-cli auth status` 显示已登录，插件也不会自动读取 CLI Keychain。

### 可选：通过受控文件注入启动环境

如果 Key 保存在仓库外、内容只有 Key 本身的受控文件中，可由 PowerShell 直接读取到进程环境。不要把真实值写进命令、脚本或仓库：

```powershell
$env:DEEPSEEK_API_KEY = (Get-Content -LiteralPath 'D:\secrets\deepseek-key.txt' -Raw).Trim()
$env:MODELLIX_API_KEY = (Get-Content -LiteralPath 'D:\secrets\modellix-key.txt' -Raw).Trim()
```

环境来源的 Modellix Key 在 UI 中只读。更换文件内容后，需要停止并重新启动 Harness。只需 UI Credential 时，不设置 `MODELLIX_API_KEY`。

## 6. 启动本地 Web UI

```powershell
dsh --profile web --no-open
```

终端会打印实际地址，例如 `http://127.0.0.1:3080`。用浏览器打开终端显示的地址，不要假定端口固定。

全新 Profile 可能先显示 Harness 自带的 DeepSeek 初始化弹窗。完成或按需处理该步骤后，插件会显示“连接 Modellix”弹窗：

1. 输入 Modellix API Key；若使用 `MODELLIX_API_KEY`，页面只显示环境来源状态。
2. 检查 Design、LLM、Web 三个开关；首次安装默认全部开启。
3. 选择“保存并启用”。

## 7. 使用 Design

1. 打开会话顶部的 **Design** 标签。
2. 搜索或按图片、视频、音频筛选模型。
3. 选择模型并输入 prompt。很多模型只需要 prompt，其余字段会按实时 Schema 填入默认值。
4. 需要精准控制时，直接修改页面列出的尺寸、质量、时长、比例等参数。
5. 也可以在“用对话调整参数”中描述修改，检查提议差异后再应用。该步骤可能产生 LLM 用量，但不会自动提交媒体生成。
6. 检查参数和计费提示，只点击一次“确认并生成”。
7. 在右侧结果区查看进行中、已完成和诊断记录；完成后可预览或下载媒体。

生成请求可能计费。插件不会自动重试计费 POST；若页面提示“提交结果未知”，应先检查结果列表或 Modellix 侧记录，不要立即重复提交。

## 8. 使用 Modellix LLM

1. 打开“设置 → Modellix”，确认 LLM 开关已开启且模型目录正常。
2. 回到会话，在模型选择器中展开 Modellix Provider。
3. 选择所需模型后发送消息。模型切换从下一次调用生效。

目录来自 Modellix 实时接口；目录不可用时，插件不会显示虚构的备用模型。

## 9. 使用 Web Search/Fetch

确认 Web 开关开启后，在对话中明确要求 Agent 搜索公开网页并读取需要的结果。Harness 原生 `web_search` 和 `web_fetch` 会使用 Modellix Provider，页面不会出现一套重复的自定义工具。

## 10. 更新本地插件

源码变化后：

1. 在运行 Harness 的终端按 `Ctrl+C` 停止当前 Profile。
2. 回到仓库重新执行构建、打包和安装。
3. 重新启动 Web Profile。仅刷新浏览器不足以加载新的 Client Bundle。

```powershell
Set-Location 'D:\work\maas\githup\dsh-modellix'
pnpm run verify:pack
pnpm pack
dsh plugin --profile web add .\dsh-modellix-0.1.1.tgz
dsh --profile web --dump-config
dsh --profile web --no-open
```

## 11. 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 先出现 DeepSeek API Key 弹窗 | 这是全新 Harness Profile 的基础初始化，不是 Modellix 弹窗；完成后继续配置 Modellix |
| `modellix-cli` 已登录但插件仍要求 Key | CLI Keychain 与 Harness Credential 相互独立；在插件 UI 保存，或给 Harness 启动进程设置 `MODELLIX_API_KEY` |
| 安装后看不到 Design 标签 | 检查 `--dump-config`，确认安装到正在运行的 Profile，并完整重启该 Profile |
| 页面提示 Key 无效 | 只有 Modellix 明确返回 401 才会进入该状态；本地 Credential 可在设置中更换，环境来源需在外部更新并重启 |
| 余额不足 | 402 不会被误报为 Key 无效；充值或调整任务后手动重试 |
| 请求过多 | 等待 429 限流窗口结束后再手动重试 |
| 结果消失 | 结果依赖上游 URL；没有上游有效期时，本地最多展示 7 天，但这不会延长资源寿命 |
| 端口已占用 | 先检查是否已有可用 DSH Web 服务；优先复用，不要连续启动多个 Profile |

## 12. 停止与卸载

在运行服务的终端按 `Ctrl+C` 停止。需要卸载时：

```powershell
dsh plugin --profile web remove dsh-modellix
dsh --profile web --dump-config
Remove-Item Env:MODELLIX_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
```

若 Modellix Key 存在本地 Harness Credential 中，先在“设置 → Modellix”移除它。卸载插件不会删除上游任务、外部环境变量或所有 Harness 数据。

完整功能、状态和安全说明见[中文用户指南](USER_GUIDE.md)。
