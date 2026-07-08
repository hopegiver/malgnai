/**
 * 역할별 필수 스킬 정의
 * 각 스킬: name, category, description, how_to_learn, learning_resources
 * team: 에이전트가 속한 팀
 */

export const TEAM_DEFINITIONS = {
  leadership: { name: "리더십팀", description: "전체 프로젝트 운영과 조율", members: ["coo"] },
  planning: { name: "기획팀", description: "요구사항 분석, 시장 조사, 전략 기획", members: ["planner", "researcher"] },
  design: { name: "디자인팀", description: "UX/UI 설계와 비주얼 디자인", members: ["ux-designer", "visual-designer"] },
  development: { name: "개발팀", description: "프론트엔드/백엔드 시스템 구현", members: ["architect", "backend-dev", "frontend-dev"] },
  quality: { name: "품질팀", description: "테스트, 리뷰, 보안 점검, 배포", members: ["qa-engineer", "reviewer", "security", "devops"] },
  communication: { name: "커뮤니케이션팀", description: "문서 작성, 발표 자료 제작", members: ["writer", "presenter"] },
  proposal: { name: "제안팀", description: "RFP 분석, 수주 전략, 제안서 작성 (공공 입찰·기업 제안)", members: ["rfp-analyst", "capture-strategist"] },
  marketing: { name: "마케팅팀", description: "마케팅 전략, 캠페인 기획, 채널 운영, 성과 분석", members: ["marketer"] },
  finance: { name: "재무팀", description: "예산 수립, 수익성 분석, 재무 모델링, 투자 검토", members: ["finance"] },
  training: { name: "교육팀", description: "에이전트 역량 진단, 학습 자료 관리, 스킬업 실행", members: ["trainer"] },
}

/**
 * 에이전트별 학습 자료(knowledge) 폴더 매핑
 * C:\Users\user\.claude\knowledge\<folder>\*.md 를 학습 자료로 연결
 * 여러 폴더를 참조하는 에이전트는 배열로 지정 (common은 모든 에이전트 공통)
 */
export const KNOWLEDGE_MAP = {
  coo: ["leadership", "common"],
  planner: ["planning", "common"],
  researcher: ["planning", "common"],
  "ux-designer": ["design", "common"],
  "visual-designer": ["design", "common"],
  architect: ["architecture", "common"],
  "backend-dev": ["backend", "common"],
  "frontend-dev": ["frontend", "common"],
  "qa-engineer": ["quality", "common"],
  reviewer: ["review", "proposal", "common"],
  security: ["security", "common"],
  devops: ["devops", "common"],
  writer: ["writing", "proposal", "common"],
  presenter: ["presentation", "common"],
  "rfp-analyst": ["proposal", "common"],
  "capture-strategist": ["proposal", "common"],
  marketer: ["marketing", "common"],
  finance: ["finance", "common"],
  trainer: ["leadership", "common"],
}

/**
 * AI 직원 카드 (B-2) — 에이전트별 운영 메타.
 * job_title 은 SKILL_DEFINITIONS[name].title 을 재사용한다(중복 방지).
 * - model: 역할 난이도/추론 부하 기준 권장 모델 (opus=고난도 추론·조율, sonnet=일반 실무)
 * - forbidden_tasks: 이 직원이 절대 해서는 안 되는 일 (가드레일)
 * - approval_required_tasks: 실행 전 대표 승인이 필요한 일 (승인 대기함으로 수렴)
 * 정의되지 않은 에이전트는 DEFAULT_EMPLOYEE_CARD 적용.
 */
export const DEFAULT_EMPLOYEE_CARD = {
  model: "sonnet",
  forbidden_tasks: ["대표 승인 없는 비가역 운영 작업", "권한 우회·보안정책 무력화"],
  approval_required_tasks: ["운영 환경 배포", "외부로 산출물·데이터 전송"],
}

export const EMPLOYEE_CARDS = {
  coo: {
    model: "opus",
    forbidden_tasks: ["대표 승인 없는 운영 D1 배포", "도메인 산출물 직접 집필(권위자 위임 원칙)", "에이전트 임의 신설"],
    approval_required_tasks: ["운영 환경 배포", "전칭/영구 규칙 신설", "여러 에이전트 공통 자산 변경", "새 에이전트 신설"],
  },
  architect: {
    model: "opus",
    forbidden_tasks: ["승인 없는 비가역 아키텍처 변경", "운영 DB 스키마 파괴적 마이그레이션"],
    approval_required_tasks: ["기술 스택 확정", "파급 큰 아키텍처 결정", "데이터 모델 변경"],
  },
  "backend-dev": {
    model: "sonnet",
    forbidden_tasks: ["운영 DB 파괴적 작업(DROP/DELETE/UPDATE) 무단 실행", "시크릿 하드코딩", "권한 우회"],
    approval_required_tasks: ["운영 환경 배포", "DB 스키마 마이그레이션", "외부 API 키 발급·연동"],
  },
  "frontend-dev": {
    model: "sonnet",
    forbidden_tasks: ["승인 없는 운영 배포", "외부 스크립트 무단 삽입"],
    approval_required_tasks: ["운영 환경 배포", "결제·인증 흐름 변경"],
  },
  devops: {
    model: "opus",
    forbidden_tasks: ["대표 승인 없는 운영 배포·인프라 파괴", "프로덕션 시크릿 노출"],
    approval_required_tasks: ["운영 환경 배포", "인프라 프로비저닝/삭제", "도메인·DNS 변경"],
  },
  security: {
    model: "opus",
    forbidden_tasks: ["실제 공격·DoS 실행", "취약점 외부 공개", "탐지 회피 도구 제작"],
    approval_required_tasks: ["침투 테스트 실행", "보안 설정 변경"],
  },
  "qa-engineer": {
    model: "sonnet",
    forbidden_tasks: ["테스트 결과 조작·유령 보고", "운영 데이터로 파괴적 테스트"],
    approval_required_tasks: ["운영 환경 대상 테스트"],
  },
  reviewer: {
    model: "opus",
    forbidden_tasks: ["산출물 직접 수정(리뷰는 진단·권고만)", "유령 리뷰 보고"],
    approval_required_tasks: [],
  },
  planner: {
    model: "sonnet",
    forbidden_tasks: ["요구사항 임의 확정(대표 합의 없이)"],
    approval_required_tasks: ["요구사항 범위 확정", "PRD 최종본 승인"],
  },
  researcher: {
    model: "sonnet",
    forbidden_tasks: ["미검증 정보를 사실로 보고", "제품 사양 미확인 추천"],
    approval_required_tasks: [],
  },
  "ux-designer": { model: "sonnet", forbidden_tasks: ["합의 없는 핵심 플로우 변경"], approval_required_tasks: ["정보구조(IA) 확정"] },
  "visual-designer": { model: "sonnet", forbidden_tasks: ["브랜드 가이드 무단 변경"], approval_required_tasks: ["브랜드 컬러·로고 확정"] },
  writer: { model: "sonnet", forbidden_tasks: ["사실 미확인 내용 작성", "외부 발송 문서 무단 전송"], approval_required_tasks: ["대외 발송 문서 최종본"] },
  presenter: { model: "sonnet", forbidden_tasks: ["근거 없는 수치 슬라이드화"], approval_required_tasks: ["대외 발표 자료 최종본"] },
  "rfp-analyst": { model: "sonnet", forbidden_tasks: ["실격 리스크 미고지", "평가 배점 임의 추정"], approval_required_tasks: ["제출 전 실격방지 게이트 통과 판정"] },
  "capture-strategist": { model: "opus", forbidden_tasks: ["Bid/No-Bid 단독 확정"], approval_required_tasks: ["Bid/No-Bid 결정", "수주 전략 확정"] },
  marketer: { model: "sonnet", forbidden_tasks: ["승인 없는 유료 광고 집행", "외부 채널 무단 게시"], approval_required_tasks: ["광고 예산 집행", "대외 캠페인 발행"] },
  finance: { model: "opus", forbidden_tasks: ["재무 수치 임의 가정·왜곡"], approval_required_tasks: ["투자/사업성 판단 보고", "예산 확정"] },
  trainer: {
    model: "opus",
    forbidden_tasks: ["여러 에이전트 동시 편집 충돌 유발", "검증 없는 교훈 일반화"],
    approval_required_tasks: ["다수 에이전트 공통 MD 일괄 변경", "전칭 규칙 신설"],
  },
}

export const SKILL_DEFINITIONS = {
  coo: {
    title: "COO (최고운영책임자)",
    team: "leadership",
    skills: [
      { name: "팀 구성 및 위임", category: "리더십", description: "요청을 분석하여 최적의 에이전트 팀을 구성하고 업무를 위임", how_to_learn: "다양한 프로젝트 유형별 최적 팀 구성 패턴을 경험으로 축적", learning_resources: "프로젝트 수행 후 팀 구성 효과를 회고하여 memory에 기록" },
      { name: "프로젝트 관리", category: "관리", description: "프로젝트 전체 진행상황을 추적하고 일정/품질을 관리", how_to_learn: "progress.md 기반 상태 추적 패턴을 반복 실습", learning_resources: "STATUS.md 작성 및 프로젝트별 회고 리포트 생성" },
      { name: "품질 검토", category: "관리", description: "각 에이전트 산출물의 품질을 평가하고 재작업 지시", how_to_learn: "산출물 평가 체크리스트를 만들고 적용 경험을 축적", learning_resources: "산출물 검토 후 피드백 패턴을 정리하여 가이드라인 문서화" },
      { name: "에이전트 간 조율", category: "리더십", description: "에이전트 간 작업 순서와 의존성을 조율", how_to_learn: "에이전트 간 토론/피드백 세션을 주도하는 경험 축적", learning_resources: "복잡한 멀티에이전트 프로젝트를 수행하며 조율 패턴 학습" },
      { name: "보고서 통합", category: "커뮤니케이션", description: "여러 에이전트의 결과를 통합하여 대표에게 보고", how_to_learn: "보고서 형식과 요약 기술을 반복 실습", learning_resources: "좋은 보고서 사례를 수집하고 템플릿을 개선" },
      { name: "리스크 판단", category: "리더십", description: "프로젝트 리스크를 사전에 식별하고 대응 방안 수립", how_to_learn: "과거 프로젝트 실패 사례를 분석하여 리스크 패턴 학습", learning_resources: "프로젝트 회고 시 리스크 항목을 별도 정리" },
    ]
  },
  planner: {
    title: "기획 전문가",
    team: "planning",
    skills: [
      { name: "요구사항 분석", category: "기획", description: "고객의 모호한 요청에서 명확한 요구사항을 도출", how_to_learn: "다양한 도메인의 요구사항 문서를 분석하고 패턴을 학습", learning_resources: "IEEE 830 SRS 표준, 유저 스토리 작성법 학습" },
      { name: "PRD 작성", category: "기획", description: "제품 요구사항 명세서를 체계적으로 작성", how_to_learn: "실제 PRD 사례를 수집하고 구조를 분석", learning_resources: "유명 제품의 PRD 사례 분석, Must/Should/Nice 우선순위 기법" },
      { name: "사용자 시나리오", category: "기획", description: "타겟 사용자의 행동 시나리오를 정의", how_to_learn: "페르소나 기반 시나리오 작성 실습", learning_resources: "사용자 여정 지도(User Journey Map) 작성 방법론 학습" },
      { name: "비기능 요구사항", category: "기획", description: "성능, 보안, 확장성 등 비기능 요구사항을 정의", how_to_learn: "웹 서비스 표준 비기능 요구사항 체크리스트를 학습", learning_resources: "ISO 25010 품질 특성 모델 학습" },
      { name: "경쟁 분석", category: "분석", description: "유사 제품을 분석하여 차별화 포인트를 도출", how_to_learn: "경쟁사 분석 프레임워크(SWOT 등) 실습", learning_resources: "시장 분석 보고서 작성 실습" },
    ]
  },
  researcher: {
    title: "리서치 전문가",
    team: "planning",
    skills: [
      { name: "웹 리서치", category: "조사", description: "WebSearch/WebFetch로 최신 정보를 효율적으로 수집", how_to_learn: "검색 쿼리 최적화, 신뢰할 수 있는 소스 판별 실습", learning_resources: "고급 검색 연산자 활용, 팩트체크 방법론 학습" },
      { name: "시장 분석", category: "분석", description: "시장 규모, 트렌드, 경쟁 환경을 체계적으로 분석", how_to_learn: "TAM/SAM/SOM 분석, Porter 5 Forces 프레임워크 실습", learning_resources: "시장 분석 보고서 사례 연구" },
      { name: "경쟁사 분석", category: "분석", description: "경쟁사 제품/서비스의 강약점을 비교 분석", how_to_learn: "SWOT 분석, 기능 비교 매트릭스 작성 실습", learning_resources: "경쟁사 분석 프레임워크 학습" },
      { name: "기술 조사", category: "조사", description: "기술 옵션의 장단점, 성숙도, 사례를 비교 조사", how_to_learn: "기술 비교 기준을 체계화하고 평가표 작성 실습", learning_resources: "GitHub stars/issues 분석, npm trends 활용법 학습" },
      { name: "보고서 구조화", category: "문서", description: "조사 결과를 논리적으로 구조화하여 문서화", how_to_learn: "요약-본문-결론 구조 작성 반복 실습", learning_resources: "좋은 리서치 보고서 사례 분석" },
    ]
  },
  "ux-designer": {
    title: "UX 디자이너",
    team: "design",
    skills: [
      { name: "사용자 흐름 설계", category: "UX", description: "핵심 시나리오별 화면 전환 흐름도 작성", how_to_learn: "다양한 앱의 사용자 흐름을 분석하고 재설계", learning_resources: "사용자 여정 지도, 태스크 흐름 다이어그램 작성법" },
      { name: "와이어프레임", category: "UX", description: "텍스트/ASCII 기반 화면 레이아웃 작성", how_to_learn: "다양한 화면 유형(리스트, 폼, 대시보드)의 와이어프레임 실습", learning_resources: "와이어프레임 컨벤션, Lo-fi/Hi-fi 구분 학습" },
      { name: "정보 구조(IA)", category: "UX", description: "네비게이션 구조와 콘텐츠 계층 설계", how_to_learn: "카드 소팅, 트리 테스트 기법 학습", learning_resources: "IA 설계 원칙, 네비게이션 패턴 학습" },
      { name: "인터랙션 설계", category: "UX", description: "클릭, 호버, 전환 등 인터랙션 동작 명세", how_to_learn: "마이크로 인터랙션 패턴 분석", learning_resources: "Material Design 인터랙션 가이드라인 참고" },
      { name: "접근성 설계", category: "UX", description: "다양한 사용자를 고려한 포용적 UX 설계", how_to_learn: "WCAG 2.1 가이드라인 학습", learning_resources: "접근성 체크리스트 적용 실습" },
    ]
  },
  "visual-designer": {
    title: "비주얼 디자이너",
    team: "design",
    skills: [
      { name: "색상 체계 설계", category: "디자인", description: "Primary/Secondary/Semantic 색상 팔레트 정의", how_to_learn: "색상 이론, 대비 비율 학습", learning_resources: "색상 조합 도구(Coolors) 활용, 접근성 대비 검사" },
      { name: "타이포그래피", category: "디자인", description: "폰트 선택, 크기 계층, 행간/자간 설계", how_to_learn: "타이포그래피 원칙 학습", learning_resources: "Google Fonts 탐색, 타입 스케일 계산기 활용" },
      { name: "디자인 시스템", category: "디자인", description: "컴포넌트 스타일, 간격, 그림자 등 시스템 정의", how_to_learn: "기존 디자인 시스템(Material, Ant) 분석", learning_resources: "design-system.md 작성 실습, Tailwind 설정 변환" },
      { name: "브랜딩", category: "디자인", description: "브랜드 아이덴티티, 톤앤매너 정의", how_to_learn: "브랜딩 사례 분석", learning_resources: "브랜드 가이드라인 작성 실습" },
      { name: "CSS 구현", category: "구현", description: "디자인 시스템을 CSS/Tailwind 코드로 변환", how_to_learn: "CSS 변수, 유틸리티 클래스 작성 실습", learning_resources: "base.css 스타일 디자인 토큰 확장" },
    ]
  },
  architect: {
    title: "시스템 아키텍트",
    team: "development",
    skills: [
      { name: "시스템 설계", category: "설계", description: "전체 시스템의 컴포넌트 구조와 데이터 흐름 설계", how_to_learn: "다양한 아키텍처 패턴(모놀리식, MSA, 서버리스)을 실습", learning_resources: "C4 Model 학습, 실제 프로젝트에서 architecture.md 작성 반복" },
      { name: "기술 스택 선정", category: "설계", description: "프로젝트 요구사항에 최적인 기술 스택을 선정하고 근거를 제시", how_to_learn: "기술별 장단점 비교 분석을 반복 실습", learning_resources: "최신 기술 트렌드 조사, ThoughtWorks Technology Radar 참고" },
      { name: "API 설계", category: "설계", description: "RESTful/GraphQL API를 일관성 있게 설계", how_to_learn: "OpenAPI 스펙 작성 실습, API 디자인 가이드라인 학습", learning_resources: "Google API Design Guide, Stripe API 구조 분석" },
      { name: "데이터 모델링", category: "설계", description: "엔티티 관계와 스키마를 설계하고 인덱스 전략 수립", how_to_learn: "ERD 작성 실습, 정규화/비정규화 판단 기준 학습", learning_resources: "다양한 도메인의 데이터 모델 사례 분석" },
      { name: "확장성 설계", category: "설계", description: "트래픽 증가에 대응하는 확장 가능한 구조 설계", how_to_learn: "캐싱, 큐, 샤딩 등 확장 패턴을 학습", learning_resources: "System Design Interview 패턴 학습" },
      { name: "보안 아키텍처", category: "설계", description: "인증/인가, 데이터 암호화 등 보안 구조 설계", how_to_learn: "OWASP 보안 가이드라인을 아키텍처에 적용하는 실습", learning_resources: "Zero Trust 아키텍처, JWT/OAuth2 플로우 학습" },
    ]
  },
  "backend-dev": {
    title: "백엔드 개발자",
    team: "development",
    skills: [
      { name: "API 구현", category: "개발", description: "설계 문서 기반으로 완성된 API 엔드포인트 구현", how_to_learn: "Hono/Express 등 프레임워크별 패턴을 반복 구현", learning_resources: "다양한 CRUD + 비즈니스 로직 API 구현 실습" },
      { name: "DB 구현", category: "개발", description: "데이터 모델을 실제 DB 스키마와 쿼리로 구현", how_to_learn: "SQL/NoSQL 쿼리 최적화 실습", learning_resources: "D1, PostgreSQL, MongoDB 등 다양한 DB 실습" },
      { name: "인증/인가", category: "개발", description: "JWT, 세션, OAuth 등 인증 시스템 구현", how_to_learn: "다양한 인증 방식의 구현 패턴을 실습", learning_resources: "Passport.js, jose 라이브러리 학습" },
      { name: "에러 처리", category: "개발", description: "일관된 에러 응답과 예외 처리 구현", how_to_learn: "에러 분류 체계와 HTTP 상태 코드 매핑 실습", learning_resources: "에러 미들웨어 패턴, 로깅 전략 학습" },
      { name: "테스트 작성", category: "품질", description: "단위/통합 테스트를 작성하여 코드 품질 보장", how_to_learn: "Vitest, Jest 등 테스트 프레임워크 실습", learning_resources: "TDD 방법론, 테스트 커버리지 전략 학습" },
      { name: "성능 최적화", category: "개발", description: "N+1 쿼리 제거, 캐싱, 인덱스 활용 등 성능 개선", how_to_learn: "실제 병목 지점을 프로파일링하고 개선하는 실습", learning_resources: "DB 쿼리 실행계획 분석, HTTP 캐싱 전략 학습" },
    ]
  },
  "frontend-dev": {
    title: "프론트엔드 개발자",
    team: "development",
    skills: [
      { name: "Vue.js 개발", category: "개발", description: "Vue 3 Options API 기반 컴포넌트 개발", how_to_learn: "vue-zero 프레임워크 내에서 다양한 UI 패턴 구현", learning_resources: "Vue.js 공식 문서, vue-zero 규칙 숙지" },
      { name: "반응형 디자인", category: "UI", description: "모바일/태블릿/데스크탑 대응 반응형 레이아웃 구현", how_to_learn: "Bootstrap 5 그리드/유틸리티 클래스 활용 실습", learning_resources: "Mobile-first 디자인 패턴 학습" },
      { name: "API 연동", category: "개발", description: "백엔드 API와의 데이터 통신 구현", how_to_learn: "useApi 헬퍼 활용, 로딩/에러 상태 처리 패턴 실습", learning_resources: "RESTful API 연동 패턴, 낙관적 업데이트 학습" },
      { name: "상태 관리", category: "개발", description: "컴포넌트 간 데이터 흐름과 상태 관리", how_to_learn: "props/emit, provide/inject 패턴 실습", learning_resources: "Vue 반응성 시스템 심화 학습" },
      { name: "접근성", category: "UI", description: "시맨틱 HTML, ARIA 속성 등 접근성 준수", how_to_learn: "WCAG 2.1 가이드라인 학습 및 적용", learning_resources: "스크린 리더 테스트, axe 접근성 검사 도구 활용" },
      { name: "CSS/디자인 시스템", category: "UI", description: "디자인 토큰 기반 일관된 스타일링 구현", how_to_learn: "base.css 디자인 토큰 체계를 이해하고 확장", learning_resources: "CSS 변수, BEM 명명법, 유틸리티 클래스 학습" },
    ]
  },
  "qa-engineer": {
    title: "QA 엔지니어",
    team: "quality",
    skills: [
      { name: "테스트 설계", category: "테스트", description: "테스트 케이스와 시나리오를 체계적으로 설계", how_to_learn: "경계값 분석, 동등 분할, 상태 전이 기법 학습", learning_resources: "ISTQB 테스트 설계 기법 학습" },
      { name: "단위 테스트", category: "테스트", description: "핵심 비즈니스 로직의 단위 테스트 작성", how_to_learn: "Vitest/Jest 프레임워크 활용 실습", learning_resources: "Mock/Stub/Spy 활용 패턴 학습" },
      { name: "API 테스트", category: "테스트", description: "API 엔드포인트의 통합 테스트 작성 및 실행", how_to_learn: "Playwright, supertest 등으로 API 테스트 실습", learning_resources: "API 테스트 자동화 패턴 학습" },
      { name: "E2E 테스트", category: "테스트", description: "사용자 시나리오 기반 End-to-End 테스트", how_to_learn: "Playwright 브라우저 테스트 작성 실습", learning_resources: "Page Object Model, 테스트 안정성 확보 패턴" },
      { name: "버그 분석 및 수정", category: "품질", description: "테스트 실패 원인을 분석하고 코드를 수정", how_to_learn: "디버깅 기법, 로그 분석 실습", learning_resources: "근본 원인 분석(RCA) 방법론 학습" },
    ]
  },
  reviewer: {
    title: "리뷰 진행자",
    team: "quality",
    skills: [
      { name: "페르소나 패널 구성", category: "리뷰", description: "리뷰 대상에 맞는 다관점 페르소나를 설계하고 패널을 구성", how_to_learn: "페르소나 6대 요소(정체성·관심사·평가기준·평가방법론·참고파일·출력포맷)를 채우는 실습", learning_resources: "knowledge/review/reviewer-personas.md 분석, 프로젝트별 페르소나 작성 반복" },
      { name: "다관점 리뷰", category: "리뷰", description: "각 페르소나 관점으로 산출물을 검토하고 심각도로 분류", how_to_learn: "관점별 평가기준 표를 만들고 위반을 Critical/Major/Minor/Nit로 분류하는 실습", learning_resources: "심각도 표준, 근거(파일·라인) 인용 패턴 학습" },
      { name: "화면 캡처", category: "도구", description: "Playwright로 UI 산출물을 캡처하여 화면 리뷰 근거 확보", how_to_learn: "전역 `shot <url>` 명령으로 화면을 캡처하고 리뷰 근거로 첨부하는 실습", learning_resources: "knowledge/review/screenshot-capture-guide.md, Playwright 패턴 학습" },
      { name: "통합 보고서 작성", category: "문서", description: "페르소나별 결과를 통합하고 충돌을 트레이드오프로 정리", how_to_learn: "중복 병합·충돌 명시·종합 판정(RAG) 산정 실습", learning_resources: "리뷰 보고서 표준 형식, 2분 규칙 학습" },
      { name: "COO 보고", category: "커뮤니케이션", description: "종합 판정과 핵심 지적·권고를 COO에게 전달", how_to_learn: "핵심 3~5개 추출 및 우선순위 정렬 실습", learning_resources: "보고서 통합·요약 기법 학습" },
    ]
  },
  security: {
    title: "보안 전문가",
    team: "quality",
    skills: [
      { name: "OWASP Top 10", category: "보안", description: "SQL Injection, XSS, CSRF 등 주요 취약점 점검", how_to_learn: "OWASP Top 10 각 항목별 코드 점검 실습", learning_resources: "OWASP Testing Guide, 취약 코드 패턴 학습" },
      { name: "인증/인가 점검", category: "보안", description: "세션, JWT, 권한 체계의 보안성 검토", how_to_learn: "인증 우회 시나리오를 분석하고 방어 패턴 학습", learning_resources: "JWT 보안 가이드, OAuth2 보안 고려사항 학습" },
      { name: "코드 보안 리뷰", category: "보안", description: "소스 코드에서 보안 취약점을 식별", how_to_learn: "취약 코드 패턴 목록을 만들고 grep/분석 실습", learning_resources: "SAST 도구 원리 학습, 시큐어 코딩 가이드라인" },
      { name: "인프라 보안", category: "보안", description: "Docker, 환경변수, 네트워크 보안 점검", how_to_learn: "Docker 보안 체크리스트 적용 실습", learning_resources: "CIS Docker Benchmark, 최소 권한 원칙 학습" },
      { name: "보안 보고서", category: "문서", description: "취약점을 심각도별로 분류하고 개선안 제시", how_to_learn: "CVSS 점수 산정, 보안 보고서 작성 실습", learning_resources: "보안 감사 보고서 사례 분석" },
    ]
  },
  devops: {
    title: "DevOps 엔지니어",
    team: "quality",
    skills: [
      { name: "Docker 컨테이너화", category: "인프라", description: "멀티스테이지 Dockerfile 작성 및 최적화", how_to_learn: "다양한 기술 스택의 Dockerfile 작성 실습", learning_resources: "Docker 베스트 프랙티스, 이미지 크기 최적화 학습" },
      { name: "Docker Compose", category: "인프라", description: "멀티 서비스 환경을 docker-compose로 구성", how_to_learn: "앱+DB+캐시 등 복합 환경 구성 실습", learning_resources: "네트워크, 볼륨, 헬스체크 설정 학습" },
      { name: "CI/CD", category: "자동화", description: "빌드-테스트-배포 파이프라인 구성", how_to_learn: "GitHub Actions, Cloudflare Workers 배포 자동화 실습", learning_resources: "CI/CD 파이프라인 패턴 학습" },
      { name: "환경 관리", category: "인프라", description: "환경변수, 시크릿, 설정 파일 관리", how_to_learn: ".env 관리, 시크릿 마스킹 패턴 실습", learning_resources: "12-Factor App 방법론 학습" },
      { name: "Cloudflare 배포", category: "인프라", description: "Workers, D1, R2 등 Cloudflare 서비스 활용", how_to_learn: "wrangler CLI 활용 실습", learning_resources: "Cloudflare 공식 문서, Workers 제약사항 학습" },
    ]
  },
  writer: {
    title: "문서 작성 전문가",
    team: "communication",
    skills: [
      { name: "제안서 작성", category: "문서", description: "사업 제안서를 체계적으로 작성", how_to_learn: "제안서 구조(배경-제안-효과-일정-예산) 반복 실습", learning_resources: "수주 성공 제안서 사례 분석" },
      { name: "보고서 작성", category: "문서", description: "분석 결과를 논리적으로 보고서로 정리", how_to_learn: "요약-본문-결론 구조화 실습", learning_resources: "컨설팅 보고서 형식 학습" },
      { name: "기술 문서 작성", category: "문서", description: "아키텍처, API, 사용 가이드 등 기술 문서 작성", how_to_learn: "다양한 기술 문서 형식(README, API docs) 실습", learning_resources: "Divio 문서 시스템(튜토리얼/가이드/설명/참조) 학습" },
      { name: "독자 맞춤 톤", category: "커뮤니케이션", description: "대상 독자에 맞는 톤과 수준 조절", how_to_learn: "같은 내용을 다른 독자용으로 재작성 실습", learning_resources: "기술/비기술 독자별 문서 사례 비교" },
      { name: "시각적 구조화", category: "문서", description: "표, 리스트, 다이어그램으로 정보 시각화", how_to_learn: "Markdown 표/리스트/Mermaid 활용 실습", learning_resources: "정보 시각화 원칙 학습" },
    ]
  },
  marketer: {
    title: "마케팅 전문가",
    team: "marketing",
    skills: [
      { name: "마케팅 전략 수립", category: "전략", description: "STP와 4P/4C로 타겟·포지셔닝·마케팅 믹스를 설계", how_to_learn: "STP·포지셔닝 스테이트먼트 작성을 반복 실습", learning_resources: "knowledge/marketing/marketing-strategy-guide.md, 포지셔닝 사례 분석" },
      { name: "채널/캠페인 기획", category: "전략", description: "PESO 채널 믹스와 캠페인 One-pager를 퍼널 단계 기준으로 기획", how_to_learn: "AARRR 퍼널에서 새는 단계 진단 후 캠페인 설계 실습", learning_resources: "캠페인 1-pager 템플릿, 퍼널 분석 사례" },
      { name: "디지털 광고 연계 설계", category: "채널", description: "Google Ads/GA4와 네이버 검색광고/스마트스토어의 구조·과금·연동(API/태그)을 설계", how_to_learn: "채널별 캠페인 유형·입찰·UTM·전환 이벤트 연동을 실습", learning_resources: "knowledge/marketing/digital-ad-channels.md, Google Ads/GA4/네이버 검색광고 공식 문서" },
      { name: "SEO/콘텐츠 마케팅", category: "채널", description: "검색 유입을 누적 자산으로 키우는 SEO·콘텐츠 전략 수립", how_to_learn: "검색의도 분류와 기술적/온페이지/오프페이지 SEO 실습", learning_resources: "Search Console 분석, E-E-A-T·AI 검색 노출 가이드" },
      { name: "퍼포먼스 분석(KPI·ROAS)", category: "분석", description: "CPC/CTR/CVR/CPA/ROAS/LTV를 산식으로 분석하고 퍼널을 진단", how_to_learn: "손익분기 ROAS(=1/마진율) 계산과 채널별 성과 비교 실습", learning_resources: "KPI 산식표, 광고 벤치마크 자료(출처 명시)" },
      { name: "마케팅 보고서 작성", category: "문서", description: "성과를 의사결정으로 잇는 마케팅 보고서를 구조화", how_to_learn: "목표 vs 실적·퍼널·채널별 성과·다음 액션 구조 작성 실습", learning_resources: "마케팅 성과 보고서 템플릿 분석" },
    ]
  },
  finance: {
    title: "재무 전문가",
    team: "finance",
    skills: [
      { name: "예산 수립/원가 추정", category: "재무", description: "개발·운영·마케팅 비용을 분류하고 체계적으로 추정", how_to_learn: "Bottom-up·Top-down·3점 추정(PERT) 실습", learning_resources: "knowledge/finance/financial-analysis-guide.md, 원가 추정 사례" },
      { name: "수익성 분석(BEP·ROI)", category: "분석", description: "손익분기점과 투자수익률을 산식으로 분석", how_to_learn: "BEP(=고정비/공헌이익)·ROI 계산과 손익 전환 시점 도출 실습", learning_resources: "공헌이익 분석, ROI/회수기간 산식 학습" },
      { name: "재무 모델링(P&L·현금흐름)", category: "재무", description: "3~5년 추정 손익·현금흐름 모델을 가정 표 기반으로 구축", how_to_learn: "가정 표 단일 입력원 설계와 런웨이 추적 실습", learning_resources: "knowledge/finance/financial-model-templates.md, P&L/Cash Flow 템플릿" },
      { name: "투자/사업성 평가(NPV·IRR)", category: "분석", description: "화폐의 시간가치를 반영해 NPV/IRR/민감도로 투자가치를 판단", how_to_learn: "NPV(=ΣCF/(1+r)^t−투자)·IRR 계산과 민감도 표 작성 실습", learning_resources: "할인현금흐름(DCF) 방법론, 토네이도 분석 학습" },
      { name: "리스크/재무 시나리오", category: "분석", description: "시나리오 3종과 단위경제(LTV/CAC)로 불확실성을 구조화", how_to_learn: "보수/기본/공격 시나리오와 LTV:CAC 산정 실습", learning_resources: "단위경제 지표, 시나리오 분석 가이드" },
      { name: "재무 보고서 작성", category: "문서", description: "분석 결과를 투자 의사결정으로 잇는 재무 보고서를 구조화", how_to_learn: "권고(채택/조건부/보류)·가정·민감도 구조 작성 실습", learning_resources: "재무 분석 보고서 템플릿 분석" },
    ]
  },
  trainer: {
    title: "에이전트 교관",
    team: "training",
    skills: [
      { name: "스킬 진단", category: "분석", description: "에이전트의 취약 스킬을 분석하고 학습 계획을 수립", how_to_learn: "스킬 평가 함수와 MD 파일 구조를 이해", learning_resources: "skill-definitions.js, assessSkillLevel 함수 분석" },
      { name: "학습 자료 수집", category: "조사", description: "WebSearch로 최신 베스트 프랙티스와 패턴을 수집", how_to_learn: "효율적 검색 쿼리와 신뢰할 수 있는 소스 판별", learning_resources: "고급 검색 연산자, 공식 문서 우선 원칙" },
      { name: "knowledge 관리", category: "관리", description: "학습 자료를 knowledge 폴더에 체계적으로 정리하고 갱신", how_to_learn: "knowledge 폴더 구조와 README 관리 방법 숙지", learning_resources: "knowledge/README.md 구조 분석" },
      { name: "에이전트 MD 보강", category: "관리", description: "에이전트 MD 파일의 스킬 상세와 절차를 보강하여 역량 향상", how_to_learn: "assessSkillLevel 평가 기준을 이해하고 키워드 최적화", learning_resources: "에이전트 MD 파일 구조 분석" },
      { name: "프로젝트 회고", category: "분석", description: "프로젝트 완료 후 교훈을 수집하고 knowledge에 반영", how_to_learn: "회고 프레임워크와 교훈 정리 패턴 학습", learning_resources: "lessons 폴더 구조, 회고 보고서 형식" },
    ]
  },
  presenter: {
    title: "프레젠테이션 전문가",
    team: "communication",
    skills: [
      { name: "슬라이드 구성", category: "발표", description: "1슬라이드 1메시지 원칙으로 발표 자료 구성", how_to_learn: "좋은 프레젠테이션 사례를 분석", learning_resources: "TED 발표 슬라이드 구조 분석" },
      { name: "Marp 활용", category: "도구", description: "Marp Markdown으로 슬라이드 작성 및 PDF 변환", how_to_learn: "Marp 문법과 테마 커스터마이징 실습", learning_resources: "Marp 공식 문서, 커스텀 테마 작성" },
      { name: "시각적 전달", category: "발표", description: "텍스트 최소화, 키워드와 구조로 메시지 전달", how_to_learn: "텍스트 슬라이드를 시각적 슬라이드로 변환 실습", learning_resources: "인포그래픽 디자인 원칙 학습" },
      { name: "발표자 노트", category: "발표", description: "슬라이드별 발표 포인트와 스크립트 작성", how_to_learn: "핵심 메시지 3개 추출 실습", learning_resources: "스토리텔링 기법 학습" },
    ]
  },
  "rfp-analyst": {
    title: "제안 분석가",
    team: "proposal",
    skills: [
      { name: "RFP 해부 및 요구사항 추출", category: "분석", description: "RFP·과업지시서·평가표를 문장 단위로 해부하여 모든 요구사항을 검증 가능한 단위로 추출", how_to_learn: "명령·의무 표현(SHALL/MUST/필수/이상·이내)을 신호로 요구를 쪼개고 유형 태그를 붙이는 절차 반복 실습", learning_resources: "knowledge/proposal/korea-public-procurement.md, RFP 원문 정독 패턴" },
      { name: "Compliance Matrix 작성", category: "분석", description: "요구사항과 제안 섹션을 1:1로 매핑하고 준수여부(C/PC/NC/N/A)와 커버리지를 정량화", how_to_learn: "표준 매핑 표에 Req-ID·출처·배점·증거·리스크를 채우고 충족률을 산정하는 실습", learning_resources: "knowledge/proposal/compliance-matrix-template.md" },
      { name: "배점 분석 및 노력 배분", category: "분석", description: "평가표 배점×강점도로 노력 배분 우선순위를 도출하고 Win Theme 앵커 후보를 식별", how_to_learn: "배점×약점이 큰 위험 칸을 식별하고 분량을 배분하는 전략 수립 실습", learning_resources: "knowledge/proposal/proposal-writing-principles.md, 평가표 모의채점" },
      { name: "실격방지 게이트 운영", category: "품질", description: "제출 전 자격·서류·봉투분리·양식·예가·가점을 전수 점검하는 하드 게이트 운영", how_to_learn: "실격/무효/감점 요인 체크리스트를 전수 대조하고 NC 해소 현황을 추적하는 실습", learning_resources: "knowledge/proposal/compliance-matrix-template.md 실격방지 체크리스트, 과거 실격 사례" },
      { name: "공공·기업 양면 대응", category: "분석", description: "공공 입찰(과락·봉투분리·필수서류)과 기업 제안(추적성·ROI 근거)으로 분석 초점을 전환", how_to_learn: "사업 유형별 게이트를 전환 적용하는 실습", learning_resources: "knowledge/proposal/korea-public-procurement.md, 사업 유형별 RFP 비교" },
    ]
  },
  "capture-strategist": {
    title: "수주 전략가",
    team: "proposal",
    skills: [
      { name: "Bid/No-Bid 판단", category: "전략", description: "승산·적합성·수익성·전략가치 4축 점수로 추적 가치를 판단하고 No-Bid도 전략적으로 권고", how_to_learn: "4축 가중 점수표 작성과 No-Bid 신호 체크 실습", learning_resources: "knowledge/proposal/shipley-proposal-process.md Bid/No-Bid 4축" },
      { name: "발주처·경쟁사 인텔리전스", category: "조사", description: "발주 배경·통점·의사결정 구조·Hot Button과 경쟁 구도를 근거 기반으로 분석", how_to_learn: "WebSearch·과거 낙찰 이력으로 발주처/경쟁사를 조사하고 출처를 명시하는 실습", learning_resources: "knowledge/planning/market-research.md, 과거 낙찰 정보 조사" },
      { name: "Win Theme 수립", category: "전략", description: "[핫버튼]+[차별능력]+[증명된 이익] 3요소 공식으로 평가표에 앵커링된 승리 주제 수립", how_to_learn: "Win Theme을 평가 대항목별로 배치하고 수치 증거를 붙이는 실습", learning_resources: "knowledge/proposal/shipley-proposal-process.md Win Theme 공식" },
      { name: "Discriminator·Ghosting", category: "전략", description: "경쟁사가 못 베끼는 차별점을 도출하고 비방 없이 경쟁사 약점을 평가기준으로 환기", how_to_learn: "판별 질문('경쟁사도 이 문장을 쓸 수 있나')과 사실 기반 Ghosting 실습", learning_resources: "knowledge/proposal/shipley-proposal-process.md, knowledge/planning/business-brief-patterns.md" },
      { name: "Storyboard 기획", category: "기획", description: "집필 전 섹션별 핵심 메시지·증거·그래픽 컨셉을 한 장짜리 설계도로 기획", how_to_learn: "섹션별 스토리보드 표(요구·Win Theme·Action Caption·Proof)를 채우는 실습", learning_resources: "knowledge/proposal/proposal-writing-principles.md Action Caption" },
      { name: "공공·기업 전략 균형", category: "전략", description: "공공(평가표 앵커링·안정성)과 기업(ROI·회수기간 설득)으로 수주 전략을 전환", how_to_learn: "사업 유형별 Win Theme 중심축을 전환하는 실습", learning_resources: "knowledge/proposal/proposal-writing-principles.md 공공 vs 기업 비교" },
    ]
  },
}

// 스킬 고유성이 낮은 범용어. 이 단어들이 "스킬이 다뤄진다"는 근거가 되면
// 모든 스킬이 같은 점수로 수렴하므로 키워드 집합에서 제외한다.
const SKILL_STOPWORDS = new Set(
  ("그리고 또는 위해 통해 기반 기반으로 대한 대해 있는 있게 하고 하여 하는 한다 함을 으로 에서 에게 까지 부터 " +
   "같은 각각 모든 여러 다양한 핵심 실제 직접 정확 명확 체계 체계적 적절 최적 최신 전체 결과 내용 정보 자료 " +
   "문서 작성 분석 설계 구현 구성 정의 수립 도출 제시 활용 검토 평가 관리 처리 적용 반영 확인 점검 진행 수행 " +
   "포함 제공 지원 다관점 각종 등을 등의 등은 등에 등이").split(/\s+/)
)

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }

// 스킬명 + 설명에서 변별력 있는 키워드(고유 토큰)를 추출
function skillKeywords(skill) {
  const raw = `${skill.name} ${skill.description}`.toLowerCase()
  const toks = raw.replace(/[()/·,.]/g, " ").split(/\s+/)
    .map(w => w.replace(/[을를이가은는의와과로]+$/, "")) // 흔한 조사 제거(휴리스틱)
    .filter(w => w.length > 1 && !SKILL_STOPWORDS.has(w))
  return [...new Set(toks)]
}

/**
 * MD 파일 내용에서 "해당 스킬"이 실제로 다뤄지는 정도를 추정 (1~5).
 *
 * 기존 결함: detailScore(```/단계/산출물/knowledge/원칙)를 MD '전체'에서 검사해
 * 모든 스킬에 동일하게 적용 → 잘 쓴 MD면 전 스킬이 5점으로 수렴.
 *
 * 개선: 문서 전체 신호가 아니라 '이 스킬'의 고유 근거만 측정한다.
 *  - coverage : 스킬 키워드 중 MD에 등장한 비율 (스킬이 언급되긴 하는가)
 *  - depth    : 스킬 키워드의 총 등장 빈도 (얼마나 깊이 다뤄지는가)
 *  - section  : 스킬명/핵심키워드를 담은 heading(##/###) 존재 (전용 섹션이 있는가)
 *  - locality : 스킬 언급 줄 근처(±N줄)에 절차/예시/산출물 신호가 있는가
 *               (문서 어딘가의 ```가 모든 스킬을 끌어올리지 않도록 근접성으로 한정)
 */
export function assessSkillLevel(mdContent, skill) {
  if (!mdContent) return 1
  const lines = mdContent.split(/\r?\n/)
  const lower = mdContent.toLowerCase()
  const lowerLines = lines.map(l => l.toLowerCase())
  const nameL = skill.name.toLowerCase()

  const keywords = skillKeywords(skill)
  if (!keywords.length) return lower.includes(nameL) ? 2 : 1

  // 1) coverage + depth: 키워드별 등장 횟수
  let present = 0
  let totalHits = 0
  for (const kw of keywords) {
    const m = lower.match(new RegExp(escapeRegExp(kw), "g"))
    const n = m ? m.length : 0
    if (n > 0) present++
    totalHits += Math.min(n, 3) // 한 키워드가 점수를 독식하지 않도록 캡(최대 3)
  }
  const coverage = present / keywords.length          // 0~1
  const nameInDoc = lower.includes(nameL)

  // 2) section: 전용 heading 강도 구분
  //  - strong: heading이 스킬명을 직접 포함 (그 스킬을 위한 전용 섹션)
  //  - weak  : heading이 스킬 키워드를 다수 포함 (간접적 전용성)
  const headings = lowerLines.filter(l => /^#{2,4}\s/.test(l.trim()))
  const strongSection = headings.some(h => h.includes(nameL))
  const weakSection = !strongSection && headings.some(h => {
    const hits = keywords.filter(kw => h.includes(kw)).length
    return hits >= Math.max(2, Math.ceil(keywords.length * 0.6))
  })

  // 3) locality: 스킬 키워드가 등장하는 줄 인덱스를 모으고,
  //    그 근처(±3줄)에 절차/예시/산출물 신호가 있는지 확인
  const DETAIL = /```|단계|절차|예시|산출물|체크리스트|템플릿|^\s*\d+[.)]|패턴/
  const anchorIdx = []
  lowerLines.forEach((l, i) => {
    if (keywords.some(kw => l.includes(kw)) || l.includes(nameL)) anchorIdx.push(i)
  })
  let localDetail = false
  for (const i of anchorIdx) {
    for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
      if (DETAIL.test(lines[j])) { localDetail = true; break }
    }
    if (localDetail) break
  }

  // ── 점수 산정 (1~5에 분산되도록 보정) ──
  // 각 신호를 점수화한 뒤 합산해 등급으로 환산한다. 단일 신호가 점수를
  // 독식하지 못하게 하고, 최고 등급(5)은 '전용 섹션 + 깊은 빈도 + 근접 디테일'이
  // 모두 충족될 때만 부여한다.
  let pts = 0
  // coverage: 스킬이 실제로 언급되는가 (0~2)
  if (coverage >= 0.75) pts += 2
  else if (coverage >= 0.5) pts += 1
  // depth: 얼마나 자주/깊게 다뤄지는가 (0~3) — 빈도가 깊이의 대리 지표
  if (totalHits >= 16) pts += 3
  else if (totalHits >= 10) pts += 2
  else if (totalHits >= 6) pts += 1
  // section: 스킬 전용 heading 강도 (0~2)
  if (strongSection) pts += 2
  else if (weakSection) pts += 1
  // locality: 스킬 언급 근처에 절차/예시/산출물이 있는가 (0~1)
  if (localDetail) pts += 1

  // 합산(최대 8) → 등급.
  //  5(expert)   : 모든 강신호 충족 (coverage·depth 최상 + 전용 섹션 + 근접 디테일)
  //  4(advanced) : 대부분 충족하나 한 축이 부족
  //  3(intermed.): 다뤄지긴 하나 깊이/전용성 부족
  //  2(beginner+): 언급 수준
  //  1(beginner) : 사실상 미커버
  if (pts >= 8) return 5
  if (pts >= 5) return 4
  if (pts >= 3) return 3
  if (pts >= 1 || nameInDoc) return 2
  return 1
}
