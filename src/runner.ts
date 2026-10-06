import 'dotenv/config';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AndroidAgent, agentFromAdbDevice } from '@midscene/android';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { type Browser, type Page, chromium } from 'playwright';
import { ensureEmulator } from './emulator';
import { type Scenario, type Step, parseFeature } from './gherkin';

const PORT = process.env.APP_PORT ?? '8788';
const BASE_URL = process.env.APP_BASE_URL ?? `http://localhost:${PORT}`;
const ASSERT_TIMEOUT_MS = Number(process.env.ASSERT_TIMEOUT_MS ?? 30_000);
const HEADLESS = process.env.HEADLESS === 'true';
// When set, screenshots of both devices are written here ~1/s for the QA page's live view.
const LIVE_DIR = process.env.LIVE_DIR;
// Structured events for the QA page (only when launched from it).
const emit = (event: Record<string, unknown>) => {
  if (LIVE_DIR) console.log(`@@${JSON.stringify(event)}`);
};
// Demo-only pacing so viewers can read each Gherkin line while recording. Off by default; never used in real runs.
const DEMO_PAUSE_MS = Number(process.env.DEMO_STEP_PAUSE_MS ?? 0);
const USE_CACHE = process.env.NO_CACHE !== 'true';

const info = (text: string) => {
  console.log(`  ℹ ${text}`);
  emit({ t: 'info', text });
};

const adb = (...args: string[]) => execFileSync('adb', args, { stdio: 'ignore' });
const adbOut = (...args: string[]) => execFileSync('adb', args, { encoding: 'utf8' });

/** Condition-based wait: polls until `fn` returns a value, never sleeps a fixed time. */
async function waitUntil<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs: number, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const uiDump = () => adbOut('shell', 'uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml');
const chromePushNotifications = () =>
  adbOut('shell', 'cmd', 'notification', 'list')
    .split('\n')
    .filter((l) => l.includes('com.android.chrome|') && l.includes('|p#')).length;

interface StepResult {
  step: string;
  ok: boolean;
  error?: string;
}
interface ScenarioResult {
  scenario: string;
  aiCalls: number;
  ok: boolean;
  steps: StepResult[];
  reports: string[];
}

class ScenarioContext {
  pairingCode?: string;
  private web?: PlaywrightAgent;
  private android?: AndroidAgent;
  private browser?: Browser;
  private page?: Page;
  private liveTimer?: NodeJS.Timeout;
  private capturing = false;

  constructor(
    private readonly browserPromise: () => Promise<Browser>,
    private readonly cacheId: string,
  ) {}

  private cache(kind: 'web' | 'android') {
    return USE_CACHE ? { id: `${kind}-${this.cacheId}` } : (false as const);
  }

  async webAgent(): Promise<PlaywrightAgent> {
    if (!this.web) {
      this.browser = await this.browserPromise();
      const page = await this.browser.newPage({ viewport: { width: 1000, height: 800 } });
      // Midscene injects styles on construction, which fails on a bare about:blank page.
      await page.setContent('<!doctype html><html><head></head><body></body></html>');
      this.page = page;
      this.web = new PlaywrightAgent(page, {
        cache: this.cache('web'),
        onTaskStartTip: (tip) => emit({ t: 'tip', agent: 'web', tip }),
      });
    }
    return this.web;
  }

  async androidAgent(): Promise<AndroidAgent> {
    if (!this.android) {
      await ensureEmulator(info);
      execFileSync('adb', ['reverse', `tcp:${PORT}`, `tcp:${PORT}`]);
      this.android = await agentFromAdbDevice(undefined, {
        cache: this.cache('android'),
        onTaskStartTip: (tip) => emit({ t: 'tip', agent: 'android', tip }),
      });
    }
    return this.android;
  }

  // The code is shown on the phone's page; read it from the UI hierarchy (no AI), AI only as a fallback.
  async readPairingCode(): Promise<string> {
    const android = await this.androidAgent();
    const code = await waitUntil(() => /text="(\d{6})"/.exec(uiDump())?.[1], 15_000, 300);
    if (code) return code;
    return android.aiString('The 6-digit pairing code shown after "Pairing code:" on the page');
  }

  // Stale notifications from earlier runs would let the final assertion pass by accident.
  // Deterministic (no AI): tap "Clear all" found via the UI hierarchy, then verify with the
  // system's own notification list and fail loudly if anything is left.
  async clearNotifications(): Promise<void> {
    await this.androidAgent();
    if (chromePushNotifications() === 0) return;

    adb('shell', 'cmd', 'statusbar', 'expand-notifications');
    try {
      const gone = await waitUntil(
        () => {
          if (chromePushNotifications() === 0) return true;
          const node = /text="Clear all"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(uiDump());
          if (node) {
            const [x1, y1, x2, y2] = node.slice(1).map(Number);
            adb('shell', 'input', 'tap', String((x1 + x2) / 2), String((y1 + y2) / 2));
          } else {
            adb('shell', 'input', 'swipe', '540', '1800', '540', '600', '250'); // scroll to the button
          }
          return false;
        },
        20_000,
        300,
      );
      if (!gone) throw new Error('Could not clear old notifications on the Android device');
    } finally {
      adb('shell', 'cmd', 'statusbar', 'collapse');
    }
  }

  resolve(text: string): string {
    return text
      .replaceAll('{receiverUrl}', `http://localhost:${PORT}/receiver.html`)
      .replaceAll('{consoleUrl}', BASE_URL);
  }

  /**
   * Steps with a deterministic meaning run without the AI (fast, cache-free, no flakiness).
   * Everything else goes to Midscene. Returns true when the step was handled.
   */
  private async builtin(step: Step, text: string): Promise<boolean> {
    if (step.kind !== 'action') return false;

    // "wait until <condition>" -> condition-based wait, never a fixed sleep.
    const wait = /^wait\s+(?:until|for)\s+(.+)$/i.exec(text);
    if (wait) {
      const agent = step.agent === 'web' ? await this.webAgent() : await this.androidAgent();
      await agent.aiWaitFor(wait[1], { timeoutMs: ASSERT_TIMEOUT_MS });
      return true;
    }

    if (step.agent === 'web') {
      const nav = /^(?:open|go to|navigate to)\s+(https?:\/\/\S+)$/i.exec(text);
      if (nav) {
        await this.webAgent();
        await this.page!.goto(nav[1], { waitUntil: 'domcontentloaded' });
        return true;
      }
      if (/pairing code shown on the phone/i.test(text)) {
        const code = await this.readPairingCode();
        await this.webAgent();
        await this.page!.fill('#code', code);
        return true;
      }
      return false;
    }

    // android
    if (/home screen/i.test(text)) {
      await this.androidAgent();
      // Clear first, then go Home, so the step ends on the launcher (not on an open shade).
      await this.clearNotifications();
      // Window focus stays on the launcher even while the shade is drawn over it, so check what is
      // actually on screen: launcher visible and no shade. Retry collapse + Home until that holds.
      const home = await waitUntil(
        () => {
          const ui = uiDump();
          if (/package="[^"]*launcher[^"]*"/i.test(ui) && !/text="(Clear all|Manage)"/.test(ui)) return true;
          adb('shell', 'cmd', 'statusbar', 'collapse');
          adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
          return false;
        },
        15_000,
        300,
      );
      if (!home) throw new Error('The Android Home screen did not come to the front');
      return true;
    }
    const open = /^open\b.*?(https?:\/\/[^\s"',]+)/i.exec(text);
    if (open) {
      await this.androidAgent();
      adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', open[1], '-p', 'com.android.chrome');
      return true;
    }
    return false;
  }

  async run(step: Step): Promise<void> {
    const text = this.resolve(step.text);
    if (await this.builtin(step, text)) return;

    const agent = step.agent === 'web' ? await this.webAgent() : await this.androidAgent();
    if (step.kind === 'action') {
      await agent.aiAct(text);
    } else if (step.agent === 'android') {
      // Push delivery is asynchronous, so wait instead of asserting immediately.
      // The shade must be open for the model to see the notification.
      adb('shell', 'cmd', 'statusbar', 'expand-notifications');
      try {
        await agent.aiWaitFor(text, { timeoutMs: ASSERT_TIMEOUT_MS });
      } finally {
        adb('shell', 'cmd', 'statusbar', 'collapse');
      }
    } else {
      await agent.aiAssert(text);
    }
  }

  aiCalls(): number {
    return [this.web, this.android].reduce((n, a) => n + (a?.metrics.calls ?? 0), 0);
  }

  reports(): string[] {
    return [this.web?.reportFile, this.android?.reportFile].filter((f): f is string => !!f);
  }

  startLive(): void {
    if (!LIVE_DIR) return;
    mkdirSync(LIVE_DIR, { recursive: true });
    const write = (name: string, data: Buffer) => {
      const tmp = join(LIVE_DIR, `${name}.tmp`);
      writeFileSync(tmp, data);
      renameSync(tmp, join(LIVE_DIR, name)); // atomic, the page never reads a half-written file
    };
    this.liveTimer = setInterval(async () => {
      if (this.capturing) return;
      this.capturing = true;
      try {
        if (this.page && !this.page.isClosed()) {
          write('web.jpg', await this.page.screenshot({ type: 'jpeg', quality: 60 }));
        }
        if (this.android) {
          const png = await new Promise<Buffer>((resolve, reject) =>
            execFile('adb', ['exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 16e6 }, (e, out) =>
              e ? reject(e) : resolve(out),
            ),
          );
          write('android.png', png);
        }
      } catch {
        // a missed frame is fine
      } finally {
        this.capturing = false;
      }
    }, 800);
  }

  stopLive(): void {
    if (this.liveTimer) clearInterval(this.liveTimer);
  }

  async close(): Promise<void> {
    this.stopLive();
    await this.web?.destroy();
    await this.android?.destroy();
  }
}

// Same steps => same cache id => AI planning is replayed from cache.
// Editing the scenario changes the id, so it is planned by AI again.
function cacheId(scenario: Scenario): string {
  const hash = createHash('sha1')
    .update(JSON.stringify(scenario.steps))
    .digest('hex')
    .slice(0, 8);
  const slug = scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug}-${hash}`;
}

async function runScenario(scenario: Scenario, ctx: ScenarioContext): Promise<ScenarioResult> {
  const steps: StepResult[] = [];
  let ok = true;
  ctx.startLive();
  emit({ t: 'scenario', name: scenario.name, total: scenario.steps.length });
  for (const [idx, step] of scenario.steps.entries()) {
    const label = `${step.keyword} [${step.agent}] ${step.text}`;
    console.log(`  ▶ ${label}`);
    emit({ t: 'step', phase: 'start', idx, agent: step.agent, label });
    try {
      await ctx.run(step);
      steps.push({ step: label, ok: true });
      emit({ t: 'step', phase: 'ok', idx });
      if (DEMO_PAUSE_MS) await new Promise((r) => setTimeout(r, DEMO_PAUSE_MS));
      console.log(`  ✓ ${label}`);
    } catch (err) {
      ok = false;
      const error = err instanceof Error ? err.message : String(err);
      steps.push({ step: label, ok: false, error });
      emit({ t: 'step', phase: 'fail', idx, error });
      console.log(`  ✗ ${label}\n    ${error}`);
      break; // later steps depend on earlier ones
    }
  }
  emit({ t: 'scenarioEnd', name: scenario.name, ok });
  return { scenario: scenario.name, aiCalls: ctx.aiCalls(), ok, steps, reports: ctx.reports() };
}

async function main() {
  const args = process.argv.slice(2);
  const tagIdx = args.indexOf('--tag');
  const tag = tagIdx >= 0 ? args[tagIdx + 1] : undefined;
  const names = args.flatMap((a, i) => (a === '--name' ? [args[i + 1]] : []));
  const files = args.filter((a, i) => a.endsWith('.feature') && args[i - 1] !== '--tag' && args[i - 1] !== '--name');

  const featureFiles = files.length
    ? files
    : readdirSync('features')
        .filter((f) => f.endsWith('.feature'))
        .map((f) => join('features', f));

  const scenarios = featureFiles
    .flatMap(parseFeature)
    .filter((s) => !tag || s.tags.includes(tag))
    .filter((s) => !names.length || names.includes(s.name));
  if (!scenarios.length) {
    console.log('No scenarios matched');
    return;
  }

  let browser: Browser | undefined;
  const getBrowser = async () => (browser ??= await chromium.launch({ headless: HEADLESS }));

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    console.log(`\nScenario: ${scenario.name}`);
    const ctx = new ScenarioContext(getBrowser, cacheId(scenario));
    try {
      results.push(await runScenario(scenario, ctx));
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
  await browser?.close();

  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/summary.json', JSON.stringify(results, null, 2));

  const passed = results.filter((r) => r.ok).length;
  emit({ t: 'summary', passed, total: results.length });
  console.log(`\n${passed}/${results.length} scenarios passed. Summary: reports/summary.json`);
  for (const r of results) console.log(`  AI calls: ${r.aiCalls} (${r.scenario})`);
  for (const r of results) for (const f of r.reports) console.log(`  report: ${f}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
