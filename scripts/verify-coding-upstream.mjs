import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = new URL('../integrations/coding-agents/', import.meta.url);
const upstream = JSON.parse(readFileSync(new URL('UPSTREAM.json', root), 'utf8'));
const changes = JSON.parse(readFileSync(new URL('LOCAL_CHANGES.json', root), 'utf8'));
for (const [file, pristine] of Object.entries(upstream.files)) {
  const actual = createHash('sha256').update(readFileSync(new URL(join('upstream', file), root))).digest('hex');
  if (actual !== (changes[file] ?? pristine)) throw new Error(`coding-agents source drift: ${file}`);
}
console.log(`Verified upstream ${upstream.commit} with ${Object.keys(changes).length} adapted files`);
