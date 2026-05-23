# local-jira-cli

Atlassian `acli`를 안전하게 감싸는 최소 래퍼 CLI PoC입니다.

목적:
- AI가 임의 명령을 실행하지 못하도록 명령을 allowlist로 제한
- `.env`를 CLI 프로세스 내부에서만 로드해 토큰/설정 노출 경계 분리
- 출력 형식을 JSON으로 강제해 후처리 안정성 확보

> ⚠️ **PoC 상태 알림**: 현재 ACLI 실제 호출 시 일부 명령은 acli 1.3.x 스펙과 맞지 않아 동작하지 않습니다 (`board-list`의 `--json` 미지원, `ticket-show`의 `--key` 미지원 등). 동작 검증된 명령: `ticket-list`, `comment-list`. 나머지는 매핑 수정 필요.

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

## 5. 사용법

```bash
node local-jira-cli.js --help
```

지원 명령(allowlist):
- `board-list` — ⚠️ 현재 acli 매핑 깨짐 (수정 예정)
- `ticket-list` — ✅ 동작 확인
- `ticket-show` — ⚠️ acli `--key` 미지원, 위치 인자로 변경 필요
- `comment-list` — ✅ 동작 확인
- `comment-add` — 미검증 (쓰기, `--yes` 필수)
- `comment-delete` — 미검증 (쓰기, `--yes` 필수)
- `transition` — 미검증 (쓰기, `--yes` 필수)

예시:

```bash
# 실제 실행 없이 ACLI 명령 확인
node local-jira-cli.js ticket-list --project TEAM --limit 20 --dry-run

# 티켓 목록 (프로젝트 기본 정렬: updated DESC)
node local-jira-cli.js ticket-list --project TEAM --limit 20

# 임의 JQL
node local-jira-cli.js ticket-list --jql "assignee = currentUser() AND statusCategory != Done"

# 댓글 목록
node local-jira-cli.js comment-list --key TEAM-123 --limit 20

# 댓글 추가 (쓰기 명령은 --yes 필수)
node local-jira-cli.js comment-add --key TEAM-123 --body "작업 시작" --yes

# 상태 전이
node local-jira-cli.js transition --key TEAM-123 --status "In Progress" --yes
```

## 실험 범위 (PoC)

이 프로젝트는 `acli` 전체 기능을 재구현하지 않습니다.
안전한 래핑 경계와 최소 업무 플로우 검증만 목표로 합니다.

## 정리

```bash
rm -rf node_modules
```
