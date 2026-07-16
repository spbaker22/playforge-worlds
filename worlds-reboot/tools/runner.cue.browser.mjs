/* Focused source-browser gameplay probe. Start Vite separately, then run:
   node tools/runner.cue.browser.mjs --base=http://127.0.0.1:4179/runner/ */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const arg = name => process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || null;
const rawBase = arg('base') || 'http://127.0.0.1:4179/runner/';
const BASE = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
const CHROME = arg('chrome') || process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(existsSync);
if(!CHROME) throw new Error('Chrome was not found; pass --chrome=/absolute/path/to/Chrome');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const vectors = Object.freeze({
  jump: [[510, 570], [510, 450]],
  slide: [[510, 450], [510, 570]],
  left: [[590, 510], [455, 510]],
  right: [[430, 510], [565, 510]],
});

async function swipe(page, direction, pointerId){
  const [start, end] = vectors[direction];
  const client = await page.createCDPSession();
  const touch = ([x, y]) => ({ x, y, radiusX: 8, radiusY: 8, force: 0.65, id: pointerId });
  try {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(start)] });
    for(let step = 1; step <= 4; step += 1){
      const mix = step / 4;
      const point = [start[0] + (end[0] - start[0]) * mix, start[1] + (end[1] - start[1]) * mix];
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(point)] });
      await sleep(12);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.detach().catch(() => {});
  }
}

function scenarioUrl(format, pace){
  const url = new URL(BASE);
  url.searchParams.set('preview', '1');
  url.searchParams.set('runnerFormat', format);
  url.searchParams.set('runnerPace', pace);
  url.searchParams.set('runnerSafety', '3');
  url.searchParams.set('runnerSwipe', 'easy');
  url.searchParams.set('sound', 'off');
  url.searchParams.set('quality', 'performance');
  url.searchParams.set('fast', '1');
  return url.href;
}

async function start(page, format, pace){
  await page.goto(scenarioUrl(format, pace), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__gp?.mode === 'title', { timeout: 30_000 });
  await page.click('#tapGo');
  await page.waitForFunction(() => __gp.mode === 'tutorial' || __gp.mode === 'race', { timeout: 10_000 });
}

const directionFor = requirement => requirement === 'jump' ? 'jump'
  : requirement === 'slide' ? 'slide'
    : requirement === 'left' ? 'left'
      : requirement === 'right' ? 'right'
        : requirement === 'either-lane' ? 'left' : null;

async function runCueFollower(page, format, pace, pointerSeed){
  await start(page, format, pace);
  const initial = await page.evaluate(() => ({
    s: __gp.courseS,
    lane: __gp.laneTarget,
    cue: __gp.cue,
    initialState: __gp.previewRuntime.initialState,
  }));
  if(format === 'final-relay'){
    assert.equal(initial.lane, -1);
    assert.equal(initial.initialState.lane, -1);
    assert.match(initial.cue.text, /SWIPE RIGHT TO CENTER/);
  }

  let opening = null;
  if(format === 'full-training' && pace === 'standard'){
    assert.equal(initial.cue.stage, 'orientation');
    assert.doesNotMatch(initial.cue.text, /SWIPE|NOW/);
    await swipe(page, 'jump', pointerSeed++);
    await page.waitForFunction(() => __gp.cueInput.lastRoute?.reason === 'no-active-cue', { timeout: 3_000 });
    opening = await page.evaluate(() => ({
      route: __gp.cueInput.lastRoute,
      locomotion: __gp.locomotion,
      jumps: __gp.simulation.jumpsUsed,
      y: __gp.yRel,
    }));
    assert.equal(opening.route.kind, 'ignored');
    assert.equal(opening.jumps, 0);
    assert.equal(opening.y, 0);
    assert.equal(opening.locomotion, 'run');
  }

  const followed = [];
  const cueStages = [];
  const seen = new Set();
  const observedCues = new Map();
  const deadline = Date.now() + 35_000;
  while(Date.now() < deadline){
    const state = await page.evaluate(() => ({ mode: __gp.mode, cue: __gp.cue }));
    if(state.mode === 'results') break;
    const cue = state.cue;
    if(cue?.hazardStart >= 0 && !observedCues.has(cue.id)){
      observedCues.set(cue.id, { id: cue.id, stage: cue.stage, visible: cue.visible, opacity: cue.opacity, text: cue.text, s: cue.currentS });
    }
    if(cue?.visible && cue.id && cue.requirement && cue.hazardStart >= 0 && !seen.has(cue.id)){
      const direction = directionFor(cue.requirement);
      assert.ok(direction, `unsupported visible cue requirement: ${cue.requirement}`);
      seen.add(cue.id);
      followed.push(cue.id);
      cueStages.push({ id: cue.id, stage: cue.stage, text: cue.text });
      await swipe(page, direction, pointerSeed++);
      await page.waitForFunction(id => __gp.cueInput.lastRoute?.hazardId === id, { timeout: 3_000 }, cue.id);
      const routed = await page.evaluate(() => __gp.cueInput.lastRoute);
      assert.ok(routed.kind === 'armed' || routed.kind === 'fire');
    } else {
      await sleep(12);
    }
  }
  await page.waitForFunction(() => __gp.mode === 'results', { timeout: 5_000 });
  const outcome = await page.evaluate(() => ({
    mode: __gp.mode,
    courseS: __gp.courseS,
    crashes: __gp.crashCount,
    damage: __gp.damageCount,
    recoveries: __gp.recoveryCount,
    shields: __gp.shields,
    finishCount: __gp.finishCount,
    cueInput: __gp.cueInput,
    trace: __gp.trace.filter(entry => entry.type === 'cue-input-fired'),
    readyTrace: __gp.trace.filter(entry => entry.type === 'cue-ready-presented'),
  }));
  const expected = format === 'final-relay'
    ? ['combined-lane-gate', 'final-gap-01']
    : ['tutorial-gap-01', 'lane-blocker-01', 'slide-gate-01', 'combined-lane-gate', 'final-gap-01'];
  if(JSON.stringify(followed) !== JSON.stringify(expected)){
    throw new Error(`cue sequence ${JSON.stringify(followed)}; observations ${JSON.stringify([...observedCues.values()])}; outcome ${JSON.stringify(outcome)}`);
  }
  assert.ok(cueStages.every(cue => cue.stage === 'anticipation' || cue.stage === 'ready'));
  assert.ok(cueStages.every(cue => /^(WAIT|NOW) ·/.test(cue.text)));
  assert.equal(outcome.mode, 'results');
  assert.equal(outcome.courseS, 150);
  assert.equal(outcome.crashes, 0);
  assert.equal(outcome.damage, 0);
  assert.equal(outcome.recoveries, 0);
  assert.equal(outcome.shields, 3);
  assert.equal(outcome.finishCount, 1);
  assert.equal(outcome.cueInput.firedCount, expected.length);
  assert.ok(outcome.cueInput.armedCount > 0);
  assert.equal(outcome.cueInput.presentedCount, outcome.cueInput.armedCount);
  assert.equal(outcome.trace.length, expected.length);
  assert.equal(outcome.readyTrace.length, expected.length);
  return { format, pace, initial, opening, followed, cueStages, outcome };
}

async function runIntentionalRecovery(page){
  await start(page, 'final-relay', 'standard');
  await page.waitForFunction(() => __gp.crashCount === 1, { timeout: 8_000 });
  await page.waitForFunction(() => __gp.recoveryCount === 1 && __gp.mode === 'race', { timeout: 8_000 });
  const outcome = await page.evaluate(() => ({
    mode: __gp.mode,
    s: __gp.courseS,
    lane: __gp.laneTarget,
    crashes: __gp.crashCount,
    damage: __gp.damageCount,
    recoveries: __gp.recoveryCount,
    shields: __gp.shields,
    lastRecoveryReason: __gp.lastRecoveryReason,
    cueInput: __gp.cueInput,
  }));
  assert.equal(outcome.mode, 'race');
  assert.equal(outcome.crashes, 1);
  assert.equal(outcome.damage, 1);
  assert.equal(outcome.recoveries, 1);
  assert.equal(outcome.shields, 2);
  assert.equal(outcome.lastRecoveryReason, 'combined-lane-gate');
  assert.equal(outcome.lane, 0);
  assert.ok(outcome.s >= 121.5 && outcome.s < 127);
  assert.equal(outcome.cueInput.armed, null);
  assert.match(outcome.cueInput.lastClearReason, /mode:race|mode:recover|mode:crash/);
  return outcome;
}

let browser;
const pageErrors = [];
try {
  browser = await puppeteer.launch({
    headless: 'new', executablePath: CHROME,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', error => pageErrors.push(error.message));
  const outcomes = [];
  let pointerSeed = 100;
  for(const format of ['full-training', 'final-relay']){
    for(const pace of ['standard', 'calm']){
      outcomes.push(await runCueFollower(page, format, pace, pointerSeed));
      pointerSeed += 20;
    }
  }
  const recovery = await runIntentionalRecovery(page);
  assert.deepEqual(pageErrors, []);
  process.stdout.write(`${JSON.stringify({ ok: true, source: BASE, outcomes, recovery }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => {});
}
