#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { activityLog } from "./tools/activity.js";
import { agentLearningLogAdd } from "./tools/agent.js";
import { decisionAdd } from "./tools/decision.js";
import { issueAdd, issueResolve } from "./tools/issue.js";
import { memoryAdd, memorySearch } from "./tools/memory.js";
import { getCurrentContext } from "./tools/context.js";
import { commandAdd } from "./tools/command.js";
import { projectStatusSet } from "./tools/project.js";
import { closeDb } from "./db/connection.js";

const server = new McpServer({
  name: "malgnai-mcp",
  version: "1.0.0",
});

// ── Activity Tools ──

server.tool(
  "activity_log",
  "활동 이력 기록",
  {
    agent_name: z.string().describe("에이전트 이름"),
    action: z.string().describe("액션 타입 (create, update, execute 등)"),
    detail: z.string().optional().describe("상세 내용"),
    project_id: z.string().describe("프로젝트 ID(STATUS.md 헤더 또는 get_current_context 로 확인)"),
    command_id: z.string().optional().describe("연관 명령(command) ID"),
  },
  async (params) => ({
    content: [{ type: "text", text: JSON.stringify(activityLog(params), null, 2) }],
  })
);

// ── Agent Tools (학습 이력만 append-only 기록 허용) ──

server.tool(
  "agent_learning_log_add",
  "에이전트 학습 이력 기록 (append-only). trainer가 특정 에이전트의 MD/knowledge를 보강한 직후 호출해 무엇을 언제 학습시켰는지 남긴다. MD 본문 수정과 달리 이력 자체는 되돌릴 필요가 없어 MCP에서 직접 쓴다.",
  {
    agent_name: z.string().describe("학습 대상 에이전트 이름"),
    project_id: z.string().describe("계기가 된 프로젝트 ID(STATUS.md 헤더 또는 get_current_context 로 확인)"),
    type: z.enum(["experience", "external", "peer_feedback", "discussion"]).describe("학습 출처 유형: experience=산출물 진단/프로젝트 교훈, external=WebSearch 등 외부 자료, peer_feedback=다른 에이전트·리뷰 피드백, discussion=사용자 요청/논의"),
    title: z.string().describe("학습 내용 제목 (예: 'API 버전 누락 패턴 반영')"),
    content: z.string().optional().describe("상세 내용 (보강한 MD/knowledge 섹션 요약)"),
    source: z.string().optional().describe("출처 (knowledge 파일 경로, URL, 프로젝트명 등)"),
  },
  async (params) => ({
    content: [{ type: "text", text: JSON.stringify(agentLearningLogAdd(params), null, 2) }],
  })
);

// ── Context Router Tools (decisions / issues / memories / get_current_context) ──

server.tool(
  "get_current_context",
  "지금 작업에 필요한 맥락만 조합해 반환 (진행 프로젝트/작업/열린 이슈/최근 결정/핵심 메모리/최근 활동). 전체 문서를 통째로 읽는 대신 이걸 먼저 호출한다.",
  {
    project_id: z.string().describe("범위를 한정할 프로젝트 ID(STATUS.md 헤더 또는 이전 조회 결과로 확인)"),
  },
  async (params) => ({
    content: [{ type: "text", text: JSON.stringify(getCurrentContext(params), null, 2) }],
  })
);

server.tool(
  "decision_add",
  "주요 결정사항 기록",
  {
    title: z.string().describe("결정 제목"),
    summary: z.string().optional().describe("결정 요약"),
    reason: z.string().optional().describe("결정 이유"),
    impact: z.string().optional().describe("영향 범위"),
    importance: z.number().optional().describe("중요도 1~5 (기본 3)"),
    project_id: z.string().describe("프로젝트 ID(STATUS.md 헤더 또는 get_current_context 로 확인)"),
  },
  async (params) => ({
    content: [{ type: "text", text: JSON.stringify(decisionAdd(params), null, 2) }],
  })
);

server.tool(
  "issue_add",
  "이슈/장애물 기록 (status=open으로 생성)",
  {
    title: z.string().describe("이슈 제목"),
    description: z.string().optional().describe("상세 설명"),
    severity: z.enum(["low", "medium", "high", "critical"]).optional().describe("심각도 (기본 medium)"),
    related_file: z.string().optional().describe("관련 파일 경로"),
    project_id: z.string().describe("프로젝트 ID(STATUS.md 헤더 또는 get_current_context 로 확인)"),
  },
  async (params) => ({
    content: [{ type: "text", text: JSON.stringify(issueAdd(params), null, 2) }],
  })
);

server.tool(
  "issue_resolve",
  "이슈를 해결 처리 (status=resolved, resolved_at 기록)",
  {
    id: z.string().describe("이슈 ID"),
    project_id: z.string().describe("이슈가 속한 프로젝트 ID(불일치 시 에러 — 다른 프로젝트 이슈 오조작 방지)"),
  },
  async (params) => ({
    content: [{ type: "text", text: JSON.stringify(issueResolve(params), null, 2) }],
  })
);

server.tool(
  "memory_add",
  "검색 가능한 메모리/요약/교훈 기록",
  {
    title: z.string().describe("메모리 제목"),
    content: z.string().describe("내용"),
    memory_type: z.string().optional().describe("분류: note/lesson/summary 등 (기본 note)"),
    tags: z.string().optional().describe("쉼표 구분 태그"),
    importance: z.number().optional().describe("중요도 1~5 (기본 3)"),
    project_id: z.string().describe("프로젝트 ID(STATUS.md 헤더 또는 get_current_context 로 확인)"),
    command_id: z.string().optional().describe("연관 명령(command) ID"),
  },
  async (params) => ({
    content: [{ type: "text", text: JSON.stringify(memoryAdd(params), null, 2) }],
  })
);

server.tool(
  "memory_search",
  "메모리 검색 (title/content/tags LIKE 검색. 벡터 검색은 후순위). query 생략 시 최신/중요 순 목록.",
  {
    query: z.string().optional().describe("검색어"),
    project_id: z.string().describe("프로젝트 ID 필터(STATUS.md 헤더 또는 get_current_context 로 확인)"),
    memory_type: z.string().optional().describe("분류 필터"),
    limit: z.number().optional().describe("최대 개수 (기본 50)"),
    offset: z.number().optional().describe("오프셋 (기본 0)"),
  },
  async (params) => ({
    content: [{ type: "text", text: JSON.stringify(memorySearch(params), null, 2) }],
  })
);

server.tool(
  "command_add",
  "사람 승인이 필요한 작업을 웹 승인함(/approvals)에 등록한다(status='queued'). 순수 이력은 activity_log 를 쓰고, 이 툴은 '승인 필요 건' 전용이다. 세션을 이어받아야 하면 session_id(현재 세션 id)를 넘겨 resume 로 등록한다 — 대표가 웹에서 승인+답변하면 워커가 claude --resume 로 같은 세션을 이어받는다.",
  {
    project_id: z.string().describe("대상 프로젝트 ID(STATUS.md 헤더 또는 get_current_context 로 확인)"),
    instruction: z.string().describe("승인 후 실행할 명령 또는 대표에게 보여줄 결정 요청/질문 내용"),
    session_id: z.string().optional().describe("(§9 resume) 이어받을 현재 세션의 id. 주면 task_type='resume' 로 등록되어 승인 시 claude --resume 로 재개된다. 신규 실행이면 생략."),
    task_type: z.string().optional().describe("작업 유형(분류용). session_id 를 주면 자동으로 'resume'."),
    risk_level: z.string().optional().describe("low|medium|high (기본 medium)"),
    title: z.string().optional().describe("승인함에 표시할 짧은 제목"),
    agent_name: z.string().optional().describe("등록 주체 에이전트(기본 mcp)"),
  },
  async (params) => ({
    content: [{ type: "text", text: JSON.stringify(commandAdd(params), null, 2) }],
  })
);

// ── Project Tools (라이프사이클 상태 선언만 쓰기 허용) ──

server.tool(
  "project_status_set",
  "프로젝트 라이프사이클 상태(대기/진행/완료/보류/삭제)를 선언한다. 라이프사이클=사람/AI의 '단계 의도'로 가동상태(파생)와 직교한다. 프로젝트가 완료됐다/보류다/다시 진행이다/삭제한다 라고 판단했을 때 호출. deleted는 하드delete가 아닌 소프트delete — DB row와 실제 폴더 모두 그대로 두고 상태만 바꾸며, 다른 상태로 되돌릴 수 있다. 순수 이력은 activity_log 로 충분하고 이 툴은 라이프사이클 전이 전용. 저위험(사람이 웹에서 즉시 되돌릴 수 있음)이라 승인함을 거치지 않고 직접 전이하며, 모든 전이는 감사로그에 남는다.",
  {
    project_id: z.string().describe("대상 프로젝트 ID(STATUS.md 헤더 또는 get_current_context 로 확인)"),
    status: z.enum(["pending", "active", "completed", "on_hold", "deleted"]).describe("전이할 상태: pending=대기, active=진행, completed=완료, on_hold=보류, deleted=삭제(소프트delete, 되돌릴 수 있음)"),
    reason: z.string().optional().describe("전이 사유(감사로그에 함께 기록). 예: 'KPI 전 항목 달성', '외부 승인 대기로 보류'"),
    agent_name: z.string().optional().describe("선언 주체 에이전트(기본 mcp)"),
  },
  async (params) => ({
    content: [{ type: "text", text: JSON.stringify(projectStatusSet(params), null, 2) }],
  })
);

// ── Server Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("SIGINT", () => {
  closeDb();
  process.exit(0);
});

process.on("SIGTERM", () => {
  closeDb();
  process.exit(0);
});

main().catch((err) => {
  console.error("Failed to start malgnai-mcp:", err);
  closeDb();
  process.exit(1);
});
