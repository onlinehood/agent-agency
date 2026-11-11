#!/usr/bin/env bash
# AgentAgency installer — one interactive command from a bare server to a running AI team.
#
#   curl -fsSL https://raw.githubusercontent.com/onlinehood/agent-agency/main/install.sh -o install.sh && bash install.sh
#
#   (or `bash install.sh` inside a checkout; on its own it clones the code for you)
#
# Steps: server check → Docker → code (/srv/agent-agency) → .env → build & start → interactive setup.
# Safe to run again. Options:
#   -y, --yes        no questions; use defaults (AA_GITHUB_TOKEN env for a private repository)
#   --dir PATH       install location (default /srv/agent-agency, or AA_DIR)
#   --no-start       prepare files only (no Docker)
set -euo pipefail

# >>> tui — terminal UI shared with ./aa (Claude Code CLI style) ------------------------------
if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ] && [ -t 1 ]; then
  C_ACC=$'\e[38;5;173m'; C_BOLD=$'\e[1m'; C_DIM=$'\e[2m'; C_GRN=$'\e[32m'; C_RED=$'\e[31m'
  C_YEL=$'\e[33m'; C_GRY=$'\e[90m'; C_0=$'\e[0m'
else
  C_ACC=""; C_BOLD=""; C_DIM=""; C_GRN=""; C_RED=""; C_YEL=""; C_GRY=""; C_0=""
fi
TUI_TTY=/dev/tty
TUI_INTERACTIVE=0
if [ -t 1 ] && { : <"$TUI_TTY"; } 2>/dev/null; then TUI_INTERACTIVE=1; fi
TUI_REPLY=""

tui_rep() { local s="" i; for ((i = 0; i < $2; i++)); do s+="$1"; done; printf '%s' "$s"; }
tui_w() { printf '%s' "$1" | sed $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' | LC_ALL=C.UTF-8 wc -L; }
tui_cols() { local c; c=$(tput cols 2>/dev/null || echo 80); [ "$c" -gt 100 ] && c=100; echo "$c"; }

# Rounded box. TUI_BOX_MIN sets a minimum inner width.
tui_box() {
  local inner=${TUI_BOX_MIN:-0} l w
  for l in "$@"; do w=$(tui_w "$l"); [ "$w" -gt "$inner" ] && inner=$w; done
  inner=$((inner + 2))
  printf '%s╭%s╮%s\n' "$C_ACC" "$(tui_rep ─ "$inner")" "$C_0"
  for l in "$@"; do
    w=$(tui_w "$l")
    printf '%s│%s %s%*s %s│%s\n' "$C_ACC" "$C_0" "$l" $((inner - 2 - w)) "" "$C_ACC" "$C_0"
  done
  printf '%s╰%s╯%s\n' "$C_ACC" "$(tui_rep ─ "$inner")" "$C_0"
}

# >>> art (generated from src/cli/sprites.ts by `npm run art` — do not edit by hand)
TUI_ART_256=(
  $'       \e[38;5;203;48;5;246m▀\e[0m\e[38;5;203m▀\e[0m     '
  $'    \e[38;5;209m▄\e[0m\e[38;5;209m▄\e[0m\e[38;5;209m▄\e[0m\e[38;5;246;48;5;209m▀\e[0m\e[38;5;209m▄\e[0m\e[38;5;209m▄\e[0m    '
  $' \e[38;5;209m▄\e[0m\e[38;5;209;48;5;223m▀\e[0m\e[38;5;223;48;5;209m▀\e[0m\e[38;5;223;48;5;209m▀\e[0m\e[38;5;209m█\e[0m\e[38;5;209m█\e[0m\e[38;5;209m█\e[0m\e[38;5;209m█\e[0m\e[38;5;209m█\e[0m\e[38;5;209m█\e[0m\e[38;5;209m█\e[0m\e[38;5;209m▄\e[0m '
  $'\e[38;5;209m█\e[0m\e[38;5;209m█\e[0m\e[38;5;209m█\e[0m\e[38;5;209;48;5;234m▀\e[0m\e[38;5;234;48;5;209m▀\e[0m\e[38;5;209;48;5;234m▀\e[0m\e[38;5;209m█\e[0m\e[38;5;209m█\e[0m\e[38;5;209;48;5;234m▀\e[0m\e[38;5;234;48;5;209m▀\e[0m\e[38;5;209;48;5;234m▀\e[0m\e[38;5;209m█\e[0m\e[38;5;209m█\e[0m\e[38;5;209;48;5;173m▀\e[0m'
  $'\e[38;5;173m▀\e[0m\e[38;5;209;48;5;173m▀\e[0m\e[38;5;209;48;5;173m▀\e[0m\e[38;5;211;48;5;173m▀\e[0m\e[38;5;209;48;5;173m▀\e[0m\e[38;5;209;48;5;173m▀\e[0m\e[38;5;173m█\e[0m\e[38;5;173m█\e[0m\e[38;5;209;48;5;173m▀\e[0m\e[38;5;209;48;5;173m▀\e[0m\e[38;5;211;48;5;173m▀\e[0m\e[38;5;209;48;5;173m▀\e[0m\e[38;5;209;48;5;173m▀\e[0m\e[38;5;173m▀\e[0m'
)
TUI_ART_PLAIN=(
  $'       █▀     '
  $'    ▄▄▄█▄▄    '
  $' ▄██████████▄ '
  $'██████████████'
  $'▀████████████▀'
)
# <<< art

# The knight, line by line (colours when the terminal has them).
tui_art() { if [ -n "$C_0" ]; then printf '%s' "${TUI_ART_256[$1]:-}"; else printf '%s' "${TUI_ART_PLAIN[$1]:-}"; fi; }

# Welcome banner: dot-art character + title, like the in-app setup.
tui_welcome() {
  local ver=${2:-} n=${#TUI_ART_PLAIN[@]} i j r top
  local -a right=("${C_BOLD}✻ AgentAgency${C_0} ${C_DIM}${ver}${C_0}" "${C_DIM}Your Agents. Your Agency.${C_0}" "" "$1")
  local -a lines=("")
  top=$(((n - ${#right[@]}) / 2))
  [ "$top" -lt 0 ] && top=0
  for ((i = 0; i < n; i++)); do
    r=""; j=$((i - top))
    if [ "$j" -ge 0 ] && [ "$j" -lt "${#right[@]}" ]; then r=${right[$j]}; fi
    lines+=(" $(tui_art "$i")   $r")
  done
  lines+=("" " ${C_DIM}↑↓ 이동 · Enter 선택 · Esc 뒤로 · Ctrl+C 종료${C_0}")
  TUI_BOX_MIN=68 tui_box "${lines[@]}"
}

tui_step() { printf '\n%s⏺%s %s%s%s %s\n' "$C_ACC" "$C_0" "$C_BOLD" "$1" "$C_0" "${C_DIM}${2:-}${C_0}"; }
tui_ok() { printf '  %s⎿%s  %s✓%s %s\n' "$C_DIM" "$C_0" "$C_GRN" "$C_0" "$*"; }
tui_warn() { printf '  %s⎿%s  %s!%s %s\n' "$C_DIM" "$C_0" "$C_YEL" "$C_0" "$*"; }
tui_fail() { printf '  %s⎿%s  %s✗%s %s\n' "$C_DIM" "$C_0" "$C_RED" "$C_0" "$*"; }
tui_note() { printf '  %s⎿  %s%s\n' "$C_DIM" "$*" "$C_0"; }
tui_sub() { printf '     %s\n' "$*"; }
tui_die() { tui_fail "$*"; exit 1; }

# Arrow-key menu. Options are "label" or "label|hint". TUI_DEFAULT = initial index.
# Sets TUI_REPLY to the chosen index; returns 1 on Esc.
tui_select() {
  local q=$1; shift
  local -a opts=("$@")
  local n=${#opts[@]} i=${TUI_DEFAULT:-0} j key rest label hint drawn=0
  if [ "$TUI_INTERACTIVE" != 1 ]; then TUI_REPLY=$i; printf '%s✔%s %s %s›%s %s\n' "$C_ACC" "$C_0" "$q" "$C_DIM" "$C_0" "${opts[$i]%%|*}"; return 0; fi
  printf '\e[?25l'
  while :; do
    [ "$drawn" = 1 ] && printf '\e[%dA\r\e[J' $((n + 2))
    printf '%s?%s %s%s%s\n' "$C_ACC" "$C_0" "$C_BOLD" "$q" "$C_0"
    for ((j = 0; j < n; j++)); do
      label=${opts[$j]%%|*}; hint=""
      [ "$label" != "${opts[$j]}" ] && hint="  ${C_DIM}· ${opts[$j]#*|}${C_0}"
      if [ "$j" = "$i" ]; then printf '  %s❯ %d. %s%s%s\n' "$C_ACC" $((j + 1)) "$label" "$C_0" "$hint"
      else printf '    %d. %s%s\n' $((j + 1)) "$label" "$hint"; fi
    done
    printf '  %s↑↓ 이동 · Enter 선택 · Esc 뒤로%s\n' "$C_DIM" "$C_0"
    drawn=1
    key=""; IFS= read -rsn1 key <"$TUI_TTY" || true
    case "$key" in
      $'\e')
        rest=""; IFS= read -rsn2 -t 0.05 rest <"$TUI_TTY" || true
        case "$rest" in
          "[A") i=$(((i - 1 + n) % n)) ;;
          "[B") i=$(((i + 1) % n)) ;;
          "") printf '\e[%dA\r\e[J\e[?25h' $((n + 2)); return 1 ;;
        esac ;;
      "") break ;;
      k) i=$(((i - 1 + n) % n)) ;;
      j) i=$(((i + 1) % n)) ;;
      [1-9]) if [ "$key" -le "$n" ]; then i=$((key - 1)); break; fi ;;
    esac
  done
  printf '\e[%dA\r\e[J\e[?25h' $((n + 2))
  printf '%s✔%s %s %s›%s %s%s%s\n' "$C_ACC" "$C_0" "$q" "$C_DIM" "$C_0" "$C_ACC" "${opts[$i]%%|*}" "$C_0"
  TUI_REPLY=$i
}

tui_confirm() { # question [default yes=0|no=1] → returns 0 for yes
  TUI_DEFAULT=${2:-0} tui_select "$1" "예" "아니요" || return 1
  [ "$TUI_REPLY" = 0 ]
}

# Text input in a rounded box. tui_input "question" "default" [secret]. Sets TUI_REPLY.
tui_input() {
  local q=$1 def=${2:-} secret=${3:-} v="" w shown
  if [ "$TUI_INTERACTIVE" != 1 ]; then TUI_REPLY=$def; return 0; fi
  w=$(($(tui_cols) - 2)); [ "$w" -gt 72 ] && w=72
  printf '%s?%s %s%s%s\n' "$C_ACC" "$C_0" "$C_BOLD" "$q" "$C_0"
  printf '%s╭%s╮%s\n' "$C_GRY" "$(tui_rep ─ $((w - 2)))" "$C_0"
  if [ -n "$secret" ]; then
    printf '%s│%s %s>%s ' "$C_GRY" "$C_0" "$C_ACC" "$C_0"
    IFS= read -rs v <"$TUI_TTY" || true
    printf '\n'
  else
    IFS= read -re -i "$def" -p $'\001'"${C_GRY}"$'\002''│'$'\001'"${C_0}${C_ACC}"$'\002'' > '$'\001'"${C_0}"$'\002' v <"$TUI_TTY" || true
  fi
  printf '%s╰%s╯%s\n' "$C_GRY" "$(tui_rep ─ $((w - 2)))" "$C_0"
  # Move back over question + box (the input line may have wrapped) and print the answer line.
  local cols rows
  cols=$(tput cols 2>/dev/null || echo 80)
  rows=1
  [ -z "$secret" ] && rows=$(((4 + $(tui_w "$v") + cols - 1) / cols))
  printf '\e[%dA\r\e[J' $((3 + rows))
  v=$(printf '%s' "$v" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  if [ -n "$secret" ]; then shown="${C_DIM}$([ -n "$v" ] && echo "••••••••" || echo "(비움)")${C_0}"; else shown="${C_ACC}${v:-${C_DIM}(비움)}${C_0}"; fi
  printf '%s✔%s %s %s›%s %s\n' "$C_ACC" "$C_0" "$q" "$C_DIM" "$C_0" "$shown"
  TUI_REPLY=$v
}

# Run a command with a spinner; output goes to $TUI_LOG. On failure the log tail is shown.
TUI_LOG=${TUI_LOG:-$(mktemp "${TMPDIR:-/tmp}/agent-agency.XXXXXX.log")}
tui_run() {
  local label=$1; shift
  local start=$SECONDS rc=0 i=0 pid
  local -a f=("·" "✢" "✳" "∗" "✻" "✽" "✻" "∗" "✳" "✢")
  printf '\n== %s\n' "$label" >>"$TUI_LOG"
  if [ "$TUI_INTERACTIVE" != 1 ]; then
    printf '%s✻%s %s…\n' "$C_ACC" "$C_0" "$label"
    "$@" >>"$TUI_LOG" 2>&1 || rc=$?
  else
    "$@" >>"$TUI_LOG" 2>&1 &
    pid=$!
    printf '\e[?25l'
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r\e[2K%s%s %s…%s %s(%ds)%s' "$C_ACC" "${f[$((i % 10))]}" "$label" "$C_0" "$C_DIM" $((SECONDS - start)) "$C_0"
      i=$((i + 1)); sleep 0.12
    done
    wait "$pid" || rc=$?
    printf '\r\e[2K\e[?25h'
  fi
  # Never keep a token from a clone URL in the log.
  sed -i -E 's#(x-access-token:)[^@]+@#\1***@#g' "$TUI_LOG" 2>/dev/null || true
  if [ "$rc" = 0 ]; then tui_ok "$label ${C_DIM}($((SECONDS - start))s)${C_0}"
  else
    TUI_FAILED=1
    tui_fail "$label 실패 ${C_DIM}(전체 기록: $TUI_LOG)${C_0}"
    tail -n 12 "$TUI_LOG" | sed "s/^/     ${C_DIM}/; s/\$/${C_0}/"
  fi
  return "$rc"
}
# <<< tui -------------------------------------------------------------------------------------

REPO_URL=${AA_REPO_URL:-https://github.com/onlinehood/agent-agency.git}
APP_DIR=${AA_DIR:-/srv/agent-agency}
NO_START=0
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) TUI_INTERACTIVE=0 ;;
    --no-start) NO_START=1 ;;
    --dir) APP_DIR=$2; shift ;;
    --resumed) AA_RESUMED=1 ;;
    -h|--help) sed -n '2,12p' "$SELF"; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
  shift
done

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"
REAL_USER="${SUDO_USER:-${USER:-$(id -un)}}"
gen() { openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
is_checkout() { [ -f "$1/docker-compose.yml" ] && [ -f "$1/package.json" ] && grep -q '"name": "agent-agency"' "$1/package.json" 2>/dev/null; }
need_sudo() {
  [ -z "$SUDO" ] && return 0
  sudo -n true 2>/dev/null && return 0
  tui_note "관리자 권한이 필요해요. sudo 비밀번호를 입력하세요."
  sudo -v </dev/tty
}
trap 'printf "\e[?25h"; [ "${TUI_FAILED:-0}" = 1 ] || rm -f "$TUI_LOG"' EXIT
trap 'printf "\e[?25h\n%s중단했어요. 다시 실행하면 이어서 합니다.%s\n" "$C_DIM" "$C_0"; exit 130' INT

# A checkout next to this script is used as is (the usual `git clone … && ./install.sh`).
HERE="$(dirname "$SELF")"
if is_checkout "$HERE"; then APP_DIR="$HERE"; fi

if [ "${AA_RESUMED:-0}" != 1 ]; then
  echo
  tui_welcome "서버에 설치합니다" "$(is_checkout "$APP_DIR" && grep -o '"version": "[^"]*"' "$APP_DIR/package.json" | cut -d'"' -f4 | sed 's/^/v/')"

  # 1. server ---------------------------------------------------------------------------------
  tui_step "서버 확인" "1/6"
  os=$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}" || uname -s)
  cpu=$(nproc 2>/dev/null || echo "?")
  mem=$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0)
  parent=$(dirname "$APP_DIR"); [ -d "$parent" ] || parent=/
  disk=$(df -Pk "$parent" 2>/dev/null | awk 'NR==2 {printf "%.0f", $4/1024/1024}')
  tui_ok "$os · $(uname -m) · CPU ${cpu}코어"
  if [ "${mem:-0}" -lt 3 ]; then tui_warn "RAM ${mem}GB — 4GB 이상을 권장해요"; else tui_ok "RAM ${mem}GB"; fi
  if [ "${disk:-0}" -lt 20 ]; then tui_warn "디스크 여유 ${disk}GB — 30GB 이상을 권장해요"; else tui_ok "디스크 여유 ${disk}GB"; fi

  # 2. Docker ---------------------------------------------------------------------------------
  if [ "$NO_START" = 0 ]; then
    tui_step "Docker" "2/6"
    if ! command -v docker >/dev/null 2>&1; then
      tui_warn "Docker가 없어요"
      tui_confirm "공식 스크립트(get.docker.com)로 설치할까요?" || tui_die "Docker가 필요해요. 설치한 뒤 다시 실행하세요."
      need_sudo
      tui_run "Docker 설치 (1~3분)" sh -c "curl -fsSL https://get.docker.com | $SUDO sh" || tui_die "Docker 설치에 실패했어요."
      $SUDO usermod -aG docker "$REAL_USER" >/dev/null 2>&1 || true
    fi
    if ! docker info >/dev/null 2>&1 && ! { [ -n "$SUDO" ] && sudo -n docker info >/dev/null 2>&1; }; then
      need_sudo
      $SUDO docker info >/dev/null 2>&1 || tui_run "Docker 시작" $SUDO systemctl start docker || tui_die "Docker를 시작하지 못했어요 (sudo systemctl start docker)."
    fi
    ver="$( (docker compose version --short || $SUDO docker compose version --short) 2>/dev/null | head -1)"
    major="${ver%%.*}"; rest="${ver#*.}"; minor="${rest%%.*}"
    if [ "${major:-0}" -lt 2 ] 2>/dev/null || { [ "${major:-0}" -eq 2 ] && [ "${minor:-0}" -lt 24 ]; }; then
      tui_die "Docker Compose v2.24 이상이 필요해요 (지금 ${ver:-없음}). Docker를 업데이트하세요."
    fi
    tui_ok "Docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,) · Compose ${ver}"
  fi

  # 3. code -------------------------------------------------------------------------------------
  tui_step "코드" "3/6"
  if is_checkout "$APP_DIR"; then
    tui_ok "$APP_DIR"
  else
    tui_input "설치 위치" "$APP_DIR"
    APP_DIR=${TUI_REPLY:-$APP_DIR}
    if is_checkout "$APP_DIR"; then
      tui_ok "이미 받아 둔 코드를 씁니다"
    else
      if [ -e "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then tui_die "$APP_DIR 가 비어 있지 않아요. 다른 위치를 고르세요."; fi
      if ! mkdir -p "$APP_DIR" 2>/dev/null; then need_sudo; $SUDO mkdir -p "$APP_DIR"; fi
      [ -w "$APP_DIR" ] || $SUDO chown "$REAL_USER:" "$APP_DIR"
      command -v git >/dev/null 2>&1 || { need_sudo; tui_run "git 설치" sh -c "$SUDO apt-get update -qq && $SUDO apt-get install -y -qq git"; }
      clean_url=$REPO_URL
      if ! { [ -z "${AA_GITHUB_TOKEN:-}" ] && GIT_TERMINAL_PROMPT=0 tui_run "코드 받기" git clone "$REPO_URL" "$APP_DIR"; }; then
        case "$REPO_URL" in
          https://github.com/*)
            token=${AA_GITHUB_TOKEN:-}
            if [ -z "$token" ]; then
              tui_note "비공개 저장소예요. 이 저장소만 읽을 수 있는 토큰이 필요해요:"
              tui_sub "GitHub → Settings → Developer settings → ${C_BOLD}Fine-grained tokens${C_0} → Generate new token"
              tui_sub "Repository access: ${C_BOLD}Only select repositories${C_0} → agent-agency · 권한 ${C_BOLD}Contents: Read-only${C_0}"
              tui_input "GitHub 읽기 전용 토큰" "" secret
              token=$TUI_REPLY
            fi
            [ -n "$token" ] || tui_die "토큰이 없어 코드를 받지 못했어요."
            rm -rf "${APP_DIR:?}/.git" 2>/dev/null || true
            GIT_TERMINAL_PROMPT=0 tui_run "코드 받기 (토큰)" git clone "https://x-access-token:${token}@${REPO_URL#https://}" "$APP_DIR" \
              || tui_die "받지 못했어요. 토큰에 이 저장소가 선택되어 있고 Contents 읽기 권한이 있는지 확인하세요."
            # Keep the token out of .git/config; ./aa update reads it from the git credential store.
            git -C "$APP_DIR" remote set-url origin "$clean_url"
            git -C "$APP_DIR" config credential.helper store
            printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=%s\n\n' "$token" | git -C "$APP_DIR" credential approve
            ;;
          *) tui_die "코드를 받지 못했어요: $REPO_URL" ;;
        esac
      fi
    fi
    # Continue with the installer that came with the code (same version as what gets installed).
    if [ "$(readlink -f "$APP_DIR/install.sh")" != "$SELF" ]; then
      exec env AA_RESUMED=1 TUI_LOG="$TUI_LOG" bash "$APP_DIR/install.sh" --dir "$APP_DIR" $([ "$TUI_INTERACTIVE" = 1 ] || echo -y) $([ "$NO_START" = 1 ] && echo --no-start)
    fi
  fi
fi

cd "$APP_DIR"

# 4. config files -------------------------------------------------------------------------------
tui_step "설정 파일" "4/6"
mkdir -p backups
if [ "$(stat -c %u backups)" != "1000" ]; then need_sudo; $SUDO chown 1000:1000 backups; fi
tui_ok "백업 폴더 $APP_DIR/backups"
if [ -f .env ]; then
  grep -qE '^POSTGRES_PASSWORD=.+' .env || tui_die ".env에 POSTGRES_PASSWORD가 비어 있어요. 값을 넣거나 .env를 지우고 다시 실행하세요."
  tui_ok "기존 .env 그대로 사용"
else
  cp .env.example .env
  pw="$(gen)"; bp="$(gen)"
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${pw}/" .env
  sed -i "s/^# AA_BACKUP_PASSPHRASE=.*/AA_BACKUP_PASSPHRASE=${bp}/" .env
  chmod 600 .env
  if [ -n "${SUDO_USER:-}" ]; then chown "$SUDO_USER": .env; fi
  tui_ok ".env 생성 · DB 비밀번호와 백업 암호를 자동으로 만들었어요"
  tui_note ".env 값은 바꾸지 마세요 (특히 POSTGRES_PASSWORD)."
fi

if [ "$NO_START" = 1 ]; then
  tui_ok "준비 완료 (--no-start: 실행은 건너뜀)"
  exit 0
fi

# 5. build & start ------------------------------------------------------------------------------
tui_step "실행" "5/6"
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  DOCKER="$SUDO docker"
  need_sudo
  $DOCKER info >/dev/null 2>&1 || tui_die "Docker에 연결할 수 없어요 (sudo systemctl start docker)."
fi
healthy() { $DOCKER compose exec -T app curl -fsS --noproxy "*" http://127.0.0.1:8080/api/health >/dev/null 2>&1; }
wait_healthy() { local n; for n in $(seq 1 90); do healthy && return 0; sleep 2; done; return 1; }
tui_run "이미지 빌드 (처음엔 몇 분 걸려요)" $DOCKER compose build || tui_die "빌드에 실패했어요."
tui_run "PostgreSQL과 앱 시작" $DOCKER compose up -d || tui_die "시작하지 못했어요."
tui_run "준비 기다리는 중" wait_healthy || tui_die "앱이 준비되지 않았어요. 로그: ./aa logs"

# `aa` from anywhere
if [ "$TUI_INTERACTIVE" = 1 ] && [ "$(readlink -f /usr/local/bin/aa 2>/dev/null)" != "$APP_DIR/aa" ]; then
  if tui_confirm "어디서든 ${C_BOLD}aa${C_0} 한 단어로 관리 메뉴를 열 수 있게 할까요?" 0; then
    need_sudo
    $SUDO ln -sf "$APP_DIR/aa" /usr/local/bin/aa && tui_ok "이제 어디서든 aa"
  fi
fi

# 6. interactive setup --------------------------------------------------------------------------
tui_step "설정" "6/6"
if [ "$TUI_INTERACTIVE" = 1 ]; then
  $DOCKER compose exec ${COLORTERM:+-e COLORTERM="$COLORTERM"} -it app agent-agency setup --continue || tui_warn "설정을 마치지 않았어요. 이어서 하려면: aa setup"
else
  tui_ok "설치 완료. 터미널에서 이어서 설정하세요:  cd $APP_DIR && ./aa setup"
fi
