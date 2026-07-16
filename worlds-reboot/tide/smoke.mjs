import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { resolveChromeExecutable } from '../tools/chrome-path.mjs';

const BASE = process.argv.find(value => value.startsWith('--url='))?.slice(6)
  || 'http://127.0.0.1:8091/tide/dist/index.html?preview=1&sound=off&quality=performance&tideSession=quick&tideTension=relaxed&tideScoring=haul';
const shots = path.resolve('tide/smoke-shots');
mkdirSync(shots, { recursive: true });
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: resolveChromeExecutable(),
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const errors = [];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function tap(page, selector){
  const point = await page.$eval(selector, element => {
    const rect = element.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  });
  await page.touchscreen.tap(point[0], point[1]);
}

async function dispatch(client, type, x = 512, y = 500, id = 1){
  const touchPoints = type === 'touchEnd' ? [] : [{ x, y, radiusX: 8, radiusY: 8, force: 0.62, id }];
  await client.send('Input.dispatchTouchEvent', { type, touchPoints });
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if(message.type() === 'error') errors.push(message.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForFunction(() => window.__gp?.flow === 'title', { timeout: 30_000 });
  const boot = await page.evaluate(() => ({
    game: __gp.game,
    options: __gp.options,
    screens: __gp.screens,
    descriptor: {
      getType: typeof Object.getOwnPropertyDescriptor(window, '__gp').get,
      setType: typeof Object.getOwnPropertyDescriptor(window, '__gp').set,
    },
  }));
  assert.equal(boot.game, 'low-tide');
  assert.equal(boot.options.session, 'quick');
  assert.equal(boot.options.tension, 'relaxed');
  assert.equal(boot.options.scoring, 'haul');
  assert.equal(boot.screens.ok, true);
  assert.equal(boot.descriptor.getType, 'function');
  assert.equal(boot.descriptor.setType, 'undefined');
  await page.screenshot({ path: path.join(shots, '01-title.png') });

  await tap(page, '#enterBtn');
  await page.waitForFunction(() => __gp.flow === 'instructions');
  await sleep(1_000);
  await page.screenshot({ path: path.join(shots, '02-instructions.png') });
  await tap(page, '#launchBtn');
  await page.waitForFunction(() => __gp.flow === 'play' && __gp.state.phase === 'aim', { timeout: 8_000 });

  const client = await page.createCDPSession();
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await dispatch(client, 'touchStart', 510, 340, 11);
  for(let step = 1; step <= 6; step += 1){
    await dispatch(client, 'touchMove', 510 + step * 8, 340 + step * 50, 11);
    await sleep(28);
  }
  await dispatch(client, 'touchEnd');
  await page.waitForFunction(() => __gp.state.phase === 'casting' || __gp.state.phase === 'waiting', { timeout: 3_000 });
  await sleep(420);
  await page.screenshot({ path: path.join(shots, '03-cast.png') });
  await page.waitForFunction(() => __gp.state.phase === 'waiting', { timeout: 4_000 });
  await page.screenshot({ path: path.join(shots, '04-waiting.png') });
  await page.waitForFunction(() => __gp.state.phase === 'bite', { timeout: 8_000 });
  await page.screenshot({ path: path.join(shots, '05-bite.png') });
  await page.touchscreen.tap(512, 500);
  await page.waitForFunction(() => __gp.state.phase === 'reeling', { timeout: 2_000 });

  let holding = false;
  for(let cycle = 0; cycle < 320; cycle += 1){
    const state = await page.evaluate(() => ({ flow: __gp.flow, phase: __gp.state.phase, tension: __gp.state.tension }));
    if(state.flow === 'outcome' || state.phase !== 'reeling') break;
    if(!holding && state.tension < 0.57){ await dispatch(client, 'touchStart', 512, 510, 20 + cycle); holding = true; }
    if(holding && state.tension > 0.72){ await dispatch(client, 'touchEnd'); holding = false; }
    await sleep(50);
  }
  if(holding) await dispatch(client, 'touchEnd');
  await page.waitForFunction(() => __gp.flow === 'outcome', { timeout: 5_000 });
  const outcome = await page.evaluate(() => ({ state: __gp.state, screens: __gp.screens }));
  assert.ok(['catch', 'snap'].includes(outcome.state.phase));
  assert.equal(outcome.screens.ok, true);
  await sleep(1_000);
  await page.screenshot({ path: path.join(shots, '06-outcome.png') });
  await tap(page, '#nextBtn');
  await page.waitForFunction(() => __gp.flow === 'play' || __gp.flow === 'results', { timeout: 3_000 });
  const final = await page.evaluate(() => ({ flow: __gp.flow, phase: __gp.state.phase, input: __gp.input, screens: __gp.screens }));
  assert.equal(final.screens.ok, true);
  assert.equal(final.input.active, false);
  assert.ok(final.flow === 'results' || final.phase === 'aim');
  if(final.flow !== 'results') await page.waitForFunction(() => __gp.flow === 'results', { timeout: 40_000 });
  await sleep(1_000);
  await page.screenshot({ path: path.join(shots, '07-results.png') });
  await tap(page, '#replayBtn');
  await page.waitForFunction(() => __gp.flow === 'countdown', { timeout: 3_000 });
  const replay = await page.evaluate(() => ({ flow: __gp.flow, state: __gp.state, screens: __gp.screens }));
  assert.equal(replay.flow, 'countdown');
  assert.equal(replay.state.phase, 'aim');
  assert.equal(replay.state.time, 0);
  assert.equal(replay.screens.ok, true);
  assert.deepEqual(errors, []);
  await client.detach();
  console.log(JSON.stringify({ ok: true, boot: boot.options, outcome: outcome.state.lastOutcome, final, replay, screenshots: shots }, null, 2));
} finally {
  await browser.close();
}
