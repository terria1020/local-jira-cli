# local-jira-cli

Jira Cloud를 AI 도구에서 안전하게 다루기 위한 로컬 전용 CLI 래퍼입니다.

이 프로젝트는 Atlassian `acli`만 감싸는 단순 래퍼가 아닙니다. **기본 Jira 작업은 ACLI로 실행하고, ACLI가 현재 직접 제공하지 않는 일부 기능은 Jira Cloud REST API로 보강**합니다. 대표적으로 전이 후보 조회와 스프린트/백로그 이슈 이동은 REST API를 사용합니다.

기준:
- 대상 ACLI: `1.3.18-stable`
- 검증 시점: 2026-05-24
- 대상 플랫폼: Jira Cloud

공식 문서:
- Atlassian CLI: https://developer.atlassian.com/cloud/acli/guides/introduction/
- Jira Software Cloud REST API: https://developer.atlassian.com/cloud/jira/software/rest/
- Sprint REST API: https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/

---

## 목적

- AI가 임의 Jira 명령을 실행하지 못하도록 명령을 allowlist로 제한합니다.
- `.env`를 CLI 프로세스 내부에서만 로드해 토큰/설정 노출 범위를 줄입니다.
- 쓰기 명령은 `--yes` 없이는 실행하지 않습니다.
- 가능한 출력은 `{ ok, result }` 형태의 JSON으로 감싸 후처리를 안정화합니다.
- ACLI와 REST API의 사용 경계를 명확히 나눕니다.

## 구조

```text
local-jira-cli
├─ ACLI 기반 명령
│  ├─ ticket-list, ticket-show
│  ├─ comment-list, comment-add, comment-delete
│  ├─ board-list, sprint-list
│  ├─ transition
│  ├─ ticket-create, ticket-update
│  └─ 여러 조회 조합 명령의 내부 호출
└─ Jira REST API 기반 명령
   ├─ transition-list
   ├─ ticket-sprint-move
   └─ ticket-create --sprint ... 의 후속 스프린트/백로그 이동
```

ACLI는 일반적인 Jira work item, comment, board, sprint 조회/수정에 사용합니다. Jira Software REST API는 ACLI에 없는 기능을 좁게 보강하는 용도입니다.

## 설치

### macOS Homebrew

Atlassian 공식 tap을 먼저 등록한 뒤 설치합니다.

```bash
brew tap atlassian/homebrew-acli
brew install acli
acli --version
```

### macOS 직접 다운로드

Homebrew를 사용하지 않는 경우 Atlassian 배포 바이너리를 내려받아 실행 권한을 부여합니다.

```bash
# Apple Silicon
curl -LO "https://acli.atlassian.com/darwin/latest/acli_darwin_arm64/acli"

# Intel Mac은 위 명령 대신 다음 URL 사용
# curl -LO "https://acli.atlassian.com/darwin/latest/acli_darwin_amd64/acli"

chmod +x ./acli
./acli --version
```

전역 실행이 필요하면 `acli` 바이너리를 PATH에 포함된 위치로 옮기거나, 해당 절대 경로를 `.env`의 `ACLI_PATH`에 설정합니다.

프로젝트 의존성 설치:

```bash
cd /Users/jaehan1346/Github/local-jira-cli
npm install
```

도움말 확인:

```bash
node local-jira-cli.js --help
```

## 인증과 환경 변수

### ACLI 인증

ACLI 기반 명령은 ACLI 자체 인증을 사용합니다.

웹 로그인:

```bash
acli jira auth login --web
```

API 토큰 로그인:

```bash
cat > ~/.atlassian_token
chmod 600 ~/.atlassian_token

acli jira auth login \
  --site <your-workspace>.atlassian.net \
  --email <your-email> \
  --token < ~/.atlassian_token
```

인증 상태 확인:

```bash
acli jira auth status
```

### REST API 설정

`transition-list`, `ticket-sprint-move`, `ticket-create --sprint ...`는 Jira REST API를 사용하므로 아래 값이 필요합니다.

```bash
cp .env.example .env
```

설정값:

| 변수 | 용도 |
|---|---|
| `ACLI_PATH` | ACLI 실행 파일 경로. 기본값은 `acli` |
| `JIRA_DEFAULT_PROJECT` | `--project` 생략 시 사용할 기본 프로젝트 |
| `JIRA_SITE` 또는 `JIRA_BASE_URL` | REST API 대상 Jira 사이트 |
| `JIRA_EMAIL` | REST API Basic auth 이메일 |
| `JIRA_API_TOKEN_FILE` | REST API 토큰 파일 경로. 권장 |
| `JIRA_API_TOKEN` | REST API 토큰 문자열. 파일 방식이 더 안전함 |

예:

```dotenv
ACLI_PATH=acli
JIRA_DEFAULT_PROJECT=SD
JIRA_SITE=mobigen.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN_FILE=~/.atlassian_token
```

주의:
- ACLI 인증 정보와 REST API 설정은 별도입니다.
- REST API 명령은 ACLI 로그인만으로는 동작하지 않습니다.
- 토큰은 가능하면 `JIRA_API_TOKEN_FILE`로 전달하고, 쉘 히스토리에 직접 남기지 마세요.

## 안전장치

쓰기 명령은 `--yes` 또는 `--dry-run` 없으면 실패합니다.

```json
{
  "ok": false,
  "code": "CONFIRMATION_REQUIRED"
}
```

권장 순서:

```bash
node local-jira-cli.js <write-command> ... --dry-run
node local-jira-cli.js <write-command> ... --yes
```

`--dry-run`은 실제 변경 없이 실행될 ACLI/REST 단계를 JSON으로 보여줍니다.

## 명령 목록

| 명령 | 구현 | 종류 | 설명 |
|---|---|---|---|
| `board-list` | ACLI | 조회 | 프로젝트/이름/타입 기준 보드 검색 |
| `ticket-list` | ACLI | 조회 | JQL 또는 프로젝트 기준 티켓 검색 |
| `ticket-show` | ACLI | 조회 | 단일 티켓 상세 조회 |
| `ticket-context` | ACLI 조합 | 조회 | 티켓 상세, 부모, 하위작업, 링크, 최근 댓글 요약 |
| `ticket-tree` | ACLI 조합 | 조회 | 부모/자식 관계 트리 조회 |
| `comment-list` | ACLI | 조회 | 댓글 목록 조회 |
| `comment-add` | ACLI | 쓰기 | 댓글 추가 |
| `comment-delete` | ACLI | 쓰기 | 댓글 삭제. ACLI JSON 미지원 출력은 stdout 래핑 |
| `transition-list` | REST | 조회 | 가능한 상태 전이 후보 조회 |
| `transition` | ACLI | 쓰기 | 상태 전이 실행 |
| `sprint-list` | ACLI | 조회 | 보드의 스프린트 목록 조회 |
| `sprint-resolve` | ACLI 조합 | 조회 | `current`, `next`, `backlog` 등 alias 해석 |
| `ticket-sprint-move` | REST | 쓰기 | 티켓을 스프린트 또는 백로그로 이동 |
| `project-overview` | ACLI 조합 | 조회 | 보드, 스프린트, 최근 티켓, 상태 카운트 요약 |
| `ticket-create` | ACLI + REST 선택 | 쓰기 | 티켓 생성, 필요 시 생성 후 스프린트/백로그 이동 |
| `ticket-update` | ACLI | 쓰기 | 요약, 본문 파일, 라벨, 담당자 등 제한적 수정 |

## 읽기 워크플로우

프로젝트 최근 티켓:

```bash
node local-jira-cli.js ticket-list --project TEAM --limit 20
```

임의 JQL:

```bash
node local-jira-cli.js ticket-list --jql "assignee = currentUser() AND statusCategory != Done"
```

티켓 상세:

```bash
node local-jira-cli.js ticket-show --key TEAM-123
```

AI 작업 전 컨텍스트 수집:

```bash
node local-jira-cli.js ticket-context --key TEAM-123 --comments 10
```

부모/하위작업 구조 확인:

```bash
node local-jira-cli.js ticket-tree --key TEAM-123 --depth 2 --limit 50
```

프로젝트/보드 현황 요약:

```bash
node local-jira-cli.js project-overview --project TEAM --limit 20 --board-limit 5
```

## 댓글과 상태 전이

댓글 추가:

```bash
node local-jira-cli.js comment-add --key TEAM-123 --body "작업 시작" --dry-run
node local-jira-cli.js comment-add --key TEAM-123 --body "작업 시작" --yes
```

긴 댓글은 파일 사용을 권장합니다.

```bash
node local-jira-cli.js comment-add --key TEAM-123 --body-file ./comment.md --yes
```

상태 전이 후보 조회:

```bash
node local-jira-cli.js transition-list --key TEAM-123
```

상태 전이:

```bash
node local-jira-cli.js transition --key TEAM-123 --status "진행 중" --dry-run
node local-jira-cli.js transition --key TEAM-123 --status "진행 중" --yes
```

`transition-list`는 REST API를 사용합니다. 가능한 후보에 없는 상태명은 임의로 전이하지 마세요.

## 스프린트와 백로그

스프린트는 프로젝트가 아니라 Scrum 보드에 연결됩니다. 프로젝트에 Scrum 보드가 여러 개 있으면 `--board-id` 또는 `--board-name`을 지정해야 합니다.

스프린트 목록:

```bash
node local-jira-cli.js sprint-list --project TEAM --board-name "SP 보드" --state active,future
```

스프린트 alias 해석:

```bash
node local-jira-cli.js sprint-resolve --project TEAM --target current
node local-jira-cli.js sprint-resolve --project TEAM --target next
node local-jira-cli.js sprint-resolve --project TEAM --target id:8242
node local-jira-cli.js sprint-resolve --project TEAM --target name:05/03주
```

지원 alias:

| alias | 의미 |
|---|---|
| `current`, `this-week`, `active`, `이번주` | active 스프린트 중 시작일이 가장 빠른 것 |
| `next`, `next-week`, `future`, `다음주` | future 스프린트 중 시작일이 가장 빠른 것 |
| `backlog`, `none`, `no-sprint`, `백로그` | 스프린트 없음, 백로그 |
| `id:<ID>` 또는 숫자 | 특정 스프린트 ID |
| `name:<NAME>` 또는 정확한 이름 | 특정 스프린트 이름 |

티켓을 현재 스프린트로 이동:

```bash
node local-jira-cli.js ticket-sprint-move --key TEAM-123 --project TEAM --target current --dry-run
node local-jira-cli.js ticket-sprint-move --key TEAM-123 --project TEAM --target current --yes
```

티켓을 백로그로 이동:

```bash
node local-jira-cli.js ticket-sprint-move --key TEAM-123 --target backlog --dry-run
node local-jira-cli.js ticket-sprint-move --key TEAM-123 --target backlog --yes
```

제약:
- 스프린트 이동은 REST API를 사용합니다.
- `current`는 active 스프린트가 없으면 실패합니다.
- `next`는 future 스프린트가 없으면 실패합니다.
- 한 번에 이동 가능한 이슈는 최대 50개로 제한합니다.

## 티켓 생성과 수정

기본 티켓 생성:

```bash
node local-jira-cli.js ticket-create \
  --project TEAM \
  --type 작업 \
  --summary "작업 제목" \
  --parent TEAM-1 \
  --dry-run
```

생성 후 현재 스프린트에 배치:

```bash
node local-jira-cli.js ticket-create \
  --project TEAM \
  --type 작업 \
  --summary "작업 제목" \
  --parent TEAM-1 \
  --sprint current \
  --yes
```

본문 파일로 생성:

```bash
node local-jira-cli.js ticket-create \
  --project TEAM \
  --type 작업 \
  --summary "작업 제목" \
  --description-file ./description.md \
  --yes
```

본문 수정:

```bash
node local-jira-cli.js ticket-update --key TEAM-123 --description-file ./description.md --dry-run
node local-jira-cli.js ticket-update --key TEAM-123 --description-file ./description.md --yes
```

요약 수정:

```bash
node local-jira-cli.js ticket-update --key TEAM-123 --summary "새 제목" --yes
```

참고:
- `ticket-create --sprint ...`는 먼저 ACLI로 이슈를 만들고, 생성된 키를 추출한 뒤 REST API로 스프린트/백로그 이동을 수행합니다.
- ACLI `--parent`는 Jira issue key 형식(`TEAM-1`) 사용을 권장합니다.
- 긴 본문은 쉘 quoting 문제를 피하려고 `--description-file`을 권장합니다.

## 출력 계약

성공:

```json
{
  "ok": true,
  "result": {}
}
```

dry-run:

```json
{
  "ok": true,
  "dryRun": true,
  "steps": []
}
```

실패:

```json
{
  "ok": false,
  "code": "VALIDATION_ERROR",
  "message": "...",
  "details": {}
}
```

일부 ACLI 명령이 JSON 출력을 지원하지 않는 경우에는 stdout 텍스트를 아래처럼 감싸 반환합니다.

```json
{
  "ok": true,
  "result": {
    "stdout": "..."
  }
}
```

## 검증 메모

2026-05-24 기준으로 다음 흐름을 실제 Jira Cloud에서 확인했습니다.

- `board-list --project SD`: `SP 보드` 조회
- `ticket-context --key SD-509`: 티켓 상세, 부모 에픽, 댓글 조회
- `transition-list --key SD-509`: REST 기반 전이 후보 조회
- `sprint-list --project SD --board-name "SP 보드"`: active 스프린트 조회
- `sprint-resolve --target current`: active 스프린트 해석
- `ticket-create --parent SD-8 --sprint current`: `기타` 에픽 아래 이슈 생성 후 현재 스프린트 배치
- `ticket-sprint-move --target backlog`: 생성한 테스트 이슈를 백로그로 이동

검증 중 `next` alias는 future 스프린트가 없어 `NOT_FOUND`로 실패했습니다. 이는 의도된 동작입니다.

## 범위

이 프로젝트는 ACLI 전체 기능이나 Jira REST API 전체를 재구현하지 않습니다. AI 도구가 반복적으로 쓰는 최소 업무 흐름을 안전하게 allowlist로 감싸는 것이 목적입니다.

## 정리

```bash
rm -rf node_modules
```
