/* Runner screenshot harness — ONE page boot, states driven via __gp hooks. */
import puppeteer from 'puppeteer';
import fs from 'fs';
const BASE = 'http://127.0.0.1:8092/';
const OUT = '/tmp/runner/';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '?lowfx=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.__gp !== undefined, { timeout: 300000, polling: 500 });
console.log('booted');
async function snap(name){
  await sleep(1100);
  await page.screenshot({ path: OUT + name + '.png' });
  const s = await page.evaluate(() => `${__gp.mode} d:${__gp.dist} spd:${__gp.spd.toFixed(1)} pos:${__gp.pos} st:${__gp.state}`);
  console.log(name, '·', s);
}
async function until(cond, timeout = 480000){
  await page.waitForFunction(cond, { timeout, polling: 300 });
}
await until(() => __gp.mode === 'title');
await snap('1-title');
await page.evaluate(() => { __gp.setFreeze(1.5); __gp.start(); });
await until(() => __gp.mode === 'intro'); await snap('2-intro-drone');
await page.evaluate(() => __gp.setFreeze(3.8)); await snap('3-intro-low');
await page.evaluate(() => { __gp.setFreeze(null); __gp.setAuto(true); });
await until(() => __gp.mode === 'race');
await page.evaluate(() => __gp.setWarp(5));
await until(() => __gp.mode === 'race' && __gp.spd > 15, 480000);
await page.evaluate(() => __gp.setWarp(1));
await sleep(400);
await snap('4-race-speed');
/* deterministic double-jump for the air shot: freeze at apex */
await page.evaluate(() => { __gp.jump(); });
await sleep(260);
await page.evaluate(() => { __gp.jump(); });
await page.waitForFunction(() => __gp.yRel > 1.1 || __gp.mode !== 'race', { timeout: 60000, polling: 100 });
await page.evaluate(() => __gp.slowmo(0.02));
await sleep(500);
await page.screenshot({ path: OUT + '5-jump.png' });
console.log('5-jump · captured');
await page.evaluate(() => __gp.slowmo(1));
await page.evaluate(() => __gp.setWarp(8));
await until(() => ['finish', 'results'].includes(__gp.mode), 600000);
await snap('6-finish');
await until(() => __gp.mode === 'results', 240000);
await snap('7-results');
console.log('pageerrors:', errs.length, errs.slice(0, 5));
await browser.close();
process.exit(errs.length ? 1 : 0);
