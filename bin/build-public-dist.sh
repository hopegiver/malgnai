#!/usr/bin/env bash
# 직원 배포용 GitHub 공개 저장소(malgnai-public) 동기화.
#
# main 저장소(현재 git 추적 파일만, docs/는 이미 미추적이라 자동 제외)에서
# git archive로 스냅샷을 뽑아 malgnai-public/ 워킹트리에 그대로 반영하고,
# test/·e2e/ 처럼 배포에 불필요한 항목만 추가로 제거한 뒤 커밋한다.
# malgnai-public은 물리적으로 별개의 git 저장소라, 여기서 제외한 경로는
# 이 저장소 히스토리에 애초에 존재한 적이 없다 — push해도 과거 버전이 새어나가지 않는다.
#
# push는 이 스크립트가 하지 않는다. 커밋 후 diff를 직접 확인하고
# `git -C ~/workspace/malgnai-public push origin main` 을 수동 실행할 것.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${MALGNAI_PUBLIC_DIR:-$HOME/workspace/malgnai-public}"

# 배포에서 제외할 경로 (docs/는 main repo에서 이미 git 미추적이라 archive에 안 잡힘)
# .mcp.json·.claude/settings.local.json은 로컬 절대경로·개인 권한설정이라 공개저장소 부적합
# IMPLEMENTATION_SUMMARY.md·.vscode·*.bak·shot-*.png·test-*.mjs는 스크래치/디버그성
# 산출물이라 실수로 시크릿·내부 경로가 섞여 들어갈 위험이 있어 원천 배제(issue 9ef79dbd 후속조치)
EXCLUDE_PATHS=(test e2e .mcp.json .claude/settings.local.json IMPLEMENTATION_SUMMARY.md .vscode "*.bak" "shot-*.png" "test-*.mjs")

if [ ! -d "$DIST_DIR/.git" ]; then
  echo "error: $DIST_DIR 에 git 저장소가 없습니다. 먼저 git init 하세요." >&2
  exit 1
fi

echo "==> $REPO_ROOT 의 git 추적 파일을 $DIST_DIR 로 동기화"

# .git을 제외한 기존 내용을 비우고 최신 스냅샷으로 교체
find "$DIST_DIR" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

git -C "$REPO_ROOT" archive HEAD | tar -x -C "$DIST_DIR"

for p in "${EXCLUDE_PATHS[@]}"; do
  if [[ "$p" == *"*"* ]]; then
    find "$DIST_DIR" -name "$p" -exec rm -rf {} +
  else
    rm -rf "${DIST_DIR:?}/$p"
  fi
done

cd "$DIST_DIR"
git add -A
if git diff --cached --quiet; then
  echo "==> 변경 없음 — 커밋 생략"
else
  git commit -m "sync: main $(git -C "$REPO_ROOT" rev-parse --short HEAD) 기준 배포판 갱신"
  echo "==> 커밋 완료. 확인 후 다음으로 push:"
  echo "    git -C \"$DIST_DIR\" push origin main"
fi
