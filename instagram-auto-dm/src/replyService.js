const { db } = require('./db');
const { sendPrivateReply, formatApiError } = require('./instagramApi');
const logger = require('./logger');

function stringifyPayload(rawPayload) {
  if (rawPayload == null) return null;
  if (typeof rawPayload === 'string') return rawPayload;
  try {
    return JSON.stringify(rawPayload);
  } catch {
    return String(rawPayload);
  }
}

function findMatchingRule(mediaId, text) {
  const normalizedText = String(text || '').toLowerCase();
  const rules = db.prepare(`
    SELECT id, media_id, keyword, reply_text
    FROM reply_rules
    WHERE use_yn = 'Y'
      AND (media_id = ? OR media_id IS NULL)
    ORDER BY CASE WHEN media_id = ? THEN 0 ELSE 1 END, id ASC
  `).all(mediaId, mediaId);

  return rules.find((rule) => normalizedText.includes(String(rule.keyword).toLowerCase())) || null;
}

function insertLog(input) {
  db.prepare(`
    INSERT INTO reply_logs (
      media_id, comment_id, username, comment_text, matched_rule_id,
      reply_text, recipient_id, message_id, status, error_message,
      raw_payload, replied_at
    )
    VALUES (
      @mediaId, @commentId, @username, @commentText, @matchedRuleId,
      @replyText, @recipientId, @messageId, @status, @errorMessage,
      @rawPayload, @repliedAt
    )
  `).run(input);
}

async function processComment({ mediaId, commentId, username = null, text = null, rawPayload = null }) {
  const payloadText = stringifyPayload(rawPayload);

  try {
    if (!mediaId || !commentId) {
      logger.warn('Comment skipped because mediaId or commentId is missing', { mediaId, commentId });
      return { status: 'invalid', commentId };
    }

    const existing = db.prepare('SELECT id, status FROM reply_logs WHERE comment_id = ?').get(commentId);
    if (existing) {
      logger.info('Duplicate comment skipped', { commentId, existingLogId: existing.id });
      return { status: 'duplicate', commentId, existingStatus: existing.status };
    }

    const matchedRule = findMatchingRule(mediaId, text);
    if (!matchedRule) {
      insertLog({
        mediaId,
        commentId,
        username,
        commentText: text,
        matchedRuleId: null,
        replyText: null,
        recipientId: null,
        messageId: null,
        status: 'ignored',
        errorMessage: null,
        rawPayload: payloadText,
        repliedAt: null
      });
      return { status: 'ignored', commentId };
    }

    try {
      const result = await sendPrivateReply(commentId, matchedRule.reply_text);
      insertLog({
        mediaId,
        commentId,
        username,
        commentText: text,
        matchedRuleId: matchedRule.id,
        replyText: matchedRule.reply_text,
        recipientId: result.recipient_id,
        messageId: result.message_id,
        status: 'sent',
        errorMessage: null,
        rawPayload: payloadText,
        repliedAt: new Date().toISOString()
      });
      logger.info('Private reply sent', { mediaId, commentId, ruleId: matchedRule.id });
      return { status: 'sent', commentId, ruleId: matchedRule.id };
    } catch (error) {
      const errorMessage = formatApiError(error);
      insertLog({
        mediaId,
        commentId,
        username,
        commentText: text,
        matchedRuleId: matchedRule.id,
        replyText: matchedRule.reply_text,
        recipientId: null,
        messageId: null,
        status: 'failed',
        errorMessage,
        rawPayload: payloadText,
        repliedAt: null
      });
      logger.error('Private reply failed', { mediaId, commentId, ruleId: matchedRule.id, error: errorMessage });
      return { status: 'failed', commentId, ruleId: matchedRule.id, errorMessage };
    }
  } catch (error) {
    const errorMessage = formatApiError(error);
    logger.error('Comment processing failed', { mediaId, commentId, error: errorMessage });

    if (mediaId && commentId) {
      try {
        insertLog({
          mediaId,
          commentId,
          username,
          commentText: text,
          matchedRuleId: null,
          replyText: null,
          recipientId: null,
          messageId: null,
          status: 'failed',
          errorMessage,
          rawPayload: payloadText,
          repliedAt: null
        });
      } catch (insertError) {
        logger.error('Failed to write processing error log', { error: formatApiError(insertError) });
      }
    }

    return { status: 'failed', commentId, errorMessage };
  }
}

module.exports = {
  processComment
};
