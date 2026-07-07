const fs = require('fs');
const path = require('path');

const verifyDbPath = path.join(process.cwd(), 'data', 'verify.sqlite');
for (const suffix of ['', '-shm', '-wal']) {
  fs.rmSync(`${verifyDbPath}${suffix}`, { force: true });
}

process.env.SQLITE_PATH = './data/verify.sqlite';
process.env.PUBLIC_COMMENT_REPLY_ENABLED = 'false';
process.env.ADMIN_TOKEN = 'verify-admin-token';
process.env.PORT = '0';

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

verifyAdminRoutes()
  .then(() => {
    db.close();
    for (const suffix of ['', '-shm', '-wal']) {
      fs.rmSync(`${verifyDbPath}${suffix}`, { force: true });
    }
    console.log('verify ok');
  })
  .catch((error) => {
    db.close();
    for (const suffix of ['', '-shm', '-wal']) {
      fs.rmSync(`${verifyDbPath}${suffix}`, { force: true });
    }
    throw error;
  });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function verifyAdminRoutes() {
  const { server } = require('../src/server');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const unauthorized = await fetch(`${baseUrl}/admin/api/rules`);
    assert(unauthorized.status === 401, 'admin API should reject missing token');

    const adminPage = await fetch(`${baseUrl}/admin?token=verify-admin-token`);
    assert(adminPage.status === 200, 'admin page should load with query token');
    assert((adminPage.headers.get('content-type') || '').includes('text/html'), 'admin page should return HTML');

    const rules = await fetch(`${baseUrl}/admin/api/rules`, {
      headers: { Authorization: 'Bearer verify-admin-token' }
    });
    assert(rules.status === 200, 'admin rules API should load with bearer token');

    const createdRule = await fetch(`${baseUrl}/admin/api/rules`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer verify-admin-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        media_id: '',
        keyword: 'admin',
        reply_text: 'admin reply {{username}}',
        priority: '',
        enabled_yn: 'Y'
      })
    });
    const createdRuleBody = await createdRule.json();
    assert(createdRule.status === 201 && createdRuleBody.data.media_id === null, 'admin rule create should normalize empty media_id');

    const patchedRule = await fetch(`${baseUrl}/admin/api/rules/${createdRuleBody.data.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer verify-admin-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        media_id: 'media-admin',
        keyword: 'admin',
        reply_text: 'patched {{username}}',
        priority: 5,
        enabled_yn: 'Y'
      })
    });
    const patchedRuleBody = await patchedRule.json();
    assert(patchedRule.status === 200 && patchedRuleBody.data.priority === 5, 'admin rule patch should update rule');

    const logs = await fetch(`${baseUrl}/admin/api/logs`, {
      headers: { Authorization: 'Bearer verify-admin-token' }
    });
    const logsBody = await logs.json();
    assert(logs.status === 200 && Array.isArray(logsBody.data), 'admin logs API should return data array');

    const testMatch = await fetch(`${baseUrl}/admin/api/test-match`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer verify-admin-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        media_id: 'media-a',
        comment_text: 'please send guide',
        username: 'tester',
        comment_id: 'comment-1'
      })
    });
    const result = await testMatch.json();
    assert(testMatch.status === 200 && result.matched === true, 'admin test-match should return rendered match');

    const disabledRule = await fetch(`${baseUrl}/admin/api/rules/${createdRuleBody.data.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer verify-admin-token' }
    });
    const disabledRuleBody = await disabledRule.json();
    assert(disabledRule.status === 200 && disabledRuleBody.data.enabled_yn === 'N', 'admin delete should disable rule');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
