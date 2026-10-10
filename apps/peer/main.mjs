import { loadRuntime, readPeerConfig } from './runtime.mjs';
import { PeerRunner } from './runner.mjs';
import { startPeerWecom } from './wecom.mjs';
import { acquireRunnerLock } from './process.mjs';
const path = process.argv[2] || process.env.COLLAB_PEER_CONFIG;
const { config } = await readPeerConfig(path);
const release = await acquireRunnerLock(config.data_dir, path);
try {
  const runtime = await loadRuntime(path);
  let bridge;
  if (runtime.config.wecom) bridge = startPeerWecom({ service: runtime.service, config: { ...runtime.config.wecom, execution_mode: runtime.config.execution_mode === 'desktop_poll' ? 'desktop_poll' : runtime.config.wecom.execution_mode } });
  const runner = new PeerRunner(runtime.service, runtime.config);
  process.once('SIGINT', () => { runner.stop(); bridge?.close?.(); });
  process.once('SIGTERM', () => { runner.stop(); bridge?.close?.(); });
  console.error(`Codex peer runner online as ${runtime.config.agent_id}; ${runtime.config.auto_execute === false ? 'notifications only; automatic code execution disabled' : 'automatic claim/fallback is Git-backed'}`);
  try { await runner.loop({ pollNotifications: () => bridge?.poll?.() }); }
  finally { bridge?.close?.(); }
} finally { await release(); }
