# 실행기 기술 타당성 검증 기록 (PRD §11 Phase 0, §15 · §19 P0)

검증 일시는 2026-11-07이고, 개발 컨테이너(Linux x86_64, Node 22)에서 수행했습니다. 같은 판정을 Telegram `/executors`, `aa doctor`, `aa config` → 현재 상태에서 실시간으로 볼 수 있습니다. 운영 서버에서는 `aa verify <실행기>`(또는 설정의 AI 구독 단계)로 직접 검증하고 근거를 기록하세요.

## 1. 공식 구독 실행기

| 실행기 | 버전 | 확인한 공식 인터페이스 | 실제 연동 결과 | 판정 |
|---|---|---|---|---|
| Claude Code CLI (`claude-cli`) | 2.1.319 | `claude -p --output-format json`, `--resume`, `--model`, `--permission-mode`, `--allowedTools/--disallowedTools`, `claude auth status --json` (`loggedIn`, `authMethod`, `apiProvider`) | 구독 OAuth 인증(`authMethod=oauth_token`, `apiProvider=firstParty`) 상태에서 읽기 전용 검증 실행에 성공했습니다(3초, 공식 usage 수신, 출력 일치). 이어서 **Phase 1 수직 슬라이스 전체를 실제 CLI로 실행**했습니다: 기획 → 구현(파일 2개 생성) → `node --test` 통과 → 리뷰 승인 → 사용자 확인 → 완료, 약 60초. | **실행 지원 (검증됨)** |
| Codex CLI (`codex-cli`) | 0.167.0 | `codex exec --json -C . --sandbox read-only\|workspace-write`, `codex exec resume <id>`, `-m`, `-i`, `codex login status` | 설치와 명령 표면은 확인했습니다. 이 환경은 `Not logged in` 상태라 실행 검증은 하지 못했습니다. | **실행 미확인** (ChatGPT 로그인 후 `verify-executor codex-cli`) |
| Codex Cloud (`codex-cloud`) | 0.167.0 | `codex cloud exec --env <ENV_ID> [--branch]`, `codex cloud status <TASK_ID>`, `codex cloud diff`, `codex cloud apply` (모두 `[EXPERIMENTAL]`) | 공식 취소 명령이 없습니다. 출력 형식도 고정되어 있지 않습니다. 로그인과 환경 ID가 없어 실행 검증은 하지 못했습니다. | **실행·상태조회·결과수집 미확인, 취소 미지원.** 검증 기록이 생기기 전에는 자동 선택하지 않습니다. |
| Claude Code cloud session (`claude-cloud`) | 2.1.319 | `--cloud [description\|session_id\|url]` 옵션의 존재 | 헤드리스 상태에서 세션 생성, 상태 조회, 결과 수집을 하는 공식 계약을 확인하지 못했습니다. | **미확인 — 비활성.** 격리된 Local CLI로 실행합니다. |

### 추가 실행기 (Gemini, Cursor)

| 실행기 | 버전 | 확인한 공식 인터페이스 | 실제 연동 결과 | 판정 |
|---|---|---|---|---|
| Gemini CLI (`gemini-cli`) | 0.67.0 | `-p`, `-o json`, `-m`, `--approval-mode plan\|auto_edit\|yolo`, `~/.gemini/settings.json`의 `security.auth.selectedType` | 인증이 없을 때 JSON 오류를 반환하는 것(code 41)과 인증 감지를 확인했습니다. 로그인이 없어 실행 검증은 하지 못했습니다. | **실행 미확인** (기능 플래그, 검증 필요) |
| Cursor Agent CLI (`cursor-cli`) | 2026.11.05 | `-p --output-format json`, `--mode plan`, `--resume [chatId]`, `--force`, `status --format json` | `status`가 "Not logged in"을 반환하는 것을 확인했습니다. 실행 검증은 하지 못했습니다. | **실행 미확인** (기능 플래그, 검증 필요) |

### 기능별 지원 범위

| 기능 | claude-cli | codex-cli | codex-cloud |
|---|---|---|---|
| 실행·결과 수집 | 지원 (검증됨) | 미확인 | 미확인 |
| 취소 | 지원: AgentAgency가 자식 프로세스 그룹을 종료합니다 | 지원: 프로세스 종료 | **미지원**: 결과 반영만 중단하고, 그 사실을 사용자에게 알립니다 |
| 재개 | 지원 (`--resume`) | 미확인 (`exec resume`) | 미지원 |
| 모델 선택 | 지원 (`auto`/opus/sonnet/haiku/`claude-*`) | 미확인. `auto`만 허용합니다 | 미지원 |
| 사용량 | 토큰 usage는 공식 값입니다. 비용 필드는 API 환산 추정치로 표시합니다 | 미확인 | 미지원 |
| 남은 구독 쿼터 | 공식 제공되지 않습니다. 한도 도달 메시지만 감지하며, 이를 추정으로 표시합니다 | 동일 | 동일 |
| 이미지 입력 | 미확인 | 미확인 (`-i`) | — |
| 음성 전사 | 미지원 | 미지원 | — |

### 유료 API 자동 전환 방지

- **환경변수 차단**: 모든 CLI 자식 프로세스의 환경에서 아래 변수를 제거합니다. 단위 테스트로 확인했습니다.
  - Anthropic: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`
  - OpenAI: `OPENAI_API_KEY`, `CODEX_API_KEY`
  - Bedrock/Vertex 전환 변수
- **API 키 로그인 비활성**: CLI가 API 키 방식으로 로그인되어 있으면 "공식 구독 인증이 아님"으로 판정하고 그 실행기를 쓰지 않습니다.
- **`paid_api` 실행기**:
  - 우선순위에 명시하고 `aa config` → 종량제 유료 API에서 허용해야만 후보가 됩니다.
  - 그래도 사용할 때마다 작업 단위 승인과 재확인이 필요합니다.
  - 테스트로 호출 0회를 확인했습니다.

## 2. Telegram

- 이 환경에서 Telegram Bot API(`api.telegram.org`)에 도달할 수 있었습니다. 가짜 토큰으로 `getMe`를 호출하면 401이 돌아오고, 설정 화면은 이를 정확히 실패로 표시합니다.
- 실제 봇 토큰이 없어서 아래 항목은 실서비스 검증을 하지 못했습니다. 모두 코드와 진단은 구현되어 있습니다.
  - Topic 생성, 고정 메시지, 인라인 승인
  - 설정의 권한 진단(포럼 여부, Manage Topics, Pin Messages)
  - 운영 서버의 엔드투엔드 스모크 테스트

## 3. GitHub

- **오프라인 검증**: 브랜치, 커밋, push, PR 생성·병합 흐름은 실제 로컬 Git 원격 저장소와 인메모리 GitHub 대역으로 검증했습니다.
- **실서비스 미검증**: 이 환경에는 유효한 GitHub 토큰이 없어(`Bad credentials`) 실제 GitHub API 호출은 하지 못했습니다. GitHub App(JWT, RS256) 서명은 단위 테스트로 검증했습니다.

## 4. 통과 기준 판단

PRD Phase 0 통과 기준은 "최소 1개 공식 구독 실행기에서 승인된 테스트 요청을 안전하게 실행하고 결과를 수집"하는 것입니다. **claude-cli로 충족했습니다.** 취소와 재개 지원 여부도 실행기별로 위 표처럼 식별됩니다.

남은 운영 서버 검증은 다음과 같습니다.

1. Codex CLI에 ChatGPT 로그인 후 `verify-executor codex-cli`를 실행합니다.
2. Codex Cloud 환경 ID를 설정한 뒤 `verify-executor codex-cloud`를 실행합니다.
3. 실제 Telegram 봇·그룹과 GitHub로 `aa setup`의 스모크 테스트를 실행합니다.
