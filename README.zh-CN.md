<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="tokengraph" src="docs/assets/logo-light.svg" height="56">
  </picture>
</p>

<h3 align="center">把你的 AI 编程，画成 GitHub 风格的图表。</h3>

<p align="center">
  <em>Claude Code、Codex CLI、Cursor、Gemini CLI、Cline、OpenCode、Kilo CLI、Copilot CLI、pi、Qwen Code 和 Goose：一张图，放进你的 README。<br>
  除非你主动发布，你的使用数据不会离开你的电脑；发布时也只会发到你自己的 gist。</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokengraph"><img alt="npm version" src="https://img.shields.io/npm/v/tokengraph"></a>
  <a href="https://github.com/altindalorcun/tokengraph/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://github.com/altindalorcun/tokengraph/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/altindalorcun/tokengraph/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.md">English</a> · <b>简体中文</b> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.ja.md">日本語</a> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.ko.md">한국어</a> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.tr.md">Türkçe</a>
</p>

> 英文 README 是原文，本翻译可能滞后于它。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/graph-dark.svg">
    <img alt="A year of daily AI coding token usage as a contribution-style graph, coloured by model family" src="docs/assets/graph-light.svg" width="900">
  </picture>
</p>

## 快速开始

```bash
npx tokengraph            # your graph, right in the terminal
npx tokengraph login      # publish it to your GitHub gist and get the README snippet
npx tokengraph story      # turn today into story cards and send them to your phone
```

需要 Node.js 22 或更新版本。想让 README 里的图表自动保持最新，运行：
`npm install -g tokengraph && tokengraph schedule`。

## 放进你的 README

`tokengraph login` 会把你的图表发布到你 GitHub 账号下的一个公开 gist，并把下面这段代码复制到剪贴板。
运行 `tokengraph readme` 可以再次打印它。把它粘贴到你的个人主页 README 中（即 `YOUR_LOGIN/YOUR_LOGIN` 仓库）：

```html
<a href="https://github.com/altindalorcun/tokengraph">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://gist.githubusercontent.com/YOUR_LOGIN/GIST_ID/raw/tokengraph-dark.svg">
    <img alt="My AI coding token usage, made with tokengraph" src="https://gist.githubusercontent.com/YOUR_LOGIN/GIST_ID/raw/tokengraph-light.svg">
  </picture>
</a>
```

图表会随读者的 GitHub 主题在浅色和深色之间切换。每次同步都会更新同一个 gist，所以这段代码永远不用改。
`tokengraph readme --compact` 生成不带标签的小图；`tokengraph readme --colors single` 用单一颜色，而不是每个模型系列一种颜色（`--colors model` 可切换回来）。

## 分享你的一天

<p align="center">
  <img alt="Three story cards: a 3D skyline of the month, a receipt of the day's models, and a sticker with the day's total" src="docs/assets/story-strip.png" width="760">
</p>

`tokengraph story` 会画出三张卡片（天际线、小票和贴纸），保存为适合 Instagram 和 TikTok 快拍尺寸的 PNG 文件，然后显示一个二维码。用同一 Wi-Fi 下的手机扫码，就能把卡片直接存进相册。
不会上传任何东西：你的电脑会把文件提供给手机，直到你保存完卡片，或闲置 10 分钟后停止。
它会询问要统计哪个时间段（今天、7 天、30 天或 12 个月）；用 `--range today|7d|30d|1y` 可以跳过这个问题，用 `--no-cost` 可以不显示估算费用。

## 工作原理

```
agent logs on your machine ──► tokengraph ──► ~/.tokengraph ledger ──► your gists
(Claude Code, Codex, …)        dedups,         (totals only grow)       public: the SVG graph
                               weights                                  secret: daily counts per machine
```

tokengraph 读取各个 agent 本来就写在磁盘上的用量计数器。它不会读取你的提示词或回答。每天的数字是加权 token 数：

```
weighted tokens = input + output + cache writes + 0.1 × cache reads
```

缓存读取的成本只是新输入的一小部分，所以按十分之一计算。否则，一次反复读取大段缓存上下文的长会话，就会淹没一整天真正的工作量。它衡量的是工作量，而不是账单。

- **不会重复计数。** agent 在流式输出时会把同一条消息多次写入磁盘，恢复或分叉的会话还会复制之前的记录。tokengraph 按每个 agent 自己的消息 id 或响应 id 去重，并且不会计入已被其他适配器计过的用量。
- **总数只增不减。** agent 会删除旧的对话记录。账本为每一天保留它见过的最大值，所以历史得以保留，较小的新扫描结果也不会把它拉低。

## 隐私

| | |
| --- | --- |
| **哪些数据会离开你的电脑** | 发到你账号下的公开 gist：SVG 图表（每日 token 总数，以及用于着色的模型系列名称），以及一个带有嵌入代码和链接的 README。发到你账号下的私密 gist：按天、按模型的 token 数、一个随机的机器 id、形如 `darwin-3f2a1c` 的标签、哈希后的机器指纹、CLI 版本和最近一次更新的时间。两者都只在执行 `tokengraph login` 之后，并且只在 tokengraph 发布时才会发送（`sync`、hook、定时任务或 `login`）。`sync --local`、`view`、`story`、`status`、`export` 和 `import` 从不发送。 |
| **哪些数据绝不会离开** | 提示词、回答、代码、文件名、路径。不会向任何 tokengraph 服务器发送任何东西：根本没有这样的服务器。 |
| **如何移除** | `tokengraph logout` 会让这台机器忘记登录信息。到 [gist.github.com](https://gist.github.com) 删除这两个 gist，即可移除已发布的内容。 |

私密 gist 是“不公开列出”，不是“私有”：任何拿到它网址的人都能读取。它只包含上面列出的字段，绝不包含主机名。在你运行 `tokengraph login` 之前，不会向任何地方发送任何东西。

## 支持的 agent

| Agent | 读取位置 | 说明 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl`（或 `$CLAUDE_CONFIG_DIR`） | Claude Code 会删除旧的对话记录，所以至少每隔几周同步一次。`tokengraph install-hook --agent claude-code` 会在会话结束时同步。 |
| Codex CLI | `~/.codex/sessions` 和 `archived_sessions`（或 `$CODEX_HOME`） | `tokengraph install-hook --agent codex` 会在一轮对话结束后同步，最多每 10 分钟一次。它不会覆盖不属于自己的 `notify` 设置。 |
| Cursor | `~/.tokengraph/cursor-events.jsonl`，由 Cursor 的 `stop` hook 写入 | Cursor 没有在磁盘上保存可用的 token 数，所以请运行一次 `tokengraph install-hook --agent cursor` 并重启 Cursor。用量从那一刻起开始计算，也可以用 `tokengraph import cursor <csv>` 导入你的历史记录。 |
| Gemini CLI | `~/.gemini/tmp/*/chats`（或 `$GEMINI_CLI_HOME`） | Gemini CLI 默认在 30 天后删除会话，所以至少每月同步一次。它不会记录某些附带调用，所以总数是下限。 |
| Cline | VS Code 系编辑器中的 `saoudrizwan.claude-dev/tasks`，以及 `~/.cline/data` | Cline 通过 Claude Code provider 发出的请求会被跳过，因为 Claude Code 适配器已经计过它们。 |
| OpenCode | `~/.local/share/opencode/opencode*.db` 和较旧的 `storage/` 文件夹 | 读取数据库需要 Node 22.13 或更新版本。OpenCode 1.3.16 之前、无法确定读取结果的记录会被跳过并报告。 |
| Kilo CLI | `~/.local/share/kilo/kilo*.db`（或 `$KILO_DB`） | VS Code 中的 Kilo Code 7.x 写入同一个数据库，所以这里也会计入。读取数据库需要 Node 22.13 或更新版本。Kilo 7.2.6 之前、无法确定读取结果的记录会被跳过并报告。 |
| Copilot CLI | `~/.copilot/session-store.db`（或 `$COPILOT_HOME`） | 需要 Copilot CLI 1.0.70 或更新版本，以及 Node 22.13 或更新版本。只读取 CLI 自己的数据库，不读取 VS Code 里的 Copilot Chat 扩展。数据库里的内容尚未用真实数据验证过，所以布局无法识别的数据库会被跳过并报告。 |
| pi | `~/.pi/agent/sessions`（或 `$PI_CODING_AGENT_DIR`，若设置了 `$PI_CODING_AGENT_SESSION_DIR` 则读取它） | 分叉的会话共享之前的请求，这些请求只计一次。压缩和分支摘要调用没有指明模型，会被跳过并报告。尚未用真实的 pi 文件验证过。 |
| Qwen Code | `~/.qwen/projects`（`$QWEN_HOME`、`$QWEN_RUNTIME_DIR`），包括对话和后台子 agent | 用 `/branch` 分叉的对话会复制之前的请求，这些请求只计一次。Qwen Code 不单独记录缓存写入，所以它们按普通输入计算。它默认在 30 天后删除后台子 agent 的对话记录，所以至少每月同步一次。尚未用真实的 Qwen Code 文件验证过。 |
| Goose | `~/.local/share/goose/sessions/sessions.db`（`$XDG_DATA_HOME`，或 `$GOOSE_PATH_ROOT/data`；Windows 上是 `%APPDATA%\Block\goose\data`） | 读取按请求记录的用量账本，所以需要带有该账本的 Goose 版本，以及 Node 22.13 或更新版本。账本出现之前的用量没有确切的日期和模型，会被跳过并报告。通过 Goose 驱动 Claude Code、Codex、Gemini CLI、Cursor、Copilot CLI 或 pi 的会话不会计入，因为这些 agent 自己的日志已经计过它们（对 Cursor 而言，仅当其 hook 会在 Goose 的运行中触发时才成立，这一点尚未验证）。尚未用真实的 Goose 文件验证过。 |

Gemini CLI、Cline、OpenCode、Kilo CLI、Copilot CLI、pi、Qwen Code 和 Goose 不需要 hook：`tokengraph schedule` 每小时同步它们一次。不支持 Aider，因为它的本地历史会对 token 数做取整。

## 命令

每个命令都支持 `--help`。未知的选项会报错。

| 命令 | 作用 |
| --- | --- |
| `tokengraph [view]` | 打开实时终端视图：年度热力图、模型、agent、连续天数。`--print` 打印静态快照。在终端中这是默认命令。 |
| `tokengraph login` | 连接 GitHub，把图表发布到你自己的 gist，并打印 README 代码。如果你已经登录了 GitHub CLI，就会使用它（`--gh`）；也可以用在浏览器中确认的一次性代码（`--device`、`--no-open`）。只申请 gist 权限。 |
| `tokengraph logout` | 让这台机器忘记 GitHub 登录。本地数据和你的 gist 都保留。 |
| `tokengraph sync` | 把每个 agent 的日志读入账本，并在已登录时发布。`--since <days>` 设置回溯多久（默认 90 天），`--local` 完全不联网。 |
| `tokengraph readme` | 打印 README 代码并复制到剪贴板。可用 `--compact`、`--colors model\|single`。 |
| `tokengraph story` | 绘制快拍卡片，保存 PNG（默认存到“下载”文件夹，可用 `--out <dir>` 指定），并询问是否发送到手机。可用 `--template skyline\|receipt\|sticker\|all`、`--range today\|7d\|30d\|1y`、`--no-cost`、`--qr` / `--no-qr`、`--no-preview`、`--handle <name>`。 |
| `tokengraph status [--json]` | 显示 GitHub 账号、账本、你的各台机器、已安装且运行正常的后台同步，以及 Claude Code、Gemini CLI 和 Qwen Code 保留日志的时长；若保留期过短、历史有丢失风险，会给出警告。`--json` 把结果输出为一个 JSON 对象，供脚本和 AI agent 使用。 |
| `tokengraph install-hook --agent <claude-code\|cursor\|codex>` | 让该 agent 在结束时启动一次后台同步。`--remove` 卸载，`--dry-run` 显示将要做的改动。 |
| `tokengraph schedule` | 安装每小时一次的后台同步：macOS 用 launchd，Linux 用 cron，Windows 用任务计划程序。`schedule --remove` 关闭它。 |
| `tokengraph export` | 把你的每日用量写成 CSV 或 JSON，每个日期、agent、模型和定价档位一行，附带加权 token 数和估算费用。可用 `--format csv\|json`、`--out <file>`、`--since <date>`、`--all-machines`。只读取账本。 |
| `tokengraph import cursor <file.csv>` | 补入 hook 之前的 Cursor 历史：从 Cursor 控制台下载用量 CSV（Usage，导出 CSV）并传给它。重复导入同一个或有重叠的文件，不会重复计数。只在一台机器上导入：各台机器的数据会相加，所以同一个文件在两台机器上导入会被计两次。从不发布。 |
| `tokengraph uninstall` | 移除 Claude Code、Cursor 和 Codex 的 hook 以及每小时的定时任务。`--purge` 还会删除 `~/.tokengraph` 中 tokengraph 自己的文件（账本、登录信息、日志、Cursor 事件文件和导入文件），并保留那里的其他任何东西；`--yes` 跳过确认，`--dry-run` 不做任何改动。你的 gist 绝不会被触碰。 |

hook 和定时任务会记录已安装程序的路径，所以使用它们之前请全局安装 tokengraph（`npm install -g tokengraph`）；两者都拒绝从 `npx` 缓存运行。

## 多台机器

每台机器都会把自己的文件 `machine-<id>.json` 写入私密的数据 gist。同步时，图表由这台机器加上其他所有机器的文件按天、按模型相加生成，所以笔记本和台式机会显示成同一张图。这些文件同时也是备份：重装系统或 `~/.tokengraph` 被清空之后，`tokengraph login` 会识别出你的机器，恢复它的历史，并且不会重复计数。

## 常见问题

**为什么用 gist？** 它们免费，属于你自己，GitHub 负责提供并缓存图片，而且没有任何人需要运行、信任或关停的服务器。即使 tokengraph 明天消失，你的图表依然能用。

**费用是真实的吗？** 它是按公开 API 标价、依据带日期的价格表算出的估算值，不是你实际被收取的金额，那取决于你的套餐。没有已知价格的模型会被排除在总额之外并标为“未定价”，绝不当作 $0 计入，所以总额只可能是下限。

**为什么用加权 token？** 原始总数里大部分是缓存读取，它们便宜但数量庞大。按十分之一计算，能让图表反映实际完成的工作。公式见[工作原理](#工作原理)。

**能离线使用吗？** 可以。`view`、`story`、`status`、`export`、`import` 和 `sync --local` 从不使用网络。只有发布才需要 GitHub。

**如何停用？** `tokengraph uninstall` 会移除 Claude Code、Cursor 和 Codex 的 hook 以及每小时的定时任务；加上 `--purge` 还会删除 `~/.tokengraph` 中 tokengraph 自己的文件（账本、登录信息、日志，以及 Cursor 事件文件和导入文件）。该文件夹里的其他东西都会保留。
然后运行 `npm uninstall -g tokengraph`。你的 gist 会留在 GitHub 上，直到你自己删除。

**支持 Windows 吗？** 路径、hook 和每小时的任务计划程序作业都是按 Windows 写的，但 tokengraph 是在 macOS 和 Linux 上开发的，所以可能存在一些不完善之处，欢迎提 issue。

## 参与贡献

欢迎提交 bug 报告和 pull request，参见 [CONTRIBUTING.md](https://github.com/altindalorcun/tokengraph/blob/main/CONTRIBUTING.md)。新的 agent 通过适配器 PR 加入。tokengraph 的定位，以及它不会做什么，写在[产品说明](https://github.com/altindalorcun/tokengraph/blob/main/docs/product.md)里。

---

如果 tokengraph 让你的主页更好看了，点个 ⭐ 能帮助更多人发现它。

## 许可证

MIT，见 [LICENSE](https://github.com/altindalorcun/tokengraph/blob/main/LICENSE)。内置的第三方组件：见
[THIRD-PARTY-NOTICES.md](https://github.com/altindalorcun/tokengraph/blob/main/packages/cli/THIRD-PARTY-NOTICES.md)。
