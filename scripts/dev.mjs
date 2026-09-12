import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadConfig, ROOT_DIR } from '../server/lib/env.js';

const config = loadConfig();
const children = [];
let stopping = false;

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(code), 300).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function run(label, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT_DIR,
    env: { ...process.env, ...env },
    stdio: 'inherit'
  });
  children.push(child);
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`[dev] ${label} exited with code ${code}`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

console.log(`[dev] API on http://${config.host}:${config.port}${config.basePath} (health: ${config.basePath}/health)`);
console.log(`[dev] Vite dev server proxies ${config.basePath}/api and ${config.basePath}/health to the API`);

run('api', [path.join(ROOT_DIR, 'server', 'index.js')], {
  PORT: String(config.port),
  BASE_PATH: config.basePath,
  HOST: config.host
});

run('vite', [path.join(ROOT_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', path.join('client', 'vite.config.js')], {
  BASE_PATH: config.basePath,
  API_PORT: String(config.port)
});
