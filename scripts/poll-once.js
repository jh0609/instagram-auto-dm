const { initDatabase, insertDefaultRule } = require('../src/db');
const { pollOnce } = require('../src/pollingWorker');

async function main() {
  initDatabase();
  insertDefaultRule();

  const mediaId = process.argv[2];
  const result = await pollOnce(mediaId);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
