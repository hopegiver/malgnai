<template>
  <CatalogList @select="onSelect" />
</template>

<script>
// 목록 UI(타입탭+점프칩+섹션+카드그리드+로딩/에러/빈상태)는 전부 컴포넌트로 옮겨졌다
// (app/components/CatalogList.vue) — index.vue와 catalog/[id].vue가 같은 컴포넌트 인스턴스를
// 재사용하지는 않지만(진짜 페이지 이동이라 매번 재마운트됨), 컴포넌트 <script> 모듈 스코프의
// state 싱글턴을 공유해 스크롤/탭 상태가 유지된다. 자세한 설계 이유는 CatalogList.vue 상단 주석 참고.
export default {
  title: '카탈로그 · malgnai-hub',
  methods: {
    // 카드를 선택하면 상세 패널 라우트로 이동한다(catalog/[id].vue가 같은 CatalogList를 배경으로
    // 렌더하면서 오른쪽에 슬라이드오버 패널을 띄운다).
    onSelect(id) {
      this.$router.push('/catalog/' + id)
    },
  },
}
</script>
