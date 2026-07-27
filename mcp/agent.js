// MalgnMcpAgent — McpAgent(Durable Object) 서브클래스, MCP 도구 11개 등록(docs/mcp-tools.md 정본).
// 인증 컨텍스트는 this.props(deviceAuthMiddleware가 주입, architecture.md §6.2)에서 얻는다 —
// 클라이언트가 보내는 userId는 절대 신뢰하지 않는다(idea.md §12.3). 매 호출마다 D1을 직접 조회하고
// state/storage에 업무데이터를 이중 저장하지 않는다(architecture.md §0 결정2).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import { z } from 'zod'
import * as repositoriesDao from '../server/dao/repositories.js'
import * as projectsDao from '../server/dao/projects.js'
import { getProjectContext } from '../server/lib/context.js'
import { recordWork } from '../server/lib/works.js'
import { recordDecision } from '../server/lib/decisions.js'
import { recordIssue } from '../server/lib/issues.js'
import { updateState } from '../server/lib/project-state.js'
import { searchProjectHistory } from '../server/lib/search.js'
import * as wbsLib from '../server/lib/wbs.js'
import { bootstrapProject } from '../server/lib/bootstrap.js'

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] }
}
function errorResult(err) {
  return { content: [{ type: 'text', text: err?.message || String(err) }], isError: true }
}

export class MalgnMcpAgent extends McpAgent {
  server = new McpServer({ name: 'malgnai-hub', version: '1.0.0' })

  /** repositoryKey → repositories get-or-create → (userId, repository.id)로 projects get-or-create.
   *  최초 호출 시 자동 프로비저닝(§4.1/§4.2) — 이 사용자의 project row 1개 생성은 가역·저위험이라
   *  승인 게이트 불필요. 타인의 프로젝트를 여기서 만들거나 조회할 길은 없다(항상 this.props.userId 스코프). */
  async resolveProject(repositoryKey) {
    if (!repositoryKey || typeof repositoryKey !== 'string') {
      const e = new Error('repositoryKey is required')
      e.name = 'ValidationError'
      throw e
    }
    const userId = this.props.userId
    const repository = await repositoriesDao.getOrCreate(this.env.DB, repositoryKey)
    const project = await projectsDao.getOrCreateForUser(this.env.DB, userId, repository)
    return { userId, repository, project }
  }

  async init() {
    this.server.registerTool(
      'get_project_context',
      {
        description: '프로젝트의 현재 상태·중요 결정·열린 이슈·최근 작업이력을 조합해 조회한다.',
        inputSchema: {
          repositoryKey: z.string().min(1),
          sections: z.array(z.enum(['state', 'decisions', 'issues', 'recentWork'])).optional(),
          limit: z.number().int().min(1).max(50).optional()
        }
      },
      async ({ repositoryKey, sections, limit }) => {
        try {
          const { project } = await this.resolveProject(repositoryKey)
          const ctx = await getProjectContext(this.env.DB, project.id, { sections, limit })
          return textResult(ctx)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'record_work',
      {
        description: '진행 중이거나 완료된 작업을 기록한다(started/progress/completed/blocked).',
        inputSchema: {
          repositoryKey: z.string().min(1),
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
      async (input) => {
        try {
          const { userId, project } = await this.resolveProject(input.repositoryKey)
          const out = await recordWork(this.env.DB, { userId, projectId: project.id, ...input })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'record_decision',
      {
        description: '중요한 의사결정을 불변 이력으로 기록한다(매번 새 행).',
        inputSchema: {
          repositoryKey: z.string().min(1),
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
      async (input) => {
        try {
          const { userId, project } = await this.resolveProject(input.repositoryKey)
          const out = await recordDecision(this.env.DB, { userId, projectId: project.id, ...input })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'record_issue',
      {
        description: '이슈를 열거나(opened)/갱신(updated)/해결(resolved)한다. opened 응답의 issueId를 보관해야 이후 resolve가 가능하다.',
        inputSchema: {
          repositoryKey: z.string().min(1),
          issueId: z.string().optional(),
          status: z.enum(['opened', 'updated', 'resolved']),
          title: z.string().max(200).optional(),
          summary: z.string().optional(),
          severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
          suspectedCause: z.string().optional(),
          result: z.string().optional(),
          nextAction: z.string().optional(),
          idempotencyKey: z.string().min(1)
        }
      },
      async (input) => {
        try {
          const { userId, project } = await this.resolveProject(input.repositoryKey)
          const out = await recordIssue(this.env.DB, { userId, projectId: project.id, ...input })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'update_project_state',
      {
        description: '프로젝트 진행 상태를 낙관적 동시성(expectedVersion)으로 갱신한다.',
        inputSchema: {
          repositoryKey: z.string().min(1),
          expectedVersion: z.number().int().min(1),
          patch: z.object({
            progress: z.number().int().min(0).max(100).optional(),
            currentWork: z.string().optional(),
            nextAction: z.string().optional(),
            health: z.enum(['normal', 'warning', 'critical']).optional(),
            phase: z.string().optional(),
            blockerSummary: z.string().optional(),
            activeBranch: z.string().optional(),
            latestCommit: z.string().optional(),
            currentGoal: z.string().optional()
          })
        }
      },
      async ({ repositoryKey, expectedVersion, patch }) => {
        try {
          const { userId, project } = await this.resolveProject(repositoryKey)
          const state = await updateState(this.env.DB, { projectId: project.id, userId, expectedVersion, patch })
          return textResult({ version: state.version })
        } catch (e) {
          if (e.name === 'ConflictError') return textResult({ error: 'VERSION_CONFLICT', current: e.current })
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'search_project_history',
      {
        description: '결정/이슈/작업이력을 전문검색(trigram FTS5)한다. repositoryKey 필수(본인 프로젝트만).',
        inputSchema: {
          repositoryKey: z.string().min(1),
          query: z.string().min(1).max(200),
          types: z.array(z.enum(['decision', 'issue', 'work'])).optional(),
          importanceMin: z.number().int().min(1).max(5).optional(),
          since: z.string().optional(),
          limit: z.number().int().min(1).max(30).optional()
        }
      },
      async ({ repositoryKey, ...rest }) => {
        try {
          const { project } = await this.resolveProject(repositoryKey)
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
          repositoryKey: z.string().min(1),
          parentId: z.string().optional(),
          status: z.enum(['planned', 'in_progress', 'done', 'delayed']).optional(),
          includeDone: z.boolean().optional()
        }
      },
      async ({ repositoryKey, ...rest }) => {
        try {
          const { project } = await this.resolveProject(repositoryKey)
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
          repositoryKey: z.string().min(1),
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
      async ({ repositoryKey, ...rest }) => {
        try {
          const { userId, project } = await this.resolveProject(repositoryKey)
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
          repositoryKey: z.string().min(1),
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
      async ({ repositoryKey, items }) => {
        try {
          const { userId, project } = await this.resolveProject(repositoryKey)
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
          repositoryKey: z.string().min(1),
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
      async ({ repositoryKey, ...rest }) => {
        try {
          const { project } = await this.resolveProject(repositoryKey)
          const out = await wbsLib.wbsUpdate(this.env.DB, { projectId: project.id, ...rest })
          return textResult(out)
        } catch (e) {
          return errorResult(e)
        }
      }
    )

    this.server.registerTool(
      'bootstrap_project',
      {
        description: '이 레포지토리를 malgnai-hub에 최초 등록(get-or-create)하고, 현재 컨텍스트(상태/결정/이슈/최근작업)를 조합해 프로젝트 루트 STATUS.md에 그대로 쓸 수 있는 마크다운(YAML frontmatter 포함)을 반환한다. 이미 등록된 프로젝트에 재호출해도 아무것도 덮어쓰지 않고 조회만 한다(멱등).',
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
  }
}
