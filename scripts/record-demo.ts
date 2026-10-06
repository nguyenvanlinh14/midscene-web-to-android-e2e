// Records the QA Test Runner page while it drives web + Android, one narration step at a time.
// Needs: `npm run dev` (console), `npm run qa` (HEADLESS=true recommended) and narration.json with audio durations.
import * as fs from 'node:fs';
import { type Locator, chromium } from 'playwright';

const QA_URL = process.env.QA_URL ?? 'http://localhost:3000';
const D = 'video';
const size = { width: 1400, height: 900 };

const steps: { id: string; dur: number }[] = JSON.parse(fs.readFileSync(`${D}/narration.json`, 'utf8'));
const durOf = (id: string) => steps.find((s) => s.id === id)!.dur;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: size,
  locale: 'en-US',
  recordVideo: { dir: `${D}/tmp`, size },
});
const page = await ctx.newPage();
const t0 = Date.now();
const marks: { id: string; at: number; dur: number }[] = [];

const mark = (id: string) => {
  marks.push({ id, at: (Date.now() - t0) / 1000, dur: durOf(id) });
  return Date.now();
};
// Hold until the step's voice clip (+0.7 s) has finished, so the video never runs ahead of the voice.
const hold = async (id: string, since: number) => {
  const left = durOf(id) * 1000 + 700 - (Date.now() - since);
  if (left > 0) await page.waitForTimeout(left);
};
const ring = (l: Locator) =>
  l
    .evaluate((e) => {
      (e as HTMLElement).style.outline = '3px solid #ff3b30';
      (e as HTMLElement).style.outlineOffset = '3px';
    })
    .catch(() => {});

await page.goto(QA_URL);
await page.waitForSelector('#gherkin');

// Pick only the first test case, so the list is shown and one scenario runs.
// The list loads asynchronously; select only after it is there, or it re-selects everything.
await page.locator('.tc', { hasText: 'Basic notification' }).waitFor();
await page.locator('#tcAll').uncheck();
await page.locator('.tc', { hasText: 'Basic notification' }).click();
await page.locator('#run', { hasText: 'Run selected (1)' }).waitFor({ timeout: 5_000 });

let s = mark('intro');
await ring(page.locator('#tcList'));
await hold('intro', s);

s = mark('run');
await ring(page.locator('#run'));
await page.waitForTimeout(600);
await page.locator('#run').click();
await hold('run', s);

// Each Gherkin step shows up as one .step card; narrate when the matching step has started.
const reached = (n: number) =>
  page.waitForFunction((k) => document.querySelectorAll('.step').length >= k, n, { timeout: 240_000 });

for (const [id, n] of [
  ['web', 1],
  ['home', 2],
  ['open', 3],
  ['wait', 4],
  ['subscribe', 5],
  ['send', 7],
  ['result', 10],
] as const) {
  await reached(n);
  s = mark(id);
  await hold(id, s);
}

await page.waitForFunction(() => /passed/.test(document.getElementById('summary')?.textContent ?? ''), null, {
  timeout: 240_000,
});
await page.locator('#tabCases').click(); // back to the list: the case is now green
s = mark('closing');
await ring(page.locator('#tcList'));
await hold('closing', s);
await page.waitForTimeout(1500);

const raw = await page.video()!.path();
await ctx.close();
await browser.close();
fs.renameSync(raw, `${D}/part1.webm`);
fs.writeFileSync(
  `${D}/timeline.json`,
  JSON.stringify({ video: `${process.cwd()}/${D}/part1.webm`, timeline: marks }, null, 1),
);
console.log('marks', marks.map((m) => `${m.id}@${m.at.toFixed(1)}s`).join('  '));
