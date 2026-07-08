#!/bin/zsh
# malgnai sqlite 정본 DB 온라인 안전 백업 (macOS LaunchAgent com.malgnai.backup 에서 6시간마다 호출).
#
# 왜 cp 가 아니라 VACUUM INTO 인가:
#   정본 DB 는 WAL 모드로 상시 라이브 서버가 쓰는 중이다(-wal 이 수 MB). 단순 cp 는
#   .db / -wal / -shm 3파일의 스냅샷 시점이 어긋나 손상될 수 있다. `VACUUM INTO` 는
#   sqlite 가 하나의 읽기 트랜잭션 안에서 일관된 스냅샷을 새 파일로 안전하게 복제하며
#   (라이브 DB 에는 쓰기 없음), 결과물은 조각모음된 단일 .db 파일(-wal/-shm 불필요)이다.
#
# 안전 원칙: 라이브 DB 는 읽기만 한다. 실패하면 부분 산출물을 지우고 비정상 종료한다.

set -u
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# ── 설정 ─────────────────────────────────────────────────────────────────
ROOT="/Users/hopegiver/workspace/malgnai"

# 정본 DB 경로: .dev.vars 의 DB_PATH 를 우선 사용, 없으면 프로젝트 기본값.
DB_PATH="$(grep -E '^DB_PATH=' "$ROOT/.dev.vars" 2>/dev/null | head -1 | cut -d= -f2-)"
if [[ -z "${DB_PATH}" ]]; then
  DB_PATH="$ROOT/data/malgnai.db"
fi

# 백업 저장 위치: 정본과 다른 디렉토리(프로젝트 밖). 커밋 대상 아님.
BACKUP_DIR="${MALGNAI_BACKUP_DIR:-/Users/hopegiver/malgnai-backups}"

# 보존 개수: 6시간 간격 × 56개 = 약 14일치.
KEEP="${MALGNAI_BACKUP_KEEP:-56}"

LOGDIR="$ROOT/logs"
LOG="$LOGDIR/backup-db.log"

mkdir -p "$BACKUP_DIR" "$LOGDIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
die() { log "ERROR: $*"; exit 1; }

TS="$(date '+%Y%m%d-%H%M')"
DEST="$BACKUP_DIR/malgnai-$TS.db"
TMP="$DEST.tmp"

log "backup start  src=$DB_PATH  dest=$DEST"

# ── 사전 점검 ────────────────────────────────────────────────────────────
[[ -f "$DB_PATH" ]] || die "source DB not found: $DB_PATH"
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not found in PATH"

# ── 1) 온라인 안전 백업 (라이브 DB 는 읽기 전용으로 연다) ────────────────────
# mode=ro 로 열어 라이브 파일에 어떤 쓰기도 하지 않음을 보장한다.
rm -f "$TMP"
if ! sqlite3 "file:$DB_PATH?mode=ro" "VACUUM INTO '$TMP';" >> "$LOG" 2>&1; then
  rm -f "$TMP"
  die "VACUUM INTO failed"
fi
[[ -s "$TMP" ]] || { rm -f "$TMP"; die "backup file empty after VACUUM INTO"; }

# ── 2) 무결성 검증 ───────────────────────────────────────────────────────
INTEG="$(sqlite3 "file:$TMP?mode=ro" 'PRAGMA integrity_check;' 2>>"$LOG")"
if [[ "$INTEG" != "ok" ]]; then
  log "integrity_check FAILED: $INTEG"
  rm -f "$TMP"
  die "integrity_check != ok (corrupt backup discarded)"
fi
log "integrity_check=ok"

# ── 3) 정합성 검증: 테이블 수 비교(원본은 읽기 전용) ─────────────────────────
SRC_TBL="$(sqlite3 "file:$DB_PATH?mode=ro" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>>"$LOG")"
DST_TBL="$(sqlite3 "file:$TMP?mode=ro"      "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>>"$LOG")"
if [[ "$SRC_TBL" != "$DST_TBL" ]]; then
  log "table count mismatch: src=$SRC_TBL dst=$DST_TBL"
  rm -f "$TMP"
  die "table count mismatch (backup discarded)"
fi
log "table count match: $DST_TBL"

# ── 4) 원자적 확정 (검증 통과분만 최종 파일명으로) ──────────────────────────
mv "$TMP" "$DEST" || { rm -f "$TMP"; die "failed to finalize $DEST"; }
SIZE="$(stat -f%z "$DEST" 2>/dev/null)"
log "backup ok  dest=$DEST  bytes=$SIZE  tables=$DST_TBL"

# ── 5) 로테이션: 최신 KEEP 개만 남기고 오래된 것 삭제 ────────────────────────
# malgnai-*.db 패턴만 대상(다른 파일/.tmp 는 절대 건드리지 않음).
#   set -e 아님 + 명시적 패턴 매칭으로 경계 안전.
setopt local_options null_glob
BACKUPS=("$BACKUP_DIR"/malgnai-*.db)   # 이름순 = 타임스탬프순(오름차순)
TOTAL=${#BACKUPS[@]}
if (( TOTAL > KEEP )); then
  REMOVE=$(( TOTAL - KEEP ))
  for f in "${BACKUPS[@]:0:$REMOVE}"; do
    rm -f "$f" && log "rotate remove: $f"
  done
  log "rotation done: kept $KEEP of $TOTAL (removed $REMOVE)"
else
  log "rotation skip: $TOTAL <= $KEEP"
fi

log "backup finish"
exit 0
