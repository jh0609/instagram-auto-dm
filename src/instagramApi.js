const config = require('./config');

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

  if (!response.ok) {
    const error = new Error(`Graph API request failed with ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
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

async function sendPrivateReply(commentId, replyText) {
  requireValue(commentId, 'commentId');
  requireValue(replyText, 'replyText');
  requireValue(config.igBusinessId, 'IG_BUSINESS_ID');
  requireValue(config.igBusinessAccessToken, 'IG_BUSINESS_ACCESS_TOKEN');

  const url = new URL(`https://graph.instagram.com/${config.igGraphVersion}/${config.igBusinessId}/messages`);
  url.searchParams.set('access_token', config.igBusinessAccessToken);

  const data = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: { text: replyText }
    })
  });

  return {
    recipient_id: data && data.recipient_id ? data.recipient_id : null,
    message_id: data && data.message_id ? data.message_id : null,
    raw: data
  };
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
  sendPrivateReply,
  formatApiError
};
