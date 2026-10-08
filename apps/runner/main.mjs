import { Runner } from './index.mjs';
const { COLLAB_REPO: repo, COLLAB_API: api, COLLAB_TOKEN: token, COLLAB_USER_ID: userId } = process.env;
if (!repo || !api || !token || !userId) throw new Error('COLLAB_REPO, COLLAB_API, COLLAB_TOKEN, COLLAB_USER_ID required');
const runner = new Runner({ repo, api, token, userId, dataDir: process.env.COLLAB_DATA_DIR || '.collab-runner', push: process.env.COLLAB_PUSH === '1', testCommand: JSON.parse(process.env.COLLAB_TEST_ARGV || '["sh","test.sh"]') });
await runner.loop();
