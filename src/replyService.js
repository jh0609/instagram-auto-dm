const { db } = require('./db');
const config = require('./config');
const { sendPrivateReply, replyToComment, formatApiError } = require('./instagramApi');
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
    SELECT id, media_id, keyword, reply_text, public_reply_text, resource_url, priority
    FROM reply_rules
    WHERE enabled_yn = 'Y'
      AND (media_id = ? OR media_id IS NULL)
    ORDER BY
      CASE WHEN media_id = ? THEN 0 ELSE 1 END,
      priority ASC,
      id ASC
  `).all(mediaId, mediaId);

  return rules.find((rule) => normalizedText.includes(String(rule.keyword).toLowerCase())) || null;
}

function renderTemplate(template, context) {
  if (template == null) return null;
  return String(template).replace(/\{\{\s*(username|keyword|comment_text|media_id|comment_id|resource_url)\s*\}\}/g, (_match, key) => {
    const value = context[key];
    return value == null ? '' : String(value);
  });
}

function insertLog(input) {
  const row = {
    publicReplyText: null,
    publicReplyCommentId: null,
    publicReplyStatus: null,
    publicReplyErrorMessage: null,
    publicRepliedAt: null,
    ...input
  };

  db.prepare(`
    INSERT INTO reply_logs (
      media_id, comment_id, username, comment_text, matched_rule_id,
      reply_text, recipient_id, message_id, status, error_message,
      raw_payload, replied_at, public_reply_text, public_reply_comment_id,
      public_reply_status, public_reply_error_message, public_replied_at
    )
    VALUES (
      @mediaId, @commentId, @username, @commentText, @matchedRuleId,
      @replyText, @recipientId, @messageId, @status, @errorMessage,
      @rawPayload, @repliedAt, @publicReplyText, @publicReplyCommentId,
      @publicReplyStatus, @publicReplyErrorMessage, @publicRepliedAt
    )
  `).run(row);
}

async function createPublicCommentReply({
  logId = null,
  mediaId = null,
  commentId,
  message,
  existingPublicReplyStatus = null
}) {
  if (!config.publicCommentReplyEnabled) {
    return {
      publicReplyText: null,
      publicReplyCommentId: null,
      publicReplyStatus: null,
      publicReplyErrorMessage: null,
      publicRepliedAt: null
    };
  }

  if (existingPublicReplyStatus === 'sent') {
    return {
      publicReplyText: message,
      publicReplyCommentId: null,
      publicReplyStatus: 'sent',
      publicReplyErrorMessage: null,
      publicRepliedAt: null
    };
  }

  try {
    const result = await replyToComment(commentId, message);
    const publicRepliedAt = new Date().toISOString();
    logger.info('Public comment reply sent', {
      logId,
      mediaId,
      commentId,
      publicReplyCommentId: result.comment_id
    });
    return {
      publicReplyText: message,
      publicReplyCommentId: result.comment_id,
      publicReplyStatus: 'sent',
      publicReplyErrorMessage: null,
      publicRepliedAt
    };
  } catch (error) {
    const errorMessage = formatApiError(error);
    logger.error('Public comment reply failed', {
      logId,
      mediaId,
      commentId,
      error: errorMessage
    });
    return {
      publicReplyText: message,
      publicReplyCommentId: null,
      publicReplyStatus: 'failed',
      publicReplyErrorMessage: errorMessage,
      publicRepliedAt: null
    };
  }
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

    const templateContext = {
      username,
      keyword: matchedRule.keyword,
      comment_text: text,
      media_id: mediaId,
      comment_id: commentId,
      resource_url: matchedRule.resource_url
    };
    const replyText = renderTemplate(matchedRule.reply_text, templateContext);
    const publicReplyText = renderTemplate(
      matchedRule.public_reply_text || config.publicCommentReplyText,
      templateContext
    );

    try {
      const result = await sendPrivateReply(commentId, replyText);
      const publicReply = await createPublicCommentReply({
        mediaId,
        commentId,
        message: publicReplyText
      });
      insertLog({
        mediaId,
        commentId,
        username,
        commentText: text,
        matchedRuleId: matchedRule.id,
        replyText,
        recipientId: result.recipient_id,
        messageId: result.message_id,
        status: 'sent',
        errorMessage: null,
        rawPayload: payloadText,
        repliedAt: new Date().toISOString(),
        ...publicReply
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
        replyText,
        recipientId: null,
        messageId: null,
        status: 'failed',
        errorMessage,
        rawPayload: payloadText,
        repliedAt: null,
        publicReplyText
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

async function retryFailedReplies(limit = 10) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);
  const rows = db.prepare(`
    SELECT id, media_id, comment_id, reply_text, error_message, created_at, public_reply_text, public_reply_status
    FROM reply_logs
    WHERE status = 'failed'
      AND comment_id IS NOT NULL
      AND reply_text IS NOT NULL
    ORDER BY id DESC
    LIMIT ?
  `).all(safeLimit);

  const results = [];

  for (const row of rows) {
    try {
      const result = await sendPrivateReply(row.comment_id, row.reply_text);
      const repliedAt = new Date().toISOString();
      const publicReply = await createPublicCommentReply({
        logId: row.id,
        mediaId: row.media_id,
        commentId: row.comment_id,
        existingPublicReplyStatus: row.public_reply_status,
        message: row.public_reply_text || config.publicCommentReplyText
      });
      db.prepare(`
        UPDATE reply_logs
        SET status = 'sent',
            recipient_id = ?,
            message_id = ?,
            error_message = NULL,
            replied_at = ?,
            public_reply_text = COALESCE(?, public_reply_text),
            public_reply_comment_id = COALESCE(?, public_reply_comment_id),
            public_reply_status = COALESCE(?, public_reply_status),
            public_reply_error_message = ?,
            public_replied_at = COALESCE(?, public_replied_at)
        WHERE id = ?
      `).run(
        result.recipient_id,
        result.message_id,
        repliedAt,
        publicReply.publicReplyText,
        publicReply.publicReplyCommentId,
        publicReply.publicReplyStatus,
        publicReply.publicReplyErrorMessage,
        publicReply.publicRepliedAt,
        row.id
      );

      logger.info('Failed private reply retry succeeded', {
        logId: row.id,
        mediaId: row.media_id,
        commentId: row.comment_id
      });
      results.push({
        logId: row.id,
        commentId: row.comment_id,
        status: 'sent',
        recipientId: result.recipient_id,
        messageId: result.message_id,
        publicReplyStatus: publicReply.publicReplyStatus,
        publicReplyCommentId: publicReply.publicReplyCommentId,
        publicReplyErrorMessage: publicReply.publicReplyErrorMessage
      });
    } catch (error) {
      const errorMessage = formatApiError(error);
      db.prepare(`
        UPDATE reply_logs
        SET error_message = ?
        WHERE id = ?
      `).run(errorMessage, row.id);

      logger.error('Failed private reply retry failed', {
        logId: row.id,
        mediaId: row.media_id,
        commentId: row.comment_id,
        error: errorMessage
      });
      results.push({
        logId: row.id,
        commentId: row.comment_id,
        status: 'failed',
        errorMessage
      });
    }
  }

  return {
    requestedLimit: safeLimit,
    total: rows.length,
    sent: results.filter((result) => result.status === 'sent').length,
    failed: results.filter((result) => result.status === 'failed').length,
    results
  };
}

module.exports = {
  processComment,
  retryFailedReplies,
  findMatchingRule,
  renderTemplate
};
