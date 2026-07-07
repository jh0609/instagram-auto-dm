const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const config = require('./config');
const { db } = require('./db');
const { fetchMedia } = require('./instagramApi');
const { createMediaCache } = require('./mediaCache');
const { findMatchingRule, renderTemplate } = require('./replyService');

const mediaCache = createMediaCache(fetchMedia, config.mediaCacheTtlSeconds);
const assetsDir = path.resolve(process.cwd(), 'public', 'assets');
const allowedImageTypes = new Map([
  ['image/png', new Set(['.png'])],
  ['image/jpeg', new Set(['.jpg', '.jpeg'])],
  ['image/webp', new Set(['.webp'])]
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(assetsDir, { recursive: true });
      cb(null, assetsDir);
    },
    filename: (_req, file, cb) => {
      cb(null, createAssetFilename(file));
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const allowedExtensions = allowedImageTypes.get(file.mimetype);
    if (!allowedExtensions || !allowedExtensions.has(extension)) {
      return cb(new Error('png, jpg, jpeg, webp 이미지만 업로드할 수 있습니다.'));
    }
    return cb(null, true);
  }
});

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
    const page = clampPage(req.query.page);
    const pageSize = clampLimit(req.query.page_size, 20, 100);
    const total = db.prepare('SELECT COUNT(*) AS count FROM reply_logs').get().count;
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const offset = (page - 1) * pageSize;
    const rows = db.prepare(`
      SELECT l.id, l.media_id, l.comment_id, l.username,
             l.ig_user_id,
             r.keyword AS matched_keyword,
             l.matched_rule_id AS rule_id,
             l.status, l.reply_text, l.public_reply_text, l.error_message,
             l.created_at
      FROM reply_logs l
      LEFT JOIN reply_rules r ON r.id = l.matched_rule_id
      ORDER BY l.id DESC
      LIMIT ? OFFSET ?
    `).all(pageSize, offset);
    res.json({
      data: rows,
      page,
      page_size: pageSize,
      total,
      total_pages: totalPages
    });
  });

  router.get('/api/media', async (req, res) => {
    try {
      const result = await mediaCache.get(clampLimit(req.query.limit, 25, 100), {
        force: isForceRefresh(req.query)
      });
      return res.json({ data: result.data, cache: result.cache });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to fetch media' });
    }
  });

  router.get('/api/media/resolve', async (req, res) => {
    const permalink = normalizeNullableText(req.query.permalink);
    if (!permalink) return res.status(400).json({ error: 'permalink is required' });

    try {
      const result = await mediaCache.get(clampLimit(req.query.limit, 100, 100), {
        force: isForceRefresh(req.query)
      });
      const media = result.data;
      const normalizedPermalink = normalizePermalink(permalink);
      const matched = media.find((item) => normalizePermalink(item.permalink) === normalizedPermalink);
      if (!matched) return res.status(404).json({ error: 'Media not found' });
      return res.json({ data: matched, cache: result.cache });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to resolve media' });
    }
  });

  router.post('/api/assets/upload', (req, res) => {
    upload.single('image')(req, res, (error) => {
      if (error) {
        const message = error.code === 'LIMIT_FILE_SIZE'
          ? '이미지는 최대 5MB까지 업로드할 수 있습니다.'
          : error.message || '이미지 업로드에 실패했습니다.';
        return res.status(400).json({ error: message });
      }

      if (!req.file) {
        return res.status(400).json({ error: '업로드할 이미지 파일을 선택하세요.' });
      }

      return res.json({
        ok: true,
        filename: req.file.filename,
        url: `${getPublicBaseUrl(req)}/assets/${req.file.filename}`
      });
    });
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
  const text = String(value || '').trim();
  if (!text) return '';

  try {
    const url = new URL(text);
    const match = url.pathname.match(/^\/(p|reel|tv)\/([^/]+)\/?/);
    if (match) return `${url.origin}/${match[1]}/${match[2]}`;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return text.split(/[?#]/)[0].replace(/\/+$/, '');
  }
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

function clampPage(value) {
  const number = Number(value || 1);
  if (!Number.isInteger(number) || number <= 0) return 1;
  return number;
}

function isForceRefresh(query) {
  const value = String(query.force || query.refresh || '').toLowerCase();
  return value === '1' || value === 'true' || value === 'y' || value === 'yes';
}

function createAssetFilename(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const timestamp = formatAssetTimestamp(new Date());
  const random = crypto.randomBytes(3).toString('hex');
  return `aji-${timestamp}-${random}${extension}`;
}

function formatAssetTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function getPublicBaseUrl(req) {
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
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
    .help { margin: 4px 0 0; color: #667085; font-size: 12px; line-height: 1.4; }
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
    .pager { align-items: center; margin-top: 12px; }
    .muted { color: #667085; }
    .mono { font-family: Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } body { margin: 12px; } }
  </style>
</head>
<body>
  <h1>autoDM 관리자</h1>

  <section>
    <h2>자동응답 규칙 입력</h2>
    <form id="ruleForm" class="grid">
      <input type="hidden" id="ruleId">
      <div>
        <label>게시글 ID</label>
        <input id="mediaId" placeholder="비워두면 공통 규칙">
        <p class="help">특정 게시글에만 적용하려면 입력하세요. 비워두면 모든 게시글에 적용됩니다.</p>
      </div>
      <div>
        <label>게시글 URL로 찾기</label>
        <div class="actions">
          <input id="mediaPermalink" placeholder="https://www.instagram.com/p/...">
          <button type="button" class="secondary" onclick="resolveMedia()">찾기</button>
        </div>
        <p class="help">Instagram 게시글 URL을 붙여넣으면 게시글 ID를 찾습니다. URL의 query/hash는 자동으로 제거됩니다.</p>
      </div>
      <div>
        <label>댓글 키워드 *</label>
        <input id="keyword" required>
        <p class="help">댓글에 이 단어가 포함되면 자동응답을 보냅니다.</p>
      </div>
      <div class="span">
        <label>DM 메시지 *</label>
        <textarea id="replyText" required></textarea>
        <p class="help">댓글 작성자에게 DM으로 보낼 내용입니다. {{username}}, {{resource_url}}, {{comment_text}} 사용 가능.</p>
      </div>
      <div class="span">
        <label>공개 댓글 답글</label>
        <textarea id="publicReplyText"></textarea>
        <p class="help">댓글 아래에 공개로 남길 답글입니다. 비워두면 공개 답글을 달지 않습니다.</p>
      </div>
      <div>
        <label>자료/링크 URL</label>
        <input id="resourceUrl">
        <p class="help">DM 메시지에서 {{resource_url}}로 사용할 링크입니다.</p>
      </div>
      <div>
        <label>우선순위</label>
        <input id="priority" type="number" value="100">
        <p class="help">숫자가 낮을수록 먼저 적용됩니다. 게시글별 규칙은 10, 공통 규칙은 100 권장.</p>
      </div>
      <div>
        <label>사용 여부</label>
        <select id="enabledYn"><option>Y</option><option>N</option></select>
        <p class="help">N이면 규칙은 저장되지만 자동응답에는 사용하지 않습니다.</p>
      </div>
      <div class="span actions">
        <button type="submit">저장</button>
        <button type="button" class="secondary" onclick="resetRuleForm()">새 규칙</button>
        <button type="button" class="secondary" onclick="loadRules()">새로고침</button>
        <button type="button" class="secondary" onclick="loadMedia()">최근 게시글 불러오기</button>
      </div>
    </form>
    <div id="mediaStatus" class="muted"></div>
    <div id="mediaList"></div>
  </section>

  <section>
    <h2>자동응답 규칙</h2>
    <div id="rules"></div>
  </section>

  <section>
    <h2>이미지 업로드</h2>
    <div class="grid">
      <div>
        <label>이미지 파일</label>
        <input id="assetImage" type="file" accept="image/png,image/jpeg,image/webp">
        <p class="help">png, jpg, jpeg, webp 파일만 업로드할 수 있습니다. 최대 5MB.</p>
      </div>
      <div class="actions">
        <button type="button" onclick="uploadAsset()">업로드</button>
        <button type="button" class="secondary" onclick="useUploadedAssetUrl()">자료/링크 URL에 넣기</button>
      </div>
      <div class="span">
        <label>업로드 URL</label>
        <input id="uploadedAssetUrl" readonly>
        <p id="assetUploadStatus" class="help"></p>
      </div>
    </div>
  </section>

  <section>
    <h2>매칭 테스트</h2>
    <form id="testForm" class="grid">
      <div><label>게시글 ID</label><input id="testMediaId"><p class="help">테스트할 게시글 ID입니다.</p></div>
      <div><label>사용자명</label><input id="testUsername"><p class="help">{{username}} 치환에 사용됩니다.</p></div>
      <div><label>댓글 ID</label><input id="testCommentId"><p class="help">{{comment_id}} 치환에 사용됩니다.</p></div>
      <div class="span"><label>댓글 내용</label><textarea id="testCommentText"></textarea><p class="help">키워드 매칭과 {{comment_text}} 치환에 사용됩니다.</p></div>
      <div class="span"><button type="submit">테스트</button></div>
    </form>
    <pre id="testResult" class="mono"></pre>
  </section>

  <section>
    <h2>발송 기록</h2>
    <div class="actions"><button type="button" class="secondary" onclick="loadLogs()">새로고침</button></div>
    <div id="logs"></div>
    <div class="actions pager">
      <button type="button" class="secondary" onclick="prevLogsPage()">이전</button>
      <span id="logsPageInfo" class="muted"></span>
      <button type="button" class="secondary" onclick="nextLogsPage()">다음</button>
    </div>
  </section>

  <script>
    const token = ${safeToken};
    localStorage.setItem('adminToken', token);
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
    const logsState = { page: 1, pageSize: 20, totalPages: 1 };
    const labels = {
      id: 'ID',
      media_id: '게시글 ID',
      ig_user_id: 'Instagram 사용자 ID',
      keyword: '댓글 키워드',
      priority: '우선순위',
      enabled_yn: '사용 여부',
      reply_text: 'DM 메시지',
      public_reply_text: '공개 댓글 답글',
      resource_url: '자료/링크 URL',
      caption: '본문',
      permalink: '게시글 URL',
      timestamp: '게시일',
      created_at: '생성일',
      status: '상태',
      comment_id: '댓글 ID',
      username: '사용자명',
      matched_keyword: '매칭 키워드',
      rule_id: '규칙 ID',
      error_message: '오류'
    };

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
        edit.textContent = '수정';
        edit.addEventListener('click', () => editRule(row.id));
        const disable = document.createElement('button');
        disable.className = 'danger';
        disable.type = 'button';
        disable.textContent = '비활성화';
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
      status.textContent = '최근 게시글을 불러오는 중입니다.';
      try {
        const { data } = await api('/media?limit=25');
        renderTable(document.getElementById('mediaList'), data, [
          'id', 'caption', 'permalink', 'timestamp'
        ], row => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'secondary';
          button.textContent = '선택';
          button.addEventListener('click', () => {
            setValue('mediaId', row.id);
            status.textContent = '선택한 게시글 ID: ' + row.id;
          });
          return button;
        });
        status.textContent = data.length ? '게시글을 선택하면 게시글 ID가 자동 입력됩니다.' : '게시글을 찾지 못했습니다.';
      } catch (error) {
        status.textContent = error.message;
      }
    }

    async function resolveMedia() {
      const status = document.getElementById('mediaStatus');
      const permalink = normalizePermalink(value('mediaPermalink'));
      setValue('mediaPermalink', permalink);
      if (!permalink) {
        status.textContent = '게시글 URL을 입력하세요.';
        return;
      }

      try {
        const { data } = await api('/media/resolve?permalink=' + encodeURIComponent(permalink));
        setValue('mediaId', data.id);
        status.textContent = '찾은 게시글 ID: ' + data.id;
      } catch (error) {
        status.textContent = error.message;
      }
    }

    async function uploadAsset() {
      const status = document.getElementById('assetUploadStatus');
      const input = document.getElementById('assetImage');
      const file = input.files && input.files[0];
      if (!file) {
        status.textContent = '업로드할 이미지 파일을 선택하세요.';
        return;
      }

      const formData = new FormData();
      formData.append('image', file);
      status.textContent = '이미지를 업로드하는 중입니다.';

      try {
        const res = await fetch('/admin/api/assets/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          body: formData
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '이미지 업로드에 실패했습니다.');
        setValue('uploadedAssetUrl', data.url);
        status.textContent = '업로드가 완료되었습니다.';
      } catch (error) {
        status.textContent = error.message;
      }
    }

    function useUploadedAssetUrl() {
      const status = document.getElementById('assetUploadStatus');
      const url = value('uploadedAssetUrl');
      if (!url) {
        status.textContent = '먼저 이미지를 업로드하세요.';
        return;
      }
      setValue('resourceUrl', url);
      status.textContent = '자료/링크 URL에 업로드 URL을 입력했습니다.';
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

    document.getElementById('mediaPermalink').addEventListener('change', event => {
      event.target.value = normalizePermalink(event.target.value);
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
      const result = await api('/logs?page=' + logsState.page + '&page_size=' + logsState.pageSize);
      const data = result.data;
      logsState.page = result.page;
      logsState.pageSize = result.page_size;
      logsState.totalPages = result.total_pages;
      renderTable(document.getElementById('logs'), data, [
        'id', 'created_at', 'status', 'media_id', 'comment_id', 'ig_user_id', 'username', 'matched_keyword', 'rule_id', 'reply_text', 'public_reply_text', 'error_message'
      ]);
      document.getElementById('logsPageInfo').textContent =
        logsState.page + ' / ' + logsState.totalPages + ' 페이지, 총 ' + result.total + '건';
    }

    async function prevLogsPage() {
      if (logsState.page <= 1) return;
      logsState.page -= 1;
      await loadLogs();
    }

    async function nextLogsPage() {
      if (logsState.page >= logsState.totalPages) return;
      logsState.page += 1;
      await loadLogs();
    }

    function normalizePermalink(input) {
      const text = String(input || '').trim();
      if (!text) return '';
      try {
        const url = new URL(text);
        const match = url.pathname.match(/^\\/(p|reel|tv)\\/([^/]+)\\/?/);
        if (match) return url.origin + '/' + match[1] + '/' + match[2] + '/';
        return url.origin + url.pathname.replace(/\\/+$/, '') + '/';
      } catch {
        return text.split(/[?#]/)[0].replace(/\\/+$/, '') + '/';
      }
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
        th.textContent = labels[column] || column;
        headRow.append(th);
      }
      if (actionRenderer) {
        const th = document.createElement('th');
        th.textContent = '작업';
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
