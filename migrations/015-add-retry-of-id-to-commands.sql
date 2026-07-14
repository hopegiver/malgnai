-- 015-add-retry-of-id-to-commands.sql
-- 2026-07-14: 실패한 명령 재실행 버튼 백엔드. 재실행은 원본 row를 mutate하지 않고 새 command row를
-- 생성한다(감사 이력 보존). 재실행 계보 추적 전용 컬럼 — 기존 parent_command_id/root_command_id는
-- 재사용하지 않는다(phase-chain.js의 maybeRequeuePhaseTx가 root_command_id 기준으로
-- MAX_PHASE_ROUNDS=20 상한을 카운트하므로, lineage 컬럼을 공유하면 재실행 체인이 그 카운트를
-- 오염시켜 무관한 NEXT_PHASE 체이닝을 조기에 막아버리는 부작용이 생긴다).

ALTER TABLE commands ADD COLUMN retry_of_id TEXT;
