# 클라우드 중립 배포 가이드 (PRD §16)

처음 설치하는 경우에는 단계별 [설치 가이드](INSTALL.md)를 먼저 보세요. 이 문서는 배포 구성, 자원, 이전, 업데이트를 다룹니다.

AgentAgency는 **Docker Compose 기반 단일 Linux 서버**를 기본 배포 단위로 씁니다. Kubernetes도, 특정 클라우드의 SDK나 관리형 서비스도 필요 없습니다.

| 호스팅 | 비고 |
|---|---|
| OCI Compute (Always Free Ampere A1 포함) | ARM64. 초기 운영·테스트용 비용 최적화 대상일 뿐 필수는 아닙니다. |
| AWS EC2, Azure VM, GCP Compute Engine | x86_64 / ARM64 |
| 일반 VPS, 온프레미스 Linux | Docker Engine + Compose v2.24+ |

AI Cloud 실행기(Codex Cloud 등)와 서버 호스팅 클라우드는 서로 독립적입니다. Cloud First 정책은 어느 호스팅 위에서도 똑같이 동작합니다.

## 권장 사양

| 규모 | vCPU | RAM | 디스크 |
|---|---|---|---|
| 최소 (Local CLI 1개 동시 실행) | 2 | 4GB | 30GB |
| 기본 (동시 2개) | 4 | 8–16GB | 60GB |

동시 실행 수는 `AA_MAX_CONCURRENT_PROJECTS`를 상한으로 합니다. 실제 CPU, RAM, 가용 메모리, 디스크를 감지해 자동으로 줄입니다. 디스크나 메모리가 부족하면 신규 작업을 미루고 알림을 보냅니다.

## 설치

```bash
./install.sh            # Docker 확인 → .env 자동 생성 → 실행 → 터미널 설정(aa setup)
```

직접 하려면:

```bash
mkdir -p backups && sudo chown 1000:1000 backups
cp .env.example .env    # POSTGRES_PASSWORD, (선택) AA_BACKUP_PASSPHRASE
docker compose up -d --build
docker compose exec -it app agent-agency setup   # 대화형 설정 (aa setup 과 같음)
```

### 추가 실행기 (선택)

Gemini CLI는 이미지에 들어 있습니다. Cursor Agent CLI는 `aa cursor`로 설치합니다(`.env`의 `INSTALL_CURSOR_CLI=true`로 이미지를 다시 빌드하며, `aa update` 뒤에도 유지).

```bash
aa cursor
```

로그인과 검증은 `aa config` → AI 구독에서 고르면 한 번에 합니다. 기능 플래그(`executors.gemini`, `executors.cursor`)도 자동으로 켜집니다. 직접 검증하려면:

```bash
aa verify gemini-cli
```

### 프로젝트별 격리 컨테이너 (권장)

```bash
docker build -f docker/workspace.Dockerfile -t agent-agency/workspace:latest .
sudo mkdir -p /srv/agent-agency/data/{app,claude,codex} && sudo chown -R 1000:1000 /srv/agent-agency/data
DOCKER_GID=$(getent group docker | cut -d: -f3) docker compose -f docker-compose.yml -f docker-compose.workspaces.yml up -d --build
```

각 프로젝트 작업은 별도 컨테이너에서 실행되며 다음 제한을 받습니다.

- 비루트 사용자(1000:1000)로 실행합니다.
- `--cap-drop ALL`, `no-new-privileges`를 적용합니다.
- CPU, RAM, pids 상한을 둡니다.
- 네트워크는 `AA_WORKSPACE_NETWORK`로 정합니다. `none`으로 두면 네트워크가 차단됩니다.

Docker 소켓을 마운트하면 호스트의 Docker를 제어할 수 있게 됩니다. 이 구성은 전용 서버에서만 쓰세요.

### 공개 URL이 필요한 경우

초기 구성은 Long Polling과 비공개 웹 접속을 씁니다. 웹훅이나 OAuth 콜백이 필요한 연동만 TLS 리버스 프록시를 두고 `AA_PUBLIC_URL`을 설정합니다. 프록시는 Caddy, nginx 등 무엇이든 됩니다.

## 백업 · 복원 · 제공업체 이전

- **정기 로컬 백업**: 매일 실행되며 최근 7개를 보관합니다. 결과는 호스트의 `./backups` 아래에 남습니다.
- **형식**: 엔진 중립 논리 백업(JSON+gzip)입니다. `AA_BACKUP_PASSPHRASE`를 설정하면 AES-256-GCM으로 암호화합니다.
- **원격 백업(선택)**: `aa config` → 원격 백업에서 S3 호환 엔드포인트를 등록하고 켭니다. AWS S3, OCI Object Storage(S3 호환 API), Cloudflare R2, MinIO, Backblaze B2 등 어디든 됩니다.
- **키 분리**: 금고 마스터 키(`/data/master.key` 또는 `AA_MASTER_KEY`)는 백업에 포함되지 않습니다. 별도의 안전한 곳에 보관하세요.

### 다른 서버/클라우드로 이전

1. 기존 서버에서 실행합니다.

```bash
docker compose exec app node dist/cli.js upgrade-check
```

이 명령은 진행 중인 작업이 있는지 확인하고 사전 백업을 만듭니다.

2. 백업 파일과 `master.key`를 새 서버로 복사합니다.
3. 새 서버에서 `docker compose up -d`로 기동합니다.
4. 백업을 복원합니다.

```bash
docker compose exec app node dist/cli.js restore /data/backups/<file>
```

5. 마스터 키를 같은 경로에 두거나 `AA_MASTER_KEY`로 지정한 뒤 재시작합니다.
6. 각 CLI에 공식 로그인을 다시 합니다(`claude auth login`, `codex login`).
7. `aa doctor` 로 연결 상태를 확인합니다.

에이전트, 관계, 기억, 프로젝트, 설정이 모두 그대로 옮겨집니다. 실제 PostgreSQL 사이, 그리고 내장 PGlite에서 PostgreSQL로의 이전은 통합 테스트로 검증합니다.

## 업데이트

Telegram에서 `/upgrade`를 쓰면 아래 1~2단계를 자동으로 처리합니다. 승인하면 새 작업을 멈추고, 실행 중인 작업이 끝나기를 기다린 뒤, 복원 검증을 마친 백업을 만들고 명령을 안내합니다. 새 버전이 시작되면 유지보수 모드는 자동으로 해제됩니다.

컨테이너를 멈출 때는 `stop_grace_period`(60초) 안에서 실행 중인 작업이 정리됩니다. 끝나지 않은 작업은 취소되고 재시작 후 체크포인트부터 이어서 진행합니다.


1. `upgrade-check`를 실행해 스키마 호환성과 진행 중 작업을 확인합니다. 사전 백업도 이때 만들어집니다.
2. 안전한 시점에 업데이트합니다. 진행 중인 작업이 없거나 `/pause` 한 뒤가 안전합니다.

```bash
git pull && docker compose up -d --build
```

마이그레이션은 기동할 때 advisory lock을 걸고 자동으로 적용됩니다.

3. 롤백할 때는 이전 이미지 태그로 되돌린 뒤 사전 백업을 복원합니다.
