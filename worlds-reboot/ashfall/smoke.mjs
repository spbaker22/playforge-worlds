import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const base = process.argv[2] || 'http://127.0.0.1:8765/';
const shotDir = process.argv[3] || '/tmp/ashfall-smoke';
const url = new URL(base);
url.searchParams.set('ashMode', 'quick');
url.searchParams.set('ashIntensity', 'standard');
url.searchParams.set('sound', 'off');
url.searchParams.set('quality', 'performance');
url.searchParams.set('preview', '1');

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-angle=swiftshader'],
  defaultViewport: { width: 1024, height: 768, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', message => { if(message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', error => consoleErrors.push(error.message));

try {
  await page.goto(url.href, { waitUntil: 'networkidle0', timeout: 30_000 });
  await page.waitForFunction(() => window.__gp?.ready === true, { timeout: 15_000 });
  const opening = await page.evaluate(() => ({
    mode: window.__gp.mode,
    screens: window.__gp.activeScreens,
    options: window.__gp.options,
    run: window.__gp.run,
    titleCopy: document.querySelector('#title .sub')?.textContent,
    previewLabel: document.querySelector('#previewLabel')?.textContent,
    frozen: Object.isFrozen(window.__gp),
    writable: Object.getOwnPropertyDescriptor(window, '__gp')?.writable,
  }));
  assert.equal(opening.mode, 'title');
  assert.deepEqual(opening.screens, ['title']);
  assert.equal(opening.options.mode, 'quick');
  assert.equal(opening.options.intensity, 'standard');
  assert.equal(opening.options.quality, 'performance');
  assert.match(opening.titleCopy, /SURVIVE UNTIL RESCUE/);
  assert.doesNotMatch(opening.titleCopy, /REACH YOUR CREW/);
  assert.match(opening.previewLabel, /QUICK RUN · STANDARD ASH/);
  assert.equal(opening.frozen, true);
  assert.equal(opening.writable, false);
  await page.screenshot({ path: `${shotDir}/title.png` });

  await page.click('#tapGo');
  await page.waitForFunction(() => window.__gp.mode === 'instructions');
  await page.screenshot({ path: `${shotDir}/instructions.png` });
  await page.click('#btnReady');
  await page.waitForFunction(() => window.__gp.mode === 'play', { timeout: 8_000 });
  const before = await page.evaluate(() => window.__gp.simulation);

  const client = await page.createCDPSession();
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 480, y: 470, radiusX: 7, radiusY: 7, force: 0.7, id: 1 }],
  });
  for(let step = 1; step <= 8; step += 1){
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 480 + step * 24, y: 470 - step * 6, radiusX: 7, radiusY: 7, force: 0.7, id: 1 }],
    });
    await new Promise(resolve => setTimeout(resolve, 18));
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(resolve => setTimeout(resolve, 550));
  const moved = await page.evaluate(() => window.__gp.simulation);
  assert.ok(Math.hypot(moved.x - before.x, moved.z - before.z) > 0.35, 'drag should move the survivor');
  await page.screenshot({ path: `${shotDir}/telegraph.png` });

  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 250, y: 500, radiusX: 7, radiusY: 7, force: 0.7, id: 2 }],
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(resolve => setTimeout(resolve, 80));
  const dashed = await page.evaluate(() => window.__gp.simulation);
  assert.ok(dashed.dashCooldown > 0, 'tap should start dash cooldown');
  assert.ok(dashed.dashDuration > 0, 'tap should activate the dash');
  assert.ok(dashed.facingX < -0.2, 'tap on left-side ground should dash left, not reuse the prior facing');

  await new Promise(resolve => setTimeout(resolve, 1300));
  const report = await page.evaluate(() => ({
    mode: window.__gp.mode,
    gameplayState: window.__gp.gameplayState,
    simulation: window.__gp.simulation,
    screens: window.__gp.activeScreens,
    audit: window.__gp.screenAudit,
    performance: window.__gp.performance,
    scene: window.__gp.scene,
    stateTag: {
      text: document.querySelector('#stateTag')?.textContent,
      opacity: getComputedStyle(document.querySelector('#stateTag')).opacity,
    },
    traceTypes: window.__gp.trace.slice(-12).map(entry => entry.type),
  }));
  assert.equal(report.mode, 'play');
  assert.deepEqual(report.screens, []);
  assert.equal(report.audit.state.ok, true);
  assert.equal(report.audit.hits.ok, true);
  assert.equal(report.scene.companions, 2);
  assert.equal(report.scene.boundaryVisible, true);
  assert.equal(report.stateTag.opacity, '1');
  assert.match(report.stateTag.text, /DASH|RINGS|SHIELD/);
  assert.ok(report.simulation.spawnCount >= 1);
  assert.ok(report.performance.frames > 30);
  await page.screenshot({ path: `${shotDir}/gameplay.png` });
  assert.deepEqual(consoleErrors, []);

  const terminalUrl = new URL(base);
  terminalUrl.searchParams.set('ashMode', 'quick');
  terminalUrl.searchParams.set('ashIntensity', 'inferno');
  terminalUrl.searchParams.set('sound', 'off');
  terminalUrl.searchParams.set('quality', 'performance');
  terminalUrl.searchParams.set('warp', '4');
  await page.goto(terminalUrl.href, { waitUntil: 'networkidle0', timeout: 30_000 });
  await page.waitForFunction(() => window.__gp?.ready === true);
  await page.click('#tapGo');
  await page.click('#btnReady');
  await page.waitForFunction(() => window.__gp.mode === 'play', { timeout: 8_000 });
  await page.waitForFunction(() => {
    const wave = window.__gp.simulation.hazards.filter(hazard => hazard.kind === 'perimeter-wave');
    return wave.length === 11 && window.__gp.scene.visibleHazards >= 11;
  }, { polling: 10, timeout: 8_000 });
  const wave = await page.evaluate(() => {
    const hazards = window.__gp.simulation.hazards.filter(hazard => hazard.kind === 'perimeter-wave');
    return {
      count: hazards.length,
      waveIds: [...new Set(hazards.map(hazard => hazard.waveId))],
      gapIndexes: [...new Set(hazards.map(hazard => hazard.gapIndex))],
      radiusScales: [...new Set(hazards.map(hazard => hazard.radiusScale))],
      visibleHazards: window.__gp.scene.visibleHazards,
      traceCount: window.__gp.trace.filter(entry => entry.type === 'sim:wave-telegraph').length,
    };
  });
  assert.equal(wave.count, 11);
  assert.equal(wave.waveIds.length, 1);
  assert.equal(wave.gapIndexes.length, 1);
  assert.deepEqual(wave.radiusScales, [1.2]);
  assert.ok(wave.visibleHazards >= 11);
  assert.ok(wave.traceCount >= 1);
  await page.screenshot({ path: `${shotDir}/perimeter-wave.png` });
  await page.waitForFunction(() => window.__gp.mode === 'results', { timeout: 18_000 });
  const terminal = await page.evaluate(() => ({
    mode: window.__gp.mode,
    status: window.__gp.simulation.status,
    hearts: window.__gp.simulation.hearts,
    screens: window.__gp.activeScreens,
    audit: window.__gp.screenAudit,
    run: window.__gp.run,
  }));
  assert.equal(terminal.status, 'lost');
  assert.equal(terminal.hearts, 0);
  assert.deepEqual(terminal.screens, ['results']);
  assert.equal(terminal.audit.state.ok, true);
  assert.equal(terminal.audit.hits.ok, true);
  await page.screenshot({ path: `${shotDir}/results.png` });
  await page.click('#btnAgain');
  await page.waitForFunction(() => window.__gp.mode === 'play', { timeout: 8_000 });
  const replay = await page.evaluate(() => ({ mode: window.__gp.mode, screens: window.__gp.activeScreens, hearts: window.__gp.simulation.hearts, run: window.__gp.run }));
  assert.equal(replay.mode, 'play');
  assert.deepEqual(replay.screens, []);
  assert.equal(replay.hearts, 3);
  assert.equal(replay.run.number, 2);
  assert.notEqual(replay.run.seed, terminal.run.seed);

  process.stdout.write(`${JSON.stringify({ opening, before, moved, dashed, report, wave, terminal, replay, consoleErrors }, null, 2)}\n`);
} finally {
  await browser.close();
}
