// ULID 생성 — 하우스 스타일: 26자, 시간정렬 가능, 소문자로 통일(architecture.md 문서 상단 "하우스 스타일").
// `ulid` 패키지는 대문자(Crockford base32)로 생성하므로 일괄 소문자 변환한다 — 같은 변환을
// 모든 값에 동일하게 적용하므로 사전식 정렬 순서(시간정렬)는 그대로 보존된다.
import { ulid as ulidRaw } from 'ulid'

export function newId() {
  return ulidRaw().toLowerCase()
}
