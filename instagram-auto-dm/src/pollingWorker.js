const config = require('./config');
const { fetchComments } = require('./instagramApi');
const { processComment } = require('./replyService');
const logger = require('./logger');

async function pollOnce(mediaId = config.defaultMediaId) {
  if (!mediaId) {
    return { mediaId: null, total: 0, processed: [], error: 'mediaId is required' };
  }

  const comments = await fetchComments(mediaId);
  const processed = [];

  for (const comment of comments) {
    const result = await processComment({
      mediaId,
      commentId: comment.id,
      username: comment.username || null,
      text: comment.text || null,
      rawPayload: comment
    });
    processed.push(result);
  }

  return { mediaId, total: comments.length, processed };
}

function startPollingWorker() {
  if (!config.pollingEnabled) return null;

  const intervalMs = Math.max(config.pollingIntervalSeconds, 5) * 1000;
  logger.info('Polling worker enabled', {
    intervalSeconds: intervalMs / 1000,
    defaultMediaIdConfigured: Boolean(config.defaultMediaId)
  });

  const run = async () => {
    try {
      const result = await pollOnce();
      logger.info('Polling run completed', {
        mediaId: result.mediaId,
        total: result.total,
        processed: result.processed.length
      });
    } catch (error) {
      logger.error('Polling run failed', { error: error.message });
    }
  };

  run();
  return setInterval(run, intervalMs);
}

module.exports = {
  pollOnce,
  startPollingWorker
};
