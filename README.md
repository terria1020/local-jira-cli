# local-jira-cli

Atlassian `acli`를 안전하게 감싸는 최소 래퍼 CLI PoC입니다.

목적:
- AI가 임의 명령을 실행하지 못하도록 명령을 allowlist로 제한
- `.env`를 CLI 프로세스 내부에서만 로드해 토큰/설정 노출 경계 분리
- 출력 형식을 JSON으로 강제해 후처리 안정성 확보

## 설치

```bash
cd /Users/jaehan1346/Github/local-jira-cli
npm install
```

## 환경 변수

```bash
cp .env.example .env
```

- `ACLI_PATH` (선택): 기본 `acli`
- `JIRA_DEFAULT_PROJECT` (선택): `ticket-list`에서 `--jql` 생략 시 사용

## 사용법

```bash
node local-jira-cli.js --help
```

지원 명령(allowlist):
- `board-list`
- `ticket-list`
- `ticket-show`
- `comment-list`
- `comment-add`
- `comment-delete`
- `transition`

예시:

```bash
# 실제 실행 없이 ACLI 명령 확인
node local-jira-cli.js ticket-list --project TEAM --limit 20 --dry-run

# 이슈 상세
node local-jira-cli.js ticket-show --key TEAM-123

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
