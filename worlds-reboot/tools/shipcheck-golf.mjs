/* Golf ship gate: the HUMAN input path — tap to start, drag-release to putt. */
import puppeteer from 'puppeteer';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto('http://127.0.0.1:8091/?lowfx=1&fast=1', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__gp !== undefined, { timeout: 300000, polling: 500 });

/* tap anywhere -> intro skipped (fast) -> aim */
await page.mouse.click(590, 400);
await page.waitForFunction(() => __gp.mode === 'aim', { timeout: 120000, polling: 400 });
console.log('reached aim via tap');

/* drag back + release = putt */
await sleep(600);
await page.mouse.move(700, 320);
await page.mouse.down();
await page.mouse.move(640, 580, { steps: 8 });
await sleep(400);
const pow = await page.evaluate(() => __gp.power);
console.log('drag power:', pow.toFixed(2));
if(pow < 0.3){ console.log('FAIL: power did not build on drag'); process.exit(1); }
await page.mouse.up();
await page.waitForFunction(() => __gp.mode === 'roll' || __gp.mode === 'sunk', { timeout: 30000, polling: 200 });
const s1 = await page.evaluate(() => __gp.strokes);
console.log('stroke registered, strokes:', s1);
if(s1 !== 1){ console.log('FAIL: stroke count'); process.exit(1); }
await page.waitForFunction(() => __gp.ballV > 1 || __gp.mode !== 'roll', { timeout: 30000, polling: 150 });
console.log('ball rolling');

/* full round on autopilot to results */
await page.evaluate(() => { __gp.setAuto(true); __gp.setWarp(10); });
await page.waitForFunction(() => __gp.mode === 'results', { timeout: 480000, polling: 500 });
const fin = await page.evaluate(() => `total:${__gp.total} pos:${__gp.pos}`);
console.log('round complete ·', fin, '· pageerrors:', errs.length, errs.slice(0, 3));
await browser.close();
process.exit(errs.length ? 1 : 0);
