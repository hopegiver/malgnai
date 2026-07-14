# Web Push Notification 구현 완료 (2026-07-12)

## 개요
malgnai에 Web Push Notification 기능이 구현되었습니다. 사용자의 브라우저가 푸시를 지원하면 승인함 변화 시 실시간 알림을 받을 수 있습니다.

## 구현 사항

### 1. VAPID 키 설정 (.dev.vars)
```
VAPID_PUBLIC_KEY=BGIl0oI0hwcEsUtG5QlNVAi8RU9KL901V2XJdUNJ7mt1PoLYSEoPjNvbICu6PkrQrx2n7gJhbuX8ZYWQw9M0D6c
VAPID_PRIVATE_KEY=1qv6y8KqBHGDiqyjZ77CQjfweSzWTeaRGF-x-GnlD6A
```

### 2. 데이터베이스
**테이블 추가: push_subscriptions**
```sql
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**마이그레이션**: `migrations/006-add-push-subscriptions.sql`

### 3. 백엔드 구현

#### DAO (server/dao/push-subscriptions.js)
- `upsertSubscription(userId, subscription)` - 구독 저장/업데이트
- `getSubscriptionsByUserId(userId)` - 사용자별 구독 조회
- `deleteSubscriptionByEndpoint(endpoint)` - 구독 제거
- `getSubscriptionsByUserIds(userIds)` - 특정 사용자들의 구독 조회

#### 푸시 발송 유틸 (server/lib/push-notifier.js)
- `sendPushNotification(userIds, options)` - 범용 푸시 발송
- `sendApprovalNotification(userId, command)` - 승인함 알림
- `sendProjectNotification(userId, options)` - 프로젝트 알림

**특징**:
- 비동기 처리 (Promise.all)
- 실패한 구독 자동 정리 (410/404 상태)
- VAPID 키 확인 후 발송

#### API 라우트 (server/api/push.js)
```
POST   /api/push/subscribe        - 구독 등록
DELETE /api/push/unsubscribe      - 구독 제거
GET    /api/push/subscriptions    - 사용자 구독 목록
POST   /api/push/test             - 테스트 알림 (관리자)
```

#### 승인함 연동 (server/api/commands.js)
1. **POST /api/commands** - 새 명령 생성 시
   - 프로젝트 소유자에게 푸시 발송
   
2. **PATCH /api/commands/:id/review** - 승인/반려 시
   - 프로젝트 소유자에게 승인 결과 푸시 발송

#### VAPID 공개 키 제공 (server/api/system.js)
```
GET /api/system/vapid-public-key - VAPID 공개 키 조회
```

### 4. 클라이언트 구현

#### Service Worker (app/assets/sw.js)
- Push 이벤트 수신 및 알림 표시
- 알림 클릭 시 해당 페이지로 이동
- 진동 반응 (navigator.vibrate)

#### Push 클라이언트 유틸 (app/assets/js/push-client.js)
**기본 메서드**:
- `isSupported()` - 브라우저 지원 확인
- `requestPermission()` - 알림 권한 요청
- `registerServiceWorker()` - Service Worker 등록
- `subscribe()` - 푸시 구독
- `unsubscribe()` - 구독 해제
- `getSubscription()` - 현재 구독 조회
- `sendTestNotification()` - 테스트 알림 (관리자)

**내부 메서드**:
- `getVapidPublicKey()` - VAPID 공개 키 조회
- `sendSubscriptionToServer(subscription)` - 서버에 구독 등록
- `removeSubscriptionFromServer(subscription)` - 서버에서 구독 제거
- `urlBase64ToUint8Array(base64String)` - base64 → Uint8Array 변환
- `getToken()` - JWT 토큰 조회

#### 레이아웃 통합 (app/layouts/default.vue)
**mounted()에서 자동 초기화**:
```javascript
async initializePushNotifications()
  - Service Worker 등록
  - 알림 권한 이미 있으면 자동 구독
  - VAPID 키 조회 및 구독
  - 서버에 구독 정보 전송
```

## 작동 흐름

### 1. 초기화 (사용자 첫 방문)
```
레이아웃 mounted()
  ↓
initializePushNotifications()
  ↓
Notification.permission 확인
  ↓
(granted) → Service Worker 등록 → VAPID 키 조회 → 구독 요청 → 서버 등록
(prompt) → 권한 요청 대기
(denied) → 스킵
```

### 2. 푸시 발송 (명령 생성/승인)
```
POST /api/commands 또는 PATCH /api/commands/:id/review
  ↓
sendApprovalNotification() 호출
  ↓
getSubscriptionsByUserIds() - 사용자 구독 조회
  ↓
webpush.sendNotification() × N (병렬)
  ↓
실패 시 구독 자동 정리 (410/404)
```

### 3. 푸시 수신 (클라이언트)
```
Service Worker: push 이벤트
  ↓
알림 표시 (title, body, icon, data)
  ↓
진동 반응 (navigator.vibrate([200, 100, 200]))
  ↓
사용자 클릭 → notificationclick 이벤트 → 페이지 이동
```

## npm 패키지
```json
{
  "dependencies": {
    "web-push": "^3.6.7"  // 새 추가
  }
}
```

## 설정 및 운영

### 환경변수 (.dev.vars)
```
VAPID_PUBLIC_KEY=...    # 클라이언트 구독용 (공개)
VAPID_PRIVATE_KEY=...   # 서버 발송용 (비공개)
```

### VAPID 키 생성 (로컬 한 번만)
```bash
npx web-push generate-vapid-keys
```

### 마이그레이션 적용
```bash
pnpm run db:migrate
```

### 테스트
**관리자 콘솔에서**:
```javascript
// 브라우저 콘솔
await fetch('/api/push/test', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
})
```

## 데이터베이스 쿼리 예제

```sql
-- 사용자 구독 조회
SELECT * FROM push_subscriptions WHERE user_id = 'user123';

-- 구독 삭제
DELETE FROM push_subscriptions WHERE endpoint = '...';

-- 모든 구독 조회
SELECT user_id, COUNT(*) as count FROM push_subscriptions GROUP BY user_id;
```

## 보안

1. **JWT 인증**: 모든 API는 JWT 토큰 검증
2. **VAPID**: 서버만 개인 키 보유 (환경변수)
3. **구독 격리**: 사용자별 구독 데이터 분리
4. **엔드포인트 유일성**: 같은 사용자가 같은 기기에서 재구독 시 자동 업데이트

## 브라우저 지원

| 브라우저 | 지원 |
|---------|------|
| Chrome | ✓ (50+) |
| Firefox | ✓ (48+) |
| Safari | ⚠ (16.1+ 부분) |
| Edge | ✓ (17+) |
| Opera | ✓ (37+) |

## 제한사항

1. **https 필수**: 로컬(localhost) 제외, 프로덕션은 https 필수
2. **Service Worker**: Origin당 1개만 등록 가능
3. **진동**: 일부 기기에서 지원 안 됨 (스마트폰 웹뷰 등)
4. **배경 동기화**: 푸시 수신 후 네트워크 요청 불가 (Service Worker 내)

## 향후 확장

1. **카테고리별 알림 설정**: 사용자가 알림 종류 선택
2. **알림 아이콘/배지**: 상황별 다양한 이미지
3. **액션 버튼**: 알림에서 직접 승인/반려
4. **배경 동기화**: 인터넷 복구 시 자동 동기화
5. **태그 기반 그룹**: 같은 명령의 중복 알림 방지

## 파일 목록

```
NEW:
├── migrations/006-add-push-subscriptions.sql    # 마이그레이션
├── server/dao/push-subscriptions.js             # DAO
├── server/lib/push-notifier.js                  # 푸시 발송 로직
├── server/api/push.js                           # API 라우트
├── app/assets/js/push-client.js                 # 클라이언트 유틸
├── app/assets/sw.js                             # Service Worker
└── .dev.vars                                    # 환경변수 (VAPID 키)

MODIFIED:
├── schema.sql                                   # push_subscriptions 테이블 추가
├── server/api/commands.js                       # 푸시 발송 코드 추가
├── server/api/system.js                         # VAPID 공개 키 엔드포인트
└── app/layouts/default.vue                      # 초기화 로직 추가
```

## 로그

구현 과정의 로그는 모두 표준 console으로 출력:
```
[Push] Service Worker registered
[Push] Successfully subscribed to push notifications
[Push] Subscribed to push notifications
[Push] Failed to send approval notification
```

## 문제 해결

**푸시가 오지 않음**:
1. Service Worker 등록 확인: DevTools → Application → Service Workers
2. 알림 권한 확인: DevTools → Application → Manifest → display
3. VAPID 키 설정 확인: .dev.vars 파일
4. 구독 상태 확인: DB `SELECT * FROM push_subscriptions WHERE user_id = ...`

**Service Worker 등록 실패**:
- https 필수 (localhost 제외)
- `/sw.js` 파일 정적 서빙 확인
- CORS 헤더 확인

**구독 저장 실패 (DB)**:
- JWT 토큰 유효성 확인
- 사용자 ID 확인
- 엔드포인트 유일성 확인
