const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

const dbPath = path.resolve(process.cwd(), config.sqlitePath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reply_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT NULL,
      keyword TEXT NOT NULL,
      reply_text TEXT NOT NULL,
      use_yn TEXT NOT NULL DEFAULT 'Y',
      priority INTEGER NOT NULL DEFAULT 100,
      enabled_yn TEXT NOT NULL DEFAULT 'Y',
      public_reply_text TEXT NULL,
      resource_url TEXT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS reply_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT NOT NULL,
      comment_id TEXT NOT NULL UNIQUE,
      ig_user_id TEXT NULL,
      username TEXT NULL,
      comment_text TEXT NULL,
      matched_rule_id INTEGER NULL,
      reply_text TEXT NULL,
      recipient_id TEXT NULL,
      message_id TEXT NULL,
      status TEXT NOT NULL,
      error_message TEXT NULL,
      raw_payload TEXT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      replied_at TEXT NULL,
      public_reply_text TEXT NULL,
      public_reply_comment_id TEXT NULL,
      public_reply_status TEXT NULL,
      public_reply_error_message TEXT NULL,
      public_replied_at TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      processed_yn TEXT NOT NULL DEFAULT 'N',
      error_message TEXT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT NULL
    );
  `);

  addColumnIfMissing('reply_rules', 'media_id', 'TEXT');
  addColumnIfMissing('reply_rules', 'priority', 'INTEGER NOT NULL DEFAULT 100');
  const addedEnabledYn = addColumnIfMissing('reply_rules', 'enabled_yn', "TEXT NOT NULL DEFAULT 'Y'");
  addColumnIfMissing('reply_rules', 'public_reply_text', 'TEXT');
  addColumnIfMissing('reply_rules', 'resource_url', 'TEXT');
  if (addedEnabledYn) {
    db.exec(`
      UPDATE reply_rules
      SET enabled_yn = use_yn
      WHERE use_yn IN ('Y', 'N')
    `);
  }

  addColumnIfMissing('reply_logs', 'public_reply_text', 'TEXT');
  addColumnIfMissing('reply_logs', 'public_reply_comment_id', 'TEXT');
  addColumnIfMissing('reply_logs', 'public_reply_status', 'TEXT');
  addColumnIfMissing('reply_logs', 'public_reply_error_message', 'TEXT');
  addColumnIfMissing('reply_logs', 'public_replied_at', 'TEXT');
  addColumnIfMissing('reply_logs', 'ig_user_id', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reply_logs_user_media_status
    ON reply_logs(ig_user_id, media_id, status);

    CREATE INDEX IF NOT EXISTS idx_reply_logs_user_rule_status
    ON reply_logs(ig_user_id, matched_rule_id, status);
  `);
}

function addColumnIfMissing(tableName, columnName, columnType) {
  const columns = db.pragma(`table_info(${tableName})`);
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
    return true;
  }
  return false;
}

function insertDefaultRule() {
  if (!config.defaultKeyword || !config.defaultReplyText) return null;

  const existing = db.prepare(`
    SELECT id
    FROM reply_rules
    WHERE keyword = ? AND reply_text = ? AND media_id IS NULL
    LIMIT 1
  `).get(config.defaultKeyword, config.defaultReplyText);

  if (existing) return existing.id;

  const result = db.prepare(`
    INSERT INTO reply_rules (media_id, keyword, reply_text, use_yn, enabled_yn, priority)
    VALUES (NULL, ?, ?, 'Y', 'Y', 100)
  `).run(config.defaultKeyword, config.defaultReplyText);

  return result.lastInsertRowid;
}

module.exports = {
  db,
  initDatabase,
  insertDefaultRule
};
