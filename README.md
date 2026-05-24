# local-jira-cli

Atlassian `acli`를 안전하게 감싸는 최소 래퍼 CLI PoC입니다.

목적:
- AI가 임의 명령을 실행하지 못하도록 명령을 allowlist로 제한
- `.env`를 CLI 프로세스 내부에서만 로드해 토큰/설정 노출 경계 분리
- 출력 형식을 JSON으로 강제해 후처리 안정성 확보 (단, acli가 `--json`을 지원하지 않는 명령은 stdout 텍스트를 그대로 감싸 반환)

대상 acli 버전: **1.3.18-stable** (2026-05 기준 실호출 검증 완료)

---

## 1. 사전 준비 — ACLI 설치

macOS Homebrew 기준:

```bash
brew install atlassian/acli/acli
acli --version    # 예: acli version 1.3.18-stable
```

> `brew install --cask` 아닙니다. 정식 tap이 formula로 등록되어 있습니다.

공식 문서: https://developer.atlassian.com/cloud/acli/

---

## 2. ACLI 인증 (최초 1회)

ACLI는 2가지 인증 방식을 지원합니다.

### 방법 A. 웹 브라우저 OAuth (대화형 환경에서 권장)

```bash
acli jira auth login --web
```

브라우저가 열리면 Atlassian 로그인 후 사이트를 선택합니다.

### 방법 B. API 토큰 (스크립트/CI/AI 도구용)

1. https://id.atlassian.com/manage-profile/security/api-tokens 에서 토큰 발급
2. 토큰을 파일에 저장 (히스토리에 평문 노출 방지):

```bash
cat > ~/.atlassian_token   # 토큰 붙여넣고 Ctrl+D
chmod 600 ~/.atlassian_token
```

3. 로그인 (세 플래그 모두 필수):

```bash
acli jira auth login \
  --site <your-workspace>.atlassian.net \
  --email <your-email> \
  --token < ~/.atlassian_token
```

성공 시 `✓ Authentication successful` 메시지가 출력됩니다.

### 인증 상태 확인

```bash
acli jira auth status
```

### 멀티 사이트 / 멀티 계정

ACLI는 사이트별로 자격증명을 저장합니다. 사이트를 여러 개 등록하려면 각각 위 절차를 반복하면 되며, 호출 시 활성 사이트가 적용됩니다. 정확한 사이트 전환 명령은 `acli jira auth --help`, `acli config --help`를 참고하세요.

---

## 3. 래퍼 설치

```bash
cd /Users/jaehan1346/Github/local-jira-cli
npm install
```

## 4. 환경 변수

```bash
cp .env.example .env
```

- `ACLI_PATH` (선택): 기본 `acli`. PATH 외 위치라면 절대 경로를 지정
- `JIRA_DEFAULT_PROJECT` (선택): `ticket-list`에서 `--jql` 생략 시 사용
- `JIRA_SITE` 또는 `JIRA_BASE_URL` (선택): `transition-list`, 스프린트 이동 REST 호출에 사용
- `JIRA_EMAIL` (선택): `transition-list`, 스프린트 이동 REST 호출에 사용
- `JIRA_API_TOKEN_FILE` 또는 `JIRA_API_TOKEN` (선택): `transition-list`, 스프린트 이동 REST 호출에 사용. 파일 방식 권장

## 5. 사용법

```bash
node local-jira-cli.js --help
```

지원 명령(allowlist):

| 래퍼 명령 | acli | 종류 |
|---|---|---|
| `board-list` | `jira board search` | 조회 |
| `ticket-list` | `jira workitem search` | 조회 |
| `ticket-show` | `jira workitem view <KEY>` | 조회 |
| `comment-list` | `jira workitem comment list` | 조회 |
| `ticket-context` | `workitem view` + `comment list` | 조회 조합 |
| `ticket-tree` | `workitem view` + `workitem search parent = ...` | 조회 조합 |
| `transition-list` | Jira REST `/transitions` | 조회 |
| `sprint-list` | `jira board list-sprints` | 조회 |
| `sprint-resolve` | `board search` + `board list-sprints` | 조회 조합 |
| `ticket-sprint-move` | Jira REST sprint/backlog issue move | 쓰기 (`--yes` 필수) |
| `comment-add` | `jira workitem comment create` | 쓰기 (`--yes` 필수) |
| `comment-delete` | `jira workitem comment delete` | 쓰기 (`--yes` 필수) |
| `transition` | `jira workitem transition` | 쓰기 (`--yes` 필수) |
| `project-overview` | `board search` + `workitem search` + `board list-sprints` | 조회 조합 |
| `ticket-create` | `jira workitem create` + 선택적 sprint/backlog move | 쓰기 (`--yes` 필수) |
| `ticket-update` | `jira workitem edit` | 쓰기 (`--yes` 필수) |

쓰기 명령은 `--yes` 또는 `--dry-run` 없으면 래퍼 차원에서 `CONFIRMATION_REQUIRED`로 차단됩니다.

예시:

```bash
# 실제 실행 없이 ACLI 명령 확인
node local-jira-cli.js ticket-list --project TEAM --limit 20 --dry-run

# 보드 목록 (프로젝트 필터)
node local-jira-cli.js board-list --project TEAM

# 티켓 목록 (프로젝트 기본 정렬: updated DESC)
node local-jira-cli.js ticket-list --project TEAM --limit 20

# 임의 JQL
node local-jira-cli.js ticket-list --jql "assignee = currentUser() AND statusCategory != Done"

# 티켓 상세
node local-jira-cli.js ticket-show --key TEAM-123

# 티켓 컨텍스트 (상세 + 부모/하위작업 + 링크 + 최근 댓글)
node local-jira-cli.js ticket-context --key TEAM-123 --comments 10

# 티켓 트리 (부모/자식 관계 탐색)
node local-jira-cli.js ticket-tree --key TEAM-123 --depth 2 --limit 50

# 프로젝트 오버뷰 (보드 + 활성/예정 스프린트 + 최근 티켓)
node local-jira-cli.js project-overview --project TEAM --limit 20 --board-limit 5

# 스프린트 목록
node local-jira-cli.js sprint-list --project TEAM --board-name "SP 보드" --state active,future

# 스프린트 alias 해석: current/this-week/이번주, next/next-week/다음주, backlog/none, id:<ID>, name:<NAME>
node local-jira-cli.js sprint-resolve --project TEAM --target current

# 티켓을 현재 스프린트로 이동
node local-jira-cli.js ticket-sprint-move --key TEAM-123 --project TEAM --target current --yes

# 티켓을 backlog로 이동
node local-jira-cli.js ticket-sprint-move --key TEAM-123 --target backlog --yes

# 가능한 상태 전이 후보 조회 (JIRA_SITE/JIRA_EMAIL/JIRA_API_TOKEN_FILE 필요)
node local-jira-cli.js transition-list --key TEAM-123

# 댓글 목록
node local-jira-cli.js comment-list --key TEAM-123 --limit 20

# 댓글 추가 (쓰기 명령은 --yes 필수)
node local-jira-cli.js comment-add --key TEAM-123 --body "작업 시작" --yes

# 댓글 삭제
node local-jira-cli.js comment-delete --key TEAM-123 --id 79216 --yes

# 상태 전이
node local-jira-cli.js transition --key TEAM-123 --status "진행 중" --yes

# 티켓 생성 후 현재 스프린트에 배치
node local-jira-cli.js ticket-create --project TEAM --type 작업 --summary "작업 제목" --parent TEAM-1 --sprint current --yes

# 티켓 수정 (본문은 파일 기반 권장)
node local-jira-cli.js ticket-update --key TEAM-123 --description-file ./description.md --yes
```

## 실험 범위 (PoC)

이 프로젝트는 `acli` 전체 기능을 재구현하지 않습니다.
안전한 래핑 경계와 최소 업무 플로우 검증만 목표로 합니다.

## 정리

```bash
rm -rf node_modules
```
