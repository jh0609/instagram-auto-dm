require('dotenv').config();

const config = {
  port: Number(process.env.PORT || 3010),
  metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
  fbGraphVersion: process.env.FB_GRAPH_VERSION || 'v25.0',
  fbPageId: process.env.FB_PAGE_ID || '',
  fbPageAccessToken: process.env.FB_PAGE_ACCESS_TOKEN || '',
  igGraphVersion: process.env.IG_GRAPH_VERSION || 'v25.0',
  igBusinessId: process.env.IG_BUSINESS_ID || '',
  igBusinessAccessToken: process.env.IG_BUSINESS_ACCESS_TOKEN || '',
  defaultMediaId: process.env.DEFAULT_MEDIA_ID || '',
  defaultKeyword: process.env.DEFAULT_KEYWORD || '',
  defaultReplyText: process.env.DEFAULT_REPLY_TEXT || '',
  sqlitePath: process.env.SQLITE_PATH || './data/instagram_auto_dm.sqlite',
  pollingEnabled: String(process.env.POLLING_ENABLED || 'false').toLowerCase() === 'true',
  pollingIntervalSeconds: Number(process.env.POLLING_INTERVAL_SECONDS || 60),
  publicCommentReplyEnabled: String(process.env.PUBLIC_COMMENT_REPLY_ENABLED || 'false').toLowerCase() === 'true',
  publicCommentReplyText: process.env.PUBLIC_COMMENT_REPLY_TEXT || 'DM으로 보내드렸어요!',
  adminToken: process.env.ADMIN_TOKEN || ''
};

module.exports = config;
