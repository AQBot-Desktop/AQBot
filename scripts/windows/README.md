# Windows 启动验证

## 便携 ZIP 发布冒烟

`smoke-portable.ps1` 由 Windows x64 发布任务和测试发布任务调用，直接解压即将上传的 ZIP，最长等待 60 秒，必须同时满足以下条件

- 脚本启动的 AQBot 进程仍存活
- 该进程拥有标题为 `AQBot` 的可见、未最小化原生主窗口
- 本次独立日志存在 `AQBot startup surface presented`，且字段为 `window="main" surface="app" visible=true`，这条日志由前端真实 commit 后的后端可见性确认产生；`surface="error"` 明确失败
- 进程会一直占用 `aqbot.log` 的追加句柄，脚本必须以 `FileShare.ReadWrite` 读这份仍在写入的日志，不能用 `File.ReadAllText`；短暂 IO 错误继续轮询，不能直接判失败

仅在全新的 GitHub-hosted Windows x64 runner 执行，ARM64 任务保持编译、打包验证，不声称通过运行验证；脚本拒绝已有 AQBot 进程和配置、文档或 WebView 数据，不删除已有内容

隔离边界是一次性 runner VM，不能把本脚本用在个人电脑或复用的 self-hosted runner；Windows `dirs::home_dir/document_dir` 使用 `SHGetKnownFolderPath`，仅替换 `HOME` 或 `USERPROFILE` 无法隔离所有数据根，所以脚本保持系统目录不变并检查真实 Known Folder；应用数据留在一次性 runner，产物只上传临时目录内的诊断日志和结果 JSON，不上传数据库、密钥或文档；退出时仅结束本次启动的进程及其子进程

## 受影响机器的同条件基线

1. 记录 ZIP 版本和 SHA-256、解压后 `AQBot.exe` 完整路径、Windows 版本与 build、WebView2 Runtime 版本、是否管理员运行、兼容模式的具体目标版本以及额外 DPI 设置，保留当前数据和 WebView 缓存
2. 固定同一个 EXE、路径、用户、权限与数据，关闭 AQBot 后确认旧进程退出；先关闭兼容模式连续启动 3 次，再启用报告中有效的同一兼容模式连续启动 3 次，每次使用独立日志文件，记录窗口显示耗时、是否出现启动错误页、60 秒后是否仍仅有后台进程
3. 完成基线后才进行单变量实验，例如 WebView2 修复或诊断性 GPU 参数，逐次记录改动并恢复；不要在基线间清缓存、升级 Runtime、切管理员身份或迁移目录，不把兼容模式有效推断成 GPU 根因
4. 验证修复版时关闭兼容模式，保持路径、权限与原有数据，连续启动 5 次，全部须显示实际应用主界面且可以交互；另在独立测试账号验证首次启动，安装版和便携版分别记录，错误页不能算启动成功

每次从同一个 PowerShell 窗口运行以下命令，只修改本次日志名和 EXE 路径，正常/兼容组使用相同启动方式

```powershell
$env:AQBOT_LOG_FILE = Join-Path $env:TEMP 'aqbot-normal-1.log'
$env:RUST_LOG = 'info'
Start-Process -FilePath 'C:\Apps\AQBot\AQBot.exe'
```

兼容组日志依次命名为 `aqbot-compat-1.log` 至 `aqbot-compat-3.log`；复现前先保存已有同名日志，避免覆盖或把不同启动混成一次；新版本日志应包含真实 AQBot 包版本、PID、Windows 版本、WebView2 版本及启动阶段，旧版缺少的字段手工记录；不要把数据库、`master.key` 或用户文档作为诊断附件

Windows 版本可以通过 `winver` 核对，ZIP 校验值使用 `Get-FileHash -Algorithm SHA256`；WebView2 版本以启动诊断记录为准，旧版从 Windows 已安装应用中的 Microsoft Edge WebView2 Runtime 信息记录，未找到时标记未知而不据此断言缺失

本地 macOS 的静态检查无法验证 Win32 窗口、WebView2 或兼容模式行为，最终验收必须回到 Windows 11 受影响机器；GitHub-hosted runner 的成功只证明其对应环境的 ZIP 启动链路
