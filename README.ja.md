<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="tokengraph" src="docs/assets/logo-light.svg" height="56">
  </picture>
</p>

<h3 align="center">AI コーディングを、GitHub 風のグラフに。</h3>

<p align="center">
  <em>Claude Code、Codex CLI、Cursor、Gemini CLI、Cline、OpenCode、Kilo CLI、Copilot CLI、pi、Qwen Code、Goose を、README に載せる 1 枚のグラフにまとめます。<br>
  使用データは、あなたが公開しない限りマシンの外に出ません。公開する場合も、送り先は自分の gist だけです。</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokengraph"><img alt="npm version" src="https://img.shields.io/npm/v/tokengraph"></a>
  <a href="https://github.com/altindalorcun/tokengraph/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://github.com/altindalorcun/tokengraph/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/altindalorcun/tokengraph/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.md">English</a> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.zh-CN.md">简体中文</a> · <b>日本語</b> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.ko.md">한국어</a> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.tr.md">Türkçe</a>
</p>

> 英語版 README が原文です。この翻訳は更新が遅れている場合があります。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/graph-dark.svg">
    <img alt="A year of daily AI coding token usage as a contribution-style graph, coloured by model family" src="docs/assets/graph-light.svg" width="900">
  </picture>
</p>

## クイックスタート

```bash
npx tokengraph            # your graph, right in the terminal
npx tokengraph login      # publish it to your GitHub gist and get the README snippet
npx tokengraph story      # turn today into story cards and send them to your phone
```

Node.js 22 以降が必要です。README のグラフを意識せずに最新に保つには、
`npm install -g tokengraph && tokengraph schedule` を実行します。

## README に載せる

`tokengraph login` は、グラフを GitHub アカウントの公開 gist に公開し、次のスニペットをクリップボードにコピーします。
もう一度表示するには `tokengraph readme` を実行してください。これをプロフィール README（`YOUR_LOGIN/YOUR_LOGIN` リポジトリ）に貼り付けます。

```html
<a href="https://github.com/altindalorcun/tokengraph">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://gist.githubusercontent.com/YOUR_LOGIN/GIST_ID/raw/tokengraph-dark.svg">
    <img alt="My AI coding token usage, made with tokengraph" src="https://gist.githubusercontent.com/YOUR_LOGIN/GIST_ID/raw/tokengraph-light.svg">
  </picture>
</a>
```

グラフは、閲覧者の GitHub のテーマに合わせてライトとダークが切り替わります。同期のたびに同じ gist が更新されるので、スニペットを書き換える必要はありません。
ラベルなしの小さいグラフには `tokengraph readme --compact` を、モデルファミリーごとの色ではなく単色にするには `tokengraph readme --colors single` を使います（`--colors model` で元に戻ります）。ファミリーは Claude、GPT、Gemini、DeepSeek、Qwen、GLM、Kimi、Grok、Composer（Cursor 独自のモデル）、Mistral、Llama、MiniMax で、それ以外のモデルはすべて「その他のモデル」として数えます。

## 1 日をシェアする

<p align="center">
  <img alt="Three story cards: a 3D skyline of the month, a receipt of the day's models, and a sticker with the day's total" src="docs/assets/story-strip.png" width="760">
</p>

`tokengraph story` は 3 枚のカード（スカイライン、レシート、ステッカー）を、Instagram や TikTok のストーリー向けサイズの PNG ファイルとして描き、QR コードを表示します。同じ Wi-Fi につないだスマートフォンで読み取ると、カードをそのまま写真アプリに保存できます。
どこにもアップロードされません。カードを保存し終えるか、10 分間操作がなくなるまで、あなたのコンピューターがスマートフォンにファイルを配信します。
対象期間（今日、7 日、30 日、12 か月）を尋ねられます。`--range today|7d|30d|1y` を付けると質問を省略でき、`--no-cost` を付けると推定コストを表示しません。

## 仕組み

```
agent logs on your machine ──► tokengraph ──► ~/.tokengraph ledger ──► your gists
(Claude Code, Codex, …)        dedups,         (totals only grow)       public: the SVG graph
                               weights                                  secret: daily counts per machine
```

tokengraph は、各エージェントがすでにディスクに書き出している使用量カウンターを読みます。プロンプトや回答は読みません。1 日ごとの数値は、重み付きトークン数です。

```
weighted tokens = input + output + cache writes + 0.1 × cache reads
```

キャッシュの読み取りは新規の入力よりずっと安いので、10 分の 1 として数えます。そうしないと、大きなキャッシュ済みコンテキストを何度も読み直す長いセッション 1 つが、その日の実際の作業を押しつぶしてしまいます。測っているのは作業量であり、請求額ではありません。

- **二重カウントしません。** エージェントはストリーミング中に同じメッセージを何度もディスクへ書き込み、再開やフォークされたセッションは以前のレコードをコピーします。tokengraph は各エージェント自身のメッセージ ID またはレスポンス ID で重複を除き、ほかのアダプターがすでに数えている使用量は数えません。
- **合計は増える一方です。** エージェントは古いトランスクリプトを削除します。台帳は各日についてこれまでに見た最大の値を保持するので、履歴は残り、新しいスキャン結果が小さくても値は下がりません。

## プライバシー

| | |
| --- | --- |
| **マシンの外に出るもの** | アカウントの公開 gist へ：SVG グラフ（日ごとのトークン合計と、色分けに使うモデルファミリー名）と、埋め込みスニペットとリンクを載せた README。アカウントの秘密 gist へ：日ごと・モデルごとのトークン数、ランダムなマシン ID、`darwin-3f2a1c` のようなラベル、ハッシュ化したマシンのフィンガープリント、CLI のバージョン、最終更新の時刻。どちらも `tokengraph login` の後で、かつ tokengraph が公開するとき（`sync`、フック、スケジュール、`login`）だけです。`sync --local`、`story`、`status`、`export`、`import` は一切送信しません。`view` も、その中で Sync（または login、グラフの色）を自分で選んだときだけ送信します。 |
| **このマシンに残るもの** | 各エージェントを 1 日のどの時間帯に使ったか。tokengraph は、最も忙しい時間帯のカード、コーディング時計、`export --hours` のために、ローカル時刻の 1 時間ごとの重み付きトークン数を `state.json` に保存します。これがマシンファイル、データ gist、グラフ、ストーリーカードに入ることはありません。時間帯のデータは、エージェントのログがまだ残っている日の分だけあります。 |
| **tokengraph が取得するもの** | Cursor に限り、かつ有効なときだけ（Cursor にサインインしていれば既定で有効。`tokengraph cursor off` で停止）：`sync` が Cursor のローカルデータベースから Cursor 自身のサインイントークンを読み取り（読み取り専用で、その 1 行だけ）、cursor.com にあなた自身の使用量エクスポート、つまり Cursor ダッシュボードのエクスポートボタンで得られるものと同じファイルを求めます。トークンは cursor.com にだけ送られ、リクエストの間だけメモリに保持され、保存も表示もログ出力もされません。保存されるのは使用量の行（タイムスタンプ、モデル名、トークン数）です。`sync --local` は一切行いません。 |
| **出ないもの** | プロンプト、回答、コード、ファイル名、パス。tokengraph のサーバーには何も送られません。そもそもサーバーが存在しません。 |
| **削除する方法** | `tokengraph logout` で、このマシンのログイン情報を消します。公開したものを取り除くには、[gist.github.com](https://gist.github.com) で 2 つの gist を削除してください。 |

秘密 gist は「限定公開」であって「非公開」ではありません。URL を知っている人なら誰でも読めます。中身は上に挙げたフィールドだけで、ホスト名は含まれません。`tokengraph login` を実行するまで、どこにも何も送信されません。

## 対応エージェント

| エージェント | 読み取り元 | 備考 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` と `transcripts`（`$CLAUDE_CONFIG_DIR` も）、および Claude デスクトップアプリの Code と Cowork のセッション（`~/Library/Application Support/Claude`、`%APPDATA%\Claude`、`~/.config/Claude`） | Claude Code は古いトランスクリプトを削除するので、少なくとも数週間に 1 回は同期してください。`tokengraph install-hook --agent claude-code` を使うと、セッション終了時に同期します。 |
| Codex CLI | `~/.codex/sessions` と `archived_sessions`（`$CODEX_HOME` も） | `tokengraph install-hook --agent codex` は、ターンの終了後に同期します（最大 10 分に 1 回）。自分のものではない `notify` 設定は上書きしません。 |
| Cursor | cursor.com にあるあなた自身の使用履歴。このマシンの Cursor のサインインで取得します（`cursor-account-*.jsonl`）。リアルタイム用に、Cursor の `stop` フックが書き込む `~/.tokengraph/cursor-events.jsonl` | Cursor はディスク上に使えるトークン数を残しません。Cursor にサインインしていれば、`tokengraph sync` が使用履歴の全体を cursor.com から自動で、最大 1 時間に 1 回取得します（すべてのマシン、IDE、CLI、クラウドエージェント。`tokengraph cursor off` で無効化）。フック（`tokengraph install-hook --agent cursor` のあと Cursor を再起動）は、cursor.com にまだ反映されていない直近の時間帯を補います。使用量 CSV（`tokengraph import cursor <csv>`）は、取得を無効にしている人向けです。 |
| Gemini CLI | `~/.gemini/tmp/*/chats` と、macOS のサンドボックスが使う `~/.cache/.gemini/tmp`（どちらも `$GEMINI_CLI_HOME` 配下も） | `tokengraph install-hook --agent gemini-cli` を実行すると、セッションの終了時に同期します（Gemini CLI の設定に書き込みます。`$GEMINI_CLI_HOME` 配下も対象）。`tokengraph schedule` でも引き続きカバーされます。Gemini CLI は既定で 30 日後にセッションを削除するので、少なくとも月に 1 回は同期してください。一部の補助的な呼び出しは記録されないため、合計は下限値です。 |
| Cline | VS Code 系エディター（VS Code、Cursor、VSCodium、Windsurf、Positron、Trae、Kiro、Antigravity など。Linux は `$XDG_CONFIG_HOME`、Windows は `%APPDATA%`、リモートは `~/.vscode-server` など）の `saoudrizwan.claude-dev/tasks` と、`~/.cline/data`（`$CLINE_DIR`、`$CLINE_DATA_DIR`、`$CLINE_SESSION_DATA_DIR` も） | Cline が Claude Code プロバイダー経由で送るリクエストは、Claude Code アダプターがすでに数えているのでスキップします。 |
| OpenCode | `~/.local/share/opencode/opencode*.db` と、古い `storage/` フォルダー（`$XDG_DATA_HOME` 配下も。`$OPENCODE_DB` でデータベースを 1 つ追加） | データベースの読み取りには Node 22.13 以降が必要です。OpenCode 1.3.16 より前の、確実に読み取れないレコードはスキップして報告します。 |
| Kilo CLI | `~/.local/share/kilo/kilo*.db`（`$XDG_DATA_HOME` 配下も。`$KILO_DB` でデータベースを 1 つ追加） | VS Code の Kilo Code 7.x も同じデータベースに書き込むので、ここで一緒に数えます。データベースの読み取りには Node 22.13 以降が必要です。Kilo 7.2.6 より前の、確実に読み取れないレコードはスキップして報告します。 |
| Copilot CLI | `~/.copilot/session-store.db`（`$COPILOT_HOME` も） | Copilot CLI 1.0.70 以降と Node 22.13 以降が必要です。読み取るのは CLI 自身のデータベースだけで、VS Code の Copilot Chat 拡張機能は対象外です。レイアウトを認識できないデータベースはスキップして報告します。 |
| pi | `~/.pi/agent/sessions`（`$PI_CODING_AGENT_DIR` も。`$PI_CODING_AGENT_SESSION_DIR` が設定されていればそちらも） | `@mariozechner/pi-coding-agent` と、その後継の `@earendil-works/pi-coding-agent` は同じ形式で書き込みます。フォークされたセッションは以前のリクエストを共有しますが、1 回だけ数えます。コンパクションとブランチ要約の呼び出しにはモデル名がないため、スキップして報告します。 |
| Qwen Code | `~/.qwen/projects`（`$QWEN_HOME`、`$QWEN_RUNTIME_DIR`）のチャットとバックグラウンドのサブエージェント | `/branch` でフォークしたチャットは以前のリクエストをコピーしますが、1 回だけ数えます。Qwen Code はキャッシュ書き込みを別に記録しないので、通常の入力として数えます。バックグラウンドのサブエージェントのトランスクリプトは既定で 30 日後に削除されるので、少なくとも月に 1 回は同期してください。使用量台帳は、メモリ抽出器のリクエストが残る唯一のローカル記録ですが、`privacy.usageStatisticsEnabled` が true の間（既定）しか書き込まれません。オフにすると、それらのリクエストはどのローカルファイルにも残らず、チャットのリクエストだけを数えます。 |
| Goose | `~/.local/share/goose/sessions/sessions.db`（`$XDG_DATA_HOME`、または `$GOOSE_PATH_ROOT/data` 配下も。Windows では `%APPDATA%\Block\goose\data`。見つかったデータベースはすべて読み取ります） | リクエストごとの使用量台帳を読むため、台帳を持つバージョンの Goose と Node 22.13 以降が必要です。台帳ができる前の使用量は日付もモデルも分からないので、スキップして報告します。Goose 経由で Claude Code、Codex、Gemini CLI、Cursor、Copilot CLI、pi を動かしたセッションは対象外です。それらのエージェント自身のログがすでに数えているためです（Cursor については、フックが Goose の実行でも動く場合に限り。これは未確認です）。 |

各エージェントの集計は、Claude Code 2.1.304, Codex CLI 0.163.0, Gemini CLI 0.64.0, Cline 3.0.73, OpenCode 1.19.3, Kilo 7.8.15, Copilot CLI 1.0.100, pi 0.73.1, Qwen Code 0.25.3、Goose 1.55.0 の実機での実行に対して、対応するすべてのプロトコルで [`scripts/e2e`](https://github.com/altindalorcun/tokengraph/blob/main/scripts/e2e/README.md) により検証しています。Cursor はオフラインでは動かせません。CSV パーサーは実際のエクスポートで、取得処理はローカルの偽サーバーで確認し、フックの形式は Cursor のドキュメントに基づいています。Cline は、一部のプロバイダーが出力に含めて報告する推論（reasoning）トークンを除いて出力トークンを保存するため、その分は数えられません。

各エージェントは、既定のフォルダーに加えて、環境変数で指定されたフォルダーからも読み取ります。tokengraph は、その変数を設定してコマンドを実行した最初のときにそのフォルダーを（`config.json` に）記憶するので、シェルの環境を受け取らない 1 時間ごとの同期やフックでも読み取れます。`tokengraph status` は、スキャンするフォルダーと、それが存在するかどうかを表示します。

Cline、OpenCode、Kilo CLI、Copilot CLI、pi、Qwen Code、Goose にフックはありません（Gemini CLI のフックは任意です）。`tokengraph schedule` が 1 時間ごとに同期します。Aider は、ローカルの履歴がトークン数を丸めているため、対応していません。

## コマンド

どのコマンドも `--help` を受け付けます。未知のオプションはエラーになります。

| コマンド | 内容 |
| --- | --- |
| `tokengraph [view]` | ライブのターミナルビューを開きます：年間ヒートマップ、モデル、エージェント、連続日数、1 日のどの時間帯に作業しているかを示すコーディング時計、そしてビューを離れずにフック、毎時のスケジュール、sync、Cursor、エクスポート、story を管理する Setup タブ。`:` または Ctrl-K でコマンドパレットが開き、各アクションには対応する CLI コマンドが表示されます。`--print` で静的なスナップショットを表示します。ターミナルでの既定のコマンドです。 |
| `tokengraph login` | GitHub に接続し、グラフを自分の gist に公開して、README のスニペットを表示します。GitHub CLI にログイン済みならそれを使い（`--gh`）、そうでなければブラウザーで承認するワンタイムコードを使います（`--device`、`--no-open`）。要求するのは gist の権限だけです。 |
| `tokengraph logout` | このマシンの GitHub ログインを消去します。ローカルのデータと gist はそのまま残ります。 |
| `tokengraph sync` | すべてのエージェントのログを台帳に読み込み、ログイン済みなら公開します。Cursor にサインインしていれば、最初に cursor.com から Cursor の使用量を取得します（最大 1 時間に 1 回）。`--since <days>` でさかのぼる日数を指定し（既定は 90）、`--local` はネットワークを一切使いません。 |
| `tokengraph readme` | README のスニペットを表示してコピーします。`--compact`、`--colors model\|single`。 |
| `tokengraph story` | ストーリーカードを描き、PNG を保存して（`--out <dir>` を指定しなければダウンロードフォルダーへ）、スマートフォンへの送信を提案します。`--template skyline\|receipt\|sticker\|all`、`--range today\|7d\|30d\|1y`、`--no-cost`、`--qr` / `--no-qr`、`--no-preview`、`--handle <name>`。 |
| `tokengraph status [--json]` | GitHub アカウント、台帳、あなたのマシン、インストール済みで正常に動いているバックグラウンド同期、各エージェントの読み取り元フォルダー（と、その存在の有無）、Claude Code・Gemini CLI・Qwen Code がログを保持する期間を表示します。保持期間が短く履歴が失われるおそれがあるときは警告します。`--json` は、スクリプトや AI エージェント向けに 1 つの JSON オブジェクトとして出力します。 |
| `tokengraph install-hook --agent <claude-code\|cursor\|codex\|gemini-cli>` | そのエージェントが終了したときに、バックグラウンド同期を開始するようにします。`--remove` でアンインストール、`--dry-run` で変更内容を確認できます。 |
| `tokengraph schedule` | 1 時間ごとのバックグラウンド同期を設定します：macOS は launchd、Linux は cron、Windows はタスク スケジューラ。`schedule --remove` で無効にします。 |
| `tokengraph export` | 日ごとの使用量を、日付・エージェント・モデル・料金ティアごとに 1 行の CSV または JSON で書き出します。重み付きトークン数と推定コストを含みます。`--format csv\|json`、`--out <file>`、`--since <date>`、`--all-machines`。`--hours` を付けると、代わりに日付・ローカル時刻の時間帯・エージェントごとに 1 行を書き出します（日付、時、ソース、重み付きトークン数。このマシンのみ）。台帳だけを読みます。 |
| `tokengraph cursor fetch\|on\|off` | cursor.com から Cursor の使用量を今すぐ取得するか（1 時間の待機は無視します）、自動取得をオンまたはオフにします。`tokengraph import cursor --fetch` は `cursor fetch` と同じ動作です。`status` で状態を確認できます。Cursor のサインインが期限切れなら、Cursor を一度開いてください。 |
| `tokengraph import cursor <file.csv>` | 取得を無効にしているときに、Cursor の履歴を手作業で追加します。Cursor のダッシュボードから使用量 CSV をダウンロードし（Usage、export CSV）、ここに渡してください。同じファイルや重なりのあるファイルを 2 回取り込んでも、二重には加算されません。取り込みは 1 台のマシンだけで行ってください。マシン同士の値は合算されるので、同じファイルを 2 台で取り込むと 2 回数えられます。公開はしません。 |
| `tokengraph uninstall` | Claude Code、Cursor、Codex、Gemini CLI のフックと 1 時間ごとのスケジュールを削除します。`--purge` を付けると、`~/.tokengraph` にある tokengraph 自身のファイル（台帳、ログイン情報、ログ、Cursor のイベントファイル、インポートファイル、取得したアカウントのファイル）も削除し、それ以外のものは残します。`--yes` で確認を省略し、`--dry-run` では何も変更しません。gist には一切手を触れません。 |

フックとスケジュールはインストール済みプログラムのパスを保存するので、使う前に tokengraph をグローバルにインストールしてください（`npm install -g tokengraph`）。どちらも `npx` のキャッシュからの実行は拒否します。

## 複数のマシン

各マシンは、自分のファイル `machine-<id>.json` を秘密のデータ gist に書き込みます。同期すると、グラフはこのマシンと他のすべてのマシンのファイルを日ごと・モデルごとに合算して作られるので、ノート PC とデスクトップが 1 つのグラフになります。同じファイルがバックアップにもなります。再インストールや `~/.tokengraph` の消去のあとでも、`tokengraph login` がマシンを見分けて履歴を復元し、二重には数えません。

## FAQ

**なぜ gist なのですか？** 無料で、自分のもので、画像の配信とキャッシュは GitHub が行い、誰かが運用したり、信頼したり、止めたりするサーバーがないからです。tokengraph が明日なくなっても、グラフは動き続けます。

**コストは本物ですか？** 日付つきの価格表をもとにした、API の公開定価での推定値です。実際の請求額ではありません。請求額はプランによって変わります。価格が不明なモデルは合計から除外して「価格未設定」と表示し、$0 として数えることはないので、合計は下限値です。価格は、各ベンダーが公開している定価で、Claude（Anthropic）、GPT と o シリーズ（OpenAI）、Gemini（Google）、Grok（xAI）、Cursor の Composer 2.5 が対象です。オープンウェイトのモデル（DeepSeek、Qwen、Llama、Mistral、MiniMax など）は、単一の定価がないため意図的に価格未設定にしています。ベンダーが価格を公開していないモデル（提供終了のモデル、プレビュー、Cursor の Auto）も同様です。

**なぜ重み付きトークンなのですか？** 生の合計の大半はキャッシュ読み取りで、安い割に量が膨大です。10 分の 1 で数えることで、グラフを実際にこなした作業量に近づけています。計算式は[仕組み](#仕組み)にあります。

**オフラインで使えますか？** はい。`view`、`story`、`status`、`export`、`import <file>`、`sync --local` はネットワークなしで動きます。`view` が公開するのは、その中で Sync（または login、グラフの色）を自分で選んだときだけです。GitHub が必要なのは公開するときだけで、Cursor の取得（`sync`、`cursor fetch`）には cursor.com が必要です。

**やめるには？** `tokengraph uninstall` で、Claude Code、Cursor、Codex、Gemini CLI のフックと 1 時間ごとのスケジュールを削除します。`--purge` を付けると、`~/.tokengraph` にある tokengraph 自身のファイル（台帳、ログイン情報、ログ、Cursor のイベントファイル、インポートファイル、取得したアカウントのファイル）も削除します。そのフォルダーにあるそれ以外のものは残ります。
そのあと `npm uninstall -g tokengraph` を実行してください。gist は、自分で削除するまで GitHub に残ります。

**Windows では？** パス、フック、1 時間ごとのタスク スケジューラのジョブは Windows 向けに書かれていますが、tokengraph は macOS と Linux で開発されています。粗い部分があるかもしれません。見つけたらぜひ issue を開いてください。

## コントリビュート

バグ報告やプルリクエストを歓迎します。[CONTRIBUTING.md](https://github.com/altindalorcun/tokengraph/blob/main/CONTRIBUTING.md) を参照してください。新しいエージェントはアダプターの PR として追加します。tokengraph が何のためにあり、何をしないのかは、[プロダクトノート](https://github.com/altindalorcun/tokengraph/blob/main/docs/product.md)にあります。

---

tokengraph でプロフィールが良くなったら、⭐ を付けてもらえると、ほかの人が見つけやすくなります。

## ライセンス

MIT。[LICENSE](https://github.com/altindalorcun/tokengraph/blob/main/LICENSE) を参照してください。同梱しているサードパーティのコンポーネントについては、
[THIRD-PARTY-NOTICES.md](https://github.com/altindalorcun/tokengraph/blob/main/packages/cli/THIRD-PARTY-NOTICES.md) を参照してください。
