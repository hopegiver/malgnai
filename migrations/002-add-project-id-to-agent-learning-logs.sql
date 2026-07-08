-- 002-add-project-id-to-agent-learning-logs.sql
-- MCP agent_learning_log_add 가 project_id 를 필수로 받게 되면서, 저장 컬럼도 추가한다.
-- 기존 행은 project_id NULL로 남는다(과거 기록은 프로젝트 미분류로 유지).

ALTER TABLE agent_learning_logs ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_learning_logs_project ON agent_learning_logs(project_id);
