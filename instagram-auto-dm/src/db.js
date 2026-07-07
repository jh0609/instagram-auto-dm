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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS reply_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT NOT NULL,
      comment_id TEXT NOT NULL UNIQUE,
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
      replied_at TEXT NULL
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
    INSERT INTO reply_rules (media_id, keyword, reply_text, use_yn)
    VALUES (NULL, ?, ?, 'Y')
  `).run(config.defaultKeyword, config.defaultReplyText);

  return result.lastInsertRowid;
}

module.exports = {
  db,
  initDatabase,
  insertDefaultRule
};
