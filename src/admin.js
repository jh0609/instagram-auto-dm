const express = require('express');
const config = require('./config');
const { db } = require('./db');
const { fetchMedia } = require('./instagramApi');
const { findMatchingRule, renderTemplate } = require('./replyService');

function createAdminRouter() {
  const router = express.Router();

  router.get('/', requireAdminToken, (req, res) => {
    res.type('html').send(renderAdminPage(req.adminToken));
  });

  router.use('/api', requireAdminToken);

  router.get('/api/rules', (_req, res) => {
    const rows = db.prepare(`
      SELECT id, media_id, keyword, reply_text, use_yn, created_at, updated_at,
             priority, enabled_yn, public_reply_text, resource_url
      FROM reply_rules
      ORDER BY
        CASE WHEN media_id IS NULL THEN 1 ELSE 0 END,
        media_id,
        priority,
        id
    `).all();
    res.json({ data: rows });
  });

  router.post('/api/rules', (req, res) => {
    const validation = normalizeRuleInput(req.body || {}, { partial: false });
    if (validation.error) return res.status(400).json({ error: validation.error });

    const input = validation.value;
    const result = db.prepare(`
      INSERT INTO reply_rules (
        media_id, keyword, reply_text, use_yn, priority, enabled_yn,
        public_reply_text, resource_url
      )
      VALUES (
        @mediaId, @keyword, @replyText, @enabledYn, @priority, @enabledYn,
        @publicReplyText, @resourceUrl
      )
    `).run(input);

    const row = getRule(result.lastInsertRowid);
    return res.status(201).json({ data: row });
  });

  router.patch('/api/rules/:id', updateRule);
  router.put('/api/rules/:id', updateRule);

  function updateRule(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid rule id' });
    if (!getRule(id)) return res.status(404).json({ error: 'Rule not found' });

    const validation = normalizeRuleInput(req.body || {}, { partial: false });
    if (validation.error) return res.status(400).json({ error: validation.error });

    const input = { ...validation.value, id };
    db.prepare(`
      UPDATE reply_rules
      SET media_id = @mediaId,
          keyword = @keyword,
          reply_text = @replyText,
          use_yn = @enabledYn,
          priority = @priority,
          enabled_yn = @enabledYn,
          public_reply_text = @publicReplyText,
          resource_url = @resourceUrl,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run(input);

    return res.json({ data: getRule(id) });
  }

  router.delete('/api/rules/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid rule id' });
    if (!getRule(id)) return res.status(404).json({ error: 'Rule not found' });

    db.prepare(`
      UPDATE reply_rules
      SET enabled_yn = 'N',
          use_yn = 'N',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);

    return res.json({ data: getRule(id) });
  });

  router.get('/api/logs', (req, res) => {
    const limit = clampLimit(req.query.limit, 100, 100);
    const rows = db.prepare(`
      SELECT l.id, l.media_id, l.comment_id, l.username,
             r.keyword AS matched_keyword,
             l.matched_rule_id AS rule_id,
             l.status, l.reply_text, l.public_reply_text, l.error_message,
             l.created_at
      FROM reply_logs l
      LEFT JOIN reply_rules r ON r.id = l.matched_rule_id
      ORDER BY l.id DESC
      LIMIT ?
    `).all(limit);
    res.json({ data: rows });
  });

  router.get('/api/media', async (req, res) => {
    try {
      const media = await fetchMedia(clampLimit(req.query.limit, 25, 100));
      return res.json({ data: media });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to fetch media' });
    }
  });

  router.get('/api/media/resolve', async (req, res) => {
    const permalink = normalizeNullableText(req.query.permalink);
    if (!permalink) return res.status(400).json({ error: 'permalink is required' });

    try {
      const media = await fetchMedia(clampLimit(req.query.limit, 100, 100));
      const normalizedPermalink = normalizePermalink(permalink);
      const matched = media.find((item) => normalizePermalink(item.permalink) === normalizedPermalink);
      if (!matched) return res.status(404).json({ error: 'Media not found' });
      return res.json({ data: matched });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to resolve media' });
    }
  });

  router.post('/api/test-match', (req, res) => {
    const mediaId = normalizeNullableText(req.body && req.body.media_id);
    const commentText = normalizeNullableText(req.body && req.body.comment_text) || '';
    const username = normalizeNullableText(req.body && req.body.username);
    const commentId = normalizeNullableText(req.body && req.body.comment_id);
    const matchedRule = findMatchingRule(mediaId, commentText);

    if (!matchedRule) {
      return res.json({
        matched: false,
        rule_id: null,
        keyword: null,
        reply_text: null,
        public_reply_text: null,
        resource_url: null
      });
    }

    const context = {
      username,
      keyword: matchedRule.keyword,
      comment_text: commentText,
      media_id: mediaId,
      comment_id: commentId,
      resource_url: matchedRule.resource_url
    };

    return res.json({
      matched: true,
      rule_id: matchedRule.id,
      keyword: matchedRule.keyword,
      reply_text: renderTemplate(matchedRule.reply_text, context),
      public_reply_text: renderTemplate(matchedRule.public_reply_text || config.publicCommentReplyText, context),
      resource_url: matchedRule.resource_url
    });
  });

  return router;
}

function requireAdminToken(req, res, next) {
  if (!config.adminToken) {
    return res.status(500).json({ error: 'ADMIN_TOKEN is not configured' });
  }

  const token = getRequestToken(req);
  if (token !== config.adminToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.adminToken = token;
  return next();
}

function getRequestToken(req) {
  const auth = req.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.query.token ? String(req.query.token) : '';
}

function normalizeRuleInput(input) {
  const keyword = normalizeNullableText(input.keyword);
  const replyText = normalizeNullableText(input.reply_text);
  const enabledYn = normalizeNullableText(input.enabled_yn) || 'Y';
  const priorityValue = input.priority === undefined || input.priority === null || input.priority === ''
    ? 100
    : Number(input.priority);

  if (!keyword) return { error: 'keyword is required' };
  if (!replyText) return { error: 'reply_text is required' };
  if (!['Y', 'N'].includes(enabledYn)) return { error: 'enabled_yn must be Y or N' };
  if (!Number.isInteger(priorityValue)) return { error: 'priority must be an integer' };

  return {
    value: {
      mediaId: normalizeNullableText(input.media_id),
      keyword,
      replyText,
      enabledYn,
      priority: priorityValue,
      publicReplyText: normalizeNullableText(input.public_reply_text),
      resourceUrl: normalizeNullableText(input.resource_url)
    }
  };
}

function normalizeNullableText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function normalizePermalink(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getRule(id) {
  return db.prepare(`
    SELECT id, media_id, keyword, reply_text, use_yn, created_at, updated_at,
           priority, enabled_yn, public_reply_text, resource_url
    FROM reply_rules
    WHERE id = ?
  `).get(id);
}

function clampLimit(value, defaultValue, maxValue) {
  const number = Number(value || defaultValue);
  if (!Number.isInteger(number) || number <= 0) return defaultValue;
  return Math.min(number, maxValue);
}

function renderAdminPage(token) {
  const safeToken = JSON.stringify(token);
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>autoDM Admin</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #202124; background: #f7f8fa; }
    h1 { margin: 0 0 16px; font-size: 24px; }
    h2 { font-size: 18px; margin: 0 0 12px; }
    section { background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    label { display: block; font-size: 12px; font-weight: 700; margin-bottom: 4px; }
    input, textarea, select { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #c9ced6; border-radius: 6px; font: inherit; }
    textarea { min-height: 72px; resize: vertical; }
    button { padding: 8px 12px; border: 1px solid #1a73e8; border-radius: 6px; background: #1a73e8; color: #fff; cursor: pointer; }
    button.secondary { background: #fff; color: #1a73e8; }
    button.danger { border-color: #b3261e; background: #b3261e; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f1f3f4; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .span { grid-column: 1 / -1; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .muted { color: #667085; }
    .mono { font-family: Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } body { margin: 12px; } }
  </style>
</head>
<body>
  <h1>autoDM Admin</h1>

  <section>
    <h2>Reply Rule</h2>
    <form id="ruleForm" class="grid">
      <input type="hidden" id="ruleId">
      <div><label>media_id</label><input id="mediaId" placeholder="empty = fallback"></div>
      <div>
        <label>게시글 URL로 찾기</label>
        <div class="actions">
          <input id="mediaPermalink" placeholder="https://www.instagram.com/p/...">
          <button type="button" class="secondary" onclick="resolveMedia()">찾기</button>
        </div>
      </div>
      <div><label>keyword *</label><input id="keyword" required></div>
      <div class="span"><label>reply_text *</label><textarea id="replyText" required></textarea></div>
      <div class="span"><label>public_reply_text</label><textarea id="publicReplyText"></textarea></div>
      <div><label>resource_url</label><input id="resourceUrl"></div>
      <div><label>priority</label><input id="priority" type="number" value="100"></div>
      <div><label>enabled_yn</label><select id="enabledYn"><option>Y</option><option>N</option></select></div>
      <div class="span actions">
        <button type="submit">Save</button>
        <button type="button" class="secondary" onclick="resetRuleForm()">New</button>
        <button type="button" class="secondary" onclick="loadRules()">Refresh</button>
        <button type="button" class="secondary" onclick="loadMedia()">게시글 불러오기</button>
      </div>
    </form>
    <div id="mediaStatus" class="muted"></div>
    <div id="mediaList"></div>
  </section>

  <section>
    <h2>Rules</h2>
    <div id="rules"></div>
  </section>

  <section>
    <h2>Test Match</h2>
    <form id="testForm" class="grid">
      <div><label>media_id</label><input id="testMediaId"></div>
      <div><label>username</label><input id="testUsername"></div>
      <div><label>comment_id</label><input id="testCommentId"></div>
      <div class="span"><label>comment_text</label><textarea id="testCommentText"></textarea></div>
      <div class="span"><button type="submit">Test</button></div>
    </form>
    <pre id="testResult" class="mono"></pre>
  </section>

  <section>
    <h2>Recent Logs</h2>
    <div class="actions"><button type="button" class="secondary" onclick="loadLogs()">Refresh Logs</button></div>
    <div id="logs"></div>
  </section>

  <script>
    const token = ${safeToken};
    localStorage.setItem('adminToken', token);
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

    async function api(path, options = {}) {
      const res = await fetch('/admin/api' + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    function value(id) { return document.getElementById(id).value; }
    function setValue(id, value) { document.getElementById(id).value = value == null ? '' : value; }

    async function loadRules() {
      const { data } = await api('/rules');
      renderTable(document.getElementById('rules'), data, [
        'id', 'media_id', 'keyword', 'priority', 'enabled_yn', 'reply_text', 'public_reply_text', 'resource_url'
      ], row => {
        const wrap = document.createElement('div');
        wrap.className = 'actions';
        const edit = document.createElement('button');
        edit.className = 'secondary';
        edit.type = 'button';
        edit.textContent = 'Edit';
        edit.addEventListener('click', () => editRule(row.id));
        const disable = document.createElement('button');
        disable.className = 'danger';
        disable.type = 'button';
        disable.textContent = 'Disable';
        disable.addEventListener('click', () => disableRule(row.id));
        wrap.append(edit, disable);
        return wrap;
      });
      window.rulesCache = data;
    }

    function editRule(id) {
      const row = window.rulesCache.find(item => item.id === id);
      if (!row) return;
      setValue('ruleId', row.id);
      setValue('mediaId', row.media_id);
      setValue('keyword', row.keyword);
      setValue('replyText', row.reply_text);
      setValue('publicReplyText', row.public_reply_text);
      setValue('resourceUrl', row.resource_url);
      setValue('priority', row.priority);
      setValue('enabledYn', row.enabled_yn);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function resetRuleForm() {
      document.getElementById('ruleForm').reset();
      setValue('ruleId', '');
      setValue('priority', 100);
      setValue('enabledYn', 'Y');
    }

    async function disableRule(id) {
      await api('/rules/' + id, { method: 'DELETE' });
      await loadRules();
    }

    async function loadMedia() {
      const status = document.getElementById('mediaStatus');
      status.textContent = 'Loading media...';
      try {
        const { data } = await api('/media?limit=25');
        renderTable(document.getElementById('mediaList'), data, [
          'id', 'caption', 'permalink', 'timestamp'
        ], row => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'secondary';
          button.textContent = 'Select';
          button.addEventListener('click', () => {
            setValue('mediaId', row.id);
            status.textContent = 'Selected media_id: ' + row.id;
          });
          return button;
        });
        status.textContent = data.length ? 'Select a post to fill media_id.' : 'No media found.';
      } catch (error) {
        status.textContent = error.message;
      }
    }

    async function resolveMedia() {
      const status = document.getElementById('mediaStatus');
      const permalink = value('mediaPermalink');
      if (!permalink) {
        status.textContent = 'Enter a permalink.';
        return;
      }

      try {
        const { data } = await api('/media/resolve?permalink=' + encodeURIComponent(permalink));
        setValue('mediaId', data.id);
        status.textContent = 'Resolved media_id: ' + data.id;
      } catch (error) {
        status.textContent = error.message;
      }
    }

    document.getElementById('ruleForm').addEventListener('submit', async event => {
      event.preventDefault();
      const id = value('ruleId');
      const body = {
        media_id: value('mediaId'),
        keyword: value('keyword'),
        reply_text: value('replyText'),
        public_reply_text: value('publicReplyText'),
        resource_url: value('resourceUrl'),
        priority: value('priority'),
        enabled_yn: value('enabledYn')
      };
      await api(id ? '/rules/' + id : '/rules', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      resetRuleForm();
      await loadRules();
    });

    document.getElementById('testForm').addEventListener('submit', async event => {
      event.preventDefault();
      const body = {
        media_id: value('testMediaId'),
        comment_text: value('testCommentText'),
        username: value('testUsername'),
        comment_id: value('testCommentId')
      };
      const result = await api('/test-match', { method: 'POST', body: JSON.stringify(body) });
      document.getElementById('testResult').textContent = JSON.stringify(result, null, 2);
    });

    async function loadLogs() {
      const { data } = await api('/logs');
      renderTable(document.getElementById('logs'), data, [
        'id', 'created_at', 'status', 'media_id', 'comment_id', 'username', 'matched_keyword', 'rule_id', 'reply_text', 'public_reply_text', 'error_message'
      ]);
    }

    function renderTable(target, rows, columns, actionRenderer) {
      target.replaceChildren();
      if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'No data';
        target.append(empty);
        return;
      }

      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const column of columns) {
        const th = document.createElement('th');
        th.textContent = column;
        headRow.append(th);
      }
      if (actionRenderer) {
        const th = document.createElement('th');
        th.textContent = 'actions';
        headRow.append(th);
      }
      thead.append(headRow);

      const tbody = document.createElement('tbody');
      for (const row of rows) {
        const tr = document.createElement('tr');
        for (const column of columns) {
          const td = document.createElement('td');
          td.className = 'mono';
          td.textContent = row[column] == null ? '' : String(row[column]);
          tr.append(td);
        }
        if (actionRenderer) {
          const td = document.createElement('td');
          td.append(actionRenderer(row));
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      target.append(table);
    }

    loadRules().catch(alert);
    loadLogs().catch(alert);
  </script>
</body>
</html>`;
}

module.exports = {
  createAdminRouter
};
