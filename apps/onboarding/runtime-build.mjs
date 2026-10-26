import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

// Identical npm/source builds reuse a service, while edited assets or runner code
// replace it. Absolute installation paths and Node binary paths are not identity.
export async function runtimeBuild(root = new URL('../../', import.meta.url)) {
  const hash = createHash('sha256');
  async function visit(path) {
    const entries = await readdir(new URL(path, root), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'test') continue;
      const file = `${path}${entry.name}`;
      if (entry.isDirectory()) await visit(`${file}/`);
      else if (/\.(mjs|js|css|html|svg|md)$/.test(entry.name)) {
        hash.update(file).update('\0').update(await readFile(new URL(file, root))).update('\0');
      }
    }
  }
  for (const path of ['apps/onboarding/', 'apps/peer/', 'packages/peer/', 'packages/codex-kit/templates/', 'scripts/peer/']) await visit(path);
  hash.update(await readFile(new URL('package.json', root)));
  hash.update(await readFile(new URL('scripts/wecom-diagnostic.mjs', root)));
  return hash.digest('hex');
}
