const config = require('./config');
const logger = require('./logger');

const PRIVATE_REPLY_RETRY_DELAYS_MS = [2000, 5000];

function requireValue(value, name) {
  if (!value) throw new Error(`${name} is required`);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  logGraphUsageHeaders(url, response);

  if (!response.ok) {
    const error = new Error(`Graph API request failed with ${response.status}`);
    error.status = response.status;
    error.data = data;
    error.isRateLimit = isRateLimitError(error);
    throw error;
  }

  return data;
}

function logGraphUsageHeaders(url, response) {
  const appUsage = response.headers.get('x-app-usage');
  const pageUsage = response.headers.get('x-page-usage');
  if (!appUsage && !pageUsage) return;

  logger.info('Graph API usage headers', {
    pathname: url && url.pathname ? url.pathname : String(url),
    xAppUsage: parseUsageHeader(appUsage),
    xPageUsage: parseUsageHeader(pageUsage)
  });
}

function parseUsageHeader(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchComments(mediaId) {
  requireValue(mediaId, 'mediaId');
  requireValue(config.fbPageAccessToken, 'FB_PAGE_ACCESS_TOKEN');

  const url = new URL(`https://graph.facebook.com/${config.fbGraphVersion}/${mediaId}/comments`);
  url.searchParams.set('fields', 'id,text,username,timestamp');
  url.searchParams.set('access_token', config.fbPageAccessToken);

  const data = await fetchJson(url);
  return Array.isArray(data && data.data) ? data.data : [];
}

async function fetchMedia(limit = 25) {
  requireValue(config.igBusinessId, 'IG_BUSINESS_ID');
  requireValue(config.igBusinessAccessToken, 'IG_BUSINESS_ACCESS_TOKEN');

  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const url = new URL(`https://graph.instagram.com/${config.igGraphVersion}/${config.igBusinessId}/media`);
  url.searchParams.set('fields', 'id,caption,media_type,media_product_type,permalink,timestamp');
  url.searchParams.set('limit', String(safeLimit));

  const data = await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${config.igBusinessAccessToken}`
    }
  });

  return Array.isArray(data && data.data) ? data.data : [];
}

async function replyToComment(commentId, message) {
  requireValue(commentId, 'commentId');
  requireValue(message, 'message');
  requireValue(config.igBusinessAccessToken, 'IG_BUSINESS_ACCESS_TOKEN');

  const url = new URL(`https://graph.instagram.com/${config.igGraphVersion}/${commentId}/replies`);

  const data = await fetchJson(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.igBusinessAccessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message })
  });

  return {
    comment_id: data && data.id ? data.id : null,
    raw: data
  };
}

async function sendPrivateReply(commentId, replyText) {
  requireValue(commentId, 'commentId');
  requireValue(replyText, 'replyText');
  requireValue(config.igBusinessId, 'IG_BUSINESS_ID');
  requireValue(config.igBusinessAccessToken, 'IG_BUSINESS_ACCESS_TOKEN');

  const url = new URL(`https://graph.instagram.com/${config.igGraphVersion}/${config.igBusinessId}/messages`);
  url.searchParams.set('access_token', config.igBusinessAccessToken);

  const requestOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: { text: replyText }
    })
  };

  let lastError = null;
  for (let attempt = 0; attempt <= PRIVATE_REPLY_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const data = await fetchJson(url, requestOptions);

      return {
        recipient_id: data && data.recipient_id ? data.recipient_id : null,
        message_id: data && data.message_id ? data.message_id : null,
        raw: data
      };
    } catch (error) {
      lastError = error;
      const delayMs = PRIVATE_REPLY_RETRY_DELAYS_MS[attempt];
      if (!delayMs || !isRetryablePrivateReplyError(error)) break;

      logger.warn('Private reply API failed, retrying', {
        commentId,
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        delayMs,
        error: formatApiError(error)
      });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function isRetryablePrivateReplyError(error) {
  if (isRateLimitError(error)) return false;

  const graphCode = getGraphErrorCode(error);
  const networkCode = error && (error.code || error.cause && error.cause.code);
  const networkMessage = error && error.message ? error.message : '';

  return Boolean(
    error && error.status >= 500 ||
    graphCode === 1 ||
    graphCode === 2 ||
    networkCode === 'ECONNRESET' ||
    networkCode === 'ETIMEDOUT' ||
    networkCode === 'UND_ERR_CONNECT_TIMEOUT' ||
    networkCode === 'UND_ERR_HEADERS_TIMEOUT' ||
    networkCode === 'UND_ERR_BODY_TIMEOUT' ||
    /timeout/i.test(networkMessage) ||
    error && error.name === 'AbortError'
  );
}

function isRateLimitError(error) {
  const graphCode = getGraphErrorCode(error);
  return Boolean(
    error && error.status === 429 ||
    graphCode === 4 ||
    graphCode === 17 ||
    graphCode === 32 ||
    graphCode === 613
  );
}

function getGraphErrorCode(error) {
  const graphError = error && error.data && error.data.error;
  if (!graphError || graphError.code == null) return null;
  return Number(graphError.code);
}

function formatApiError(error) {
  const parts = [];
  if (error && error.message) parts.push(error.message);
  if (error && error.response && error.response.data) {
    parts.push(JSON.stringify(error.response.data));
  } else if (error && error.data) {
    parts.push(JSON.stringify(error.data));
  }
  return parts.join(' | ').slice(0, 2000) || 'Unknown error';
}

module.exports = {
  fetchComments,
  fetchMedia,
  replyToComment,
  sendPrivateReply,
  formatApiError,
  isRateLimitError,
  isRetryablePrivateReplyError
};
