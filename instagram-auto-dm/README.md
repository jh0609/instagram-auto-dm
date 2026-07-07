# instagram-auto-dm

Instagram 게시물 댓글에 특정 키워드가 달리면 Instagram Private Reply를 자동 발송하는 독립 Node.js 서버입니다. Webhook 수신과 polling을 모두 지원하며, 댓글 처리 로직은 `processComment()`로 공통화되어 있습니다.

## 설치

```bash
npm install
cp .env.example .env
npm run init-db
npm run dev
```

운영 실행:

```bash
npm start
```

## 환경변수

`.env.example`을 `.env`로 복사한 뒤 값을 입력합니다.

```env
PORT=3010
META_WEBHOOK_VERIFY_TOKEN=your-webhook-verify-token
FB_GRAPH_VERSION=v25.0
FB_PAGE_ID=your-facebook-page-id
FB_PAGE_ACCESS_TOKEN=your-page-access-token
IG_GRAPH_VERSION=v25.0
IG_BUSINESS_ID=your-instagram-business-id
IG_BUSINESS_ACCESS_TOKEN=your-instagram-business-access-token
DEFAULT_MEDIA_ID=instagram-media-id
DEFAULT_KEYWORD=keyword
DEFAULT_REPLY_TEXT=자동 답장 메시지
SQLITE_PATH=./data/instagram_auto_dm.sqlite
POLLING_ENABLED=false
POLLING_INTERVAL_SECONDS=60
```

토큰 용도:

- `FB_PAGE_ACCESS_TOKEN`: 댓글 조회, polling, fallback 조회에 사용합니다.
- `IG_BUSINESS_ACCESS_TOKEN`: Instagram Private Reply 발송에 사용합니다.

토큰 값은 로그에 출력하지 않습니다.

## npm scripts

```bash
npm run init-db
npm run dev
npm start
npm run poll-once -- <media_id>
```

`npm run poll-once`에서 `<media_id>`를 생략하면 `DEFAULT_MEDIA_ID`를 사용합니다.

## Endpoints

### GET /health

```bash
curl http://localhost:3010/health
```

응답:

```json
{ "ok": true }
```

### GET /webhooks/instagram

Meta Webhook 검증 요청을 처리합니다.

- `hub.mode=subscribe`
- `hub.verify_token` 값이 `META_WEBHOOK_VERIFY_TOKEN`과 같으면 `hub.challenge`를 반환합니다.
- 값이 다르면 `403`을 반환합니다.

### POST /webhooks/instagram

Meta timeout 방지를 위해 요청 수신 즉시 `200 OK`를 반환하고, 이후 payload를 비동기로 처리합니다.

처리 순서:

1. raw payload를 `webhook_events`에 저장합니다.
2. payload에서 `comment_id`, `media_id`, `text`, `username`을 최대한 추출합니다.
3. 추출에 성공하면 `processComment()`를 호출합니다.
4. 추출할 수 없으면 payload만 저장하고 로그를 남깁니다.

### POST /dev/poll-once

개발용 polling endpoint입니다.

```bash
curl -X POST http://localhost:3010/dev/poll-once \
  -H "Content-Type: application/json" \
  -d "{\"media_id\":\"YOUR_MEDIA_ID\"}"
```

`media_id`를 생략하면 `DEFAULT_MEDIA_ID`를 사용합니다.

## Webhook 등록

1. Meta App Dashboard에서 Webhooks 제품을 설정합니다.
2. Callback URL에 공개 URL의 `/webhooks/instagram` 경로를 입력합니다.
3. Verify Token에 `.env`의 `META_WEBHOOK_VERIFY_TOKEN` 값을 입력합니다.
4. Instagram comments 관련 이벤트를 구독합니다.
5. 로컬 개발 중이면 ngrok 같은 터널을 사용해 `http://localhost:3010`을 공개 URL로 연결합니다.

예:

```bash
ngrok http 3010
```

Callback URL:

```text
https://YOUR-NGROK-DOMAIN/webhooks/instagram
```

## Polling 테스트

CLI:

```bash
npm run poll-once -- YOUR_MEDIA_ID
```

서버 endpoint:

```bash
curl -X POST http://localhost:3010/dev/poll-once \
  -H "Content-Type: application/json" \
  -d "{\"media_id\":\"YOUR_MEDIA_ID\"}"
```

주기 polling을 켜려면:

```env
POLLING_ENABLED=true
POLLING_INTERVAL_SECONDS=60
```

## DB 초기화

```bash
npm run init-db
```

생성되는 테이블:

- `reply_rules`
- `reply_logs`
- `webhook_events`

`DEFAULT_KEYWORD`와 `DEFAULT_REPLY_TEXT`가 설정되어 있으면 `reply_rules`에 기본 룰을 1개 생성합니다. 동일한 keyword/reply_text 조합의 기본 룰이 이미 있으면 중복 생성하지 않습니다.

## 중복 발송 방지

`reply_logs.comment_id`는 `UNIQUE`입니다. 이미 처리한 `comment_id`는 `duplicate`로 스킵되어 같은 댓글에 Private Reply를 중복 발송하지 않습니다.
