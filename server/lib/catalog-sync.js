// 회사 Claude Code 플러그인(GitHub `malgnsoft/claude-plugins`, public repo, malgn-agent만 v1 범위 —
// 2026-08-25 저장소 소유자 hopegiver→malgnsoft 이전 + 플러그인 디렉터리명 malgn-dev→malgn-agent 개명)
// agents/skills/knowledge 카탈로그 동기화. GitHub REST(Git Trees API, recursive)로 파일 목록+blob
// sha를 가져오고 raw.githubusercontent.com으로 각 파일 content를 fetch한다. public repo라 애초엔
// 인증 없이 호출했으나(호출 빈도가 관리자 수동 트리거 + 1일 1회 cron뿐이라 60req/h 미인증 한도로
// 충분할 것으로 예상 — 상세 근거는 migrations/0006 주석/docs/architecture.md §0 참고), Cloudflare
// Workers 공유 egress IP가 다른 고객 트래픽과 합산되어 프로덕션에서 403(rate limit)이 실제로
// 발생했다. 그래서 `GITHUB_TOKEN` 시크릿(`wrangler secret put GITHUB_TOKEN`)이 있으면 반드시
// Authorization 헤더를 실어 인증 호출로 승격하고, 없으면 기존처럼 무인증으로 폴백한다(토큰 없이도
// 완전히 깨지지는 않되, 있는데 안 쓰는 실수는 없게). 인증 스킴은 GitHub REST 공식 문서
// (https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api)가 현재
// 예시로 제시하는 `Authorization: Bearer <token>`을 채택한다(`token` 스킴도 여전히 동작하지만
// 문서 예시가 Bearer이므로 이를 표준으로 따른다).
//
// 호출 진입점 2곳: server/api/admin-catalog.js(POST /api/admin/catalog/sync, 관리자 수동) +
// server/index.js scheduled 핸들러(Cloudflare Cron Trigger, 1일 1회, wrangler.jsonc triggers.crons).
// 둘 다 이 syncCatalog() 하나를 그대로 호출한다 — 동기화 로직을 두 곳에 중복 구현하지 않는다.
import * as catalogDao from '../dao/catalog.js'

const REPO = 'malgnsoft/claude-plugins'
const BRANCH = 'main'
const PLUGIN_NAME = 'malgn-agent'

const AGENT_PATH_RE = /^malgn-agent\/agents\/([^/]+)\.md$/
const SKILL_PATH_RE = /^malgn-agent\/skills\/([^/]+)\/SKILL\.md$/
const KNOWLEDGE_PATH_RE = /^malgn-agent\/knowledge\/(.+)\.md$/

function fetchError(message) {
  const e = new Error(message)
  e.name = 'InternalError'
  return e
}

function conflictError(message) {
  const e = new Error(message)
  e.name = 'ConflictError'
  return e
}

/** githubToken이 있으면 Authorization: Bearer 헤더를 추가한다(GitHub REST 공식 문서 예시
 *  스킴, 토큰 값 자체는 절대 로그/에러 메시지에 싣지 않는다). 없으면 무인증 그대로 폴백한다. */
function authHeaders(githubToken, base) {
  return githubToken ? { ...base, Authorization: `Bearer ${githubToken}` } : base
}

/** 403/401은 인증 관련 오류일 가능성이 높으므로, 토큰 사용 여부(값 자체가 아니라 유무)를 에러
 *  메시지에 덧붙여 관리자 화면에서 "토큰 미설정으로 인한 무인증 차단"과 "토큰은 실었는데도 거부
 *  (만료/권한 부족)"를 구분할 수 있게 한다. */
function authHint(githubToken) {
  return githubToken ? ' (authenticated request)' : ' (unauthenticated request)'
}

async function fetchTree(githubToken) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`, {
    headers: authHeaders(githubToken, { 'User-Agent': 'malgnai-hub-catalog-sync', Accept: 'application/vnd.github+json' })
  })
  if (!res.ok) throw fetchError(`GitHub tree fetch failed: ${res.status} ${res.statusText}${authHint(githubToken)}`)
  const json = await res.json()
  if (json.truncated) {
    // recursive tree가 GitHub 응답 한도를 넘으면 일부 파일이 누락될 수 있다 — 조용히 넘어가지
    // 않고 로그로 남긴다(malgn-agent 규모에서는 정상적으로 발생하지 않을 것으로 예상되는 비정상 케이스).
    console.error('[catalog-sync] GitHub tree response truncated — some files may be missing')
  }
  return Array.isArray(json.tree) ? json.tree : []
}

async function fetchRaw(path, githubToken) {
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${path}`, {
    headers: authHeaders(githubToken, {})
  })
  if (!res.ok) throw fetchError(`GitHub raw fetch failed for ${path}: ${res.status} ${res.statusText}${authHint(githubToken)}`)
  return res.text()
}

/** agent/skill frontmatter(`---\nname: ...\ndescription: ...\n---`) 파싱. 실패 시 둘 다 null. */
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { name: null, description: null }
  const body = m[1]
  const nameMatch = body.match(/^name:\s*(.+?)\s*$/m)
  const descMatch = body.match(/^description:\s*(.+?)\s*$/m)
  const strip = (v) => (v ? v.replace(/^['"]|['"]$/g, '') : null)
  return { name: strip(nameMatch?.[1] ?? null), description: strip(descMatch?.[1] ?? null) }
}

/** knowledge 문서는 frontmatter가 없다 — 첫 `# H1` 줄을 display_name으로 쓴다. */
function parseFirstH1(content) {
  const m = content.match(/^#\s+(.+?)\s*$/m)
  return m ? m[1] : null
}

function classifyEntries(tree) {
  const items = []
  for (const entry of tree) {
    if (entry.type !== 'blob') continue
    let m
    if ((m = entry.path.match(AGENT_PATH_RE))) {
      items.push({ itemType: 'agent', slug: m[1], path: entry.path, sha: entry.sha })
    } else if ((m = entry.path.match(SKILL_PATH_RE))) {
      items.push({ itemType: 'skill', slug: m[1], path: entry.path, sha: entry.sha })
    } else if ((m = entry.path.match(KNOWLEDGE_PATH_RE))) {
      items.push({ itemType: 'knowledge', slug: m[1], path: entry.path, sha: entry.sha })
    }
  }
  return items
}

/** GitHub 스캔 결과에서 같은 (item_type, slug)가 두 번 나오면(경로 규칙상 정상적으로는 발생하지
 *  않아야 함 — 예: agents/foo.md와 agents/foo.MD 같은 케이스) 조용히 하나를 덮어쓰지 않고
 *  명확한 에러로 전체 sync를 실패시킨다. */
function assertNoDuplicateSlugs(entries) {
  const seen = new Map()
  for (const entry of entries) {
    const key = `${entry.itemType}:${entry.slug}`
    if (seen.has(key)) {
      throw conflictError(`duplicate catalog slug detected during GitHub scan: ${key} (${seen.get(key)} vs ${entry.path})`)
    }
    seen.set(key, entry.path)
  }
}

/** malgn-agent agents/skills/knowledge를 GitHub에서 읽어 catalog_items/catalog_item_versions에
 *  반영한다. 파싱 실패(frontmatter 깨짐 등)는 항목을 빼지 않고 display_name=null로 포함하며
 *  parseFailures에 기록한다(조용히 누락 금지). 반환값은 관리자 트리거 응답/cron 로그 양쪽에서 쓴다.
 *
 *  GitHub에서 파일이 삭제되거나 이름이 바뀌면 이번 스캔의 (item_type, slug) 집합에서 빠진다 —
 *  기존 DB 행 중 그렇게 빠진 것을 찾아 catalogDao.markRemoved()로 soft-remove 표시한다(하드
 *  삭제 금지, migrations/0015). 이 diff는 `entries`(GitHub tree 스캔 결과, raw content fetch
 *  성공 여부와 무관)를 기준으로 계산한다 — raw fetch가 일시적으로 실패해 parseFailures에 들어간
 *  항목까지 "삭제됨"으로 오판하지 않기 위함.
 *
 *  githubToken(선택, 보통 c.env.GITHUB_TOKEN/env.GITHUB_TOKEN): 있으면 GitHub 요청에 인증
 *  헤더를 싣는다. 없으면 기존과 동일하게 무인증으로 시도한다. */
export async function syncCatalog(db, githubToken) {
  const tree = await fetchTree(githubToken)
  const entries = classifyEntries(tree)
  assertNoDuplicateSlugs(entries)

  const result = { scanned: entries.length, itemsUpserted: 0, versionsCreated: 0, itemsRemoved: 0, parseFailures: [] }

  for (const entry of entries) {
    let content
    try {
      content = await fetchRaw(entry.path, githubToken)
    } catch (err) {
      console.error('[catalog-sync] raw content fetch failed', entry.path, err)
      result.parseFailures.push({ path: entry.path, reason: 'fetch_failed' })
      continue
    }

    let displayName = null
    let description = null
    if (entry.itemType === 'knowledge') {
      displayName = parseFirstH1(content)
      if (!displayName) {
        console.error('[catalog-sync] knowledge doc missing H1', entry.path)
        result.parseFailures.push({ path: entry.path, reason: 'missing_h1' })
      }
    } else {
      const fm = parseFrontmatter(content)
      displayName = fm.name
      description = fm.description
      if (!fm.name) {
        console.error('[catalog-sync] frontmatter parse failed (missing name)', entry.path)
        result.parseFailures.push({ path: entry.path, reason: 'frontmatter_missing_name' })
      }
    }

    const { id: itemId } = await catalogDao.upsertCompanyItem(db, {
      pluginName: PLUGIN_NAME,
      itemType: entry.itemType,
      slug: entry.slug,
      displayName,
      description,
      sourcePath: entry.path
    })
    result.itemsUpserted++

    const { created } = await catalogDao.insertVersionIfChanged(db, itemId, entry.sha, content)
    if (created) result.versionsCreated++
  }

  const scannedKeys = new Set(entries.map((e) => `${e.itemType}:${e.slug}`))
  const activeExisting = await catalogDao.listActiveCompanyItemKeys(db, PLUGIN_NAME)
  const removedIds = activeExisting
    .filter((row) => !scannedKeys.has(`${row.item_type}:${row.slug}`))
    .map((row) => row.id)
  if (removedIds.length > 0) {
    await catalogDao.markRemoved(db, removedIds)
    result.itemsRemoved = removedIds.length
  }

  return result
}
