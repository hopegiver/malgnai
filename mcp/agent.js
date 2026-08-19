// MalgnMcpAgent — McpAgent(Durable Object) 서브클래스, MCP 도구 14개 등록(docs/mcp-tools.md 정본).
// 인증 컨텍스트는 this.props(deviceAuthMiddleware가 주입, architecture.md §6.2)에서 얻는다 —
// 클라이언트가 보내는 userId는 절대 신뢰하지 않는다(idea.md §12.3). 매 호출마다 D1을 직접 조회하고
// state/storage에 업무데이터를 이중 저장하지 않는다(architecture.md §0 결정2).
//
// 2026-07-28 전면 개명 + project_states 폐기(mcp-tools.md §5): 모든 도구를 `엔티티_동사` 패턴으로
// 재명명하고, update_project_state 도구/project_states 테이블을 완전히 없앴다 — state는 이제
// project_get_context/project_bootstrap이 매 호출마다 즉석 계산한다(server/lib/context.js
// computeProjectState). record_issue(opened/updated/resolved 3분기)는 issue_record(opened 전용)/
// issue_resolve(resolved 전용) 2개로 분리됐다(issue_update는 만들지 않음, §4.4).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import { z } from 'zod'
import * as projectsDao from '../server/dao/projects.js'
import { getProjectContext } from '../server/lib/context.js'
import { recordWork } from '../server/lib/works.js'
import { recordDecision } from '../server/lib/decisions.js'
import { recordIssue, resolveIssue } from '../server/lib/issues.js'
import { searchProjectHistory } from '../server/lib/search.js'
import * as wbsLib from '../server/lib/wbs.js'
import { bootstrapProject } from '../server/lib/bootstrap.js'
import { recordAgentLearning } from '../server/lib/agent-learnings.js'
import { recordAgentScore } from '../server/lib/agent-scores.js'
import { getAgentContext } from '../server/lib/agent-context.js'

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] }
}
function errorResult(err) {
  return { content: [{ type: 'text', text: err?.message || String(err) }], isError: true }
}

export class MalgnMcpAgent extends McpAgent {
  server = new McpServer({ name: 'malgnai-hub', version: '1.0.0' })

  /** projectId → 본인 소유 projects row 조회(2026-08-11 repositoryKey 전면 교체, mcp-tools.md §4.0).
   *  project_bootstrap(§4.11)만 repositoryKey로 최초 등록을 담당하고, 나머지 12개 도구는 그 응답의
   *  project_id를 그대로 받는다 — 매 호출마다 repositories/projects get-or-create를 반복하지 않는다.
   *  findOwnedById는 타인 소유 projectId를 존재해도 null로 위장한다(IDOR 방지, api.md §5.3과 동일 패턴). */
  async resolveProjectById(projectId) {
    if (!projectId || typeof projectId !== 'string') {
      const e = new Error('projectId is required')
      e.name = 'ValidationError'
      throw e
    }
    const userId = this.props.userId
    const project = await projectsDao.findOwnedById(this.env.DB, userId, projectId)
    if (!project) {
      const e = new Error('project not found')
      e.name = 'NotFoundError'
      throw e
    }
    return { userId, project }
  }

  async init() {
    this.server.registerTool(
      'project_get_context',
      {
        description: '프로젝트의 현재 상태(즉석 계산)·중요 결정·열린 이슈·최근 작업이력·WBS를 조합해 조회한다.',
        inputSchema: {
          projectId: z.string().min(1),
          sections: z.array(z.enum(['state', 'decisions', 'issues', 'recentWork', 'wbs'])).optional(),
          limit: z.number().int().min(1).max(50).optional()
        }
      },
      async ({ projectId, sections, limit }) => {
        try {
          const { project } = await this.resolveProjectById(projectId)
          const ctx = await getProjectContext(this.env.DB, project.id, { sections, limit })
          return textResult(ctx)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'work_record',
      {
        description: '진행 중이거나 완료된 작업을 기록한다(started/progress/completed/blocked). nextAction을 채우면 project_get_context의 state.nextAction에 그대로 이어진다.',
        inputSchema: {
          projectId: z.string().min(1),
          status: z.enum(['started', 'progress', 'completed', 'blocked']),
          title: z.string().min(1).max(200),
          summary: z.string().max(2000).optional(),
          reason: z.string().optional(),
          result: z.string().optional(),
          artifacts: z.array(z.string()).max(20).optional(),
          nextAction: z.string().optional(),
          idempotencyKey: z.string().min(1)
        }
      },
      async ({ projectId, ...rest }) => {
        try {
          const { userId, project } = await this.resolveProjectById(projectId)
          const out = await recordWork(this.env.DB, { userId, projectId: project.id, ...rest })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'decision_record',
      {
        description: '중요한 의사결정을 불변 이력으로 기록한다(매번 새 행).',
        inputSchema: {
          projectId: z.string().min(1),
          title: z.string().min(1).max(200),
          decision: z.string().min(1).max(2000),
          reason: z.string().min(1).max(2000),
          alternatives: z.array(z.string()).optional(),
          impact: z.array(z.string()).optional(),
          reversalCondition: z.string().optional(),
          importance: z.number().int().min(1).max(5).optional(),
          idempotencyKey: z.string().min(1)
        }
      },
      async ({ projectId, ...rest }) => {
        try {
          const { userId, project } = await this.resolveProjectById(projectId)
          const out = await recordDecision(this.env.DB, { userId, projectId: project.id, ...rest })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'issue_record',
      {
        description: '이슈를 새로 연다(opened 전용). 응답의 issueId를 보관해야 이후 issue_resolve가 가능하다. 열린 이슈를 나중에 갱신하는 기능은 없다(issue_update 미제공, §4.4).',
        inputSchema: {
          projectId: z.string().min(1),
          title: z.string().min(1).max(200),
          summary: z.string().min(1),
          severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
          suspectedCause: z.string().optional(),
          idempotencyKey: z.string().min(1)
        }
      },
      async ({ projectId, ...rest }) => {
        try {
          const { userId, project } = await this.resolveProjectById(projectId)
          const out = await recordIssue(this.env.DB, { userId, projectId: project.id, ...rest })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'issue_resolve',
      {
        description: 'issue_record로 연 이슈를 해결 처리한다(resolved 전용). issueId가 없거나 본인 프로젝트의 이슈가 아니면 NOT_FOUND.',
        inputSchema: {
          projectId: z.string().min(1),
          issueId: z.string().min(1),
          result: z.string().min(1)
        }
      },
      async ({ projectId, issueId, result }) => {
        try {
          const { project } = await this.resolveProjectById(projectId)
          const out = await resolveIssue(this.env.DB, { projectId: project.id, issueId, result })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'project_search_history',
      {
        description: '결정/이슈/작업이력을 전문검색(trigram FTS5)한다. projectId 필수(본인 프로젝트만).',
        inputSchema: {
          projectId: z.string().min(1),
          query: z.string().min(1).max(200),
          types: z.array(z.enum(['decision', 'issue', 'work'])).optional(),
          importanceMin: z.number().int().min(1).max(5).optional(),
          since: z.string().optional(),
          limit: z.number().int().min(1).max(30).optional()
        }
      },
      async ({ projectId, ...rest }) => {
        try {
          const { project } = await this.resolveProjectById(projectId)
          const out = await searchProjectHistory(this.env.DB, project.id, rest)
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'wbs_list',
      {
        description: '프로젝트 WBS(작업분류체계) 트리를 조회한다. 그룹 노드는 자식 롤업 진행률을 반환.',
        inputSchema: {
          projectId: z.string().min(1),
          parentId: z.string().optional(),
          status: z.enum(['planned', 'in_progress', 'done', 'delayed']).optional(),
          includeDone: z.boolean().optional()
        }
      },
      async ({ projectId, ...rest }) => {
        try {
          const { project } = await this.resolveProjectById(projectId)
          const out = await wbsLib.wbsList(this.env.DB, project.id, rest)
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'wbs_add',
      {
        description: 'WBS 항목을 1건 추가한다(parentId 없으면 최상위 Step).',
        inputSchema: {
          projectId: z.string().min(1),
          parentId: z.string().optional(),
          title: z.string().min(1).max(200),
          description: z.string().optional(),
          responsibleTeam: z.string().optional(),
          assigneeAgentName: z.string().optional(),
          startDate: z.string().optional(),
          endDate: z.string().optional(),
          idempotencyKey: z.string().min(1)
        }
      },
      async ({ projectId, ...rest }) => {
        try {
          const { userId, project } = await this.resolveProjectById(projectId)
          const out = await wbsLib.wbsAdd(this.env.DB, { userId, projectId: project.id, ...rest })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'wbs_bulk_add',
      {
        description: 'WBS 초안(Step+하위 작업)을 배치(1~100개)로 트랜잭션 1개에서 원자 생성한다. 부모가 자식보다 배열에서 먼저 와야 한다.',
        inputSchema: {
          projectId: z.string().min(1),
          items: z
            .array(
              z.object({
                tempId: z.string().min(1),
                parentTempId: z.string().optional(),
                parentId: z.string().optional(),
                title: z.string().min(1).max(200),
                description: z.string().optional(),
                responsibleTeam: z.string().optional(),
                assigneeAgentName: z.string().optional(),
                startDate: z.string().optional(),
                endDate: z.string().optional()
              })
            )
            .min(1)
            .max(100)
        }
      },
      async ({ projectId, items }) => {
        try {
          const { userId, project } = await this.resolveProjectById(projectId)
          const out = await wbsLib.wbsBulkAdd(this.env.DB, { userId, projectId: project.id, items })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'wbs_update',
      {
        description: 'WBS 항목을 갱신한다. 그룹(자식 있는) 노드는 progress/status=done을 직접 지정할 수 없다(자식 롤업 전용).',
        inputSchema: {
          projectId: z.string().min(1),
          id: z.string().min(1),
          title: z.string().max(200).optional(),
          description: z.string().optional(),
          status: z.enum(['planned', 'in_progress', 'done']).optional(),
          progress: z.number().int().min(0).max(100).optional(),
          responsibleTeam: z.string().optional(),
          assigneeAgentName: z.string().optional(),
          startDate: z.string().optional(),
          endDate: z.string().optional(),
          completedDate: z.string().optional()
        }
      },
      async ({ projectId, ...rest }) => {
        try {
          const { project } = await this.resolveProjectById(projectId)
          const out = await wbsLib.wbsUpdate(this.env.DB, { projectId: project.id, ...rest })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'project_bootstrap',
      {
        description: '이 레포지토리를 malgnai-hub에 최초 등록(get-or-create)하고, 프로젝트 루트에 그대로 쓸 수 있는 파일 3종의 마크다운과 폴더 스캐폴드 목록을 반환한다. statusMarkdown은 현재 컨텍스트(상태/결정/이슈/최근작업)를 조합한 STATUS.md(YAML frontmatter 포함, 매번 새로 조립). claudeMarkdown/docsReadmeMarkdown은 CLAUDE.md/docs/README.md용 고정 템플릿(D1 조회와 무관하게 항상 동일, repositoryKey만 치환), scaffoldFolders는 고정 배열 ["docs","src","output"] — 이미 로컬에 내용이 채워진 파일이 있으면 덮어쓰지 않도록 판단하는 것은 클라이언트 몫이다. 이미 등록된 프로젝트에 재호출해도 아무것도 덮어쓰지 않고 조회만 한다(멱등).',
        inputSchema: {
          repositoryKey: z.string().min(1),
          repositoryName: z.string().optional(),
          projectName: z.string().optional()
        }
      },
      async ({ repositoryKey, repositoryName, projectName }) => {
        try {
          const userId = this.props.userId
          const out = await bootstrapProject(this.env.DB, userId, { repositoryKey, repositoryName, projectName })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    // 2026-08 개인 에이전트 트래킹 도구 3종(mcp-tools.md §4.12~4.14, architecture.md §0 결정21).
    // 나머지 11개와 달리 project_id가 아니라 user_id가 1차 소유권 — 에이전트는 프로젝트가 아니라
    // 사람에게 속하고 여러 프로젝트를 넘나든다. projectId는 선택(필수 아님): 주어지면
    // resolveProjectById()로 "계기가 된 프로젝트" 참조를 확정하고(본인 소유가 아니면 에러), 없으면
    // projectId=null·userId=this.props.userId를 그대로 쓴다(다른 도구들의 projectId 필수 검증을 걸지 않음).
    this.server.registerTool(
      'agent_learning_record',
      {
        description: '개인 에이전트의 학습 이력(experience/external/peer_feedback/discussion)을 불변 이력으로 기록한다(매번 새 행). user_id+agent_name이 1차 소유권 — projectId는 선택이며 주면 계기가 된 프로젝트로 참조 저장된다.',
        inputSchema: {
          agentName: z.string().min(1),
          type: z.enum(['experience', 'external', 'peer_feedback', 'discussion']),
          title: z.string().min(1).max(200),
          content: z.string().min(1).max(2000),
          source: z.string().optional(),
          projectId: z.string().optional(),
          idempotencyKey: z.string().min(1)
        }
      },
      async ({ projectId: inputProjectId, ...rest }) => {
        try {
          const userId = this.props.userId
          let projectId = null
          if (inputProjectId) {
            const { project } = await this.resolveProjectById(inputProjectId)
            projectId = project.id
          }
          const out = await recordAgentLearning(this.env.DB, { userId, projectId, ...rest })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'agent_score_record',
      {
        description: '개인 에이전트의 평가 점수(overallScore 0~100, dimensionScores JSON 가능)를 불변 이력으로 기록한다(매번 새 행). user_id+agent_name이 1차 소유권 — projectId는 선택이며 주면 계기가 된 프로젝트로 참조 저장된다.',
        inputSchema: {
          agentName: z.string().min(1),
          overallScore: z.number().min(0).max(100),
          dimensionScores: z.record(z.number()).optional(),
          improvementNote: z.string().optional(),
          evaluatorNote: z.string().optional(),
          projectId: z.string().optional(),
          idempotencyKey: z.string().min(1)
        }
      },
      async ({ projectId: inputProjectId, ...rest }) => {
        try {
          const userId = this.props.userId
          let projectId = null
          if (inputProjectId) {
            const { project } = await this.resolveProjectById(inputProjectId)
            projectId = project.id
          }
          const out = await recordAgentScore(this.env.DB, { userId, projectId, ...rest })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'agent_get_context',
      {
        description: '개인 에이전트의 최신 평가 점수·점수 추이·최근 학습 이력을 조합해 조회한다. user_id+agent_name 스코프라 repositoryKey가 필요 없다(타 사용자 데이터에 닿을 경로 자체가 없음).',
        inputSchema: {
          agentName: z.string().min(1),
          learningLimit: z.number().int().min(1).max(50).optional(),
          scoreHistoryLimit: z.number().int().min(1).max(50).optional()
        }
      },
      async ({ agentName, learningLimit, scoreHistoryLimit }) => {
        try {
          const userId = this.props.userId
          const out = await getAgentContext(this.env.DB, userId, agentName, { learningLimit, scoreHistoryLimit })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )
  }
}
