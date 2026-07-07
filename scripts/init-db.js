const { initDatabase, insertDefaultRule } = require('../src/db');

initDatabase();
const ruleId = insertDefaultRule();

console.log('SQLite tables are ready.');
if (ruleId) {
  console.log(`Default reply rule is ready. rule_id=${ruleId}`);
} else {
  console.log('Default reply rule was skipped because DEFAULT_KEYWORD or DEFAULT_REPLY_TEXT is empty.');
}
