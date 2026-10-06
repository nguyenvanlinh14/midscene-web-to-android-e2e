import { type ChildProcess, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { parseFeatureText } from './gherkin';
import { extname, join, normalize, resolve } from 'node:path';

const PORT = Number(process.env.QA_PORT ?? 3000);
const ROOT = process.cwd();
const LIVE_DIR = join(tmpdir(), 'qa-live');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

let current: ChildProcess | undefined;

function serveStatic(root: string, relPath: string, res: import('node:http').ServerResponse) {
  const base = resolve(ROOT, root);
  const file = resolve(base, normalize(relPath).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/api/features') {
    const features = readdirSync(join(ROOT, 'features'))
      .filter((f) => f.endsWith('.feature'))
      .map((f) => ({ name: f, content: readFileSync(join(ROOT, 'features', f), 'utf8') }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(features));
    return;
  }

  // Parse Gherkin text into the scenario list shown by the page.
  if (req.method === 'POST' && url.pathname === '/api/scenarios') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { gherkin } = JSON.parse(raw || '{}') as { gherkin?: string };
    res.writeHead(200, { 'content-type': 'application/json' });
    try {
      const scenarios = parseFeatureText(gherkin ?? '').map((sc) => ({
        name: sc.name,
        tags: sc.tags,
        steps: sc.steps.length,
        devices: [...new Set(sc.steps.map((st) => st.agent))],
      }));
      res.end(JSON.stringify({ scenarios }));
    } catch (err) {
      res.end(JSON.stringify({ scenarios: [], error: err instanceof Error ? err.message.split('\n')[0] : String(err) }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/run') {
    if (current) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'A run is already in progress' }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { gherkin, scenarios } = JSON.parse(raw || '{}') as { gherkin?: string; scenarios?: string[] };
    if (!gherkin?.trim()) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gherkin text is empty' }));
      return;
    }

    rmSync(LIVE_DIR, { recursive: true, force: true }); // drop frames from the previous run
    const dir = mkdtempSync(join(tmpdir(), 'qa-run-'));
    const featureFile = join(dir, 'input.feature');
    writeFileSync(featureFile, gherkin);

    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
    // Args are passed as an array (no shell), the feature goes in as a file path.
    const nameArgs = (scenarios ?? []).flatMap((n) => ['--name', n]);
    const child = spawn('npx', ['tsx', 'src/runner.ts', featureFile, ...nameArgs], {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0', LIVE_DIR },
    });
    current = child;
    child.stdout.pipe(res, { end: false });
    child.stderr.pipe(res, { end: false });
    child.on('close', (code) => {
      current = undefined;
      res.end(`\nExit code ${code}\n`);
    });
    // Stop button / closed tab aborts the run.
    res.on('close', () => child.kill('SIGTERM'));
    return;
  }

  if (url.pathname.startsWith('/live/')) {
    res.setHeader('cache-control', 'no-store');
    return serveStatic(LIVE_DIR, url.pathname.slice('/live/'.length), res);
  }
  if (url.pathname.startsWith('/midscene_run/')) return serveStatic('.', url.pathname, res);
  return serveStatic('qa-ui', url.pathname === '/' ? 'index.html' : url.pathname, res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`QA Test Runner: http://localhost:${PORT}`);
});
