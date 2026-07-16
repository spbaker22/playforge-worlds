/* Focused source-only courier/framing evidence. Run against a separately
   started Runner Vite server; this script never builds dist/standalone. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const arg = name => process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || null;
const rawBase = arg('base') || 'http://127.0.0.1:4179/runner/';
const BASE = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
const EVIDENCE = arg('evidence');
if(!EVIDENCE || !path.isAbsolute(EVIDENCE)) throw new Error('Pass --evidence=/absolute/path');
mkdirSync(EVIDENCE, { recursive: true });
const CHROME = arg('chrome') || process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(existsSync);
if(!CHROME) throw new Error('Chrome was not found; pass --chrome=/absolute/path/to/Chrome');

const scenarios = [
  { id: 'desktop-1440x900', width: 1440, height: 900, deviceScaleFactor: 1 },
  { id: 'ipad-landscape-1024x768', width: 1024, height: 768, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];

function sourceUrl(){
  const url = new URL(BASE);
  url.searchParams.set('preview', '1');
  url.searchParams.set('runnerFormat', 'full-training');
  url.searchParams.set('runnerPace', 'standard');
  url.searchParams.set('runnerSafety', '3');
  url.searchParams.set('runnerSwipe', 'easy');
  url.searchParams.set('quality', 'auto');
  url.searchParams.set('sound', 'off');
  url.searchParams.set('fast', '1');
  return url.href;
}

let browser;
const errors = [];
try {
  browser = await puppeteer.launch({
    headless: 'new', executablePath: CHROME,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const outcomes = [];
  for(const scenario of scenarios){
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(`${scenario.id}: ${error.message}`));
    await page.setViewport(scenario);
    await page.goto(sourceUrl(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => window.__gp?.mode === 'title', { timeout: 30_000 });
    await page.click('#tapGo');
    await page.waitForFunction(() => __gp.mode === 'tutorial', { timeout: 10_000 });
    await page.waitForFunction(() => __gp.courseS >= 14, { timeout: 8_000 });
    await page.evaluate(() => __gp.slowmo(0));
    await new Promise(resolve => setTimeout(resolve, 350));

    const audit = await page.evaluate(() => ({
      s: __gp.courseS,
      mode: __gp.mode,
      locomotion: __gp.locomotion,
      visual: __gp.visual,
      parity: __gp.rivalParity,
      cue: __gp.cue,
    }));
    const framing = audit.visual.camera.framing;
    const player = framing.rows.find(row => row.id === 'player');
    assert.equal(audit.mode, 'tutorial');
    assert.ok(audit.s >= 14 && audit.s < 18);
    assert.equal(audit.parity.ok, true);
    assert.equal(framing.allFourInFrame, true);
    assert.equal(framing.allFourFullyInFrame, true);
    assert.deepEqual(framing.rightClippedIds, []);
    assert.ok(player.bounds.maxY - player.bounds.minY >= 0.32, `${scenario.id} hero must remain legible in gameplay`);
    assert.ok(audit.visual.couriers.every(courier => courier.readableFace));
    assert.ok(audit.visual.couriers.every(courier => courier.athleticSilhouette));
    assert.ok(audit.visual.couriers.every(courier => courier.compactCourierPack));
    assert.equal(audit.visual.slideClearance.clears, true);
    assert.equal(audit.visual.actionPoses.neverBelowDeck, true);
    assert.match(audit.cue.text, /FOLLOW THE GLOWING ROUTE/);

    const screenshot = path.join(EVIDENCE, `${scenario.id}.png`);
    await page.screenshot({ path: screenshot });
    outcomes.push({ scenario, screenshot, audit });
    await page.close();
  }
  assert.deepEqual(errors, []);
  process.stdout.write(`${JSON.stringify({ ok: true, source: BASE, outcomes }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => {});
}
