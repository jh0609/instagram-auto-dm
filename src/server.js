const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { db, initDatabase, insertDefaultRule } = require('./db');
const { extractComments } = require('./webhookParser');
const { processComment, retryFailedReplies } = require('./replyService');
const { pollOnce, startPollingWorker } = require('./pollingWorker');
const { createAdminRouter } = require('./admin');
const logger = require('./logger');

initDatabase();
insertDefaultRule();

const app = express();

app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buffer) => {
    req.rawBody = buffer.toString('utf8');
  }
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/admin', createAdminRouter());

app.get('/privacy', (_req, res) => {
  res.type('html').send(`
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>개인정보처리방침</title>
</head>
<body>
  <h1>개인정보처리방침</h1>
  <p>autoDM은 Instagram 댓글 키워드에 따른 자동 응답 DM 발송을 위해 필요한 최소한의 정보를 처리합니다.</p>

  <h2>수집하는 정보</h2>
  <ul>
    <li>Instagram 댓글 ID</li>
    <li>댓글 내용</li>
    <li>댓글 작성자 username</li>
    <li>DM 발송 성공/실패 기록</li>
    <li>Instagram Webhook 이벤트 데이터</li>
  </ul>

  <h2>이용 목적</h2>
  <p>특정 키워드가 포함된 댓글에 대해 요청한 자료 또는 안내 메시지를 자동으로 발송하기 위해 사용합니다.</p>

  <h2>보관 기간</h2>
  <p>중복 발송 방지, 장애 재처리, 서비스 운영 기록 확인을 위해 필요한 기간 동안 보관합니다.</p>

  <h2>제3자 제공</h2>
  <p>수집된 정보는 Meta/Instagram API 연동 및 서비스 운영 목적 외 제3자에게 판매하거나 제공하지 않습니다.</p>

  <h2>삭제 요청</h2>
  <p>개인정보 삭제를 원하시면 아래 이메일로 요청해 주세요.</p>
  <p>연락처: syncbak123@naver.com</p>

  <h2>시행일</h2>
  <p>2026-07-07</p>
</body>
</html>
  `);
});

app.get('/data-deletion', (_req, res) => {
  res.type('html').send(`
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>사용자 데이터 삭제 안내</title>
</head>
<body>
  <h1>사용자 데이터 삭제 안내</h1>
  <p>autoDM에서 처리한 Instagram 댓글 및 메시지 관련 데이터 삭제를 원하시면 아래 이메일로 요청해 주세요.</p>

  <h2>삭제 요청 방법</h2>
  <p>이메일 제목에 "autoDM 데이터 삭제 요청"을 포함하고, 삭제를 원하는 Instagram username 또는 관련 댓글 정보를 함께 보내 주세요.</p>

  <h2>연락처</h2>
  <p>syncbak123@naver.com</p>

  <h2>처리 안내</h2>
  <p>요청 확인 후 서비스 운영상 필요한 절차에 따라 관련 데이터를 삭제합니다.</p>
</body>
</html>
  `);
});

app.get('/terms', (_req, res) => {
  res.type('html').send(`
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>서비스 약관</title>
</head>
<body>
  <h1>서비스 약관</h1>
  <p>autoDM은 Instagram 댓글 키워드에 따라 자동으로 안내 DM을 발송하는 서비스입니다.</p>

  <h2>서비스 내용</h2>
  <p>사용자가 특정 키워드 댓글을 남기면, 사전에 설정된 메시지를 Instagram API를 통해 발송합니다.</p>

  <h2>제한 사항</h2>
  <p>본 서비스는 스팸, 무단 광고, 부정 사용을 목적으로 사용하지 않습니다.</p>

  <h2>문의</h2>
  <p>syncbak123@naver.com</p>
</body>
</html>
  `);
});

app.get('/webhooks/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.metaWebhookVerifyToken) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post('/webhooks/instagram', (req, res) => {
  res.sendStatus(200);
  setImmediate(() => handleWebhookPayload(req.body, req.rawBody));
});

app.post('/dev/poll-once', async (req, res) => {
  const mediaId = (req.body && req.body.media_id) || config.defaultMediaId;
  try {
    const result = await pollOnce(mediaId);
    res.json(result);
  } catch (error) {
    logger.error('Manual polling failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.post('/dev/retry-failed', async (req, res) => {
  const limit = req.body && req.body.limit;
  try {
    const result = await retryFailedReplies(limit);
    res.json(result);
  } catch (error) {
    logger.error('Failed reply retry endpoint failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

async function handleWebhookPayload(payload, rawBody) {
  const payloadText = rawBody || JSON.stringify(payload || {});
  const eventKey = crypto.createHash('sha256').update(payloadText).digest('hex');
  const event = saveWebhookEvent(eventKey, payloadText);

  try {
    const comments = extractComments(payload);
    if (comments.length === 0) {
      logger.warn('Webhook payload saved but no comment fields were extracted', { eventKey });
      markWebhookEventProcessed(eventKey, 'No comment fields extracted');
      return;
    }

    for (const comment of comments) {
      if (comment.mediaId && comment.commentId) {
        await processComment({
          mediaId: comment.mediaId,
          commentId: comment.commentId,
          igUserId: comment.igUserId,
          username: comment.username,
          text: comment.text,
          rawPayload: comment.rawPayload
        });
      } else {
        logger.warn('Webhook comment skipped because required fields are missing', {
          eventKey,
          mediaId: comment.mediaId,
          commentId: comment.commentId
        });
      }
    }

    markWebhookEventProcessed(eventKey, null);
  } catch (error) {
    const errorMessage = error.message || 'Unknown webhook processing error';
    logger.error('Webhook processing failed', { eventKey, error: errorMessage });
    markWebhookEventProcessed(eventKey, errorMessage);
  }

  return event;
}

function saveWebhookEvent(eventKey, payloadText) {
  try {
    db.prepare(`
      INSERT INTO webhook_events (event_key, payload)
      VALUES (?, ?)
    `).run(eventKey, payloadText);
    return { eventKey, duplicate: false };
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      logger.info('Duplicate webhook event skipped', { eventKey });
      return { eventKey, duplicate: true };
    }
    throw error;
  }
}

function markWebhookEventProcessed(eventKey, errorMessage) {
  db.prepare(`
    UPDATE webhook_events
    SET processed_yn = 'Y',
        error_message = ?,
        processed_at = CURRENT_TIMESTAMP
    WHERE event_key = ?
  `).run(errorMessage, eventKey);
}

const server = app.listen(config.port, () => {
  logger.info(`instagram-auto-dm listening on port ${config.port}`);
});

startPollingWorker();

module.exports = {
  app,
  server,
  handleWebhookPayload
};
