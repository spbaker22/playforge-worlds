/* Golf screenshot harness — ONE page boot, states driven via __gp hooks. */
import puppeteer from 'puppeteer';
import fs from 'fs';

const BASE = 'http://127.0.0.1:8091/';
const OUT = '/tmp/golf/';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new', protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio']
});
const page = await browser.newPage();
await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', e => errs.push(e.message));

await page.goto(BASE + '?lowfx=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.__gp !== undefined, { timeout: 300000, polling: 500 });
console.log('booted');

async function snap(name){
  await sleep(1200);
  await page.screenshot({ path: OUT + name + '.png' });
  const s = await page.evaluate(() => `${__gp.mode} hole:${__gp.hole} strokes:${__gp.strokes} total:${__gp.total} pos:${__gp.pos} v:${__gp.ballV.toFixed(1)}`);
  console.log(name, '·', s);
}
async function until(cond, timeout = 420000){
  await page.waitForFunction(cond, { timeout, polling: 400 });
}

/* 1: title */
await until(() => __gp.mode === 'title');
await snap('1-title');

/* 2-3: intro freeze-frames */
await page.evaluate(() => { __gp.setFreeze(1.4); __gp.start(); });
await until(() => __gp.mode === 'intro'); await snap('2-intro-drone');
await page.evaluate(() => __gp.setFreeze(3.7)); await snap('3-intro-low');

/* 4: release into aim; simulate a held drag for the power/arrow shot */
await page.evaluate(() => __gp.setFreeze(null));
await until(() => __gp.mode === 'aim');
await sleep(800);
await page.mouse.move(720, 480);
await page.mouse.down();
await page.mouse.move(650, 640, { steps: 6 });
await sleep(900);
await snap('4-aim-drag');
await page.mouse.move(716, 486, { steps: 3 }); /* cancel: near origin, below stroke threshold */
await page.mouse.up();

/* 5: stroke and catch the ball mid-roll */
await page.evaluate(() => __gp.stroke(0.62));
await until(() => __gp.mode === 'roll' && __gp.ballV > 3);
await page.screenshot({ path: OUT + '5-rolling.png' });
console.log('5-rolling · captured');

/* 6: autopilot to the cup — firefly burst */
await page.evaluate(() => { __gp.setAuto(true); __gp.setWarp(8); });
await until(() => __gp.mode === 'sunk', 600000);
await page.screenshot({ path: OUT + '6-sunk.png' });
console.log('6-sunk · captured');

/* 7: card, then full round to results */
await until(() => __gp.mode === 'card', 600000);
await sleep(250);
await page.screenshot({ path: OUT + '7-card.png' });
console.log('7-card · captured');
await page.evaluate(() => __gp.setWarp(10));
await until(() => __gp.mode === 'results', 900000);
await snap('8-results');

console.log('pageerrors:', errs.length, errs.slice(0, 5));
await browser.close();
process.exit(errs.length ? 1 : 0);
