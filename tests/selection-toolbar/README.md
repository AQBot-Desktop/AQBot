# #201 长代码选区诊断

本次实现补齐诊断日志与公共文本链路回归，不改字数限制、探测次数、模拟复制范围、IPC 或数据库

## 当前证据与边界

- Windows UIA、macOS AX、Linux AT-SPI 主采集路径读取完整选区，没有通用字数或行数上限
- `100 / 500 / 1000` 行回归检查去抖、发布决策、快捷键候选缓存、复制取文、输入视图与请求内容，另检查长文本提示词保留 Unicode、缩进、空行及字面占位符
- 延迟事件检查回放公共去抖器的 `selection → clear → pointer selection → range selection`，不代表已复现系统事件竞态
- 尚无报告者的操作系统、编辑器、AQBot 版本、选中方式及故障日志；本机 UI 自动化工具读取界面超时，未完成鼠标或键盘划词实测，这不是 AQBot 原生选区读取超时的证据
- 因此没有已确认的 #201 故障分支，也没有实施推测性修复

## 生成对照文本

在仓库根目录执行，脚本在新的系统临时目录生成三份 UTF-8 文件，并输出路径、行数、Unicode 字符数、字节数和 SHA-256

```sh
node scripts/selection-toolbar-fixture.mjs
```

依次在报告者使用的编辑器和系统文本编辑器中打开三份文件，对每份分别执行鼠标跨屏拖选与键盘全选，保持相同触发模式、应用过滤和权限设置；每次关闭上一次结果窗口，避免既有交互保护影响下一次对照

先使用不调用 AI 的复制功能确认全文，再使用首轮确认发送模式查看“解释”的原文输入；需要验证实际 AI 请求时只发送上述合成文本，记录输入发送失败与工具栏未显示的区别

记录以下信息：系统及版本、AQBot 版本或 commit、源应用及版本、触发模式、选中方式、样本行数、操作时间、是否显示、显示位置、复制全文是否一致、原文输入是否完整

## 开启诊断

退出现有 AQBot 进程后，从终端启动本次构建；macOS/Linux 示例中的变量仅传给该次命令，PowerShell 示例会保留于当前终端及后续子进程，测试结束后关闭该 PowerShell 窗口

macOS 开发环境，在仓库根目录执行：

```sh
RUST_LOG='info,aqbot_lib::selection_toolbar=debug' AQBOT_LOG_FILE=/tmp/aqbot-selection-201.log pnpm dev
```

Windows PowerShell，将可执行文件路径替换为本次构建的实际路径：

```powershell
$env:RUST_LOG = 'info,aqbot_lib::selection_toolbar=debug'
$env:AQBOT_LOG_FILE = "$env:TEMP\aqbot-selection-201.log"
& 'C:\path\to\AQBot.exe'
```

Linux，从终端运行本次构建的实际可执行文件：

```sh
RUST_LOG='info,aqbot_lib::selection_toolbar=debug' AQBOT_LOG_FILE=/tmp/aqbot-selection-201.log /path/to/AQBot
```

只开启划词模块 debug，不开启全局 debug；诊断记录长度、耗时、来源应用标识、坐标、原生错误及忽略原因，选区正文和窗口标题不作为诊断字段

## 阅读日志

保留每次操作前后的完整划词模块日志，新增诊断统一使用 `[selection-toolbar-diagnostics]`，不要只过滤 `failed`，否则会丢失空选区和忽略决策

| 阶段 | 证据 | 下一步 |
| --- | --- | --- |
| 原生读取 | 读取开始、成功/空/失败、字符数、耗时、错误码或失败阶段 | 与短文本及系统编辑器对照，定位接口或应用兼容性 |
| 坐标 | 原生 anchor、`selection toolbar placement resolved` | 检查离屏首行、无效矩形和最终窗口坐标 |
| 事件 | `selection event received`、`clear event received`、`selection_invalidated` | 按时间及 generation 检查是否被新事件或清空取消 |
| 去抖 | `debounce_waiting`、`debounce_ignored`、`debounce_superseded` | 区分尚未到期、重复选区与 generation 已失效 |
| 发布 | `publishing selection`、`selection observation arbitration`、`selection_ignored` | 检查触发模式、应用过滤、重复选区及截图/结果窗口交互保护 |
| 窗口与前端 | `selection_show_failed`、`selection toolbar show`、`frontend_ready`、`session_emit_failed` | 区分窗口失败、前端未就绪与 session 事件发送失败 |

Windows 和 macOS 鼠标路径原有三次探测延迟为 80、150、400 ms，总等待间隔 630 ms；这不是原生 API 调用总耗时上限，后续系统通知仍可能产生选区，不能仅凭慢于 630 ms 就判定根因

捕获到失败后，用同一输入一次只改变一个条件，缩减到稳定失败的行数、选中方式和事件顺序；只有重放能捕获同一故障时才编写对应修复，公共链路通过不能排除原生读取或窗口问题

## 自动验证

本次 macOS 验证：131 项划词相关 Rust 测试通过，包括 5 项新增检查；合成样本的行数、字符数、字节数、SHA-256 与 Unicode/空白保留检查通过；源码扫描未发现超过 3000 行的手写源码

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib selection_toolbar:: --offline
```

该命令运行当前宿主平台与公共链路测试，不代表其他操作系统已完成编译或 UI 验证；人工回归还需覆盖普通点击、空白选区、应用过滤、快捷键触发、结果窗口交互，以及复制后原剪贴板的正常行为

已尝试 Windows 交叉编译 `cargo check --manifest-path src-tauri/Cargo.toml --lib --target x86_64-pc-windows-msvc --offline`，在 `ring` / `aws-lc-sys` 依赖构建阶段因本机缺少 `assert.h` / `windows.h` 失败，未进入应用代码检查；Linux 尚未编译或实测

Windows 特定弱 UIA 应用的剪贴板路径存在约百万 UTF-16 单元截断，本次保留现状，另行跟踪，不能据此解释普通编辑器的 500 行问题
