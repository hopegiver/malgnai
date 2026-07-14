-- Drop claude_history table (2026-07-10)
-- Reason: history.jsonl source stopped recording (2026-06-25); /activities already covers all use cases
DROP TABLE IF EXISTS claude_history;
