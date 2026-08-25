<template>
  <div>
    <!-- 배경: 목록 화면과 완전히 동일한 컴포넌트 — 스크롤/탭 상태는 CatalogList 모듈 스코프의 state
         싱글턴을 통해 index.vue와 공유된다(패널을 닫으면 그대로 남아있음). 패널이 열려있는 동안은
         아래 딤 오버레이가 목록 클릭을 가로채므로(일반적인 슬라이드오버 관례), 다른 항목을 보려면
         먼저 패널을 닫아야 한다. -->
    <CatalogList :selected-id="id" @select="onSelect" />

    <Transition name="cat-panel-dim">
      <div v-if="panelVisible" class="cat-panel-backdrop" @click="close"></div>
    </Transition>

    <Transition name="cat-panel-slide" appear>
      <aside
        v-if="panelVisible"
        class="cat-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="item ? (item.display_name || item.slug) : '카탈로그 상세'"
      >
        <div class="cat-panel-inner">
          <div class="cat-panel-header d-flex align-items-center justify-content-between mb-3">
            <button type="button" class="btn btn-link p-0 text-muted small text-decoration-none d-inline-flex align-items-center gap-1" @click="close">
              <i class="bi bi-arrow-left"></i> 카탈로그
            </button>
            <button type="button" class="admin-icon-btn" @click="close" aria-label="닫기">
              <i class="bi bi-x-lg"></i>
            </button>
          </div>

          <!-- 로딩/에러 -->
          <div v-if="loading" class="card p-4 placeholder-glow">
            <span class="placeholder col-4 mb-2" style="height:1.5rem"></span>
            <span class="placeholder col-6"></span>
          </div>
          <div v-else-if="error" class="alert alert-warning d-flex justify-content-between align-items-center">
            <span><i class="bi bi-exclamation-triangle me-1"></i>{{ errorMessage }}</span>
            <button class="btn btn-sm btn-outline-secondary" @click="loadItem">다시 시도</button>
          </div>

          <template v-else-if="item">
            <!-- 헤더 -->
            <div class="d-flex justify-content-between align-items-start mb-3 flex-wrap gap-2">
              <div class="min-w-0">
                <h1 class="mb-1 d-flex align-items-center gap-2" style="font-size:1.375rem">
                  <i class="bi flex-shrink-0" :class="catalogItemTypeMeta(item.item_type).icon"></i>
                  <span class="text-truncate">{{ item.display_name || item.slug }}</span>
                </h1>
                <div class="text-muted small d-flex flex-wrap gap-3">
                  <span><i class="bi bi-hash me-1"></i>{{ item.slug }}</span>
                  <span v-if="item.source_path"><i class="bi bi-folder2-open me-1"></i>{{ item.source_path }}</span>
                  <span><i class="bi bi-arrow-repeat me-1"></i>{{ item.latest_synced_at ? formatDate(item.latest_synced_at) : '동기화 전' }}</span>
                </div>
              </div>
              <div class="d-flex align-items-center gap-2 flex-shrink-0">
                <span class="badge" :class="catalogItemTypeMeta(item.item_type).cls">{{ catalogItemTypeMeta(item.item_type).label }}</span>
                <span class="badge" :class="catalogPromotionStatusMeta(latestPromotionStatus).cls">{{ catalogPromotionStatusMeta(latestPromotionStatus).label }}</span>
              </div>
            </div>
            <p v-if="item.description" class="text-muted mb-4">{{ item.description }}</p>

            <!-- 본문: 원본 MD 렌더링. 패널이 좁아 기존 페이지의 col-lg-8/4 그리드(뷰포트 기준
                 브레이크포인트라 패널 폭과 무관하게 동작해 버림)를 쓰지 않고 항상 세로로 쌓는다. -->
            <div class="card p-4 mb-3">
              <div v-if="item.content_md" class="markdown-body" v-html="renderMarkdown(item.content_md)"></div>
              <div v-else class="text-center py-5">
                <i class="bi bi-file-earmark-text d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
                <div class="fw-medium mb-1 text-muted">동기화된 원문이 아직 없습니다</div>
                <div class="text-faint small">플러그인 동기화가 완료되면 원본 MD 전문이 여기에 표시됩니다.</div>
              </div>
            </div>

            <!-- 평가 점수: 공식점수(evaluator)와 개인집계(personal_aggregate)는 서로 다른 질문에
                 답하는 다른 숫자이므로 절대 섞지 않고 각각 별도 subsection으로 명확히 라벨링한다. -->
            <div class="card p-4 mb-3">
              <h2 class="h6 mb-3">평가 점수</h2>

              <div class="cat-score-block mb-3 pb-3 border-bottom border-hairline">
                <div class="d-flex justify-content-between align-items-center mb-1">
                  <span class="small fw-semibold">공식 평가 점수</span>
                  <span class="text-faint" style="font-size:11px" title="evaluator 채점 — 회사 공식 평가 기준">evaluator</span>
                </div>
                <template v-if="scores.evaluator.length">
                  <div class="cat-score-value">{{ scores.evaluator[0].overall_score }}<small v-if="scores.evaluator[0].verified" class="text-success ms-1"><i class="bi bi-patch-check-fill"></i></small></div>
                  <div class="text-faint" style="font-size:11px">{{ formatDate(scores.evaluator[0].created_at) }}</div>
                  <div v-if="scores.evaluator.length > 1" class="text-faint mt-1" style="font-size:11px">이전 {{ scores.evaluator.length - 1 }}건 이력 있음</div>
                </template>
                <div v-else class="text-faint small">아직 공식 평가가 없습니다</div>
              </div>

              <div class="cat-score-block" :class="{ 'mb-3 pb-3 border-bottom border-hairline': scores.self_service.length }">
                <div class="d-flex justify-content-between align-items-center mb-1">
                  <span class="small fw-semibold">개인 집계 점수</span>
                  <span class="text-faint" style="font-size:11px" title="personal_aggregate — 개인 경험 평균, 공식 평가와 다른 지표">personal_aggregate</span>
                </div>
                <template v-if="scores.personal_aggregate.length">
                  <div class="cat-score-value">{{ scores.personal_aggregate[0].overall_score }}</div>
                  <div class="text-faint" style="font-size:11px">{{ formatDate(scores.personal_aggregate[0].created_at) }}</div>
                  <div v-if="scores.personal_aggregate.length > 1" class="text-faint mt-1" style="font-size:11px">이전 {{ scores.personal_aggregate.length - 1 }}건 이력 있음</div>
                </template>
                <div v-else class="text-faint small">아직 개인 집계 점수가 없습니다</div>
              </div>

              <div class="cat-score-block" v-if="scores.self_service.length">
                <div class="d-flex justify-content-between align-items-center mb-1">
                  <span class="small fw-semibold">셀프서비스 채점</span>
                  <span class="text-faint" style="font-size:11px">self_service</span>
                </div>
                <div class="cat-score-value">{{ scores.self_service[0].overall_score }}</div>
                <div class="text-faint" style="font-size:11px">{{ formatDate(scores.self_service[0].created_at) }}</div>
              </div>
            </div>

            <!-- 승격 이력 -->
            <div class="card p-4">
              <h2 class="h6 mb-3">승격 이력</h2>
              <div v-if="promotions.length" class="pd-list">
                <div v-for="p in promotions" :key="p.id" class="pd-item pd-item--static">
                  <div class="pd-item-body">
                    <div class="d-flex align-items-center gap-2 mb-1">
                      <span class="badge" :class="catalogPromotionStatusMeta(p.status).cls">{{ catalogPromotionStatusMeta(p.status).label }}</span>
                      <span v-if="p.reviewer" class="pd-item-title" style="font-size:13px">{{ p.reviewer }}</span>
                    </div>
                    <div v-if="p.note" class="small text-muted">{{ p.note }}</div>
                  </div>
                  <div class="pd-item-right"><small class="text-faint text-nowrap">{{ formatDate(p.created_at) }}</small></div>
                </div>
              </div>
              <div v-else class="text-center py-4">
                <i class="bi bi-signpost-split d-block mb-2" style="font-size:1.75rem;color:var(--color-ink-faint)"></i>
                <div class="text-faint small">아직 승격 이력이 없습니다</div>
              </div>
            </div>
          </template>
        </div>
      </aside>
    </Transition>
  </div>
</template>

<script>
export default {
  title: '카탈로그 상세 · malgnai-hub',
  data() {
    return {
      loading: true,
      error: false,
      errorMessage: '',
      item: null,
      promotions: [],
      scores: { evaluator: [], personal_aggregate: [], self_service: [] },
      // 패널 열림/닫힘. 닫기 버튼/배경/Esc는 이 값을 false로 바꿔 슬라이드아웃 애니메이션(아래
      // <style>의 cat-panel-slide-leave)이 재생되게 한 뒤, 애니메이션 시간만큼 기다렸다가 실제
      // 라우트를 /catalog로 되돌린다(먼저 라우팅해버리면 [id].vue 자체가 언마운트되어 leave
      // 트랜지션이 재생될 기회 없이 즉시 사라진다 — Vue Transition은 부모가 통째로 destroy될 때는
      // leave 훅을 실행하지 않는다).
      panelVisible: true,
    }
  },
  computed: {
    // route.params.id를 그대로 재사용(서버 응답 DTO의 id 필드에 의존하지 않음).
    id() {
      return this.$route.params.id
    },
    // 목록 화면과 동일한 배지 표시 규칙: 가장 최근 승격 이력의 status(없으면 null → "평가 전").
    latestPromotionStatus() {
      return this.promotions.length ? this.promotions[0].status : null
    },
  },
  watch: {
    // /catalog/A → /catalog/B 처럼 이 페이지에 머무른 채로(같은 라우트 레코드라 컴포넌트가 재마운트
    // 되지 않음) id 파라미터만 바뀌는 경우를 여기서 감지해 상세 데이터를 다시 불러온다.
    // immediate:true라 최초 진입(직접 URL 접근 포함) 시에도 이 한 곳에서 로드된다.
    id: {
      immediate: true,
      handler() {
        this.loadItem()
      },
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onKeydown)
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.onKeydown)
  },
  methods: {
    onKeydown(e) {
      if (e.key === 'Escape') this.close()
    },
    // 배경 목록에서 다른 카드를 클릭했을 때 — 패널은 열어둔 채로 라우트만 교체(같은 [id].vue
    // 컴포넌트가 유지되며 id 변경 watch가 상세 데이터만 다시 불러온다).
    onSelect(id) {
      this.$router.push('/catalog/' + id)
    },
    close() {
      this.panelVisible = false
      // .cat-panel-slide-* 트랜지션 duration(220ms)과 맞춘다.
      setTimeout(() => {
        this.$router.push('/catalog')
      }, 220)
    },
    async loadItem() {
      this.loading = true
      this.error = false
      const { data, error } = await useApi(`/api/catalog/${this.id}`)
      this.loading = false
      if (error) {
        this.error = true
        this.errorMessage = error?.code === 'NOT_FOUND' ? '카탈로그 항목을 찾을 수 없습니다.' : (error?.message || '카탈로그 항목을 불러오지 못했습니다.')
        return
      }
      this.item = data
      this.promotions = data?.promotions || []
      this.scores = {
        evaluator: data?.scores?.evaluator || [],
        personal_aggregate: data?.scores?.personal_aggregate || [],
        self_service: data?.scores?.self_service || [],
      }
    },
    catalogItemTypeMeta,
    catalogPromotionStatusMeta,
    formatDate,
    renderMarkdown,
  },
}
</script>

<style>
.cat-score-value { font-size: 1.5rem; font-weight: 700; color: var(--color-ink); line-height: 1.3; }
/* .markdown-body(content_md 렌더링 공통 스타일)는 base.css로 이동했다(2026-08-18) — vue-zero는
   .vue 파일의 <style>을 페이지 스코프로 주입해 다른 페이지로 이동하면 disabled 처리되므로, 프로젝트
   상세 화면(상태텍스트 마크다운 렌더링)에서도 재사용하려면 진짜 전역 스타일시트에 있어야 한다. */

/* ── 슬라이드오버 패널(카탈로그 상세, 2026-08-19 리팩터, 2026-08-19 딤 오버레이 추가) ──────
   전역 커스텀 모달(base.css .modal-backdrop-custom, z-index:1050, rgba(0,0,0,0.45))과 같은 톤으로
   딤 처리하되, 헤더(z-index 90~95)/사이드바(100)보다 위, 전역 모달(1050)보다는 아래로 잡는다
   (카탈로그 패널 위에 진짜 모달이 뜰 일이 있으면 그게 항상 이겨야 하므로). 딤을 클릭하면 패널이
   닫힌다(close()) — 일반적인 슬라이드오버 관례. */
.cat-panel-backdrop {
  position: fixed; inset: 0; z-index: 1044;
  background: rgba(0, 0, 0, 0.45);
  cursor: pointer;
}
.cat-panel {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 1045;
  width: min(640px, 100vw);
  background-color: var(--color-canvas, #fff);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.16);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.cat-panel-inner { padding: 20px 20px 40px; }
@media (min-width: 576px) {
  .cat-panel-inner { padding: 28px 32px 48px; }
}

.cat-panel-slide-enter-active, .cat-panel-slide-leave-active { transition: transform 0.22s ease; }
.cat-panel-slide-enter-from, .cat-panel-slide-leave-to { transform: translateX(100%); }

.cat-panel-dim-enter-active, .cat-panel-dim-leave-active { transition: opacity 0.22s ease; }
.cat-panel-dim-enter-from, .cat-panel-dim-leave-to { opacity: 0; }
</style>
