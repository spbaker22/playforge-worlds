import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const arg = name => process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || null;
const rawBase = arg('base') || process.argv[2];
if(!rawBase || !/^https?:\/\//.test(rawBase)){
  throw new Error('Usage: node tools/preview-smoke.mjs --base=http://host:port/preview-dist/<id>/ [--screenshots=/absolute/path]');
}
const BASE = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
const SCREENSHOTS = arg('screenshots');
if(SCREENSHOTS) mkdirSync(SCREENSHOTS, { recursive: true });
const CHROME = arg('chrome') || process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(existsSync);
if(!CHROME) throw new Error('Chrome was not found; pass --chrome=/absolute/path/to/Chrome');

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
    const steps = 4;
    for(let step = 1; step <= steps; step += 1){
      const t = step / steps;
      const point = [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(point)] });
      await sleep(24);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.detach().catch(() => {});
  }
}

async function dispatchTouch(client, type, { x = 512, y = 500, id = 1, force = 0.65 } = {}){
  const touchPoints = type === 'touchEnd' || type === 'touchCancel'
    ? []
    : [{ x, y, radiusX: 8, radiusY: 8, force, id }];
  await client.send('Input.dispatchTouchEvent', { type, touchPoints });
}

function watch(page, label){
  page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
}

async function screenshot(page, name){
  if(!SCREENSHOTS) return;
  await page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`), fullPage: name === 'launcher' });
}

const distance2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

async function auditPreviewMenu(page, game){
  await tap(page, '#pcMenu');
  await page.waitForFunction(() => !document.getElementById('pcSheet')?.hidden, { timeout: 5_000 });
  const audit = await page.evaluate(() => {
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const sheet = box(document.getElementById('pcSheet'));
    const menu = box(document.getElementById('pcMenu'));
    const hudSelectors = [
      '#brand', '.chip.mid', '.chip.right', '#bigStat', '#stateTag',
      '#clockBlock', '#haulBlock', '#rivals', '#tensionDock',
      '.hud-top', '.hud-bottom', '#flightStatus',
    ];
    const hudOverlaps = hudSelectors.filter(selector => {
      const element = document.querySelector(selector);
      return element ? overlaps(sheet, box(element)) || overlaps(menu, box(element)) : false;
    });
    const actions = [...document.querySelectorAll('#pcSheet a,#pcSheet button')].map(element => ({
      id: element.id,
      text: element.textContent.trim(),
      ...box(element),
    }));
    return {
      menu,
      sheet,
      actions,
      hudOverlaps,
      backHref: document.getElementById('pcBack').href,
      labels: actions.map(action => action.text),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  assert.ok(audit.menu.width >= 44 && audit.menu.height >= 44, `${game} MENU trigger must be at least 44x44`);
  assert.ok(audit.actions.every(action => action.width >= 44 && action.height >= 44), `${game} menu actions must be at least 44x44`);
  assert.ok(audit.sheet.left >= 0 && audit.sheet.top >= 0 && audit.sheet.right <= audit.viewport.width && audit.sheet.bottom <= audit.viewport.height, `${game} menu sheet must stay inside the viewport`);
  assert.deepEqual(audit.hudOverlaps, [], `${game} preview menu must not overlap HUD safe zones`);
  assert.ok(audit.labels.some(label => label.includes('BACK TO GAMES')));
  assert.ok(audit.labels.some(label => label.includes('RESET GAME')));
  assert.ok(audit.labels.some(label => label.includes('SOUND')));
  assert.ok(audit.labels.some(label => label.includes('QUALITY')));
  const expectedHub = new URL('../index.html', page.url());
  expectedHub.search = '';
  expectedHub.hash = '';
  assert.equal(audit.backHref, expectedHub.href, `${game} Back must stay inside this versioned preview`);
  await screenshot(page, `${game}-menu`);
  await tap(page, '#pcClose');
  await page.waitForFunction(() => document.getElementById('pcSheet')?.hidden, { timeout: 5_000 });
  return audit;
}

async function projectedGolfTouchShot(page, { distance, angleOffset, pointerId }){
  const gesture = await page.evaluate(({ targetDistance, offset }) => {
    const ball = __gp.ballState;
    const direction = __gp.aimDir + offset;
    const world = new __dbg.THREE.Vector3(
      ball.x + Math.sin(direction) * targetDistance,
      ball.y - 0.30,
      ball.z + Math.cos(direction) * targetDistance,
    );
    world.project(__dbg.camera);
    const rect = document.getElementById('gl').getBoundingClientRect();
    const release = [
      rect.left + (world.x + 1) * rect.width / 2,
      rect.top + (1 - world.y) * rect.height / 2,
    ];
    if(release[0] < rect.left + 24 || release[0] > rect.right - 24 || release[1] < rect.top + 24 || release[1] > rect.bottom - 24){
      throw new Error(`Projected golf target is outside the touch-safe canvas: ${release.join(',')}`);
    }
    const startX = release[0] > rect.left + rect.width / 2 ? release[0] - 72 : release[0] + 72;
    const startY = release[1] > rect.top + rect.height / 2 ? release[1] - 36 : release[1] + 36;
    return { start: [startX, startY], release };
  }, { targetDistance: distance, offset: angleOffset });
  await swipe(page, gesture.start, gesture.release, pointerId);
  return gesture;
}

async function waitForGolfAim(page, strokes){
  await page.waitForFunction(expected => __gp.mode === 'aim' && __gp.cameraReady && __gp.strokes === expected, {
    timeout: 15_000,
  }, strokes);
}

try {
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  watch(page, 'launcher');
  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 90_000 });
  await page.waitForFunction(() => window.__previewLauncher, { timeout: 30_000 });

  const launcher = await page.evaluate(() => {
    const measure = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        fontSize: Number.parseFloat(style.fontSize),
        textOverflows: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
      };
    };
    const optionButtons = [...document.querySelectorAll('[data-option] button[data-value]')];
    const buttonCollisions = [];
    for(const group of document.querySelectorAll('[data-option]')){
      const buttons = [...group.querySelectorAll('button[data-value]')];
      for(let left = 0; left < buttons.length; left += 1){
        const a = buttons[left].getBoundingClientRect();
        for(let right = left + 1; right < buttons.length; right += 1){
          const b = buttons[right].getBoundingClientRect();
          if(a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5){
            buttonCollisions.push(`${buttons[left].textContent.trim()} / ${buttons[right].textContent.trim()}`);
          }
        }
      }
    }
    __previewLauncher.set('golf.format', 'practice');
    __previewLauncher.set('golf.practiceHole', 4);
    __previewLauncher.set('golf.cupAssist', 'family');
    __previewLauncher.set('golf.rivals', 'relaxed');
    __previewLauncher.set('runner.format', 'final-relay');
    __previewLauncher.set('runner.pace', 'calm');
    __previewLauncher.set('runner.safety', 5);
    __previewLauncher.set('runner.swipe', 'easy');
    __previewLauncher.set('ashfall.mode', 'quick');
    __previewLauncher.set('ashfall.intensity', 'inferno');
    __previewLauncher.set('wings.route', 'quick');
    __previewLauncher.set('wings.control', 'direct');
    __previewLauncher.set('wings.race', 'rivals');
    __previewLauncher.set('tide.session', 'quick');
    __previewLauncher.set('tide.tension', 'relaxed');
    __previewLauncher.set('tide.scoring', 'trophy');
    __previewLauncher.set('quality', 'performance');
    __previewLauncher.set('sound', 'off');
    const golf = document.getElementById('playGolf');
    const runner = document.getElementById('playRunner');
    const ashfall = document.getElementById('playAshfall');
    const wings = document.getElementById('playWings');
    const tide = document.getElementById('playTide');
    const playButtons = [golf, runner, ashfall, wings, tide];
    return {
      options: __previewLauncher.options,
      golfHref: golf.href,
      runnerHref: runner.href,
      ashfallHref: ashfall.href,
      wingsHref: wings.href,
      tideHref: tide.href,
      playTargets: playButtons.map(button => ({ id: button.id, ...measure(button) })),
      resetTarget: measure(document.getElementById('resetOptions')),
      legends: [...document.querySelectorAll('legend')].map(legend => ({ text: legend.textContent.trim(), ...measure(legend) })),
      segmentedTargets: optionButtons.map(button => ({
        option: button.closest('[data-option]').dataset.option,
        value: button.dataset.value,
        text: button.textContent.trim(),
        ...measure(button),
      })),
      buttonCollisions,
    };
  });
  assert.equal(launcher.playTargets.length, 5);
  assert.ok(launcher.playTargets.every(target => target.width >= 44 && target.height >= 56), 'all launcher Play buttons must be at least 44x56 CSS px');
  assert.ok(launcher.resetTarget.width >= 44 && launcher.resetTarget.height >= 44, 'launcher Reset options must be at least 44x44 CSS px');
  assert.ok(launcher.segmentedTargets.every(target => target.width >= 44 && target.height >= 44), 'launcher segmented controls must be at least 44x44 CSS px');
  assert.ok(launcher.segmentedTargets.every(target => target.fontSize >= 10), 'launcher option labels must be at least 10px');
  assert.ok(launcher.legends.every(legend => legend.fontSize >= 10), 'launcher legends must be at least 10px');
  assert.ok(launcher.segmentedTargets.every(target => !target.textOverflows), 'launcher option labels must fit inside their buttons');
  assert.equal(launcher.resetTarget.textOverflows, false, 'launcher Reset options label must fit inside its button');
  assert.deepEqual(launcher.buttonCollisions, [], 'launcher option buttons must not overlap');
  assert.equal(launcher.options.golf.practiceHole, 4);
  assert.equal(launcher.options.runner.safety, 5);
  assert.deepEqual(launcher.options.ashfall, { mode: 'quick', intensity: 'inferno' });
  assert.deepEqual(launcher.options.wings, { route: 'quick', control: 'direct', race: 'rivals' });
  assert.deepEqual(launcher.options.tide, { session: 'quick', tension: 'relaxed', scoring: 'trophy' });
  for(const [game, href] of Object.entries({
    golf: launcher.golfHref,
    runner: launcher.runnerHref,
    ashfall: launcher.ashfallHref,
    wings: launcher.wingsHref,
    tide: launcher.tideHref,
  })) assert.equal(new URL(href).searchParams.has('hub'), false, `${game} launcher href must not emit a hub query`);
  await screenshot(page, 'launcher');

  const golfUrl = new URL(launcher.golfHref);
  // A hostile legacy query must never influence the locally-derived Back link.
  golfUrl.searchParams.set('hub', 'javascript:document.body.dataset.injected=1');
  await page.goto(golfUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.__gp?.mode === 'title', { timeout: 60_000 });
  const golfOptions = await page.evaluate(() => ({
    options: __gp.previewOptions,
    runtime: __gp.previewRuntime,
    holes: __gp.roundHoles,
    back: Boolean(document.getElementById('pcBack')),
    injected: document.body.dataset.injected || null,
  }));
  assert.deepEqual(golfOptions.holes, [4]);
  assert.equal(golfOptions.options.golf.cupAssist, 'family');
  assert.equal(golfOptions.options.golf.rivals, 'relaxed');
  assert.equal(golfOptions.runtime.cupRules.cupCaptureRadius, 0.54);
  assert.equal(golfOptions.runtime.lowfx, true);
  assert.equal(golfOptions.back, true);
  assert.equal(golfOptions.injected, null);
  assert.equal(golfUrl.searchParams.has('fast'), false, 'Golf acceptance must use normal game timing');
  await tap(page, '#tapGo');
  const golfStartScreen = await page.evaluate(() => ({
    mode: __gp.mode,
    titleHidden: document.getElementById('title').hidden,
    titleInert: document.getElementById('title').inert,
    activeScreens: __gp.activeScreens,
  }));
  assert.equal(golfStartScreen.mode, 'intro');
  assert.equal(golfStartScreen.titleHidden, true, 'Golf title must hide synchronously after TAP TO PLAY');
  assert.equal(golfStartScreen.titleInert, true, 'Golf title must stop intercepting touches after start');
  assert.ok(!golfStartScreen.activeScreens.includes('title'));
  await page.waitForFunction(() => __gp.mode === 'aim' && __gp.cameraReady, { timeout: 30_000 });
  const golfMenu = await auditPreviewMenu(page, 'golf');
  const initialLie = await page.evaluate(() => __gp.lie);

  const firstTouch = await projectedGolfTouchShot(page, { distance: 0.9, angleOffset: Math.PI * 0.58, pointerId: 101 });
  await waitForGolfAim(page, 1);
  const firstLie = await page.evaluate(() => __gp.lie);
  assert.equal(firstLie.reason, 'settled');
  assert.ok(distance2d(firstLie, initialLie) > 0.2, 'first touch shot must produce a new lie');

  const secondTouch = await projectedGolfTouchShot(page, { distance: 0.9, angleOffset: -Math.PI * 0.58, pointerId: 102 });
  await waitForGolfAim(page, 2);
  const secondShot = await page.evaluate(() => ({ origin: __gp.lastShotOrigin, lie: __gp.lie, strokes: __gp.strokes, hole: __gp.hole }));
  assert.equal(secondShot.origin.strokesBefore, 1);
  assert.equal(secondShot.origin.hole, 4);
  assert.ok(distance2d(secondShot.origin, firstLie) < 1e-6, 'stroke 2 must begin at stroke 1 settled lie');
  assert.equal(secondShot.lie.reason, 'settled');
  assert.ok(distance2d(secondShot.lie, firstLie) > 0.2, 'stroke 2 must settle at a new lie');
  assert.equal(secondShot.strokes, 2);
  assert.equal(secondShot.hole, 4);
  await screenshot(page, 'golf-putt');

  // Finish the one-hole practice card through the same projected CDP touch
  // gesture used above. Deliberately short, cross-cup targets keep this bounded
  // while ensuring every gameplay stroke goes through the real pointer path.
  const completionTouches = [];
  for(let attempt = 0; attempt < 6; attempt += 1){
    const before = await page.evaluate(() => ({ mode: __gp.mode, strokes: __gp.strokes }));
    if(before.mode === 'card') break;
    assert.equal(before.mode, 'aim', `bounded golf completion expected aim, received ${before.mode}`);
    const touch = await projectedGolfTouchShot(page, {
      distance: 0.82,
      angleOffset: (attempt % 2 === 0 ? 1 : -1) * Math.PI * 0.64,
      pointerId: 103 + attempt,
    });
    await page.waitForFunction(expected => __gp.mode === 'card'
      || (__gp.mode === 'aim' && __gp.cameraReady && __gp.strokes === expected), {
      timeout: 20_000,
    }, before.strokes + 1);
    const after = await page.evaluate(() => ({ mode: __gp.mode, strokes: __gp.strokes, origin: __gp.lastShotOrigin }));
    assert.equal(after.strokes, before.strokes + 1, `touch stroke ${before.strokes + 1} must fire exactly once`);
    assert.equal(after.origin.strokesBefore, before.strokes);
    completionTouches.push({ touch, before, after });
  }
  await page.waitForFunction(() => __gp.mode === 'card' && __gp.activeScreens.includes('card'), { timeout: 20_000 });
  await screenshot(page, 'golf-card');
  const golfCard = await page.evaluate(() => ({
    mode: __gp.mode,
    strokes: __gp.strokes,
    activeScreens: __gp.activeScreens,
    nextLabel: document.getElementById('btnNext').textContent.trim(),
  }));
  assert.equal(golfCard.nextLabel, 'VIEW RESULT');
  await tap(page, '#btnNext');
  await page.waitForFunction(() => __gp.mode === 'results' && __gp.activeScreens.includes('results'), { timeout: 10_000 });
  await screenshot(page, 'golf-results');
  const golfResults = await page.evaluate(() => ({
    mode: __gp.mode,
    total: __gp.total,
    activeScreens: __gp.activeScreens,
    playAgainLabel: document.getElementById('btnAgain').textContent.trim(),
  }));
  assert.equal(golfResults.playAgainLabel, 'PLAY AGAIN');
  await tap(page, '#btnAgain');
  await page.waitForFunction(() => __gp.mode === 'aim' && __gp.cameraReady && __gp.strokes === 0, { timeout: 10_000 });
  const golfReplay = await page.evaluate(() => ({ mode: __gp.mode, strokes: __gp.strokes, hole: __gp.hole, resetReason: __gp.lastResetReason }));
  assert.equal(golfReplay.hole, 4);
  assert.equal(golfReplay.strokes, 0);
  assert.match(golfReplay.resetReason, /play-again-button/);
  const golfProgress = {
    startScreen: golfStartScreen,
    initialLie,
    firstTouch,
    firstLie,
    secondTouch,
    secondShot,
    completionTouches,
    card: golfCard,
    results: golfResults,
    replay: golfReplay,
    menu: golfMenu,
  };

  const runnerUrl = new URL(launcher.runnerHref);
  await page.goto(runnerUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.__gp?.mode === 'title', { timeout: 60_000 });
  const runnerOptions = await page.evaluate(() => ({ options: __gp.previewOptions, runtime: __gp.previewRuntime, s: __gp.courseS, shields: __gp.shields, back: Boolean(document.getElementById('pcBack')) }));
  assert.equal(runnerOptions.options.runner.format, 'final-relay');
  assert.equal(runnerOptions.options.runner.pace, 'calm');
  assert.equal(runnerOptions.runtime.startMode, 'race');
  assert.equal(runnerOptions.runtime.simConfig.startS, 112);
  assert.equal(runnerOptions.runtime.simConfig.maxSpeed, 11.8);
  assert.equal(runnerOptions.runtime.simConfig.rivalPaceScale, 0.7);
  assert.equal(runnerOptions.runtime.swipeThreshold, 0.022);
  assert.equal(runnerOptions.shields, 5);
  assert.ok(runnerOptions.s >= 112);
  assert.equal(runnerOptions.back, true);
  assert.equal(runnerUrl.searchParams.has('fast'), false, 'Runner acceptance must use normal game timing');
  const runnerClickedAt = Date.now();
  await tap(page, '#tapGo');
  const runnerStartScreen = await page.evaluate(() => ({
    mode: __gp.mode,
    titleHidden: __gp.titleHidden,
    titleInert: document.getElementById('title').inert,
    activeScreens: __gp.activeScreens,
    durations: __gp.flow.durations,
  }));
  assert.equal(runnerStartScreen.mode, 'intro');
  assert.equal(runnerStartScreen.titleHidden, true, 'Runner title must hide synchronously after TAP TO RUN');
  assert.equal(runnerStartScreen.titleInert, true, 'Runner title must stop intercepting touches after start');
  assert.ok(!runnerStartScreen.activeScreens.includes('title'));
  assert.equal(runnerStartScreen.durations.intro, 4.2);
  assert.equal(runnerStartScreen.durations.countdown, 3);
  await page.waitForFunction(() => __gp.mode === 'countdown' && !__gp.countHidden, { timeout: 12_000 });
  const countdownStartedAt = Date.now();
  const countdownScreen = await page.evaluate(() => ({
    mode: __gp.mode,
    titleHidden: __gp.titleHidden,
    countHidden: __gp.countHidden,
    activeScreens: __gp.activeScreens,
  }));
  assert.equal(countdownScreen.titleHidden, true);
  assert.equal(countdownScreen.countHidden, false);
  assert.deepEqual(countdownScreen.activeScreens, ['count']);
  await page.waitForFunction(() => __gp.mode === 'race', { timeout: 30_000 });
  const raceStartedAt = Date.now();
  assert.ok(countdownStartedAt - runnerClickedAt >= 3_900, 'Runner must play the normal intro before countdown');
  assert.ok(raceStartedAt - countdownStartedAt >= 2_750, 'Runner must play the normal three-second countdown');
  const activeStartedAt = Date.now();
  const startS = await page.evaluate(() => __gp.courseS);
  await swipe(page, [660, 520], [560, 520], 201);
  await page.waitForFunction(() => __gp.actionCounts.left >= 1, { timeout: 10_000 });
  const leftGesture = await page.evaluate(() => ({
    accepted: __gp.lastAcceptedAction,
    laneTarget: __gp.laneTarget,
    titleHidden: __gp.titleHidden,
  }));
  assert.equal(leftGesture.accepted.direction, 'left');
  assert.equal(leftGesture.accepted.pointerType, 'touch');
  assert.equal(leftGesture.accepted.beforePointerUp, true);
  assert.equal(leftGesture.laneTarget, -1);
  assert.equal(leftGesture.titleHidden, true);
  await page.waitForFunction(() => __gp.crashCount >= 1, { timeout: 15_000 });
  await page.waitForFunction(() => __gp.recoveryCount >= 1 && __gp.mode === 'race', { timeout: 15_000 });
  await swipe(page, [600, 590], [600, 480], 202);
  await page.waitForFunction(() => __gp.actionCounts.up >= 1, { timeout: 10_000 });
  const remainingActiveWindow = Math.max(0, 6_200 - (Date.now() - activeStartedAt));
  if(remainingActiveWindow) await sleep(remainingActiveWindow);
  await page.waitForFunction(() => __gp.mode === 'race' && __gp.recoveryCount >= 1 && __gp.resultsCount === 0, { timeout: 15_000 });
  const runnerMenu = await auditPreviewMenu(page, 'runner');
  await screenshot(page, 'runner-relay');
  const runnerProgress = await page.evaluate(() => ({
    mode: __gp.mode,
    s: __gp.courseS,
    actions: __gp.actionCounts,
    shields: __gp.shields,
    crashes: __gp.crashCount,
    recoveries: __gp.recoveryCount,
    results: __gp.resultsCount,
    resetReason: __gp.lastResetReason,
    recoveryReason: __gp.lastRecoveryReason,
    rivals: __gp.simulation.rivals.map(rival => ({ id: rival.id, speed: rival.speed, s: rival.s })),
    titleHidden: __gp.titleHidden,
    countHidden: __gp.countHidden,
    transitions: __gp.trace
      .filter(entry => entry.type === 'transition' && entry.status === 'accepted')
      .map(entry => ({ from: entry.from, to: entry.to, reason: entry.reason })),
  }));
  runnerProgress.menu = runnerMenu;
  runnerProgress.timing = {
    introMilliseconds: countdownStartedAt - runnerClickedAt,
    countdownMilliseconds: raceStartedAt - countdownStartedAt,
    activeMilliseconds: Date.now() - activeStartedAt,
  };
  runnerProgress.startScreen = runnerStartScreen;
  runnerProgress.countdownScreen = countdownScreen;
  runnerProgress.leftGesture = leftGesture;
  assert.equal(runnerProgress.mode, 'race');
  assert.ok(Date.now() - activeStartedAt >= 6_000, 'Runner must remain playable beyond the old five-second failure window');
  assert.ok(runnerProgress.s >= 121.5, 'Runner must recover to the authored safe pad rather than restart');
  assert.equal(runnerProgress.actions.left, 1);
  assert.equal(runnerProgress.actions.up, 1);
  assert.ok(runnerProgress.crashes >= 1);
  assert.ok(runnerProgress.recoveries >= 1);
  assert.equal(runnerProgress.results, 0);
  assert.equal(runnerProgress.resetReason, 'initial');
  assert.equal(runnerProgress.titleHidden, true);
  assert.equal(runnerProgress.countHidden, true);
  assert.match(runnerProgress.recoveryReason, /combined-lane-gate|final-gap/);
  assert.ok(runnerProgress.shields < 5 && runnerProgress.shields > 0);
  assert.ok(runnerProgress.rivals.every(rival => rival.speed < 10.2), 'Calm rivals must use the scaled deterministic pace at runtime');
  const titleTransitions = runnerProgress.transitions.filter(entry => entry.to === 'title');
  assert.equal(titleTransitions.length, 1, 'Runner must enter title once and never loop back after countdown');
  assert.equal(titleTransitions[0].from, null);
  assert.ok(runnerProgress.transitions.some(entry => entry.to === 'crash'), 'Runner swipe path must reach crash flow');
  assert.ok(runnerProgress.transitions.some(entry => entry.to === 'recover'), 'Runner crash must reach recover flow');
  assert.ok(runnerProgress.transitions.some(entry => entry.from === 'recover' && entry.to === 'race'), 'Runner recovery must resume the race');

  const ashfallUrl = new URL(launcher.ashfallHref);
  ashfallUrl.searchParams.set('warp', '6');
  ashfallUrl.searchParams.set('hub', 'javascript:document.body.dataset.injected=1');
  await page.goto(ashfallUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.__gp?.ready === true && __gp.mode === 'title', { timeout: 60_000 });
  const ashfallBoot = await page.evaluate(() => ({
    options: __gp.options,
    activeScreens: __gp.activeScreens,
    frozen: Object.isFrozen(__gp),
    descriptor: {
      writable: Object.getOwnPropertyDescriptor(window, '__gp').writable,
      configurable: Object.getOwnPropertyDescriptor(window, '__gp').configurable,
    },
    back: Boolean(document.getElementById('pcBack')),
    injected: document.body.dataset.injected || null,
  }));
  assert.equal(ashfallBoot.options.mode, 'quick');
  assert.equal(ashfallBoot.options.intensity, 'inferno');
  assert.equal(ashfallBoot.options.sound, 'off');
  assert.equal(ashfallBoot.options.quality, 'performance');
  assert.deepEqual(ashfallBoot.activeScreens, ['title']);
  assert.equal(ashfallBoot.frozen, true);
  assert.equal(ashfallBoot.descriptor.writable, false);
  assert.equal(ashfallBoot.descriptor.configurable, false);
  assert.equal(ashfallBoot.back, true);
  assert.equal(ashfallBoot.injected, null);
  await screenshot(page, 'ashfall-title');
  await tap(page, '#tapGo');
  await page.waitForFunction(() => __gp.mode === 'instructions', { timeout: 5_000 });
  await tap(page, '#btnReady');
  await page.waitForFunction(() => __gp.mode === 'play', { timeout: 8_000 });
  const ashfallBefore = await page.evaluate(() => __gp.simulation);
  await swipe(page, [480, 470], [680, 420], 301);
  await sleep(70);
  const ashfallMoved = await page.evaluate(() => __gp.simulation);
  assert.ok(distance2d(ashfallMoved, ashfallBefore) > 0.2, 'Ashfall CDP drag must move the survivor toward the finger');
  await page.touchscreen.tap(520, 500);
  await sleep(45);
  const ashfallDashed = await page.evaluate(() => __gp.simulation);
  assert.ok(ashfallDashed.dashCooldown > 0, 'Ashfall CDP tap must trigger dash cooldown');
  await page.waitForFunction(() => __gp.simulation.hits >= 1, { timeout: 10_000 });
  const ashfallHit = await page.evaluate(() => ({
    mode: __gp.mode,
    state: __gp.simulation,
    gameplayState: __gp.gameplayState,
    traceTypes: __gp.trace.map(entry => entry.type),
  }));
  assert.ok(ashfallHit.traceTypes.includes('sim:telegraph'), 'Ashfall must emit a live hazard telegraph');
  assert.ok(ashfallHit.traceTypes.includes('sim:hit'), 'Ashfall must resolve a live hazard hit');
  await screenshot(page, 'ashfall-gameplay');
  const ashfallMenu = await auditPreviewMenu(page, 'ashfall');
  await page.waitForFunction(() => __gp.mode === 'results', { timeout: 15_000 });
  const ashfallResults = await page.evaluate(() => ({
    mode: __gp.mode,
    status: __gp.simulation.status,
    hearts: __gp.simulation.hearts,
    activeScreens: __gp.activeScreens,
    screenAudit: __gp.screenAudit,
    titleTransitions: __gp.trace.filter(entry => entry.type === 'transition' && entry.to === 'title').length,
  }));
  assert.deepEqual(ashfallResults.activeScreens, ['results']);
  assert.equal(ashfallResults.screenAudit.state.ok, true);
  assert.equal(ashfallResults.screenAudit.hits.ok, true);
  assert.equal(ashfallResults.titleTransitions, 1, 'Ashfall must not loop back to title');
  await screenshot(page, 'ashfall-results');
  await tap(page, '#btnAgain');
  await page.waitForFunction(() => __gp.mode === 'play', { timeout: 8_000 });
  const ashfallReplay = await page.evaluate(() => ({ mode: __gp.mode, hearts: __gp.simulation.hearts, time: __gp.simulation.time, activeScreens: __gp.activeScreens }));
  assert.equal(ashfallReplay.hearts, 3);
  assert.deepEqual(ashfallReplay.activeScreens, []);

  const wingsUrl = new URL(launcher.wingsHref);
  wingsUrl.searchParams.set('hub', 'https://example.invalid/escape');
  await page.goto(wingsUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.__gp?.mode === 'title', { timeout: 60_000 });
  const wingsBoot = await page.evaluate(() => ({
    options: __gp.options,
    route: __gp.route,
    activeScreens: __gp.activeScreens,
    frozen: Object.isFrozen(__gp),
    descriptor: {
      writable: Object.getOwnPropertyDescriptor(window, '__gp').writable,
      configurable: Object.getOwnPropertyDescriptor(window, '__gp').configurable,
    },
    back: document.getElementById('pcBack')?.href,
  }));
  assert.equal(wingsBoot.options.route, 'quick');
  assert.equal(wingsBoot.options.control, 'direct');
  assert.equal(wingsBoot.options.race, 'rivals');
  assert.equal(wingsBoot.options.sound, 'off');
  assert.equal(wingsBoot.options.quality, 'performance');
  assert.equal(wingsBoot.route.gates, 6);
  assert.deepEqual(wingsBoot.activeScreens, ['title']);
  assert.equal(wingsBoot.frozen, true);
  assert.equal(wingsBoot.descriptor.writable, false);
  assert.equal(wingsBoot.descriptor.configurable, false);
  assert.equal(wingsBoot.back, new URL('../index.html', wingsUrl).href.split('?')[0]);
  await screenshot(page, 'wings-title');
  await tap(page, '#beginButton');
  await page.waitForFunction(() => __gp.mode === 'briefing', { timeout: 5_000 });
  await tap(page, '#flightButton');
  await page.waitForFunction(() => __gp.mode === 'flight', { timeout: 8_000 });
  await swipe(page, [500, 420], [620, 320], 401);
  await sleep(70);
  const wingsTouch = await page.evaluate(() => ({ mode: __gp.mode, gesture: __gp.gesture, state: __gp.state }));
  assert.equal(wingsTouch.gesture.control, 'direct');
  assert.ok(wingsTouch.gesture.sequence >= 1 && wingsTouch.gesture.samples >= 5, 'Wings must receive genuine CDP drag samples');
  assert.ok(wingsTouch.gesture.bank > 0 && wingsTouch.gesture.pitch > 0, 'Wings touch drag must produce bank and pitch together');
  assert.equal(wingsTouch.gesture.lastEndReason, 'pointerup');
  await screenshot(page, 'wings-gameplay');
  const wingsMenu = await auditPreviewMenu(page, 'wings');

  const wingsAutoUrl = new URL(launcher.wingsHref);
  wingsAutoUrl.searchParams.set('auto', '1');
  wingsAutoUrl.searchParams.set('fast', '1');
  await page.goto(wingsAutoUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.__gp?.mode === 'results', { timeout: 45_000 });
  const wingsResults = await page.evaluate(() => ({
    mode: __gp.mode,
    options: __gp.options,
    state: __gp.state,
    activeScreens: __gp.activeScreens,
    transitionSequence: __gp.transitionSequence,
  }));
  assert.equal(wingsResults.options.auto, true);
  assert.equal(wingsResults.state.status, 'finished');
  assert.equal(wingsResults.state.gatesPassed, 6);
  assert.deepEqual(wingsResults.activeScreens, ['results']);
  await screenshot(page, 'wings-results');
  await tap(page, '#replayButton');
  await page.waitForFunction(() => __gp.mode === 'flight', { timeout: 5_000 });
  const wingsReplay = await page.evaluate(() => ({ mode: __gp.mode, state: __gp.state, activeScreens: __gp.activeScreens, transitionSequence: __gp.transitionSequence }));
  assert.equal(wingsReplay.state.gatesPassed, 0);
  assert.equal(wingsReplay.state.misses, 0);
  assert.deepEqual(wingsReplay.activeScreens, []);
  assert.ok(wingsReplay.transitionSequence > wingsResults.transitionSequence);

  const tideUrl = new URL(launcher.tideHref);
  tideUrl.searchParams.set('hub', 'javascript:alert(1)');
  await page.goto(tideUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.__gp?.flow === 'title', { timeout: 60_000 });
  const tideBoot = await page.evaluate(() => ({
    options: __gp.options,
    render: __gp.render,
    screens: __gp.screens,
    frozen: Object.isFrozen(__gp),
    descriptor: {
      get: typeof Object.getOwnPropertyDescriptor(window, '__gp').get,
      set: typeof Object.getOwnPropertyDescriptor(window, '__gp').set,
      configurable: Object.getOwnPropertyDescriptor(window, '__gp').configurable,
    },
    back: document.getElementById('pcBack')?.href,
  }));
  assert.equal(tideBoot.options.session, 'quick');
  assert.equal(tideBoot.options.tension, 'relaxed');
  assert.equal(tideBoot.options.scoring, 'trophy');
  assert.equal(tideBoot.options.sound, 'off');
  assert.equal(tideBoot.options.quality, 'performance');
  assert.equal(tideBoot.render.engineQuality, 'performance');
  assert.equal(tideBoot.screens.ok, true);
  assert.equal(tideBoot.frozen, true);
  assert.equal(tideBoot.descriptor.get, 'function');
  assert.equal(tideBoot.descriptor.set, 'undefined');
  assert.equal(tideBoot.descriptor.configurable, false);
  assert.equal(tideBoot.back, new URL('../index.html', tideUrl).href.split('?')[0]);
  await screenshot(page, 'tide-title');
  await tap(page, '#enterBtn');
  await page.waitForFunction(() => __gp.flow === 'instructions', { timeout: 5_000 });
  await tap(page, '#launchBtn');
  await page.waitForFunction(() => __gp.flow === 'play' && __gp.state.phase === 'aim', { timeout: 8_000 });
  const tideMenu = await auditPreviewMenu(page, 'tide');
  await swipe(page, [510, 340], [558, 640], 501);
  await page.waitForFunction(() => ['casting', 'waiting'].includes(__gp.state.phase), { timeout: 3_000 });
  await page.waitForFunction(() => __gp.state.phase === 'waiting', { timeout: 4_000 });
  await page.waitForFunction(() => __gp.state.phase === 'bite', { timeout: 8_000 });
  await screenshot(page, 'tide-gameplay');
  await page.touchscreen.tap(512, 500);
  await page.waitForFunction(() => __gp.state.phase === 'reeling', { timeout: 2_000 });
  const tideClient = await page.createCDPSession();
  await tideClient.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  let tideHolding = false;
  try {
    for(let cycle = 0; cycle < 360; cycle += 1){
      const state = await page.evaluate(() => ({ flow: __gp.flow, phase: __gp.state.phase, tension: __gp.state.tension, progress: __gp.state.reelProgress }));
      if(state.flow === 'outcome' || state.phase !== 'reeling') break;
      if(!tideHolding && state.tension < 0.56){
        await dispatchTouch(tideClient, 'touchStart', { x: 512, y: 510, id: 600 + cycle });
        tideHolding = true;
      } else if(tideHolding && state.tension > 0.72){
        await dispatchTouch(tideClient, 'touchEnd');
        tideHolding = false;
      }
      await sleep(45);
    }
    if(tideHolding) await dispatchTouch(tideClient, 'touchEnd');
  } finally {
    await tideClient.detach().catch(() => {});
  }
  await page.waitForFunction(() => __gp.flow === 'outcome', { timeout: 5_000 });
  const tideCatch = await page.evaluate(() => ({ state: __gp.state, input: __gp.input, screens: __gp.screens }));
  assert.equal(tideCatch.state.lastOutcome.type, 'catch', 'Tide managed reel must land a fish');
  assert.ok(tideCatch.state.catches >= 1);
  assert.equal(tideCatch.input.active, false);
  assert.equal(tideCatch.screens.ok, true);
  await tap(page, '#nextBtn');
  await page.waitForFunction(() => __gp.flow === 'play' || __gp.flow === 'results', { timeout: 4_000 });
  await page.waitForFunction(() => __gp.flow === 'results', { timeout: 50_000 });
  const tideResults = await page.evaluate(() => ({ flow: __gp.flow, state: __gp.state, screens: __gp.screens, titleHidden: document.getElementById('title').hidden }));
  assert.equal(tideResults.state.status, 'finished');
  assert.ok(tideResults.state.catches >= 1);
  assert.equal(tideResults.screens.ok, true);
  assert.equal(tideResults.titleHidden, true);
  await screenshot(page, 'tide-results');
  await tap(page, '#replayBtn');
  await page.waitForFunction(() => __gp.flow === 'countdown', { timeout: 3_000 });
  const tideReplay = await page.evaluate(() => ({ flow: __gp.flow, state: __gp.state, screens: __gp.screens, titleHidden: document.getElementById('title').hidden }));
  assert.equal(tideReplay.state.time, 0);
  assert.equal(tideReplay.state.catches, 0);
  assert.equal(tideReplay.screens.ok, true);
  assert.equal(tideReplay.titleHidden, true);

  await sleep(250);
  assert.deepEqual(errors, [], `Preview emitted page errors:\n${errors.join('\n')}`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    base: BASE,
    launcher,
    golfProgress,
    runnerProgress,
    ashfall: { boot: ashfallBoot, moved: ashfallMoved, dashed: ashfallDashed, hit: ashfallHit, results: ashfallResults, replay: ashfallReplay, menu: ashfallMenu },
    wings: { boot: wingsBoot, touch: wingsTouch, results: wingsResults, replay: wingsReplay, menu: wingsMenu },
    tide: { boot: tideBoot, catch: tideCatch, results: tideResults, replay: tideReplay, menu: tideMenu },
    screenshots: SCREENSHOTS,
  }, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => {});
}
