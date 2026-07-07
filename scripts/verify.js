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
process.env.IG_BUSINESS_ID = '';
process.env.IG_BUSINESS_ACCESS_TOKEN = '';

const { db, initDatabase } = require('../src/db');
const { isRateLimitError } = require('../src/instagramApi');
const { createMediaCache } = require('../src/mediaCache');
const { processComment, findUserDuplicate, findMatchingRule, renderTemplate } = require('../src/replyService');

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

verifyRateLimitHelpers();
verifyBackupScript();

verifyMediaCache()
  .then(verifyDuplicatePolicy)
  .then(verifyAdminRoutes)
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

function verifyRateLimitHelpers() {
  assert(isRateLimitError({ status: 429 }) === true, 'HTTP 429 should be rate limit');
  for (const code of [4, 17, 32, 613]) {
    assert(
      isRateLimitError({ data: { error: { code } } }) === true,
      `Graph error code ${code} should be rate limit`
    );
  }
  assert(isRateLimitError({ status: 500, data: { error: { code: 1 } } }) === false, 'code 1 should not be rate limit');
}

function verifyBackupScript() {
  const scriptPath = path.join(process.cwd(), 'scripts', 'backup-db.sh');
  assert(fs.existsSync(scriptPath), 'backup-db.sh should exist');
  const content = fs.readFileSync(scriptPath, 'utf8');
  assert(content.includes('sqlite3') && content.includes('.backup'), 'backup-db.sh should use sqlite3 .backup');

  if (process.platform !== 'win32') {
    const mode = fs.statSync(scriptPath).mode;
    assert((mode & 0o111) !== 0, 'backup-db.sh should be executable');
  }
}

async function verifyMediaCache() {
  let calls = 0;
  const cache = createMediaCache(async (limit) => {
    calls += 1;
    return [{ id: `media-${calls}`, limit }];
  }, 300);

  const first = await cache.get(25);
  const second = await cache.get(25);
  const forced = await cache.get(25, { force: true });

  assert(first.cache.hit === false, 'first media cache read should miss');
  assert(second.cache.hit === true, 'second media cache read should hit');
  assert(forced.cache.hit === false, 'forced media cache read should miss');
  assert(calls === 2, 'media cache should avoid repeated fetches unless forced');
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
    assert(logsBody.page === 1 && logsBody.page_size === 20, 'admin logs API should include pagination metadata');

    const mediaWithoutConfig = await fetch(`${baseUrl}/admin/api/media`, {
      headers: { Authorization: 'Bearer verify-admin-token' }
    });
    const mediaWithoutConfigBody = await mediaWithoutConfig.json();
    assert(
      mediaWithoutConfig.status === 500 && /IG_BUSINESS/.test(mediaWithoutConfigBody.error),
      'admin media API should return clear config error when Instagram credentials are missing'
    );

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

async function verifyDuplicatePolicy() {
  const sentLog = db.prepare(`
    INSERT INTO reply_logs (
      media_id, comment_id, ig_user_id, username, comment_text, matched_rule_id,
      reply_text, status, created_at, replied_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run('media-a', 'already-sent-comment', 'ig-user-1', 'tester', 'please send guide', mediaRule.id, 'sent');

  const skipped = await processComment({
    mediaId: 'media-a',
    commentId: 'new-duplicate-comment',
    igUserId: 'ig-user-1',
    username: 'tester',
    text: 'please send guide',
    rawPayload: { verify: true }
  });
  assert(skipped.status === 'skipped', 'same ig_user_id + media_id should be skipped');

  const skippedLog = db.prepare('SELECT status, ig_user_id, error_message FROM reply_logs WHERE comment_id = ?')
    .get('new-duplicate-comment');
  assert(skippedLog.status === 'skipped', 'skipped duplicate should be logged');
  assert(skippedLog.ig_user_id === 'ig-user-1', 'skipped log should store ig_user_id');
  assert(skippedLog.error_message === 'Duplicate user/media skipped', 'skipped log should store duplicate reason');

  const otherMediaDuplicate = findUserDuplicate({
    igUserId: 'ig-user-1',
    mediaId: 'media-other',
    ruleId: mediaRule.id
  });
  assert(otherMediaDuplicate === null, 'same user on different media should not be blocked by user/media policy');

  const noUserDuplicate = findUserDuplicate({
    igUserId: null,
    mediaId: 'media-a',
    ruleId: mediaRule.id
  });
  assert(noUserDuplicate === null, 'missing ig_user_id should only use comment_id duplicate policy');

  const savedUserId = db.prepare('SELECT ig_user_id FROM reply_logs WHERE id = ?').get(sentLog.lastInsertRowid);
  assert(savedUserId.ig_user_id === 'ig-user-1', 'reply_logs should store ig_user_id');
}
