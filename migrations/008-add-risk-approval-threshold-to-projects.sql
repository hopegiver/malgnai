-- 008-add-risk-approval-threshold-to-projects.sql
-- 2026-07-13: 프로젝트별 위험도(risk_level) 승인 임계값. ingestCycleResultTx 의 auto/queued
-- 판정에 risk_level 을 반영하기 위한 컬럼(기존엔 risk_level 자체를 판정 로직이 보지 않았음).
--
-- 허용값: 'off'(게이트 미적용, risk-blind) | 'low' | 'medium' | 'high' | 'critical'
--   의미 = "이 등급부터 사람 승인 필요"(risk_level >= threshold → 승인함).
--   threshold='low' 는 항상 승인(모든 proposal의 risk_level 이 'low' 이상으로 정규화되므로).
--
-- 기본값 'high': high/critical proposal 만 승인 필요, low/medium 은 계속 자동집행 후보 —
--   완전 무변경('off')과 전면 승인('low') 사이 절충. 상수 DEFAULT 라 기존 행에도 즉시
--   백필된다(NULL 로 남지 않음) — 배포 즉시 전 프로젝트에 high/critical 승인 게이트 적용됨.
--   근거: docs/design/risk-approval-threshold-and-cadence-extension.md §1.1.2
--
-- CHECK 제약 미부여: cadence/autonomy_level 등 기존 enum성 TEXT 컬럼과 동일 관례(앱 레이어
--   화이트리스트 검증 + riskAllowsAuto() fail-safe 로 이미 안전망 확보, §1.1.4 근거).
-- 비파괴 ADD COLUMN — 재승인 없이 배포 가능(decision 8c58dece).

ALTER TABLE projects ADD COLUMN risk_approval_threshold TEXT DEFAULT 'high';
