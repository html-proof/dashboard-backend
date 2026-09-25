// The dashboard UI lives in its own repo (dashboard-front-end). Download it into ./public so the
// server can serve it. Pure Node (no git needed). Skipped when public/ already exists (local dev).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const repo = process.env.FRONTEND_REPO || 'html-proof/dashboard-front-end';
const branch = process.env.FRONTEND_BRANCH || 'main';
const force = process.argv.includes('--force');

if (existsSync('public/index.html') && !force) {
  console.log('public/ already present - skipping frontend fetch');
} else {
  const headers = { 'user-agent': 'dashboard-backend', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const tree = await fetch(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, { headers });
  if (!tree.ok) throw new Error(`Frontend fetch failed: ${tree.status} ${await tree.text()}`);
  const files = (await tree.json()).tree.filter((item) => item.type === 'blob' && !item.path.startsWith('.github/'));
  for (const { path } of files) {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`);
    if (!res.ok) throw new Error(`Failed to download ${path}: ${res.status}`);
    const target = join('public', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  }
  console.log(`Fetched ${files.length} frontend files from ${repo}@${branch}`);
}
