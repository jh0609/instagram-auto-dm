const fs = require('fs');
const path = require('path');

const verifyDbPath = path.join(process.cwd(), 'data', 'verify.sqlite');
for (const suffix of ['', '-shm', '-wal']) {
  fs.rmSync(`${verifyDbPath}${suffix}`, { force: true });
}

process.env.SQLITE_PATH = './data/verify.sqlite';
process.env.PUBLIC_COMMENT_REPLY_ENABLED = 'false';

const { db, initDatabase } = require('../src/db');
const { findMatchingRule, renderTemplate } = require('../src/replyService');

initDatabase();

const columns = db.pragma('table_info(reply_rules)').map((column) => column.name);
for (const column of ['media_id', 'priority', 'enabled_yn', 'public_reply_text', 'resource_url']) {
  assert(columns.includes(column), `reply_rules.${column} column is missing`);
}

db.prepare(`
  INSERT INTO reply_rules (
    media_id, keyword, reply_text, enabled_yn, priority, public_reply_text, resource_url
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run('media-a', 'guide', 'A {{username}} {{resource_url}}', 'Y', 50, 'A public {{keyword}}', 'https://example.com/a');

db.prepare(`
  INSERT INTO reply_rules (
    media_id, keyword, reply_text, enabled_yn, priority, public_reply_text, resource_url
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(null, 'guide', 'fallback {{media_id}}', 'Y', 1, 'fallback public', 'https://example.com/fallback');

db.prepare(`
  INSERT INTO reply_rules (
    media_id, keyword, reply_text, enabled_yn, priority, public_reply_text, resource_url
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run('media-a', 'guide', 'disabled', 'N', 1, null, null);

const mediaRule = findMatchingRule('media-a', 'please send guide');
assert(mediaRule && mediaRule.media_id === 'media-a', 'media-specific rule should win over fallback');
assert(mediaRule.reply_text === 'A {{username}} {{resource_url}}', 'unexpected media-specific reply text');

const fallbackRule = findMatchingRule('media-b', 'please send guide');
assert(fallbackRule && fallbackRule.media_id === null, 'fallback rule should match when media-specific rule is absent');

const rendered = renderTemplate('Hi {{username}} {{keyword}} {{comment_text}} {{media_id}} {{comment_id}} {{resource_url}}', {
  username: 'tester',
  keyword: 'guide',
  comment_text: 'please send guide',
  media_id: 'media-a',
  comment_id: 'comment-1',
  resource_url: 'https://example.com/a'
});
assert(
  rendered === 'Hi tester guide please send guide media-a comment-1 https://example.com/a',
  'template rendering failed'
);

db.close();
for (const suffix of ['', '-shm', '-wal']) {
  fs.rmSync(`${verifyDbPath}${suffix}`, { force: true });
}

console.log('verify ok');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
