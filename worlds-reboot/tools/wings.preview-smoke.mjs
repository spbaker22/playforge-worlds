import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argument = name => process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || null;
const rawBase = argument('base') || process.argv[2];
if(!rawBase || !/^https?:\/\//.test(rawBase)){
  throw new Error('Usage: node tools/wings.preview-smoke.mjs --base=http://host:port/preview-dist/<id>/ [--screenshots=/absolute/path]');
}
const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
const screenshots = argument('screenshots');
if(screenshots) mkdirSync(screenshots, { recursive: true });
const chrome = argument('chrome') || process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(existsSync);
if(!chrome) throw new Error('Chrome was not found; pass --chrome=/absolute/path/to/Chrome');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const errors = [];
let browser;

async function tap(page, selector){
  const point = await page.$eval(selector, element => {
    const rect = element.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  });
  await page.touchscreen.tap(point[0], point[1]);
}

async function swipe(page, start, end, pointerId){
  const client = await page.createCDPSession();
  const touch = ([x, y]) => ({ x, y, radiusX: 8, radiusY: 8, force: 0.65, id: pointerId });
  try {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(start)] });
    for(let step = 1; step <= 4; step += 1){
      const progress = step / 4;
      const point = [start[0] + (end[0] - start[0]) * progress, start[1] + (end[1] - start[1]) * progress];
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(point)] });
      await sleep(24);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.detach().catch(() => {});
  }
}

async function shot(page, name){
  if(screenshots) await page.screenshot({ path: path.join(screenshots, `${name}.png`) });
}

try {
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: chrome,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if(response.status() >= 400 && pathname !== '/favicon.ico') errors.push(`http ${response.status()}: ${response.url()}`);
  });
  page.on('console', message => {
    const text = message.text();
    if(message.type() === 'error' && !text.startsWith('Failed to load resource:')) errors.push(`console: ${text}`);
  });

  await page.goto(base, { waitUntil: 'networkidle0', timeout: 90_000 });
  await page.waitForFunction(() => window.__previewLauncher, { timeout: 30_000 });
  const hub = await page.evaluate(() => {
    __previewLauncher.set('wings.route', 'quick');
    __previewLauncher.set('wings.control', 'direct');
    __previewLauncher.set('wings.race', 'rivals');
    __previewLauncher.set('quality', 'performance');
    __previewLauncher.set('sound', 'off');
    const links = ['playGolf', 'playRunner', 'playAshfall', 'playWings', 'playTide'].map(id => document.getElementById(id));
    const wings = document.getElementById('playWings');
    const rect = wings.getBoundingClientRect();
    return {
      count: links.filter(Boolean).length,
      wingsHref: wings.href,
      wingsTarget: { width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  assert.equal(hub.count, 5, 'Hub must retain all five games');
  assert.ok(hub.wingsTarget.width >= 44 && hub.wingsTarget.height >= 44, 'Paper Wings hub target must be touch sized');
  await shot(page, 'hub');

  const wingsUrl = new URL(hub.wingsHref);
  wingsUrl.searchParams.set('hub', 'javascript:alert(1)');
  await page.goto(wingsUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.__gp?.mode === 'title', { timeout: 60_000 });
  const boot = await page.evaluate(() => ({
    mode: __gp.mode,
    options: __gp.options,
    route: __gp.route,
    screens: __gp.activeScreens,
    sharedChrome: document.querySelectorAll('#previewChrome').length,
    legacy: ['previewMenu', 'previewSheet', 'previewReset', 'previewSound', 'previewQuality', 'previewToggle']
      .filter(id => document.getElementById(id)),
    back: document.getElementById('pcBack')?.href,
  }));
  assert.equal(boot.mode, 'title');
  assert.equal(boot.options.route, 'quick');
  assert.equal(boot.options.control, 'direct');
  assert.equal(boot.options.race, 'rivals');
  assert.equal(boot.route.gates, 6);
  assert.deepEqual(boot.screens, ['title']);
  assert.equal(boot.sharedChrome, 1, 'Exactly one shared preview chrome must mount');
  assert.deepEqual(boot.legacy, [], 'No obsolete Paper Wings preview chrome may survive the build');
  const expectedBack = new URL('../index.html', wingsUrl);
  expectedBack.search = '';
  expectedBack.hash = '';
  assert.equal(boot.back, expectedBack.href, 'Shared Back action must stay inside the immutable preview');
  await shot(page, 'wings-title');

  await tap(page, '#beginButton');
  await page.waitForFunction(() => __gp.mode === 'briefing', { timeout: 5_000 });
  await tap(page, '#flightButton');
  await page.waitForFunction(() => __gp.mode === 'flight', { timeout: 8_000 });
  await swipe(page, [500, 420], [620, 320], 401);
  await sleep(80);
  const touch = await page.evaluate(() => ({ mode: __gp.mode, gesture: __gp.gesture }));
  assert.equal(touch.mode, 'flight');
  assert.ok(touch.gesture.sequence >= 1 && touch.gesture.samples >= 5, 'Genuine iPad touch samples must reach the action controller');
  assert.ok(touch.gesture.bank > 0 && touch.gesture.pitch > 0, 'Diagonal touch must produce bank and pitch together');
  assert.equal(touch.gesture.lastEndReason, 'pointerup');
  await shot(page, 'wings-touch');

  await tap(page, '#pcMenu');
  await page.waitForFunction(() => !document.getElementById('pcSheet')?.hidden, { timeout: 5_000 });
  const menu = await page.evaluate(() => {
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const sheet = box(document.getElementById('pcSheet'));
    const trigger = box(document.getElementById('pcMenu'));
    const actions = [...document.querySelectorAll('#pcSheet a,#pcSheet button')].map(box);
    const hudOverlaps = ['.hud-top', '.hud-bottom', '#flightStatus'].filter(selector => {
      const element = document.querySelector(selector);
      return element && (overlaps(sheet, box(element)) || overlaps(trigger, box(element)));
    });
    return { sheet, trigger, actions, hudOverlaps, viewport: { width: innerWidth, height: innerHeight } };
  });
  assert.ok(menu.trigger.width >= 44 && menu.trigger.height >= 44, 'Shared menu trigger must be at least 44x44');
  assert.ok(menu.actions.every(action => action.width >= 44 && action.height >= 44), 'Shared menu actions must be at least 44x44');
  assert.ok(menu.sheet.left >= 0 && menu.sheet.top >= 0 && menu.sheet.right <= menu.viewport.width && menu.sheet.bottom <= menu.viewport.height, 'Shared menu must stay inside the iPad viewport');
  assert.deepEqual(menu.hudOverlaps, [], 'Shared menu must not overlap Paper Wings HUD safe zones');
  await shot(page, 'wings-menu');

  const autoUrl = new URL(hub.wingsHref);
  autoUrl.searchParams.set('auto', '1');
  autoUrl.searchParams.set('fast', '1');
  await page.goto(autoUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.__gp?.mode === 'results', { timeout: 45_000 });
  const results = await page.evaluate(() => ({ mode: __gp.mode, state: __gp.state, screens: __gp.activeScreens, sequence: __gp.transitionSequence }));
  assert.equal(results.state.status, 'finished');
  assert.equal(results.state.gatesPassed, 6);
  assert.deepEqual(results.screens, ['results']);
  await shot(page, 'wings-results');
  await tap(page, '#replayButton');
  await page.waitForFunction(() => __gp.mode === 'flight', { timeout: 5_000 });
  const replay = await page.evaluate(() => ({ state: __gp.state, screens: __gp.activeScreens, sequence: __gp.transitionSequence }));
  assert.equal(replay.state.gatesPassed, 0);
  assert.equal(replay.state.misses, 0);
  assert.deepEqual(replay.screens, []);
  assert.ok(replay.sequence > results.sequence);
  assert.deepEqual(errors, [], `Browser errors: ${errors.join(' | ')}`);

  process.stdout.write(`${JSON.stringify({ hub, boot, touch, menu, results, replay, errors }, null, 2)}\n`);
  process.stdout.write('WINGS_PREVIEW_SMOKE_OK\n');
} finally {
  if(browser) await browser.close();
}
