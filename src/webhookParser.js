function extractComments(payload) {
  const comments = [];

  for (const entry of asArray(payload && payload.entry)) {
    for (const change of asArray(entry && entry.changes)) {
      const value = change && change.value ? change.value : {};
      const comment = normalizeComment(value, entry, change);
      if (comment.commentId || comment.mediaId || comment.text) comments.push(comment);
    }

    for (const messaging of asArray(entry && entry.messaging)) {
      const comment = normalizeComment(messaging, entry, {});
      if (comment.commentId || comment.mediaId || comment.text) comments.push(comment);
    }
  }

  if (comments.length === 0 && payload && typeof payload === 'object') {
    const comment = normalizeComment(payload, {}, {});
    if (comment.commentId || comment.mediaId || comment.text) comments.push(comment);
  }

  return comments;
}

function normalizeComment(value, entry, change) {
  const media = value.media || value.media_id || value.post || {};
  const from = value.from || value.user || {};
  const commentId = value.comment_id || value.commentId || value.id || value.comment && value.comment.id || null;

  return {
    mediaId: pickString(
      value.media_id,
      value.mediaId,
      media.id,
      value.post_id,
      entry.id
    ),
    commentId: pickString(commentId),
    username: pickString(
      value.username,
      value.user_name,
      from.username,
      from.name,
      value.comment && value.comment.username
    ),
    text: pickString(
      value.text,
      value.message,
      value.comment && value.comment.text,
      value.comment && value.comment.message
    ),
    rawPayload: { entry, change, value }
  };
}

function pickString(...values) {
  const value = values.find((item) => item !== undefined && item !== null && String(item) !== '');
  return value === undefined ? null : String(value);
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

module.exports = {
  extractComments
};
