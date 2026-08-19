<template>
  <div>
    <div class="mb-3">
      <router-link to="/catalog" class="text-muted small">&larr; 카탈로그</router-link>
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
          <h1 class="mb-1 d-flex align-items-center gap-2">
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

      <div class="row g-3">
        <!-- 본문: 원본 MD 렌더링 -->
        <div class="col-12 col-lg-8">
          <div class="card p-4">
            <div v-if="item.content_md" class="markdown-body" v-html="renderMarkdown(item.content_md)"></div>
            <div v-else class="text-center py-5">
              <i class="bi bi-file-earmark-text d-block mb-3" style="font-size:2.5rem;color:var(--color-ink-faint)"></i>
              <div class="fw-medium mb-1 text-muted">동기화된 원문이 아직 없습니다</div>
              <div class="text-faint small">플러그인 동기화가 완료되면 원본 MD 전문이 여기에 표시됩니다.</div>
            </div>
          </div>
        </div>

        <!-- 사이드바: 평가 점수 + 승격 이력 -->
        <div class="col-12 col-lg-4">
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
        </div>
      </div>
    </template>
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
    }
  },
  computed: {
    // 목록 화면과 동일한 배지 표시 규칙: 가장 최근 승격 이력의 status(없으면 null → "평가 전").
    latestPromotionStatus() {
      return this.promotions.length ? this.promotions[0].status : null
    },
  },
  async mounted() {
    await this.loadItem()
  },
  methods: {
    async loadItem() {
      this.loading = true
      this.error = false
      const id = this.$route.params.id
      const { data, error } = await useApi(`/api/catalog/${id}`)
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
</style>
