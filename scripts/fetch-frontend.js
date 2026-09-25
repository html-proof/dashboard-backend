// Build step: the dashboard UI lives in its own repo (dashboard-front-end).
// Pull it into ./public so the server can serve it. Skipped when public/ already exists (local dev).
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const repo = process.env.FRONTEND_REPO || 'https://github.com/html-proof/dashboard-front-end.git';
const branch = process.env.FRONTEND_BRANCH || 'main';

if (existsSync('public/index.html')) {
  console.log('public/ already present - skipping frontend fetch');
} else {
  console.log(`Fetching frontend from ${repo} (${branch})`);
  execSync(`git clone --depth 1 --branch ${branch} ${repo} public`, { stdio: 'inherit' });
}
