#!/bin/zsh
# malgnai auto-retrospective. [07-03] 별도 cron/LaunchAgent 없이 sync-all.sh(10분 틱)에서 호출됨.
# Guard: run claude headless only if there is new claude activity AND >= RETRO_MIN_INTERVAL_MS since last retro.

export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ROOT="/Users/hopegiver/workspace/malgnai"
cd "$ROOT" || exit 1

LOGDIR="$ROOT/logs"
LOG="$LOGDIR/retro.log"
MARKER="$LOGDIR/last-retro.txt"
PROMPT="$ROOT/bin/retro-prompt.txt"
mkdir -p "$LOGDIR"

export CLAUDE_DIR="/Users/hopegiver/.claude"

# guard: skip quietly if no new activity or too soon since last retro
if ! node bin/retro-guard.js >> "$LOG" 2>&1; then
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] retro start" >> "$LOG"

# run claude headless with the retro prompt via stdin (unattended).
# --model 고정: 미지정 시 haiku/구버전 sonnet 등으로 자동배정되는 걸 방지(worker-exec.js와 동일 정책).
cat "$PROMPT" | claude -p --model claude-sonnet-5 --dangerously-skip-permissions >> "$LOG" 2>&1

# update last-retro marker (epoch ms)
node -e "const fs=require('fs');fs.writeFileSync(process.argv[1], String(Date.now()))" "$MARKER"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] retro done" >> "$LOG"
