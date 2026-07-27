// `ai`(Vercel AI SDK) 패키지 빌드 시점 별칭용 no-op 스텁.
//
// `agents` 패키지(McpAgent가 속한 Cloudflare Agents SDK)는 AIChatAgent용 헬퍼(this.mcp.getAITools()
// 등)에서 선택적으로 `await import('ai')`를 시도한다. 이 프로젝트는 McpAgent를 MCP 서버(도구 10개
// 등록)로만 쓰고 AIChatAgent/getAITools()는 전혀 호출하지 않으므로 실제 `ai` 패키지를 설치할 이유가
// 없다 — 하지만 esbuild는 동적 import라도 문자열 리터럴이면 빌드 시점에 해석을 시도해 "ai" 모듈을
// 찾지 못하면 번들링 자체가 실패한다. wrangler.jsonc의 top-level `alias`로 이 빈 스텁으로 치환해
// 빌드만 통과시키고, 런타임에 실제로 호출되지 않으므로 동작에는 영향이 없다.
export function jsonSchema() {
  throw new Error('ai SDK is not installed in this project (McpAgent is used as a plain MCP server, not an AIChatAgent).')
}
export default {}
