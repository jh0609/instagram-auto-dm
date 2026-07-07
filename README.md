# instagram-auto-dm

Instagram 게시물 댓글에 특정 키워드가 달리면 Instagram Private Reply를 자동 발송하는 독립 Node.js 서버입니다. 운영 기본 흐름은 Webhook 수신이며, 댓글 처리 로직은 `processComment()`로 공통화되어 있습니다.

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
PUBLIC_COMMENT_REPLY_ENABLED=false
PUBLIC_COMMENT_REPLY_TEXT=DM으로 보내드렸어요!
ADMIN_TOKEN=change-this-admin-token
ALLOW_REPEAT_PER_USER_PER_MEDIA=false
ALLOW_REPEAT_PER_USER_PER_RULE=true
MEDIA_CACHE_TTL_SECONDS=300
```

토큰 용도:

- `FB_PAGE_ACCESS_TOKEN`: polling 방식의 댓글 조회가 필요할 때만 사용합니다. Webhook만 사용하면 비워둘 수 있습니다.
- `IG_BUSINESS_ACCESS_TOKEN`: Instagram Private Reply 발송과 공개 댓글 답글 작성에 사용합니다.

토큰 값은 로그에 출력하지 않습니다.
`ADMIN_TOKEN`은 `/admin`과 `/admin/api/*` 접근에 사용하는 간단한 관리용 토큰입니다.
`ALLOW_REPEAT_PER_USER_PER_MEDIA=false`이면 같은 Instagram 사용자가 같은 게시글에 여러 댓글을 달아도 DM은 한 번만 발송합니다. `ALLOW_REPEAT_PER_USER_PER_RULE=false`이면 같은 사용자가 같은 rule에 여러 번 매칭되어도 DM은 한 번만 발송합니다.
`MEDIA_CACHE_TTL_SECONDS`는 Admin 게시글 목록 조회 캐시 시간입니다. 기본값은 300초입니다.

## npm scripts

```bash
npm run init-db
npm run dev
npm start
npm run poll-once -- <media_id>
npm run verify
```

`npm run poll-once`에서 `<media_id>`를 생략하면 `DEFAULT_MEDIA_ID`를 사용합니다.
`npm run verify`는 임시 SQLite DB로 rule 마이그레이션, media별/fallback 매칭, 템플릿 치환을 확인합니다.

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

개발용 polling endpoint입니다. 현재 운영 기본값은 `POLLING_ENABLED=false`이며, Webhook만 사용할 경우 이 endpoint를 사용할 필요가 없습니다.

```bash
curl -X POST http://localhost:3010/dev/poll-once \
  -H "Content-Type: application/json" \
  -d "{\"media_id\":\"YOUR_MEDIA_ID\"}"
```

`media_id`를 생략하면 `DEFAULT_MEDIA_ID`를 사용합니다.

### POST /dev/retry-failed

`reply_logs`에서 `status='failed'`인 최근 로그를 다시 발송합니다. 기본 `limit`은 10입니다.

```bash
curl -X POST http://localhost:3010/dev/retry-failed \
  -H "Content-Type: application/json" \
  -d "{\"limit\":10}"
```

성공하면 기존 로그의 `status`, `recipient_id`, `message_id`, `replied_at`을 업데이트합니다. `PUBLIC_COMMENT_REPLY_ENABLED=true`이면 Private Reply 재발송 성공 후 공개 답글도 시도합니다. 실패하면 `error_message`를 최신 오류로 업데이트합니다.

## Admin UI

`ADMIN_TOKEN`을 설정하면 브라우저에서 rule과 최근 로그를 관리할 수 있습니다.

```text
https://YOUR-DOMAIN/admin?token=ADMIN_TOKEN
```

Admin UI 기능:

- `reply_rules` 조회
- rule 추가/수정
- rule 비활성화
- 최근 `reply_logs` 확인
- 실제 DM 발송 없이 rule matching과 템플릿 렌더링 테스트

Admin API 인증은 아래 두 방식을 모두 지원합니다.

```bash
curl http://localhost:3010/admin/api/rules?token=ADMIN_TOKEN
curl http://localhost:3010/admin/api/rules \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

Admin API:

- `GET /admin/api/rules`
- `POST /admin/api/rules`
- `PATCH /admin/api/rules/:id`
- `DELETE /admin/api/rules/:id`
- `GET /admin/api/logs?page=1&page_size=20`
- `GET /admin/api/media?limit=25`
- `GET /admin/api/media/resolve?permalink=...`
- `POST /admin/api/assets/upload`
- `POST /admin/api/test-match`

`DELETE /admin/api/rules/:id`는 실제 삭제하지 않고 `enabled_yn='N'`으로 비활성화합니다. Rule 생성/수정 시 `keyword`, `reply_text`는 필수이며, `media_id` 빈 문자열은 `NULL`로 저장됩니다. `priority` 기본값은 `100`이고 `enabled_yn`은 `Y` 또는 `N`만 허용합니다.

`POST /admin/api/test-match` 예시:

```bash
curl -X POST http://localhost:3010/admin/api/test-match \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"media_id\":\"17900000000000000\",
    \"comment_text\":\"가이드 보내주세요\",
    \"username\":\"tester\",
    \"comment_id\":\"comment-1\"
  }"
```

응답에는 `matched`, `rule_id`, `keyword`, 렌더링된 `reply_text`, 렌더링된 `public_reply_text`, `resource_url`이 포함됩니다.

게시글 ID 조회:

```bash
curl "http://localhost:3010/admin/api/media?limit=25" \
  -H "Authorization: Bearer ADMIN_TOKEN"

curl "http://localhost:3010/admin/api/media/resolve?permalink=https%3A%2F%2Fwww.instagram.com%2Fp%2FPOST_CODE%2F" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

`/admin/api/logs`는 `page`, `page_size`, `total`, `total_pages`를 함께 반환합니다. `page_size`는 최대 100입니다.

`/admin/api/media`는 `IG_BUSINESS_ID`와 `IG_BUSINESS_ACCESS_TOKEN`으로 `graph.instagram.com/{IG_GRAPH_VERSION}/{IG_BUSINESS_ID}/media`를 호출합니다. `limit`은 기본 25이며 최대 100입니다. media 목록은 rate limit 방지를 위해 기본 5분간 메모리에 캐시됩니다. 강제로 새로 조회하려면 `?force=true`를 붙입니다.

`/admin/api/media/resolve`는 캐시된 media 목록을 우선 사용하며, 입력한 Instagram permalink와 내 media 목록의 permalink를 비교해 `media_id`를 찾습니다. URL 끝의 slash 유무는 무시합니다. `/p/{shortcode}`, `/reel/{shortcode}`, `/tv/{shortcode}` 형식을 지원하고 query string/hash는 제거해 비교합니다. resolve도 `?force=true`를 붙이면 캐시를 무시하고 새로 조회합니다.

## 이미지 업로드

Admin UI의 `이미지 업로드` 섹션에서 이미지를 업로드하면 `public/assets/`에 저장되고 공개 URL을 반환합니다. 업로드 완료 후 `자료/링크 URL에 넣기` 버튼을 누르면 rule form의 `자료/링크 URL`에 자동 입력됩니다. 이 URL은 `reply_text`에서 `{{resource_url}}`로 사용할 수 있습니다.

업로드 API:

```bash
curl -X POST "http://localhost:3010/admin/api/assets/upload" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -F "image=@./example.png"
```

제한:

- field 이름: `image`
- 허용 MIME: `image/png`, `image/jpeg`, `image/webp`
- 허용 확장자: `.png`, `.jpg`, `.jpeg`, `.webp`
- 최대 파일 크기: 5MB
- 파일명은 서버에서 `aji-YYYYMMDD-HHMMSS-random.ext` 형식으로 재생성합니다.

Nginx에서 아래처럼 정적 서빙하도록 설정하면 업로드된 파일이 공개 URL로 접근됩니다.

```nginx
location /assets/ {
    alias /opt/instagram-auto-dm/public/assets/;
}
```

## Rate Limit 대응

모든 Graph API 응답에서 `x-app-usage`, `x-page-usage` 헤더가 있으면 서버 로그에 남깁니다. 로그에는 URL 전체를 남기지 않고 pathname만 기록하므로 `access_token` query 값이 노출되지 않습니다.

아래 응답은 rate limit 계열 오류로 분류합니다.

- HTTP `429`
- Graph API error code `4`, `17`, `32`, `613`

Rate limit 오류는 즉시 반복 재시도하지 않습니다. 운영 중 Admin의 게시글 목록 조회는 캐시를 사용하고, 불필요한 `force=true` 호출을 반복하지 않는 것을 권장합니다.

## 공개 댓글 답글

`PUBLIC_COMMENT_REPLY_ENABLED=true`로 설정하면 Private Reply 발송이 성공한 댓글에 공개 답글을 추가로 작성합니다. 기본 문구는 `PUBLIC_COMMENT_REPLY_TEXT`의 값이며 예시는 다음과 같습니다.

```env
PUBLIC_COMMENT_REPLY_ENABLED=true
PUBLIC_COMMENT_REPLY_TEXT=DM으로 보내드렸어요!
```

공개 답글은 Private Reply가 성공한 뒤에만 작성됩니다. 공개 답글 작성에 실패해도 DM 발송 성공은 유지되며, `reply_logs.status`는 `sent`로 남고 공개 답글 결과는 `public_reply_status`, `public_reply_error_message` 컬럼에 별도로 저장됩니다.

이미 `public_reply_status='sent'`인 댓글은 `/dev/retry-failed` 등에서 다시 처리되더라도 공개 답글을 중복 작성하지 않습니다.

## 게시글별 Reply Rule

`reply_rules.media_id`에 Instagram media id를 넣으면 해당 게시글 댓글에만 적용되는 rule이 됩니다. `media_id`가 `NULL`인 rule은 모든 게시글에 적용되는 fallback rule입니다.

매칭 우선순위:

1. `enabled_yn='Y'`
2. 댓글 내용에 `keyword` 포함
3. 현재 댓글의 `media_id`와 일치하는 rule 우선
4. `media_id IS NULL`인 공통 rule은 fallback
5. 같은 범위에서는 `priority ASC`, 그 다음 `id ASC`

예시:

```sql
INSERT INTO reply_rules (
  media_id, keyword, reply_text, public_reply_text, resource_url, priority, enabled_yn
) VALUES (
  '17900000000000000',
  '가이드',
  '{{username}}님, 요청하신 자료입니다: {{resource_url}}',
  'DM으로 {{keyword}} 자료를 보내드렸어요!',
  'https://example.com/guide-a',
  10,
  'Y'
);

INSERT INTO reply_rules (
  media_id, keyword, reply_text, public_reply_text, resource_url, priority, enabled_yn
) VALUES (
  NULL,
  '가이드',
  '요청하신 공통 자료입니다: {{resource_url}}',
  'DM으로 보내드렸어요!',
  'https://example.com/default-guide',
  100,
  'Y'
);
```

`reply_text`와 `public_reply_text`는 아래 템플릿 변수를 지원합니다.

- `{{username}}`
- `{{keyword}}`
- `{{comment_text}}`
- `{{media_id}}`
- `{{comment_id}}`
- `{{resource_url}}`

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

Polling은 기본 비활성화되어 있습니다. Webhook 대신 댓글 조회를 직접 테스트해야 할 때만 사용합니다.

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

## 일시 오류 재처리

Meta Graph API가 Private Reply 발송 중 HTTP 500 또는 `OAuthException code=1` 같은 `unknown error`를 반환하는 경우가 있습니다. 이는 Meta 측 일시 오류일 수 있으므로 서버는 Private Reply 발송 시 다음 오류를 최대 2회 자동 재시도합니다.

- HTTP 500 이상
- Graph API `error.code` 1 또는 2
- 네트워크 `ECONNRESET`, `ETIMEDOUT`, timeout 계열 오류

자동 재시도 후에도 실패한 로그는 `reply_logs.status='failed'`로 남습니다. 이후 아래 endpoint로 수동 재처리할 수 있습니다.

```bash
curl -X POST http://localhost:3010/dev/retry-failed \
  -H "Content-Type: application/json" \
  -d "{\"limit\":10}"
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

기존 DB에도 안전하게 동작하며, `reply_rules`에 아래 컬럼이 없으면 자동으로 추가합니다.

- `media_id`
- `priority`
- `enabled_yn`
- `public_reply_text`
- `resource_url`

## DB 백업

수동 백업:

```bash
chmod +x scripts/backup-db.sh
./scripts/backup-db.sh
```

기본 DB 경로는 `data/instagram_auto_dm.sqlite`입니다. `SQLITE_PATH`를 지정하면 해당 DB를 백업합니다.

```bash
SQLITE_PATH=/opt/instagram-auto-dm/data/instagram_auto_dm.sqlite ./scripts/backup-db.sh
```

백업 파일은 `backups/instagram_auto_dm.YYYYMMDD_HHMMSS.sqlite` 형식으로 생성됩니다. 스크립트는 `sqlite3 ".backup"` 명령을 사용하므로 실행 중인 SQLite DB도 안전하게 백업할 수 있습니다. 백업은 최신 14개만 유지하고 나머지는 삭제합니다.

systemd timer 예시:

```ini
# /etc/systemd/system/instagram-auto-dm-backup.service
[Unit]
Description=Backup instagram-auto-dm SQLite database

[Service]
Type=oneshot
WorkingDirectory=/opt/instagram-auto-dm
Environment=SQLITE_PATH=/opt/instagram-auto-dm/data/instagram_auto_dm.sqlite
ExecStart=/opt/instagram-auto-dm/scripts/backup-db.sh
```

```ini
# /etc/systemd/system/instagram-auto-dm-backup.timer
[Unit]
Description=Run instagram-auto-dm SQLite backup daily

[Timer]
OnCalendar=*-*-* 03:20:00
Persistent=true

[Install]
WantedBy=timers.target
```

등록:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now instagram-auto-dm-backup.timer
systemctl list-timers instagram-auto-dm-backup.timer
```

## 중복 발송 방지

`reply_logs.comment_id`는 `UNIQUE`입니다. 이미 처리한 `comment_id`는 `duplicate`로 스킵되어 같은 댓글에 Private Reply를 중복 발송하지 않습니다.

Webhook payload에 Instagram 사용자 ID가 포함된 경우에는 사용자 기준 중복 발송도 차단할 수 있습니다. 기본값은 같은 사용자와 같은 게시글 조합에 대해 이미 `status='sent'` 이력이 있으면 새 DM을 발송하지 않는 방식입니다.

중복 차단으로 발송하지 않은 댓글은 `reply_logs.status='skipped'`로 저장됩니다. `skipped`는 오류가 아니라 중복 발송 방지 정책에 따라 정상적으로 발송을 생략한 상태입니다. 중복 판단은 `status='sent'` 이력만 기준으로 하며, `failed`나 `skipped` 이력은 차단 기준에 포함하지 않습니다.
