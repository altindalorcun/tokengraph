<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="tokengraph" src="docs/assets/logo-light.svg" height="56">
  </picture>
</p>

<h3 align="center">AI 코딩을 GitHub 스타일 그래프로.</h3>

<p align="center">
  <em>Claude Code, Codex CLI, Cursor, Gemini CLI, Cline, OpenCode, Kilo CLI, Copilot CLI, pi, Qwen Code, Goose: README에 넣을 수 있는 하나의 그래프입니다.<br>
  사용 데이터는 직접 게시하지 않는 한 내 컴퓨터를 벗어나지 않으며, 게시하더라도 내 gist에만 올라갑니다.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokengraph"><img alt="npm version" src="https://img.shields.io/npm/v/tokengraph"></a>
  <a href="https://github.com/altindalorcun/tokengraph/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://github.com/altindalorcun/tokengraph/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/altindalorcun/tokengraph/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.md">English</a> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.zh-CN.md">简体中文</a> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.ja.md">日本語</a> · <b>한국어</b> · <a href="https://github.com/altindalorcun/tokengraph/blob/main/README.tr.md">Türkçe</a>
</p>

> 영어 README가 원문이며, 이 번역은 원문보다 늦게 갱신될 수 있습니다.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/graph-dark.svg">
    <img alt="A year of daily AI coding token usage as a contribution-style graph, coloured by model family" src="docs/assets/graph-light.svg" width="900">
  </picture>
</p>

## 빠른 시작

```bash
npx tokengraph            # your graph, right in the terminal
npx tokengraph login      # publish it to your GitHub gist and get the README snippet
npx tokengraph story      # turn today into story cards and send them to your phone
```

Node.js 22 이상이 필요합니다. README 그래프를 신경 쓰지 않고도 최신 상태로 유지하려면
`npm install -g tokengraph && tokengraph schedule`을 실행하세요.

## README에 넣기

`tokengraph login`은 그래프를 내 GitHub 계정의 공개 gist에 게시하고, 아래 스니펫을 클립보드에 복사합니다.
다시 출력하려면 `tokengraph readme`를 실행하세요. 이를 프로필 README(`YOUR_LOGIN/YOUR_LOGIN` 저장소)에 붙여 넣으면 됩니다.

```html
<a href="https://github.com/altindalorcun/tokengraph">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://gist.githubusercontent.com/YOUR_LOGIN/GIST_ID/raw/tokengraph-dark.svg">
    <img alt="My AI coding token usage, made with tokengraph" src="https://gist.githubusercontent.com/YOUR_LOGIN/GIST_ID/raw/tokengraph-light.svg">
  </picture>
</a>
```

그래프는 보는 사람의 GitHub 테마에 따라 라이트와 다크로 바뀝니다. 동기화할 때마다 같은 gist가 갱신되므로 스니펫은 바뀌지 않습니다.
레이블 없는 작은 그래프는 `tokengraph readme --compact`로, 모델 계열별 색 대신 한 가지 색으로 보려면 `tokengraph readme --colors single`을 사용하세요(`--colors model`로 되돌릴 수 있습니다).

## 하루 공유하기

<p align="center">
  <img alt="Three story cards: a 3D skyline of the month, a receipt of the day's models, and a sticker with the day's total" src="docs/assets/story-strip.png" width="760">
</p>

`tokengraph story`는 세 장의 카드(스카이라인, 영수증, 스티커)를 Instagram과 TikTok 스토리 크기의 PNG 파일로 그린 뒤 QR 코드를 보여 줍니다. 같은 Wi-Fi에 연결된 휴대폰으로 스캔하면 카드를 바로 사진 앱에 저장할 수 있습니다.
어디에도 업로드되지 않습니다. 카드를 다 저장하거나 10분 동안 아무 동작이 없을 때까지, 내 컴퓨터가 휴대폰에 파일을 제공합니다.
어느 기간을 다룰지(오늘, 7일, 30일, 12개월) 묻습니다. `--range today|7d|30d|1y`로 질문을 건너뛸 수 있고, `--no-cost`로 예상 비용을 뺄 수 있습니다.

## 동작 방식

```
agent logs on your machine ──► tokengraph ──► ~/.tokengraph ledger ──► your gists
(Claude Code, Codex, …)        dedups,         (totals only grow)       public: the SVG graph
                               weights                                  secret: daily counts per machine
```

tokengraph는 에이전트가 이미 디스크에 기록해 둔 사용량 카운터를 읽습니다. 프롬프트나 답변은 읽지 않습니다. 하루의 수치는 가중 토큰 수입니다.

```
weighted tokens = input + output + cache writes + 0.1 × cache reads
```

캐시 읽기는 새 입력보다 훨씬 싸기 때문에 10분의 1로 셉니다. 그러지 않으면 큰 캐시 컨텍스트를 계속 다시 읽는 긴 세션 하나가 그날의 실제 작업을 묻어 버립니다. 청구서가 아니라 작업량을 측정하는 것입니다.

- **이중 집계가 없습니다.** 에이전트는 스트리밍 중에 같은 메시지를 디스크에 여러 번 쓰고, 재개되거나 포크된 세션은 이전 기록을 복사합니다. tokengraph는 각 에이전트 고유의 메시지 id 또는 응답 id로 중복을 제거하며, 다른 어댑터가 이미 집계한 사용량은 세지 않습니다.
- **합계는 늘기만 합니다.** 에이전트는 오래된 대화 기록을 삭제합니다. 원장은 날짜별로 지금까지 본 가장 큰 값을 보관하므로 기록이 유지되고, 더 작은 새 스캔 결과가 나와도 값이 내려가지 않습니다.

## 개인정보 보호

| | |
| --- | --- |
| **내 컴퓨터를 떠나는 것** | 내 계정의 공개 gist로: SVG 그래프(일별 토큰 합계와, 색을 나누는 데 쓰이는 모델 계열 이름), 그리고 임베드 스니펫과 링크가 담긴 README. 내 계정의 secret gist로: 일별·모델별 토큰 수, 무작위 컴퓨터 id, `darwin-3f2a1c` 같은 레이블, 해시한 컴퓨터 핑거프린트, CLI 버전, 마지막 업데이트 시각. 둘 다 `tokengraph login` 이후에만, 그리고 tokengraph가 게시할 때(`sync`, 훅, 스케줄, `login`)에만 전송됩니다. `sync --local`, `view`, `story`, `status`, `export`, `import`는 절대 전송하지 않습니다. |
| **절대 떠나지 않는 것** | 프롬프트, 답변, 코드, 파일 이름, 경로. tokengraph 서버로는 아무것도 전송되지 않습니다. 그런 서버 자체가 없습니다. |
| **삭제하는 방법** | `tokengraph logout`은 이 컴퓨터에서 로그인 정보를 지웁니다. 게시된 내용을 없애려면 [gist.github.com](https://gist.github.com)에서 두 gist를 삭제하세요. |

secret gist는 '비공개(private)'가 아니라 '목록에 표시되지 않는(unlisted)' gist입니다. URL을 아는 사람은 누구나 읽을 수 있습니다. 여기에는 위에 나열한 필드만 들어 있고 호스트 이름은 절대 들어 있지 않습니다. `tokengraph login`을 실행하기 전에는 어디로도 아무것도 전송되지 않습니다.

## 지원하는 에이전트

| 에이전트 | 읽는 위치 | 참고 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl`(또는 `$CLAUDE_CONFIG_DIR`) | Claude Code는 오래된 대화 기록을 삭제하므로 최소한 몇 주에 한 번은 동기화하세요. `tokengraph install-hook --agent claude-code`는 세션이 끝날 때 동기화합니다. |
| Codex CLI | `~/.codex/sessions`와 `archived_sessions`(또는 `$CODEX_HOME`) | `tokengraph install-hook --agent codex`는 한 턴이 끝난 뒤 동기화하며, 최대 10분에 한 번입니다. 자체 설정이 아닌 `notify` 설정은 절대 덮어쓰지 않습니다. |
| Cursor | `~/.tokengraph/cursor-events.jsonl`, Cursor의 `stop` 훅이 기록 | Cursor는 디스크에 쓸 만한 토큰 수를 남기지 않으므로, `tokengraph install-hook --agent cursor`를 한 번 실행하고 Cursor를 다시 시작하세요. 사용량은 그 시점부터 집계되며, 이전 기록은 `tokengraph import cursor <csv>`로 가져올 수 있습니다. |
| Gemini CLI | `~/.gemini/tmp/*/chats`(또는 `$GEMINI_CLI_HOME`) | Gemini CLI는 기본적으로 30일 후 세션을 삭제하므로 최소한 한 달에 한 번은 동기화하세요. 일부 보조 호출은 기록하지 않으므로 합계는 하한값입니다. |
| Cline | VS Code 계열 에디터의 `saoudrizwan.claude-dev/tasks`와 `~/.cline/data` | Cline이 Claude Code 공급자를 통해 보내는 요청은 Claude Code 어댑터가 이미 집계하므로 건너뜁니다. |
| OpenCode | `~/.local/share/opencode/opencode*.db`와 이전 방식의 `storage/` 폴더 | 데이터베이스를 읽으려면 Node 22.13 이상이 필요합니다. OpenCode 1.3.16 이전의 기록 중 확실하게 읽을 수 없는 것은 건너뛰고 보고합니다. |
| Kilo CLI | `~/.local/share/kilo/kilo*.db`(또는 `$KILO_DB`) | VS Code의 Kilo Code 7.x도 같은 데이터베이스에 기록하므로 여기서 함께 집계됩니다. 데이터베이스를 읽으려면 Node 22.13 이상이 필요합니다. Kilo 7.2.6 이전의 기록 중 확실하게 읽을 수 없는 것은 건너뛰고 보고합니다. |
| Copilot CLI | `~/.copilot/session-store.db`(또는 `$COPILOT_HOME`) | Copilot CLI 1.0.70 이상과 Node 22.13 이상이 필요합니다. CLI 자체 데이터베이스만 읽으며, VS Code의 Copilot Chat 확장은 읽지 않습니다. 데이터베이스 내용은 아직 실제 데이터로 확인하지 않았으므로, 알 수 없는 구조의 데이터베이스는 건너뛰고 보고합니다. |
| pi | `~/.pi/agent/sessions`(또는 `$PI_CODING_AGENT_DIR`, 설정되어 있으면 `$PI_CODING_AGENT_SESSION_DIR`) | 포크된 세션은 이전 요청을 공유하며, 이는 한 번만 집계됩니다. 압축과 브랜치 요약 호출은 모델 이름이 없으므로 건너뛰고 보고합니다. 실제 pi 파일로는 아직 확인하지 않았습니다. |
| Qwen Code | `~/.qwen/projects`(`$QWEN_HOME`, `$QWEN_RUNTIME_DIR`), 채팅과 백그라운드 서브에이전트 | `/branch`로 포크한 채팅은 이전 요청을 복사하며, 이는 한 번만 집계됩니다. Qwen Code는 캐시 쓰기를 따로 기록하지 않으므로 일반 입력으로 셉니다. 백그라운드 서브에이전트의 대화 기록은 기본적으로 30일 후 삭제하므로 최소한 한 달에 한 번은 동기화하세요. 실제 Qwen Code 파일로는 아직 확인하지 않았습니다. |
| Goose | `~/.local/share/goose/sessions/sessions.db`(`$XDG_DATA_HOME`, 또는 `$GOOSE_PATH_ROOT/data`. Windows에서는 `%APPDATA%\Block\goose\data`) | 요청별 사용량 원장을 읽으므로 원장이 있는 Goose 버전과 Node 22.13 이상이 필요합니다. 원장이 생기기 전의 사용량은 날짜와 모델을 알 수 없으므로 건너뛰고 보고합니다. Goose를 통해 Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI, pi를 구동한 세션은 제외합니다. 해당 에이전트 자체 로그가 이미 집계하기 때문입니다(Cursor는 Goose 실행에서도 훅이 동작하는 경우에 한하며, 이는 확인되지 않았습니다). 실제 Goose 파일로는 아직 확인하지 않았습니다. |

Gemini CLI, Cline, OpenCode, Kilo CLI, Copilot CLI, pi, Qwen Code, Goose는 훅이 필요 없습니다. `tokengraph schedule`이 한 시간마다 동기화합니다. Aider는 로컬 기록이 토큰 수를 반올림하기 때문에 지원하지 않습니다.

## 명령어

모든 명령어는 `--help`를 받습니다. 알 수 없는 옵션은 오류입니다.

| 명령어 | 하는 일 |
| --- | --- |
| `tokengraph [view]` | 실시간 터미널 뷰를 엽니다: 연간 히트맵, 모델, 에이전트, 연속 일수. `--print`는 정적 스냅샷을 출력합니다. 터미널에서의 기본 명령어입니다. |
| `tokengraph login` | GitHub에 연결하고, 그래프를 내 gist에 게시하고, README 스니펫을 출력합니다. GitHub CLI에 로그인되어 있으면 그것을 사용하고(`--gh`), 아니면 브라우저에서 승인하는 일회용 코드를 사용합니다(`--device`, `--no-open`). gist 권한만 요청합니다. |
| `tokengraph logout` | 이 컴퓨터에서 GitHub 로그인 정보를 지웁니다. 로컬 데이터와 gist는 그대로 남습니다. |
| `tokengraph sync` | 모든 에이전트의 로그를 원장에 읽어 들이고, 로그인되어 있으면 게시합니다. `--since <days>`는 얼마나 과거까지 읽을지 정하며(기본 90), `--local`은 네트워크를 전혀 사용하지 않습니다. |
| `tokengraph readme` | README 스니펫을 출력하고 복사합니다. `--compact`, `--colors model\|single`. |
| `tokengraph story` | 스토리 카드를 그리고, PNG를 저장하고(`--out <dir>`을 주지 않으면 다운로드 폴더에), 휴대폰으로 보낼지 묻습니다. `--template skyline\|receipt\|sticker\|all`, `--range today\|7d\|30d\|1y`, `--no-cost`, `--qr` / `--no-qr`, `--no-preview`, `--handle <name>`. |
| `tokengraph status [--json]` | GitHub 계정, 원장, 내 컴퓨터 목록, 설치되어 정상 동작 중인 백그라운드 동기화, 그리고 Claude Code, Gemini CLI, Qwen Code가 로그를 보관하는 기간을 보여 줍니다. 보관 기간이 짧아 기록이 사라질 위험이 있을 때는 경고합니다. `--json`은 스크립트와 AI 에이전트용으로 하나의 JSON 객체로 출력합니다. |
| `tokengraph install-hook --agent <claude-code\|cursor\|codex>` | 해당 에이전트가 끝날 때 백그라운드 동기화를 시작하게 합니다. `--remove`는 제거하고, `--dry-run`은 바뀔 내용을 보여 줍니다. |
| `tokengraph schedule` | 한 시간마다 도는 백그라운드 동기화를 설치합니다: macOS에서는 launchd, Linux에서는 cron, Windows에서는 작업 스케줄러. `schedule --remove`로 끕니다. |
| `tokengraph export` | 일별 사용량을 CSV 또는 JSON으로 씁니다. 날짜, 에이전트, 모델, 요금 등급마다 한 행이며, 가중 토큰 수와 예상 비용이 들어 있습니다. `--format csv\|json`, `--out <file>`, `--since <date>`, `--all-machines`. 원장만 읽습니다. |
| `tokengraph import cursor <file.csv>` | 훅을 설치하기 전의 Cursor 기록을 추가합니다. Cursor 대시보드에서 사용량 CSV를 내려받아(Usage, export CSV) 여기에 넘기세요. 같은 파일이나 일부 겹치는 파일을 두 번 가져와도 두 번 더해지지 않습니다. 한 컴퓨터에서만 가져오세요. 컴퓨터별 값은 합산되므로 같은 파일을 두 컴퓨터에서 가져오면 두 번 집계됩니다. 게시는 하지 않습니다. |
| `tokengraph uninstall` | Claude Code, Cursor, Codex 훅과 한 시간마다 도는 스케줄을 제거합니다. `--purge`는 `~/.tokengraph`에 있는 tokengraph 자체 파일(원장, 로그인 정보, 로그, Cursor 이벤트 파일과 가져오기 파일)도 삭제하고 그 밖의 파일은 그대로 둡니다. `--yes`는 확인을 건너뛰고, `--dry-run`은 아무것도 바꾸지 않습니다. gist는 절대 건드리지 않습니다. |

훅과 스케줄은 설치된 프로그램의 경로를 저장하므로, 사용하기 전에 tokengraph를 전역으로 설치하세요(`npm install -g tokengraph`). 둘 다 `npx` 캐시에서는 실행을 거부합니다.

## 여러 컴퓨터

각 컴퓨터는 자기 파일 `machine-<id>.json`을 secret 데이터 gist에 씁니다. 동기화하면 그래프는 이 컴퓨터와 다른 모든 컴퓨터의 파일을 날짜별·모델별로 합산해 만들어지므로, 노트북과 데스크톱이 하나의 그래프로 나타납니다. 이 파일들은 백업도 됩니다. 재설치하거나 `~/.tokengraph`를 지운 뒤에도 `tokengraph login`이 내 컴퓨터를 알아보고 기록을 복원하며, 아무것도 두 번 세지 않습니다.

## FAQ

**왜 gist인가요?** 무료이고, 내 소유이며, 이미지는 GitHub가 제공하고 캐시하고, 누가 운영하거나 믿거나 중단시킬 서버가 없기 때문입니다. tokengraph가 내일 사라져도 그래프는 계속 동작합니다.

**비용은 실제 금액인가요?** 날짜가 붙은 가격표를 바탕으로 공개 API 정가 기준으로 낸 추정치입니다. 실제 청구 금액이 아니며, 청구 금액은 요금제에 따라 달라집니다. 가격을 알 수 없는 모델은 합계에서 빼고 가격 미정으로 표시하며 $0으로 세지 않으므로, 합계는 하한값일 수밖에 없습니다.

**왜 가중 토큰인가요?** 원시 합계의 대부분은 캐시 읽기이며, 싸지만 양이 많습니다. 10분의 1로 세면 그래프가 실제로 한 작업을 반영합니다. 계산식은 [동작 방식](#동작-방식)에 있습니다.

**오프라인에서 동작하나요?** 네. `view`, `story`, `status`, `export`, `import`, `sync --local`은 네트워크를 쓰지 않습니다. 게시할 때만 GitHub가 필요합니다.

**그만두려면 어떻게 하나요?** `tokengraph uninstall`은 Claude Code, Cursor, Codex 훅과 한 시간마다 도는 스케줄을 제거합니다. `--purge`를 더하면 `~/.tokengraph`에 있는 tokengraph 자체 파일(원장, 로그인 정보, 로그, Cursor 이벤트 파일과 가져오기 파일)도 삭제합니다. 그 폴더의 나머지는 그대로 남습니다.
그다음 `npm uninstall -g tokengraph`를 실행하세요. gist는 직접 삭제하기 전까지 GitHub에 남아 있습니다.

**Windows는요?** 경로, 훅, 한 시간마다 도는 작업 스케줄러 작업은 Windows용으로 작성되었지만 tokengraph는 macOS와 Linux에서 개발되므로 거친 부분이 있을 수 있습니다. 문제가 있으면 이슈를 열어 주세요.

## 기여하기

버그 리포트와 풀 리퀘스트를 환영합니다. [CONTRIBUTING.md](https://github.com/altindalorcun/tokengraph/blob/main/CONTRIBUTING.md)를 참고하세요. 새 에이전트는 어댑터 PR로 추가됩니다. tokengraph가 무엇을 위한 것이고 무엇을 하지 않는지는 [제품 노트](https://github.com/altindalorcun/tokengraph/blob/main/docs/product.md)에 있습니다.

---

tokengraph 덕분에 프로필이 더 좋아졌다면, ⭐ 하나가 다른 사람들이 tokengraph를 찾는 데 도움이 됩니다.

## 라이선스

MIT. [LICENSE](https://github.com/altindalorcun/tokengraph/blob/main/LICENSE)를 참고하세요. 포함된 서드파티 구성 요소는
[THIRD-PARTY-NOTICES.md](https://github.com/altindalorcun/tokengraph/blob/main/packages/cli/THIRD-PARTY-NOTICES.md)를 참고하세요.
