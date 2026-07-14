---
name: verify
description: malgnai 웹앱 런타임 검증 레시피 (서버 이미 상시 기동 중)
---

# malgnai 검증 레시피

## 서버
- `pnpm start` 로 기동하지만 보통 이미 LaunchAgent(`com.malgnai.server`)가 :9000 상시 기동 중.
  `lsof -i :9000 -sTCP:LISTEN -t` 로 먼저 확인, 떠 있으면 재기동 불필요.

## 인증
- `.dev.vars`의 `ADMIN_PASSWORD`는 users 테이블이 **비어있을 때만** 쓰인 최초 시드 비번이라
  이미 운영 중인 실제 계정 비번과 다를 수 있음(로그인 실패 시 확인할 것).
- 실계정 자격증명을 흔들지 말고, **임시 테스트 유저**를 만들어 쓰고 끝나면 삭제:
  ```js
  // node --input-type=module -e '...'
  import { hashPassword } from './server/utils/password.js'
  import Database from 'better-sqlite3'
  const { hash, salt } = await hashPassword('아무비번')
  const db = new Database('data/malgnai.db')
  db.prepare("INSERT INTO users (id, username, password_hash, password_salt, role, created_at) VALUES (?,?,?,?,?,datetime('now'))")
    .run('verify-temp-<id>', 'verify-temp@malgnai.local', hash, salt, 'super_admin')
  ```
  role을 `super_admin`으로 주면 프로젝트 소유/협업자 관계 없이 `/api/projects`에서 전체 프로젝트가
  보여서(2026-07-14 사용자 필터 버그 수정 이후 super_admin bypass 확인됨) 콘솔 등 프로젝트 선택이 필요한
  화면 검증이 쉬워짐.
  로그인은 `POST /api/auth/login {username, password}` → `token` 획득.
  **role을 나중에 UPDATE 했다면 재로그인해서 새 JWT를 받아야 함** — JWT는 발급 시점의 role을
  클레임에 박아두므로 DB role 변경이 기존 토큰에 즉시 반영되지 않는다(실측 확인, 처음 로그인 토큰으로
  시도했다가 프로젝트 0개로 실패했었음).
  **테스트 끝나면 반드시 `DELETE FROM users WHERE id=...`로 정리** (운영 DB 재사용 원칙, 전역 피드백 참고).

## 프론트엔드 브라우저 구동
- Playwright는 별도 설치 없이 전역 `~/.claude/tools/node_modules/playwright` 공유 캐시를 재사용한다.
  본 프로젝트 안에는 playwright 의존성이 없으므로, 검증 스크립트는 `~/.claude/tools/`에 임시
  `.mjs` 파일로 써서 그 디렉터리에서 실행하면 node_modules 해석이 된다. **끝나면 스크립트 파일 삭제.**
- localStorage 인증: 먼저 origin(`http://localhost:9000/`)을 한 번 방문한 뒤
  `page.evaluate(() => localStorage.setItem('token', TOKEN))`으로 심고, 그 다음 실제 페이지로 이동.
  (`app/assets/js/utils.js`가 `localStorage.token`을 Authorization 헤더로 자동 첨부.)
- 실제 커맨드 실행(예: 콘솔 메시지 전송)이 진짜 워커를 돌리게 하고 싶지 않으면
  `page.route('**/api/console/**', ...)`로 해당 API만 가로채 `route.fulfill()`로 응답을 흉내내면
  됨 — 실제 commands 테이블에 데이터가 남지 않아 별도 정리가 필요 없다.

## IME(한글 조합) 관련 UI 검증
- Enter 키 전송 로직은 `e.isComposing`(Safari는 `e.keyCode===229`)을 반드시 체크해야 함.
- Playwright로 재현할 때는 실제 한글 타이핑 대신 합성 이벤트로 충분:
  ```js
  new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })
  ```
  `isComposing`은 KeyboardEventInit 표준 필드라 생성자에 바로 넣으면 됨(Object.defineProperty 불필요).
  `dispatchEvent()`의 반환값이 `false`면 그 이벤트에서 `preventDefault()`가 호출된 것.
