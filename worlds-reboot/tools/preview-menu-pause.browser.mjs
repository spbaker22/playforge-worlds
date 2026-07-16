import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argument = name => process.argv.slice(2)
  .find(value => value.startsWith(`--${name}=`))
  ?.slice(name.length + 3) || null;
const positionalBase = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const rawBase = argument('base') || positionalBase;
const sourceMode = process.argv.includes('--source');
if(!sourceMode && (!rawBase || !/^https?:\/\//.test(rawBase))){
  throw new Error('Usage: node tools/preview-menu-pause.browser.mjs --source OR --base=http://host/preview-dist/<id>/');
}
const base = rawBase ? (rawBase.endsWith('/') ? rawBase : `${rawBase}/`) : null;
const onlyGame = argument('game');
const chrome = argument('chrome') || process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(existsSync);
if(!chrome) throw new Error('Chrome was not found; pass --chrome=/absolute/path/to/Chrome');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const viteBin = path.join(repoRoot, 'node_modules', '.bin', 'vite');
const sourcePortBase = 42_000 + (process.pid % 2_000) * 5;
const gameCases = [
  {
    id: 'golf',
    path: 'golf/index.html?preview=1&fast=1&sound=off&quality=performance&golfFormat=practice&golfHole=1',
    control: '#gl',
    ready: () => window.__gp?.mode === 'title',
    start: async page => {
      await page.evaluate(() => window.__gp.start());
      await page.waitForFunction(() => window.__gp?.mode === 'aim' && window.__gp.cameraReady, { timeout: 15_000 });
    },
  },
  {
    id: 'runner',
    path: 'runner/index.html?preview=1&fast=1&sound=off&quality=performance&runnerFormat=full-training&runnerPace=calm',
    control: '#gl',
    ready: () => window.__gp?.mode === 'title',
    start: async page => {
      await page.evaluate(() => window.__gp.start());
      await page.waitForFunction(() => window.__gp?.mode === 'tutorial', { timeout: 15_000 });
    },
  },
  {
    id: 'ashfall',
    path: 'ashfall/index.html?preview=1&sound=off&quality=performance&ashMode=quick&ashIntensity=calm',
    control: '#gl',
    ready: () => window.__gp?.mode === 'title',
    start: async page => {
      await page.click('#tapGo');
      await page.waitForFunction(() => window.__gp?.mode === 'instructions', { timeout: 5_000 });
      await page.click('#btnReady');
      await page.waitForFunction(() => window.__gp?.mode === 'play', { timeout: 8_000 });
    },
  },
  {
    id: 'wings',
    path: 'wings/index.html?preview=1&fast=1&sound=off&quality=performance&wingsRoute=quick&wingsControl=guided&wingsRace=rivals',
    control: '#gl',
    ready: () => window.__gp?.mode === 'title',
    start: async page => {
      await page.click('#beginButton');
      await page.waitForFunction(() => window.__gp?.mode === 'briefing', { timeout: 5_000 });
      await page.click('#flightButton');
      await page.waitForFunction(() => window.__gp?.mode === 'flight', { timeout: 8_000 });
    },
  },
  {
    id: 'tide',
    path: 'tide/index.html?preview=1&sound=off&quality=performance&tideSession=quick&tideTension=relaxed&tideScoring=haul',
    control: '#touchSurface',
    ready: () => window.__gp?.flow === 'title',
    start: async page => {
      await page.click('#enterBtn');
      await page.waitForFunction(() => window.__gp?.flow === 'instructions', { timeout: 5_000 });
      await page.click('#launchBtn');
      await page.waitForFunction(() => window.__gp?.flow === 'play', { timeout: 8_000 });
    },
  },
];
const selectedCases = onlyGame ? gameCases.filter(game => game.id === onlyGame) : gameCases;
if(selectedCases.length === 0) throw new Error(`Unknown game filter: ${onlyGame}`);

async function startSourceServer(game, port = 4178){
  const child = spawn(viteBin, [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--strictPort',
    '--base', `/${game.id}/`,
  ], {
    cwd: path.join(repoRoot, game.id),
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const origin = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 20_000;
  while(Date.now() < deadline){
    if(child.exitCode !== null) throw new Error(`${game.id} Vite exited early (${child.exitCode}): ${output}`);
    try {
      const response = await fetch(new URL(`${game.id}/index.html`, origin));
      if(response.ok) return { child, origin };
    } catch {}
    await sleep(80);
  }
  child.kill('SIGTERM');
  throw new Error(`${game.id} Vite did not become ready: ${output}`);
}

async function stopSourceServer(server){
  if(!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 3_000);
    once(server, 'exit').then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  if(server.exitCode === null){
    server.kill('SIGKILL');
    await once(server, 'exit');
  }
}

function readProbeState(game){
  const menu = document.getElementById('pcMenu');
  const sheet = document.getElementById('pcSheet');
  const scrim = document.getElementById('pcScrim');
  const chromeState = {
    expanded: menu?.getAttribute('aria-expanded'),
    sheetHidden: sheet?.hidden,
    scrimHidden: scrim?.hidden,
    dialogRole: sheet?.getAttribute('role'),
    activeElement: document.activeElement?.id || '',
  };
  if(game === 'golf'){
    const gesture = window.__gp.gesture;
    return {
      paused: window.__gp.previewPaused,
      chrome: chromeState,
      authority: {
        mode: window.__gp.mode,
        hole: window.__gp.hole,
        strokes: window.__gp.strokes,
        total: window.__gp.total,
        ball: window.__gp.ballState,
        lie: window.__gp.lie,
        simulation: window.__gp.simulation,
      },
      input: {
        active: gesture.active,
        engaged: gesture.engaged,
        valid: gesture.valid,
        targeting: gesture.targeting,
        sequence: gesture.session.sequence,
      },
      progress: window.__gp.simulation.wallTime,
    };
  }
  if(game === 'runner'){
    const gesture = window.__gp.gesture;
    return {
      paused: window.__gp.previewPaused,
      chrome: chromeState,
      authority: { mode: window.__gp.mode, simulation: window.__gp.simulation },
      input: {
        active: gesture.gesture.active,
        sequence: gesture.gesture.sequence,
        accepted: gesture.acceptedCount,
        queued: gesture.queuedCount,
        cueArmed: window.__gp.cueInput.armed,
      },
      progress: window.__gp.simulation.time,
    };
  }
  if(game === 'ashfall'){
    return {
      paused: window.__gp.previewPaused,
      chrome: chromeState,
      authority: { mode: window.__gp.mode, simulation: window.__gp.simulation },
      input: {
        active: window.__gp.action.active || window.__gp.gesture.active,
        sequence: window.__gp.action.sequence,
        gestureSequence: window.__gp.gesture.sequence,
      },
      progress: window.__gp.simulation.time,
    };
  }
  if(game === 'wings'){
    return {
      paused: window.__gp.previewPaused,
      chrome: chromeState,
      authority: {
        mode: window.__gp.mode,
        state: window.__gp.state,
        transitionSequence: window.__gp.transitionSequence,
      },
      input: { active: window.__gp.gesture.active, sequence: window.__gp.gesture.sequence },
      progress: window.__gp.state.time,
    };
  }
  return {
    paused: window.__gp.previewPaused,
    chrome: chromeState,
    authority: {
      flow: window.__gp.flow,
      state: window.__gp.state,
      competition: window.__gp.competition,
    },
    input: { active: window.__gp.input.active, sequence: window.__gp.input.sequence },
    progress: window.__gp.state.time,
  };
}

async function elementPoint(page, selector, { xRatio = 0.42, yRatio = 0.58 } = {}){
  return page.evaluate(({ selector: targetSelector, xRatio: x, yRatio: y }) => {
    const target = document.querySelector(targetSelector);
    if(!target) throw new Error(`Missing target ${targetSelector}`);
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width * x, y: rect.top + rect.height * y };
  }, { selector, xRatio, yRatio });
}

let browser;
let sourceServer = null;
const report = {};
try {
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: chrome,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1194, height: 834, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(`page: ${error.message}`));
  page.on('console', message => {
    const value = message.text();
    if(message.type() === 'error' && !value.startsWith('Failed to load resource:')) browserErrors.push(`console: ${value}`);
  });
  page.on('response', response => {
    if(response.status() >= 400 && new URL(response.url()).pathname !== '/favicon.ico'){
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  for(const [index, game] of selectedCases.entries()){
    browserErrors.length = 0;
    let caseBase = base;
    if(sourceMode){
      const started = await startSourceServer(game, sourcePortBase + index);
      sourceServer = started.child;
      caseBase = started.origin;
    }
    try {
      await page.goto(new URL(game.path, caseBase), { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await page.waitForFunction(game.ready, { timeout: 60_000 });
      await game.start(page);
      await sleep(350);

      if(index === 0){
        await page.click('#pcMenu');
        await page.waitForFunction(() => window.__gp.previewPaused && document.activeElement?.id === 'pcClose');
        const accessible = await page.evaluate(() => ({
          expanded: document.getElementById('pcMenu').getAttribute('aria-expanded'),
          role: document.getElementById('pcSheet').getAttribute('role'),
          modal: document.getElementById('pcSheet').getAttribute('aria-modal'),
          scrimHidden: document.getElementById('pcScrim').hidden,
        }));
        assert.deepEqual(accessible, { expanded: 'true', role: 'dialog', modal: 'true', scrimHidden: false });
        await page.keyboard.down('Shift');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Shift');
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'pcQuality', 'Shift+Tab must wrap to the last menu action');
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'pcClose', 'Tab must wrap back to the close action');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !window.__gp.previewPaused && document.activeElement?.id === 'pcMenu');

        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.__gp.previewPaused && document.activeElement?.id === 'pcClose');
        await page.click('#pcClose');
        await page.waitForFunction(() => !window.__gp.previewPaused && document.activeElement?.id === 'pcMenu');

        await page.keyboard.press('Space');
        await page.waitForFunction(() => window.__gp.previewPaused && document.activeElement?.id === 'pcClose');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !window.__gp.previewPaused && document.activeElement?.id === 'pcMenu');

        await page.click('#pcMenu');
        await page.waitForFunction(() => window.__gp.previewPaused);
        await page.mouse.click(72, 72);
        await page.waitForFunction(() => !window.__gp.previewPaused && document.getElementById('pcSheet').hidden);
      }

      const controlPoint = game.id === 'golf'
        ? { x: 330, y: 480 }
        : await elementPoint(page, game.control);
      const heldTouch = await page.touchscreen.touchStart(controlPoint.x, controlPoint.y);
      if(game.id === 'golf') await heldTouch.move(430, 470);
      await sleep(60);
      const active = await page.evaluate(readProbeState, game.id);
      assert.equal(active.input.active, true, `${game.id}: setup pointer must be active before opening the menu`);
      if(game.id === 'golf'){
        assert.equal(active.input.engaged, true, 'golf: captured drag must be engaged before MENU touch');
        assert.equal(active.input.targeting, true, 'golf: captured drag must be targeting before MENU touch');
        assert.equal(active.input.valid, true, 'golf: captured drag must be valid before MENU touch');
      }

      const menuPoint = await elementPoint(page, '#pcMenu', { xRatio: 0.5, yRatio: 0.5 });
      const menuTouch = await page.touchscreen.touchStart(menuPoint.x, menuPoint.y);
      await page.waitForFunction(() => window.__gp.previewPaused && !document.getElementById('pcSheet').hidden);
      const openedWithSecondTouch = await page.evaluate(readProbeState, game.id);
      assert.equal(openedWithSecondTouch.input.active, false, `${game.id}: second-finger MENU down must cancel active input`);
      await menuTouch.end();
      await sleep(40);
      const afterMenuRelease = await page.evaluate(readProbeState, game.id);
      assert.equal(afterMenuRelease.paused, true, `${game.id}: MENU touch release must not close the menu`);
      await heldTouch.end();
      await sleep(80);
      const pausedBefore = await page.evaluate(readProbeState, game.id);
      assert.equal(pausedBefore.paused, true, `${game.id}: stale pre-menu pointer release closed the menu`);
      assert.equal(pausedBefore.input.active, false, `${game.id}: menu open must cancel active input`);
      assert.equal(pausedBefore.chrome.scrimHidden, false, `${game.id}: input scrim must be active`);
      assert.equal(pausedBefore.chrome.dialogRole, 'dialog', `${game.id}: menu must retain dialog semantics`);

      await sleep(2_250);
      const pausedAfter = await page.evaluate(readProbeState, game.id);
      assert.deepEqual(pausedAfter.authority, pausedBefore.authority, `${game.id}: authoritative state advanced while menu was open`);
      assert.equal(pausedAfter.paused, true, `${game.id}: pause state ended without a close action`);

      const sequenceBeforeScrimTap = pausedAfter.input.sequence;
      await page.touchscreen.tap(72, 72);
      await page.waitForFunction(() => !window.__gp.previewPaused && document.getElementById('pcSheet').hidden);
      const closed = await page.evaluate(readProbeState, game.id);
      assert.equal(closed.input.sequence, sequenceBeforeScrimTap, `${game.id}: outside close tap leaked into gameplay`);
      assert.equal(closed.chrome.scrimHidden, true, `${game.id}: scrim did not close`);

      await sleep(420);
      const resumed = await page.evaluate(readProbeState, game.id);
      assert.ok(resumed.progress > pausedAfter.progress, `${game.id}: play did not resume after menu close`);
      await page.touchscreen.tap(controlPoint.x, controlPoint.y);
      await sleep(80);
      const afterControlTap = await page.evaluate(readProbeState, game.id);
      assert.ok(afterControlTap.input.sequence > sequenceBeforeScrimTap, `${game.id}: gameplay input did not resume after close`);
      assert.deepEqual(browserErrors, [], `${game.id}: browser errors: ${browserErrors.join(' | ')}`);

      report[game.id] = {
        pausedSeconds: 2.25,
        progressAtPause: pausedBefore.progress,
        progressAfterWait: pausedAfter.progress,
        progressAfterResume: resumed.progress,
        inputSequence: {
          activeSetup: active.input.sequence,
          afterStaleRelease: pausedBefore.input.sequence,
          afterOutsideClose: closed.input.sequence,
          afterGameplayTap: afterControlTap.input.sequence,
        },
      };
    } finally {
      await stopSourceServer(sourceServer);
      sourceServer = null;
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write('PREVIEW_MENU_PAUSE_BROWSER_OK\n');
} finally {
  await stopSourceServer(sourceServer);
  if(browser) await browser.close();
}
