const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { db, initDatabase, insertDefaultRule } = require('./db');
const { extractComments } = require('./webhookParser');
const { processComment, retryFailedReplies } = require('./replyService');
const { pollOnce, startPollingWorker } = require('./pollingWorker');
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
