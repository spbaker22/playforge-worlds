import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const argument = name => process.argv.slice(2)
  .find(value => value.startsWith(`--${name}=`))
  ?.slice(name.length + 3) || null;
const rawBase = argument('base');
if(!rawBase || !/^https?:\/\//.test(rawBase)){
  throw new Error('Usage: node tools/wings.campaign.browser.mjs --base=http://host:port/ [--chrome=/absolute/path/to/Chrome]');
}
const base = new URL(rawBase.endsWith('/') ? rawBase : `${rawBase}/`);
const chrome = argument('chrome') || process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(existsSync);
if(!chrome) throw new Error('Chrome was not found; pass --chrome=/absolute/path/to/Chrome');

const PROGRESS_KEY = 'playforge:wings:campaign:v1';
const MISSION_IDS = [
  'flight-school', 'ridge-race', 'target-run', 'stunt-trial',
  'mountain-rescue', 'storm-escape', 'ace-pursuit', 'skybreaker-finale',
];
const SCREEN_IDS = ['title', 'campaign', 'briefing', 'countdown', 'results'];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function wingsEntry(){
  const clean = new URL(base);
  clean.search = '';
  clean.hash = '';
  if(clean.pathname.endsWith('/wings/index.html')) return clean;
  if(clean.pathname.endsWith('/wings/')) return new URL('index.html', clean);
  return new URL('wings/index.html', clean);
}

function missionUrl(missionId, { auto = false } = {}){
  const url = wingsEntry();
  url.searchParams.set('preview', '1');
  url.searchParams.set('fast', '1');
  url.searchParams.set('sound', 'off');
  url.searchParams.set('quality', 'performance');
  url.searchParams.set('wingsRoute', 'full');
  url.searchParams.set('wingsControl', 'guided');
  url.searchParams.set('wingsRace', 'rivals');
  url.searchParams.set('wingsMission', missionId);
  if(auto) url.searchParams.set('auto', '1');
  return url;
}

async function waitForContract(page){
  await page.waitForFunction(() => {
    const gp = window.__gp;
    return gp && gp.flow && gp.campaign && gp.state && gp.gesture && gp.commands
      && Array.isArray(gp.activeScreens) && typeof gp.missionId === 'string';
  }, { timeout: 60_000 });
}

async function waitForFlow(page, mode, timeout = 15_000){
  await page.waitForFunction(expected => window.__gp?.flow?.mode === expected, { timeout }, mode);
}

async function readGp(page){
  return page.evaluate(() => JSON.parse(JSON.stringify({
    previewPaused: window.__gp.previewPaused,
    mode: window.__gp.mode,
    flow: window.__gp.flow,
    missionId: window.__gp.missionId,
    campaign: window.__gp.campaign,
    state: window.__gp.state,
    gesture: window.__gp.gesture,
    commands: window.__gp.commands,
    activeScreens: window.__gp.activeScreens,
    transitionSequence: window.__gp.transitionSequence,
    presentation: window.__gp.presentation,
  })));
}

function commandCount(commands, type){
  const counts = commands?.counts || commands?.byType || commands?.totals || {};
  return Number(counts[type] || 0);
}

async function waitForCommand(page, type, previous){
  await page.waitForFunction(({ commandType, prior }) => {
    const commands = window.__gp?.commands;
    const counts = commands?.counts || commands?.byType || commands?.totals || {};
    return Number(counts[commandType] || 0) > prior;
  }, { timeout: 8_000 }, { commandType: type, prior: previous });
}

async function auditScreens(page, expectedFlowMode){
  const report = await page.evaluate(({ ids, flowMode }) => {
    const expectedScreen = ids.includes(flowMode) ? flowMode : null;
    const screens = ids.map(id => {
      const element = document.getElementById(id);
      const active = !element.hidden;
      return {
        id,
        active,
        hidden: element.hidden,
        inert: element.inert,
        ariaHidden: element.getAttribute('aria-hidden'),
        datasetActive: element.dataset.screenActive,
      };
    });
    const touchTargets = [...document.querySelectorAll(
      '#beginButton,#selectMissionButton,#flightButton,#replayButton,#nextMissionButton,#missionSelectButton,#actionButton,#campaign .mission-node[data-mission-id]',
    )].filter(element => !element.hidden && !element.disabled && element.getClientRects().length > 0).map(element => {
      const rect = element.getBoundingClientRect();
      return { id: element.id || element.dataset.missionId, width: rect.width, height: rect.height };
    });
    const hud = document.getElementById('hud');
    return {
      expectedScreen,
      screens,
      domActive: screens.filter(screen => screen.active).map(screen => screen.id),
      debugActive: [...window.__gp.activeScreens],
      flowMode: window.__gp.flow.mode,
      legacyMode: window.__gp.mode,
      hud: { hidden: hud.hidden, ariaHidden: hud.getAttribute('aria-hidden') },
      canvasLabel: document.getElementById('gl').getAttribute('aria-label'),
      touchTargets,
    };
  }, { ids: SCREEN_IDS, flowMode: expectedFlowMode });

  assert.equal(report.flowMode, expectedFlowMode);
  const expectedActive = report.expectedScreen ? [report.expectedScreen] : [];
  assert.deepEqual(report.domActive, expectedActive, `${expectedFlowMode}: one authoritative screen invariant failed`);
  assert.deepEqual(report.debugActive, expectedActive, `${expectedFlowMode}: __gp active screens disagree with the DOM`);
  for(const screen of report.screens){
    const active = screen.id === report.expectedScreen;
    assert.equal(screen.hidden, !active, `${expectedFlowMode}: ${screen.id} hidden mismatch`);
    assert.equal(screen.inert, !active, `${expectedFlowMode}: ${screen.id} inert mismatch`);
    assert.equal(screen.ariaHidden, String(!active), `${expectedFlowMode}: ${screen.id} aria-hidden mismatch`);
    assert.equal(screen.datasetActive, String(active), `${expectedFlowMode}: ${screen.id} data-screen-active mismatch`);
  }
  const hudExpected = ['play', 'recovery', 'fail'].includes(expectedFlowMode);
  assert.equal(report.hud.hidden, !hudExpected, `${expectedFlowMode}: HUD visibility mismatch`);
  assert.equal(report.hud.ariaHidden, String(!hudExpected), `${expectedFlowMode}: HUD aria-hidden mismatch`);
  assert.ok(report.canvasLabel?.includes('Paper Wings'), 'Canvas requires an accessible Paper Wings label');
  assert.ok(report.touchTargets.every(target => target.width >= 44 && target.height >= 44), `${expectedFlowMode}: visible controls must be at least 44px`);
  return report;
}

async function gameplayPoints(page){
  return page.evaluate(() => {
    const box = selector => {
      const element = document.querySelector(selector);
      if(!element) throw new Error(`Missing ${selector}`);
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    };
    const canvas = box('#gl');
    const action = box('#actionButton');
    const menu = box('#pcMenu');
    const actionX = action.left + action.width / 2;
    return {
      left: { x: canvas.left + canvas.width * 0.27, y: canvas.top + canvas.height * 0.57 },
      leftMoved: { x: canvas.left + canvas.width * 0.27 + 58, y: canvas.top + canvas.height * 0.57 - 36 },
      action: { x: actionX, y: action.top + action.height / 2 },
      stunt: {
        x: actionX + (actionX > innerWidth - 76 ? -58 : 58),
        y: action.top + action.height / 2,
        type: actionX > innerWidth - 76 ? 'roll-left' : 'roll-right',
      },
      menu: { x: menu.left + menu.width / 2, y: menu.top + menu.height / 2 },
    };
  });
}

async function createRawTouchRig(page){
  const active = new Map();
  return {
    async start(id, point){
      assert.ok(!active.has(id), `touch ${id} must not already be active`);
      const handle = await page.touchscreen.touchStart(Math.round(point.x), Math.round(point.y));
      active.set(id, handle);
    },
    async move(id, point){
      const handle = active.get(id);
      assert.ok(handle, `touch ${id} must be active before move`);
      await handle.move(Math.round(point.x), Math.round(point.y));
    },
    async end(id){
      const handle = active.get(id);
      if(!handle) return;
      await handle.end();
      active.delete(id);
    },
    async close(){
      for(const [id, handle] of [...active]){
        await handle.end().catch(() => {});
        active.delete(id);
      }
    },
  };
}

async function openMissionFromTitle(page, missionId){
  await waitForFlow(page, 'title');
  await auditScreens(page, 'title');
  await page.click('#beginButton');
  await waitForFlow(page, 'campaign');
  const campaignScreen = await auditScreens(page, 'campaign');
  const map = await page.evaluate(() => ({
    nodes: [...document.querySelectorAll('#campaign .mission-node[data-mission-id]')].map(node => ({
      id: node.dataset.missionId,
      state: node.dataset.state,
      selected: node.dataset.selected,
      pressed: node.getAttribute('aria-pressed'),
      disabled: node.disabled,
      ariaDisabled: node.getAttribute('aria-disabled'),
    })),
    label: document.querySelector('.flight-map')?.getAttribute('aria-label'),
  }));
  assert.equal(map.nodes.length, 8, 'Campaign map must expose all eight missions');
  assert.equal(new Set(map.nodes.map(node => node.id)).size, 8, 'Campaign mission IDs must be unique');
  assert.equal(map.label, 'Paper Wings mission map');
  const requested = map.nodes.find(node => node.id === missionId);
  assert.ok(requested && !requested.disabled, `${missionId} must be unlocked before selection`);
  assert.ok(map.nodes.every(node => node.ariaDisabled === String(node.disabled)), 'Map disabled semantics must match native state');

  await page.click(`#campaign .mission-node[data-mission-id="${missionId}"]`);
  await page.waitForFunction(id => window.__gp.flow.selectedMissionId === id, { timeout: 5_000 }, missionId);
  await page.click('#selectMissionButton');
  await waitForFlow(page, 'briefing');
  const briefingScreen = await auditScreens(page, 'briefing');
  const briefing = await page.evaluate(() => ({
    kicker: document.getElementById('briefKicker').textContent.trim(),
    title: document.getElementById('briefTitle').textContent.trim(),
    objective: document.getElementById('briefObjective').textContent.trim(),
    controls: [...document.querySelectorAll('.control-item strong')].map(element => element.textContent.trim()),
  }));
  assert.ok(briefing.kicker && briefing.title && briefing.objective, 'Briefing content must be populated');
  assert.deepEqual(briefing.controls, ['Left thumb', 'Tap', 'Hold', 'Flick']);
  assert.equal((await readGp(page)).missionId, missionId);

  await page.click('#flightButton');
  await waitForFlow(page, 'play', 20_000);
  const playScreen = await auditScreens(page, 'play');
  const started = await readGp(page);
  assert.equal(started.mode, 'flight', 'Legacy-facing mode must map authoritative play to flight');
  assert.equal(started.flow.mode, 'play');
  assert.equal(started.state.missionId, missionId);
  assert.equal(started.state.status, 'flying');
  return { campaignScreen, map, briefingScreen, briefing, playScreen };
}

async function flightSchoolInputAndPause(page){
  const points = await gameplayPoints(page);
  const rig = await createRawTouchRig(page);
  try {
    await rig.start(701, points.left);
    await rig.move(701, points.leftMoved);
    await sleep(120);
    const steering = await readGp(page);
    assert.equal(steering.gesture.steeringActive, true);
    assert.ok(steering.gesture.bank > 0 && steering.gesture.pitch > 0, 'Left touch must steer on both axes');

    const boostStartBefore = commandCount(steering.commands, 'boost-start');
    await rig.start(702, points.action);
    await waitForCommand(page, 'boost-start', boostStartBefore);
    const boosted = await readGp(page);
    assert.equal(boosted.gesture.steeringActive, true, 'Steering must survive a simultaneous right hold');
    assert.equal(boosted.gesture.actionActive, true);
    assert.equal(boosted.gesture.held.boost, true);
    assert.equal(boosted.state.aero.boostActive, true);
    const boostEndBefore = commandCount(boosted.commands, 'boost-end');
    await rig.end(702);
    await waitForCommand(page, 'boost-end', boostEndBefore);

    const stuntBefore = commandCount((await readGp(page)).commands, points.stunt.type);
    await rig.start(703, points.action);
    await rig.move(703, points.stunt);
    await sleep(50);
    await rig.end(703);
    await waitForCommand(page, points.stunt.type, stuntBefore);
    const stunt = await readGp(page);
    assert.equal(stunt.gesture.steeringActive, true, 'Steering must survive a simultaneous right flick');
    assert.ok(stunt.state.stunts.eventSequence > 0 || commandCount(stunt.commands, points.stunt.type) > stuntBefore,
      'Stunt command evidence must be visible through __gp');

    const menuCommandSequence = Number(stunt.commands.sequence || stunt.commands.commandSequence || 0);
    await rig.start(704, points.menu);
    await page.waitForFunction(() => window.__gp.previewPaused && window.__gp.flow.paused, { timeout: 5_000 });
    const pausedBefore = await readGp(page);
    assert.equal(pausedBefore.gesture.steeringActive, false, 'MENU must cancel the steering pointer');
    assert.equal(pausedBefore.gesture.actionActive, false, 'MENU must cancel the action pointer');
    assert.equal(pausedBefore.gesture.lastCancelReason, 'preview-menu-open');
    await rig.end(704);
    await rig.end(701);
    await sleep(1_250);
    const pausedAfter = await readGp(page);
    assert.deepEqual(pausedAfter.state, pausedBefore.state, 'Authoritative simulation advanced while MENU was open');
    assert.equal(Number(pausedAfter.commands.sequence || pausedAfter.commands.commandSequence || 0), menuCommandSequence,
      'Stale touch releases emitted a command while paused');
    assert.equal(pausedAfter.previewPaused, true);
    assert.equal(pausedAfter.flow.paused, true);

    await page.touchscreen.tap(72, 72);
    await page.waitForFunction(() => !window.__gp.previewPaused && !window.__gp.flow.paused, { timeout: 5_000 });
    const resumeTime = (await readGp(page)).state.time;
    await page.waitForFunction(time => window.__gp.state.time > time, { timeout: 5_000 }, resumeTime);
    await auditScreens(page, 'play');
    return {
      steering: { bank: steering.gesture.bank, pitch: steering.gesture.pitch },
      commands: {
        boostStart: commandCount(boosted.commands, 'boost-start'),
        boostEnd: commandCount((await readGp(page)).commands, 'boost-end'),
        stunt: commandCount(stunt.commands, points.stunt.type),
        stuntType: points.stunt.type,
      },
      pause: { seconds: 1.25, cancelReason: pausedAfter.gesture.lastCancelReason },
    };
  } finally {
    await rig.close();
  }
}

async function seedFinaleUnlock(page){
  const completed = MISSION_IDS.slice(0, -1);
  const missions = Object.fromEntries(completed.map(id => [id, {
    attempts: 1,
    completions: 1,
    completed: true,
    bestScore: 5000,
    bestStars: 3,
    bestTimeMs: 60_000,
    bestCombo: 8,
    completedObjectiveIds: [],
  }]));
  await page.evaluate(({ key, missionIds, completedIds, records }) => {
    localStorage.setItem(key, JSON.stringify({
      storeVersion: 1,
      campaignVersion: 1,
      campaign: {
        version: 1,
        catalogVersion: 1,
        revision: completedIds.length,
        unlockedMissionIds: missionIds,
        completedMissionIds: completedIds,
        totalStars: completedIds.length * 3,
        missions: records,
      },
    }));
  }, { key: PROGRESS_KEY, missionIds: MISSION_IDS, completedIds: completed, records: missions });
}

async function skybreakerFireInput(page){
  const points = await gameplayPoints(page);
  const before = await readGp(page);
  const fireBefore = commandCount(before.commands, 'fire');
  const rig = await createRawTouchRig(page);
  try {
    await rig.start(801, points.left);
    await rig.move(801, points.leftMoved);
    await sleep(80);
    await rig.start(802, points.action);
    await sleep(70);
    await rig.end(802);
    await waitForCommand(page, 'fire', fireBefore);
    const fired = await readGp(page);
    assert.equal(fired.gesture.steeringActive, true, 'Steering must remain active while the right tap fires');
    assert.ok(commandCount(fired.commands, 'fire') > fireBefore, 'Fire command evidence must be visible through __gp');
    assert.ok(fired.state.shotsFired > before.state.shotsFired || commandCount(fired.commands, 'fire') > fireBefore);
    await rig.end(801);
    return { fireCount: commandCount(fired.commands, 'fire'), shotsFired: fired.state.shotsFired };
  } finally {
    await rig.close();
  }
}

async function verifyAutoMission(page, missionId){
  await page.goto(missionUrl(missionId, { auto: true }), { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await waitForContract(page);
  await waitForFlow(page, 'results', 120_000);
  const screen = await auditScreens(page, 'results');
  const results = await readGp(page);
  assert.equal(results.missionId, missionId);
  assert.equal(results.state.missionId, missionId);
  assert.equal(results.state.status, 'finished');
  assert.equal(results.state.result?.outcome, 'success');
  assert.equal(results.flow.result?.outcome, 'success');
  assert.ok(results.campaign.completedMissionIds.includes(missionId));
  assert.deepEqual(results.activeScreens, ['results']);

  const replay = await page.$eval('#replayButton', button => {
    button.click();
    return JSON.parse(JSON.stringify({ flow: window.__gp.flow, missionId: window.__gp.missionId }));
  });
  assert.equal(replay.flow.mode, 'briefing', `${missionId}: replay must return to briefing`);
  assert.equal(replay.flow.result, null);
  assert.equal(replay.missionId, missionId);
  const restart = await page.$eval('#flightButton', button => {
    button.click();
    return JSON.parse(JSON.stringify(window.__gp.flow));
  });
  assert.equal(restart.mode, 'countdown');
  await waitForFlow(page, 'play', 20_000);
  const restarted = await readGp(page);
  assert.equal(restarted.state.missionId, missionId);
  assert.equal(restarted.state.status, 'flying');
  assert.ok(restarted.state.time < 3, `${missionId}: replay retained terminal simulation time`);
  return {
    screen,
    score: results.state.result.score,
    gatesPassed: results.state.gatesPassed,
    transitionSequence: results.transitionSequence,
    replayMode: replay.flow.mode,
  };
}

const browserErrors = [];
async function createHarnessPage(browser){
  const page = await browser.newPage();
  await page.setViewport({ width: 1194, height: 834, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
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
  return page;
}

let browser;
try {
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: chrome,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await createHarnessPage(browser);

  await page.goto(missionUrl('flight-school'), { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await waitForContract(page);
  await page.evaluate(key => localStorage.removeItem(key), PROGRESS_KEY);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
  await waitForContract(page);
  const flightSchoolFlow = await openMissionFromTitle(page, 'flight-school');
  const inputAndPause = await flightSchoolInputAndPause(page);
  const flightSchoolAuto = await verifyAutoMission(page, 'flight-school');
  await page.close();

  const finalePage = await createHarnessPage(browser);
  await finalePage.goto(missionUrl('skybreaker-finale'), { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await waitForContract(finalePage);
  await seedFinaleUnlock(finalePage);
  await finalePage.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
  await waitForContract(finalePage);
  const skybreakerFlow = await openMissionFromTitle(finalePage, 'skybreaker-finale');
  const fire = await skybreakerFireInput(finalePage);
  const skybreakerAuto = await verifyAutoMission(finalePage, 'skybreaker-finale');
  await finalePage.close();

  assert.deepEqual(browserErrors, [], `Browser errors: ${browserErrors.join(' | ')}`);
  const report = {
    base: base.href,
    flow: {
      flightSchool: { mapNodes: flightSchoolFlow.map.nodes.length, briefing: flightSchoolFlow.briefing.title },
      skybreaker: { mapNodes: skybreakerFlow.map.nodes.length, briefing: skybreakerFlow.briefing.title },
    },
    input: { ...inputAndPause, fire },
    auto: { flightSchool: flightSchoolAuto, skybreaker: skybreakerAuto },
    errors: browserErrors,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write('WINGS_CAMPAIGN_BROWSER_OK\n');
} finally {
  if(browser) await browser.close();
}
