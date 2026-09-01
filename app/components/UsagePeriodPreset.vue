<template>
  <div class="btn-group btn-group-sm usage-period-preset" role="group" aria-label="기간 프리셋">
    <button
      v-for="p in PRESETS"
      :key="p.key"
      type="button"
      class="btn"
      :class="modelValue === p.key ? 'btn-primary' : 'btn-outline-secondary'"
      :disabled="disabled"
      @click="select(p.key)"
    >{{ p.label }}</button>
  </div>
</template>

<script>
/**
 * UsagePeriodPreset — 사용량 화면 공통 기간 프리셋(오늘/최근7일/최근30일) 선택기.
 *
 * 목적: 전사 통합 대시보드(app/pages/admin/usage/index.vue)와 사용자별 드릴다운
 * (app/pages/admin/usage/[id].vue)이 "오늘"의 정의(UTC 기준, utils.js isoDaysAgo())를
 * 어긋나지 않게 같은 소스로 공유한다(docs/api.md §5.8.0). 기존 app/pages/usage.vue는
 * 프리셋 버튼이 아니라 직접 날짜 입력 UI라 이 컴포넌트를 쓰도록 바꾸지 않았다(동작 불변 원칙).
 *
 * v-model은 선택된 프리셋 key('today'/'7d'/'30d')만 들고 있고, 실제 from/to 계산은
 * utils.js usagePeriodRange()로 위임해 change 이벤트에 { from, to }를 함께 실어 보낸다 —
 * 부모가 계산식을 중복 구현하지 않게 하려는 의도.
 */
export default {
  name: 'UsagePeriodPreset',
  props: {
    modelValue: { type: String, default: '30d' },
    disabled: { type: Boolean, default: false },
  },
  emits: ['update:modelValue', 'change'],
  data() {
    return { PRESETS: USAGE_PERIOD_PRESETS }
  },
  methods: {
    select(key) {
      if (this.disabled || key === this.modelValue) return
      this.$emit('update:modelValue', key)
      this.$emit('change', usagePeriodRange(key))
    },
  },
}
</script>
