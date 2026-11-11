# 아키텍처

```text
Telegram (single bot, long polling)      Terminal: install.sh · aa · agent-agency setup/config (src/cli)
        │                                   │  SetupService (src/setup) ─ control channel ─┐
  TelegramGateway (src/telegram) ──┐        │      optional web console (src/web, 127.0.0.1)│
                                   ▼        ▼                                              ▼
                         Orchestrator (src/core/orchestration)                     Runtime (bot restart,
     classifier · proposals/import · approvals · task control · /commands          GitHub/executor reload)
        │            │                 │                     │
 Communicator   Discussion       ApprovalEngine        Scheduler (src/core/scheduler)
 (dialogue      (1–3 agents,     (actor+nonce+expiry,  PostgreSQL job queue,
  renderer)      ≤3 rounds)       reconfirm)            resource-aware concurrency
        │                                                    │
        └──── WorkTypePlugin: CodingAgencyPlugin · ResearchAgencyPlugin ──┘
                plan → implement → quality gate → review → fix → PR → merge
                        │                 │
                  AgentRunner        WorkspaceManager (git worktree per task,
          (execution policy:         Local or Docker sandbox per project)
           cloud → local_cli,
           duplicate-run guard,
           paid API approval)
                        │
          ExecutorRegistry ── claude-cloud (detect) · codex-cloud (verify-gated)
                              claude-cli · codex-cli · gemini-cli · cursor-cli
                              (official subscription CLIs)
                        │
   ContextBuilder + MemoryService ── PostgreSQL (source of truth)
   Vault (AES-256-GCM) · Audit · Settings · Flags · FileStore (logs/screenshots)
   GitHubService (App or PAT) · Backup (logical JSON, S3-compatible upload)
```

## 저장소 분리 (PRD §17)

| 데이터 | 위치 | 구현 |
|---|---|---|
| 원본 대화 이벤트, 요약, 확정 결정 | PostgreSQL | `conversation_messages`, `conversation_summaries`(근거 메시지 ID 연결), `decisions`(confirmed/proposed) |
| 에이전트 정체성·모델·페르소나·관계·친밀도 | PostgreSQL | `agents`, `agent_personas`, `agent_relationships` |
| 프로젝트 기억·선호, 작업 상태·체크포인트 | PostgreSQL | `project_memories`(certainty, source_refs), `tasks.checkpoint` |
| 코드·문서·PR·테스트 정의 | GitHub | 작업별 브랜치/PR, PR 본문에 품질 게이트·리뷰 요약 |
| 실행 로그·스크린샷·첨부·임시 파일 | 배포 환경 파일 저장소 | `LocalFileStore`(30일/7일 보존, 진행 중 증거 예외) |

캐릭터 대사(`rendered_text`)와 기계 판독 상태(`machine_state`)는 같은 행 안에서도 다른 필드로 둡니다. 실행 성공 여부는 언제나 실행 기록(`executions`)과 품질 게이트 결과로 판단합니다.

## 실행 정책 (PRD §15)

1. `resolveExecutionPolicy`는 system → user → project → agent 순서로 설정을 덮어씁니다. 기본값은 `[cloud, local_cli]`, `autoFallback: true`, `paidApi.enabled: false`입니다.
2. `executorCandidates`는 에이전트 공급자의 실행기를 우선순위대로 나열합니다. 각 실행기의 사용 가능 여부와 그 사유를 함께 계산합니다.
3. 아래 조건 중 하나라도 해당하면 그 실행기는 건너뜁니다.
   - 공식 구독 인증이 아닙니다.
   - 실행 기능이 "미확인"인데 검증 기록이 없습니다.
   - 쿼터가 소진되었습니다.
4. 사용량 한도, 인증 만료, 실행 불가로 실패하면 다음 실행기로 넘어갑니다. 넘어가기 전에 이전 클라우드 작업(`executions.external_ref`)의 종료 여부를 조회합니다. 아직 실행 중이거나 상태를 알 수 없으면 중복 실행을 막기 위해 보류합니다.
5. 실행기가 바뀌면 이전 세션을 재개하지 않습니다. Context Builder가 PostgreSQL과 체크포인트에서 맥락을 다시 구성합니다.
6. `paid_api` 종류의 실행기는 다음 두 조건을 모두 만족할 때만 씁니다.
   - 운영자가 `aa config` → 종량제 유료 API에서 허용했습니다.
   - 해당 작업에 대한 `paid_api_usage` 승인이 있습니다(재확인 포함).

## 신뢰성

- **체크포인트**: 작업의 단계, 커밋, 품질 게이트, 리뷰, 세션 참조를 `tasks.checkpoint`에 병합 방식으로 기록합니다. 재시작하면 `Scheduler.recover()`가 마지막 단계부터 다시 시작합니다.
- **외부 효과 원장**: 저장소 생성, push, PR, 병합, Topic 생성은 `external_effects`의 멱등 키로 한 번만 실행합니다.
- **동시성**: 프로젝트당 한 작업씩 실행하고 전역 동시성에 상한을 둡니다(기본 2). 실제 CPU/RAM/디스크를 감지해 상한을 더 낮추거나 신규 작업을 미룹니다.
- **업그레이드**: 마이그레이션은 추가만 합니다. 앱보다 새 스키마의 DB에서는 기동을 거부합니다. `upgrade-check`가 호환성, 진행 중 작업, 사전 백업을 확인합니다.
