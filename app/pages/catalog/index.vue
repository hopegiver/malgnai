<template>
  <div>
    <div class="d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
      <div>
        <h1 class="mb-0">카탈로그</h1>
        <small class="text-muted" v-if="!loading && !error">
          malgn-dev 플러그인 · {{ filteredItems.length }}개
        </small>
      </div>
      <button class="btn btn-outline-secondary btn-sm d-flex align-items-center gap-1" @click="load" :disabled="loading">
        <i class="bi" :class="loading ? 'bi-arrow-repeat spin' : 'bi-arrow-clockwise'"></i>
        새로고침
      </button>
    </div>

    <!-- 타입 탭: 에이전트/스킬/지식을 별도 조회 -->
    <div class="cat-tabs-wrap mb-4">
      <ul class="nav cat-tabs" role="tablist">
        <li class="nav-item" role="presentation" v-for="t in TYPES" :key="t.value">
          <button class="nav-link" type="button" :class="{ active: activeType === t.value }" @click="activeType = t.value">
            <i class="bi" :class="t.icon"></i>{{ t.label }}
            <span v-if="!loading && !error" class="cat-tab-count">{{ countByType(t.value) }}</span>
          </button>
        </li>
      </ul>
    </div>

    <!-- 로딩 스켈레톤: 섹션 헤더 자리표시자 1~2개 + 실제 카드(cat-card, 16px 패딩)와 동일 클래스를
         써서 로딩→데이터 전환 시 레이아웃이 튀지 않게 한다(IA §7). -->
    <div v-if="loading">
      <div class="skeleton-line cat-section-header-skeleton" v-for="n in 2" :key="'sh' + n"></div>
      <div class="row g-3 mb-4">
        <div class="col-12 col-md-6 col-xl-4" v-for="n in 6" :key="n">
          <div class="cat-card card" style="min-height:130px">
            <div class="skeleton-line" style="width:60%;height:16px;margin-bottom:10px"></div>
            <div class="skeleton-line" style="width:90%;height:12px;margin-bottom:6px"></div>
            <div class="skeleton-line" style="width:70%;height:12px;margin-bottom:16px"></div>
            <div class="skeleton-line" style="width:30%;height:20px"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 에러 -->
    <div v-else-if="error" class="alert alert-warning d-flex justify-content-between align-items-center">
      <span><i class="bi bi-exclamation-triangle me-1"></i>{{ errorMessage }}</span>
      <button class="btn btn-sm btn-outline-secondary" @click="load">다시 시도</button>
    </div>

    <!-- 카테고리 점프 칩 + 섹션별 카드 그리드: 카드 마크업 자체는 기존 그대로 재사용(IA §6.3).
         칩은 필터가 아니라 페이지 내 앵커 이동(IA §6.2) — 0개인 카테고리는 sections에 없으므로
         칩 목록에서도 자동으로 빠진다(Dead End 방지, IA §7 마지막 행). -->
    <template v-else-if="sections.length">
      <div class="cat-jump-chips mb-4">
        <button
          v-for="sec in sections"
          :key="'chip-' + sec.anchorId"
          type="button"
          class="cat-jump-chip"
          :class="{ active: activeSectionKey === sec.anchorId }"
          @click="jumpTo(sec.anchorId)"
        >{{ sec.label }} {{ sec.items.length }}</button>
      </div>

      <div v-for="sec in sections" :key="sec.anchorId" :id="sec.anchorId" class="cat-section mb-4" :data-section-anchor="sec.anchorId">
        <h2 class="cat-section-header">
          <span class="cat-section-dot" aria-hidden="true"></span>{{ sec.label }}
          <span class="cat-section-count">{{ sec.items.length }}</span>
        </h2>
        <div class="row g-3">
          <div class="col-12 col-md-6 col-xl-4" v-for="item in sec.items" :key="item.id">
            <div class="cat-card card h-100" @click="$router.push('/catalog/' + item.id)" style="cursor:pointer">
              <div class="d-flex justify-content-between align-items-center mb-2 gap-2">
                <span class="fw-semibold d-inline-flex align-items-center gap-2 min-w-0" style="font-size:15px">
                  <i class="bi flex-shrink-0" :class="catalogItemTypeMeta(item.item_type).icon"></i>
                  <span class="text-truncate">{{ item.display_name || item.slug }}</span>
                </span>
                <span class="badge flex-shrink-0" :class="catalogPromotionStatusMeta(item.latest_promotion_status).cls">
                  {{ catalogPromotionStatusMeta(item.latest_promotion_status).label }}
                </span>
              </div>
              <p class="text-muted small mb-2 cat-card-desc">{{ item.description || '설명 없음' }}</p>
              <div class="mt-auto pt-3 border-top border-hairline d-flex justify-content-between align-items-center">
                <small class="text-faint">
                  <i class="bi bi-arrow-repeat me-1"></i>{{ item.latest_synced_at ? formatRelative(item.latest_synced_at) : '동기화 전' }}
                </small>
                <small v-if="item.latest_evaluator_score !== null && item.latest_evaluator_score !== undefined" class="text-faint">
                  공식점수 {{ item.latest_evaluator_score }}
                </small>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 빈 상태: 필터 결과 없음(다른 탭엔 있음) -->
    <div v-else-if="items.length" class="text-center py-5">
      <i class="bi bi-funnel d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
      <div class="fw-medium mb-1 text-muted">이 타입의 카탈로그 항목이 없습니다</div>
    </div>

    <!-- 빈 상태: 카탈로그 전체가 비어있음 -->
    <div v-else class="text-center py-5">
      <i class="bi bi-collection d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
      <div class="fw-medium mb-1 text-muted">아직 카탈로그가 비어있습니다</div>
      <div class="text-faint small">malgn-dev 플러그인 동기화(관리자 수동 트리거 또는 매일 자동)가 완료되면 이곳에 표시됩니다.</div>
    </div>
  </div>
</template>

<script>
const TYPES = [
  { value: 'agent', label: '에이전트', icon: 'bi-robot' },
  { value: 'skill', label: '스킬', icon: 'bi-lightning-charge' },
  { value: 'knowledge', label: '지식', icon: 'bi-book' },
]

export default {
  title: '카탈로그 · malgnai-hub',
  data() {
    return {
      TYPES,
      items: [],
      loading: true,
      error: false,
      errorMessage: '',
      activeType: 'agent',
      activeSectionKey: null,
    }
  },
  computed: {
    filteredItems() {
      return this.items.filter((it) => it.item_type === this.activeType)
    },
    // 카테고리 조직도화(docs/ux/catalog-information-architecture.md §4~5): 탭 타입별로 신뢰 가능한
    // 원천이 달라 그룹핑 함수도 다르게 쓴다 — agent는 slug 확정 매핑, skill은 slug 접두사,
    // knowledge는 slug의 폴더 세그먼트(utils.js catalogAgentCategory/catalogSkillCategory/
    // catalogKnowledgeCategory). '기타'는 lookup에 없는 항목의 폴백 섹션(사라짐 방지, IA §7).
    sections() {
      const type = this.activeType
      // 세 타입 모두 slug 하나로 분류한다 — knowledge도 source_path가 아니라 slug의 폴더 세그먼트를
      // 쓴다(목록 API 응답에 source_path가 없음, utils.js catalogKnowledgeCategory 주석 참고).
      const categoryOf = type === 'agent' ? catalogAgentCategory : type === 'skill' ? catalogSkillCategory : catalogKnowledgeCategory
      const groups = {}
      for (const it of this.filteredItems) {
        const key = categoryOf(it.slug)
        ;(groups[key] || (groups[key] = [])).push(it)
      }
      let orderedKeys
      if (type === 'knowledge') {
        // 지식 폴더는 고정 카테고리 목록이 없는 데이터 기반 그룹이라 항목 수 내림차순(스캔 우선순위)
        // + 동률은 가나다 순으로 정렬하고, '기타'(폴더 세그먼트 추출 실패)는 항상 맨 끝 고정한다.
        orderedKeys = Object.keys(groups).filter((k) => k !== '기타').sort((a, b) => groups[b].length - groups[a].length || a.localeCompare(b, 'ko'))
        if (groups['기타']) orderedKeys.push('기타')
      } else {
        // agent/skill은 IA 문서가 정한 고정 순서를 그대로 쓴다 — 순서 자체가 "조직도" 의미를 가짐.
        // 0개인 카테고리는 렌더링하지 않는다(빈 섹션 헤더 방지, IA §7).
        const fixedOrder = type === 'agent' ? CATALOG_AGENT_CATEGORY_ORDER : CATALOG_SKILL_CATEGORY_ORDER
        orderedKeys = fixedOrder.filter((k) => groups[k] && groups[k].length)
      }
      return orderedKeys.map((key, idx) => ({
        key,
        label: key,
        items: groups[key],
        anchorId: `cat-section-${type}-${idx}`,
      }))
    },
  },
  watch: {
    // 탭 전환 시 섹션 DOM이 통째로 교체되므로 IntersectionObserver도 새 섹션 헤더 기준으로 재설치.
    activeType() {
      this.setupSectionObserver()
    },
  },
  async mounted() {
    await this.load()
    this.setupSectionObserver()
  },
  beforeUnmount() {
    if (this._sectionObserver) this._sectionObserver.disconnect()
  },
  methods: {
    async load() {
      this.loading = true
      this.error = false
      // type을 지정하지 않고 3종 전체를 한 번에 받아 탭은 클라이언트 필터로 처리한다(회사 카탈로그
      // 규모가 작아 요청 3번보다 1번이 낫고, 탭별 카운트 배지도 별도 호출 없이 바로 계산 가능).
      const { data, error } = await useApi('/api/catalog')
      this.loading = false
      if (error) {
        this.error = true
        this.errorMessage = error?.message || '카탈로그 목록을 불러오지 못했습니다.'
        return
      }
      this.items = data?.data || []
    },
    countByType(type) {
      return this.items.filter((it) => it.item_type === type).length
    },
    // 점프 칩 클릭 → 페이지 내 앵커로 스무스 스크롤(신규 네비게이션 아님, IA §6.3 CTA 명시).
    jumpTo(anchorId) {
      const el = document.getElementById(anchorId)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    },
    // 뷰포트 상단을 통과하는 첫 섹션 헤더를 기준으로 점프 칩 하이라이트(IA §6.2 — 주체: 사용자 스크롤,
    // 이벤트: 섹션 헤더가 뷰포트 상단 25% 지점을 통과). 탭 전환 때마다 섹션 DOM이 새로 그려지므로
    // 매번 재설치한다.
    setupSectionObserver() {
      if (this._sectionObserver) {
        this._sectionObserver.disconnect()
        this._sectionObserver = null
      }
      this.$nextTick(() => {
        const headers = this.$el.querySelectorAll('[data-section-anchor]')
        if (!headers.length) {
          this.activeSectionKey = null
          return
        }
        this.activeSectionKey = headers[0].dataset.sectionAnchor
        this._sectionObserver = new IntersectionObserver(
          (entries) => {
            const visible = entries.filter((e) => e.isIntersecting).map((e) => e.target.dataset.sectionAnchor)
            if (visible.length) this.activeSectionKey = visible[0]
          },
          { rootMargin: '0px 0px -75% 0px', threshold: 0 }
        )
        headers.forEach((h) => this._sectionObserver.observe(h))
      })
    },
    catalogItemTypeMeta,
    catalogPromotionStatusMeta,
    formatRelative,
  },
}
</script>

<style>
.cat-tabs-wrap { display: flex; align-items: flex-end; border-bottom: 1px solid var(--color-hairline); background-color: var(--color-surface); border-radius: var(--rounded-md) var(--rounded-md) 0 0; }
.cat-tabs { border-bottom: none; gap: 0.125rem; background-color: transparent; border-radius: 0; }
.cat-tabs .nav-link {
  position: relative; display: inline-flex; align-items: center; gap: 0.4rem;
  color: var(--color-ink-muted); font-size: 0.9375rem; font-weight: 500;
  border: none; background: none; border-radius: var(--rounded-sm) var(--rounded-sm) 0 0;
  padding: 0.625rem 0.875rem; margin-bottom: -1px;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.cat-tabs .nav-link::after {
  content: ""; position: absolute; left: 0.5rem; right: 0.5rem; bottom: -1px;
  height: 2px; border-radius: 2px 2px 0 0; background-color: var(--color-primary, var(--color-brand));
  transform: scaleX(0); transform-origin: center; transition: transform 0.2s ease;
}
.cat-tabs .nav-link:hover { color: var(--color-ink); background-color: var(--color-canvas-soft); }
.cat-tabs .nav-link.active { color: var(--color-brand); font-weight: 600; background: none; }
.cat-tabs .nav-link.active::after { transform: scaleX(1); background-color: var(--color-brand); }
.cat-tab-count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 1.25rem; height: 1.25rem; padding: 0 0.375rem; margin-left: 2px;
  font-size: 0.6875rem; font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--color-ink-muted); background-color: var(--color-canvas-soft);
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-full);
}
/* 카드 패딩: 대시보드 .project-card(base.css)와 동일한 16px — 이 화면도 같은 "클릭 가능한
   목록 카드" 패턴이라 Bootstrap 기본 p-4(24px, 정적 콘텐츠 카드용)를 쓰지 않고 통일한다. */
.cat-card { padding: 16px; transition: border-color var(--transition-fast), box-shadow var(--transition-fast); }
.cat-card:hover { border-color: var(--color-brand); box-shadow: var(--shadow-md); }
.cat-card-desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 2.6em; }

/* 카테고리 점프 칩(IA §6.2): 필터가 아니라 페이지 내 앵커 이동. 가로 스크롤(모바일 포함),
   현재 스크롤 위치의 섹션은 IntersectionObserver로 하이라이트(active). */
.cat-jump-chips {
  display: flex; gap: 0.5rem; overflow-x: auto; padding-bottom: 0.25rem;
  scrollbar-width: thin;
}
.cat-jump-chip {
  flex-shrink: 0; white-space: nowrap; cursor: pointer;
  font-size: 0.8125rem; font-weight: 500; font-variant-numeric: tabular-nums;
  color: var(--color-ink-muted); background-color: var(--color-canvas-soft);
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-full);
  padding: 0.375rem 0.75rem;
  transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
}
.cat-jump-chip:hover { color: var(--color-ink); border-color: var(--color-brand); }
.cat-jump-chip.active { color: var(--color-brand); background-color: var(--color-canvas); border-color: var(--color-brand); font-weight: 600; }

/* 점프 칩 클릭 시 scrollIntoView가 섹션 상단을 뷰포트 top(0)에 맞추는데, 앱 전역 sticky 헤더
   (.admin-header, base.css --header-h:52px)가 그 위를 덮어 섹션 헤더 글자가 가려지는 문제가 있어
   (실제 캡처로 재현 확인, 2026-08-06) scroll-margin-top으로 여유를 준다. */
.cat-section { scroll-margin-top: calc(var(--header-h, 52px) + 12px); }

/* 카테고리 섹션 헤더: "조직도" 그 자체 역할(IA §6.1) — 아이콘 대신 단순 dot으로 그룹 소속을 표시,
   카드 스타일(visual-designer 산출물)은 건드리지 않는다. */
.cat-section-header {
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 1.0625rem; font-weight: 700; color: var(--color-ink);
  margin-bottom: 0.875rem;
}
.cat-section-dot {
  width: 0.5rem; height: 0.5rem; border-radius: 50%;
  background-color: var(--color-brand); flex-shrink: 0;
}
.cat-section-count {
  font-size: 0.75rem; font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--color-ink-muted); background-color: var(--color-canvas-soft);
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-full);
  min-width: 1.375rem; height: 1.375rem; padding: 0 0.4rem;
  display: inline-flex; align-items: center; justify-content: center;
}
.cat-section-header-skeleton { width: 8rem; height: 1.0625rem; margin-bottom: 0.875rem; }
</style>
