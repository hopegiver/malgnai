#!/bin/zsh
# malgnai periodic sync (cron, every 10 min). Mac port of sync-all.cmd.
# Bundles sync-projects + sync-agents + sync-claude + (guard-gated) auto-retro.
# Runs only when dev server (localhost:9000) is up; otherwise skips quietly.

export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ROOT="/Users/hopegiver/workspace/malgnai"
cd "$ROOT" || exit 1

SERVER_URL="http://localhost:9000"
LOGDIR="$ROOT/logs"
LOG="$LOGDIR/sync-all.log"
mkdir -p "$LOGDIR"

# mac 경로 오버라이드 (소스 기본값은 윈도우 경로)
export WORKSPACE_DIR="/Users/hopegiver/workspace"
export CLAUDE_DIR="/Users/hopegiver/.claude"
export AGENTS_DIR="/Users/hopegiver/.claude/agents"
export KNOWLEDGE_DIR="/Users/hopegiver/.claude/knowledge"

# [M-3] X-API-Key 인증 배선: /api/projects/sync 는 apiKeyMiddleware 로 보호되므로
# sync-projects.js 가 X-API-Key 헤더를 실어야 한다. 키는 서버와 동일한 단일 소스(.dev.vars)에서
# 읽는다(별도 설정 파일을 두지 않아 키 표류를 방지). 값의 따옴표는 벗겨준다.
if [ -z "$MALGNAI_API_KEY" ] && [ -f "$ROOT/.dev.vars" ]; then
  export MALGNAI_API_KEY="$(grep -E '^MALGNAI_API_KEY=' "$ROOT/.dev.vars" | head -1 | sed -E 's/^MALGNAI_API_KEY=//; s/^["'\'']//; s/["'\'']$//')"
fi

# skip if dev server not responding
if ! curl -s -o /dev/null -m 5 "$SERVER_URL/"; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] dev server down at $SERVER_URL - skip" >> "$LOG"
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] sync start" >> "$LOG"

node bin/sync-projects.js "$SERVER_URL" >> "$LOG" 2>&1
node bin/sync-agents.js   "$SERVER_URL" >> "$LOG" 2>&1
node bin/sync-claude.js   "$SERVER_URL" >> "$LOG" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] sync done" >> "$LOG"

# auto-retro: guard-gated (new activity + min interval), backgrounded so it never
# delays this 10min sync tick — retro.sh itself no-ops in <1s when not due.
nohup "$ROOT/bin/retro.sh" >/dev/null 2>&1 &
disown
