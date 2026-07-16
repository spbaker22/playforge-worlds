/* Stackyard Golf Phase 2 hard gate — fresh artifact, pure sim, and real pointer paths. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import puppeteer, { KnownDevices } from 'puppeteer';
import { createFixedStepRunner } from '../engine/fixed-step.js';
import { HOLES, holeWalls } from '../golf/src/course.js';
import { copyBallState, heightLocal, localToWorld, stepGolfBall } from '../golf/src/sim.js';
import { resolveChromeExecutable } from './chrome-path.mjs';
import { assertContainedPhaseTarget } from './phase-target-bootstrap.mjs';

assertContainedPhaseTarget('Stackyard Golf Phase 2 gate');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CANDIDATE_MODE = process.argv.includes('--candidate');
assert.deepEqual(process.argv.slice(2), CANDIDATE_MODE ? ['--candidate'] : [], 'unknown Golf Phase 2 arguments');
const CANDIDATE_REPORT_PATH = process.env.PLAYFORGE_CANDIDATE_REPORT_PATH
  ? resolve(process.env.PLAYFORGE_CANDIDATE_REPORT_PATH) : null;
if(CANDIDATE_MODE){
  assert.ok(CANDIDATE_REPORT_PATH, 'Golf candidate mode requires PLAYFORGE_CANDIDATE_REPORT_PATH');
  const ownedTemp = resolve(process.env.TMPDIR || tmpdir());
  const offset = relative(ownedTemp, CANDIDATE_REPORT_PATH);
  assert.ok(offset && !offset.startsWith('..') && !isAbsolute(offset), 'Golf candidate report must be inside outer temp');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const closeEnough = (a, b, epsilon = 1e-5) => Math.abs(a - b) <= epsilon;
const assertVector = (actual, expected, epsilon = 1e-5, label = 'vector') => {
  assert.equal(actual.length, expected.length, `${label} dimensions`);
  actual.forEach((value, index) => assert.ok(
    closeEnough(value, expected[index], epsilon),
    `${label}[${index}] ${value} != ${expected[index]}`,
  ));
};

/* ---------------- pure deterministic simulation gate ---------------- */
function initialPureState(){
  const hole = HOLES[0];
  const [x, z] = localToWorld(hole, 0, 1);
  return {
    x,
    y: hole.base + heightLocal(hole, 0, 1) + 0.34,
    z,
    vx: 0,
    vz: 2.2 + 0.22 * 13.2,
    v: 2.2 + 0.22 * 13.2,
    rollT: 0,
  };
}

function runPureCadence(cadence, { firstStall = 0 } = {}){
  let state = initialPureState();
  let terminal = null;
  let runner;
  runner = createFixedStepRunner({
    step: 1 / 120,
    maxFrame: 0.1,
    maxSteps: 120,
    onStep(dt){
      const result = stepGolfBall(state, { hole: HOLES[0], walls: holeWalls(0), ballRadius: 0.34 }, dt);
      state = result.state;
      if(result.terminal){
        terminal = result.terminal;
        runner.setSimulating(false);
      }
    },
  });
  let suppliedWall = 0;
  let frame = 0;
  if(firstStall){
    runner.advance(firstStall);
    suppliedWall += firstStall;
  }
  while(!terminal && frame < 3000){
    const delta = cadence[frame % cadence.length];
    runner.advance(delta);
    suppliedWall += delta;
    frame += 1;
  }
  assert.equal(terminal, 'settled', 'pure shot must settle');
  assert.ok(closeEnough(runner.state.wallTime, suppliedWall, 1e-10), 'fixed-step wall clock must receive actual supplied wall time');
  return { state, runner: runner.state, frames: frame, suppliedWall };
}

function pureSimulationGate(){
  const sixty = runPureCadence([1 / 60]);
  const mixed = runPureCadence([1 / 144, 1 / 90, 1 / 30, 1 / 75, 1 / 120]);
  const stalled = runPureCadence([1 / 60], { firstStall: 0.5 });
  for(const axis of ['x', 'y', 'z', 'vx', 'vz', 'v', 'rollT']){
    assert.ok(closeEnough(sixty.state[axis], mixed.state[axis], 1e-10), `mixed cadence changed ${axis}`);
    assert.ok(closeEnough(sixty.state[axis], stalled.state[axis], 1e-10), `stall cadence changed ${axis}`);
  }
  assert.ok(stalled.runner.droppedTime >= 0.399, '0.5s stall must be truthfully recorded as dropped time');

  let previous = initialPureState();
  let current = copyBallState(previous);
  let interpolationRunner;
  interpolationRunner = createFixedStepRunner({
    step: 1 / 120,
    onStep(dt){
      previous = current;
      current = stepGolfBall(current, { hole: HOLES[0], walls: holeWalls(0), ballRadius: 0.34 }, dt).state;
    },
  });
  const frame = interpolationRunner.advance(0.01);
  assert.ok(frame.alpha > 0 && frame.alpha < 1, 'interpolation fixture must retain a fractional accumulator');
  const renderedZ = previous.z + (current.z - previous.z) * frame.alpha;
  assert.ok(renderedZ >= Math.min(previous.z, current.z) && renderedZ <= Math.max(previous.z, current.z));
  return { sixty, mixed, stalled, interpolationAlpha: frame.alpha };
}

/* ---------------- fresh standalone artifact + private server ---------------- */
async function createFreshArtifactServer(){
  const output = await mkdtemp(join(tmpdir(), 'playforge-golf-phase2-'));
  const viteCli = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const build = spawnSync(process.execPath, [
    viteCli, 'build', 'golf', '--config', 'golf/vite.config.js',
    '--outDir', output, '--emptyOutDir',
  ], { cwd: ROOT, encoding: 'utf8' });
  if(build.status !== 0) throw new Error(`fresh Golf build failed\n${build.stdout}\n${build.stderr}`);
  const artifact = await readFile(join(output, 'index.html'));
  const hash = createHash('sha256').update(artifact).digest('hex');
  const server = createServer((request, response) => {
    if(request.url === '/' || request.url?.startsWith('/?') || request.url === '/index.html'){
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(artifact);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/?lowfx=1&fast=1`,
    hash,
    output,
    async close(){
      await new Promise(resolve => server.close(resolve));
      await rm(output, { recursive: true, force: true });
    },
  };
}

let browser;
let artifactServer;

async function openGolf(){
  const page = await browser.newPage();
  await page.emulate(KnownDevices['iPad Pro 11 landscape']);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(artifactServer.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => window.__gp, { timeout: 120_000 });
  return { page, errors };
}

async function elementCenter(page, selector){
  return page.$eval(selector, element => {
    const rect = element.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  });
}

async function tapElement(page, selector){
  const [x, y] = await elementCenter(page, selector);
  await page.touchscreen.tap(x, y);
}

async function beginTouch(page, point, pointerId = 1){
  const client = await page.createCDPSession();
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  let current = point;
  const touch = ([x, y], id = pointerId) => ({ x, y, radiusX: 8, radiusY: 8, force: 0.65, id });
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(point)] });
  return {
    async move(next){
      current = next;
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(next)] });
      await sleep(28);
    },
    async second(next, secondId = pointerId + 1){
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [touch(current), touch(next, secondId)],
      });
      await sleep(28);
    },
    async end(){
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await client.detach();
    },
    async cancel(){
      await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      await client.detach();
    },
  };
}

async function canceledTouchOnElement(page, selector, pointerId = 1){
  const point = await elementCenter(page, selector);
  const touch = await beginTouch(page, point, pointerId);
  await touch.cancel();
  await sleep(100);
}

async function startToAim(page){
  await tapElement(page, '#tapGo');
  await page.waitForFunction(() => __gp.mode === 'aim' && __gp.cameraReady, { timeout: 30_000 });
}

async function screenForWorld(page, world){
  return page.evaluate(([x, y, z]) => {
    const projected = new __dbg.THREE.Vector3(x, y, z).project(__dbg.camera);
    return [(projected.x + 1) * innerWidth / 2, (1 - projected.y) * innerHeight / 2];
  }, world);
}

async function assertScreenAudit(page, label){
  const audit = await page.evaluate(() => __gp.auditScreens());
  assert.equal(audit.state.ok, true, `${label}: incomplete inactive screen state`);
  assert.equal(audit.hits.ok, true, `${label}: inactive screen won a viewport hit`);
  assert.deepEqual(audit.hits.violations, []);
  return audit;
}

function assertCameraLocked(samples){
  const first = samples[0];
  for(const sample of samples.slice(1)){
    assertVector(sample.position, first.position, 1e-5, 'locked camera position');
    assertVector(sample.quaternion, first.quaternion, 1e-6, 'locked camera quaternion');
    assert.ok(closeEnough(sample.fov, first.fov, 1e-5), 'locked camera FOV changed');
  }
}

async function gestureSample(page){
  return page.evaluate(() => ({
    gesture: __gp.gesture,
    reticle: __gp.reticleWorld,
    camera: __gp.camTransform,
    power: __gp.power,
    strokes: __gp.strokes,
  }));
}

/* ---------------- absolute-target and invalidation gate ---------------- */
async function absoluteTargetGate(){
  const { page, errors } = await openGolf();
  await startToAim(page);
  const rest = await page.evaluate(() => __gp.restTarget);

  // Below the enter threshold, the displayed reticle remains at rest.
  let touch = await beginTouch(page, [430, 700], 11);
  await touch.move([430, 708]);
  let sample = await gestureSample(page);
  assert.equal(sample.gesture.phase, 'tracking');
  assert.equal(sample.gesture.valid, false);
  assertVector(sample.gesture.target, rest, 1e-5, 'deadzone rest target');
  assertVector(sample.reticle, rest, 1e-5, 'deadzone displayed reticle');
  await touch.cancel();
  await page.waitForFunction(() => __gp.mode === 'aim');

  // The same CURRENT pointer produces the same absolute target from varied Y starts.
  const end = [600, 540];
  const starts = [[600, 760], [600, 650], [600, 500]];
  const targets = [];
  const cameraSamples = [];
  for(let i = 0; i < starts.length; i++){
    touch = await beginTouch(page, starts[i], 20 + i);
    cameraSamples.push((await gestureSample(page)).camera);
    await touch.move(end);
    sample = await gestureSample(page);
    cameraSamples.push(sample.camera);
    assert.equal(sample.gesture.valid, true, `varied-start target ${i} must be valid`);
    assertVector(sample.reticle, sample.gesture.target, 1e-5, 'reticle world alignment');
    const reticleScreen = await screenForWorld(page, sample.reticle);
    assertVector(reticleScreen, end, 1.1, 'reticle finger alignment');
    targets.push(sample.gesture.target);
    await touch.cancel();
    await page.waitForFunction(() => __gp.mode === 'aim');
  }
  targets.slice(1).forEach((target, i) => assertVector(target, targets[0], 1e-5, `absolute target start ${i + 1}`));
  assertCameraLocked(cameraSamples);

  // Grabbing the displayed rest reticle keeps it in place until engagement,
  // then follows the absolute current point without a relative-delta snap.
  const restScreen = await screenForWorld(page, rest);
  const reticleEnd = [restScreen[0] + 24, restScreen[1] - 28];
  touch = await beginTouch(page, restScreen, 30);
  sample = await gestureSample(page);
  assertVector(sample.reticle, rest, 1e-5, 'reticle pointer-down rest');
  await touch.move(reticleEnd);
  const grabbed = await gestureSample(page);
  assert.equal(grabbed.gesture.valid, true);
  const grabbedScreen = await screenForWorld(page, grabbed.reticle);
  assertVector(grabbedScreen, reticleEnd, 1.1, 'grabbed reticle alignment');
  await touch.cancel();
  await page.waitForFunction(() => __gp.mode === 'aim');
  touch = await beginTouch(page, [reticleEnd[0], reticleEnd[1] + 100], 31);
  await touch.move(reticleEnd);
  const sameEndOtherStart = await gestureSample(page);
  assertVector(sameEndOtherStart.gesture.target, grabbed.gesture.target, 1e-5, 'grabbed absolute target independent of start');
  await touch.cancel();
  await page.waitForFunction(() => __gp.mode === 'aim');

  // Leave the deadzone, return inside it, then repeat the identical target.
  const originScreen = [600, 700], validScreen = [600, 560];
  touch = await beginTouch(page, originScreen, 40);
  await touch.move(validScreen);
  const first = await gestureSample(page);
  assert.equal(first.gesture.valid, true);
  await touch.move(originScreen);
  const returned = await gestureSample(page);
  assert.equal(returned.gesture.valid, false);
  assert.equal(returned.gesture.hasTarget, false);
  assert.equal(returned.gesture.power, 0);
  assert.equal(returned.gesture.lastInvalidReason, 'screen-deadzone');
  await touch.move(validScreen);
  const repeated = await gestureSample(page);
  assert.equal(repeated.gesture.valid, true);
  assertVector(repeated.gesture.target, first.gesture.target, 1e-5, 'repeated target after deadzone return');
  assert.ok(closeEnough(repeated.gesture.direction, first.gesture.direction, 1e-7), 'repeated direction changed');
  await touch.cancel();
  await page.waitForFunction(() => __gp.mode === 'aim');

  // Ball-near invalidity clears every accepted field and can recover repeatedly.
  const ballPlane = await page.evaluate(() => {
    const ball = __gp.ballState, planeY = __gp.gesture.planeY;
    return [ball.x, planeY, ball.z];
  });
  const ballScreen = await screenForWorld(page, ballPlane);
  touch = await beginTouch(page, [ballScreen[0], ballScreen[1] + 110], 50);
  await touch.move(ballScreen);
  const nearBall = await gestureSample(page);
  assert.equal(nearBall.gesture.valid, false);
  assert.equal(nearBall.gesture.hasTarget, false);
  assert.equal(nearBall.gesture.engaged, false);
  assert.equal(nearBall.gesture.power, 0);
  assert.equal(nearBall.gesture.lastInvalidReason, 'ball-near');
  await touch.move(restScreen);
  const recovered = await gestureSample(page);
  assert.equal(recovered.gesture.valid, true);
  await touch.move(ballScreen);
  assert.equal((await gestureSample(page)).gesture.valid, false);
  await touch.move(restScreen);
  const recoveredAgain = await gestureSample(page);
  assertVector(recoveredAgain.gesture.target, recovered.gesture.target, 1e-5, 'ball-near repeat target');
  assert.ok(closeEnough(recoveredAgain.gesture.direction, recovered.gesture.direction, 1e-7));
  await touch.cancel();
  await page.waitForFunction(() => __gp.mode === 'aim');

  // A horizon miss on move and final release must cancel, never fire stale aim.
  touch = await beginTouch(page, originScreen, 60);
  await touch.move(validScreen);
  assert.equal((await gestureSample(page)).gesture.valid, true);
  await touch.move([600, 80]);
  const missed = await gestureSample(page);
  assert.equal(missed.gesture.valid, false);
  assert.equal(missed.gesture.hasTarget, false);
  assert.equal(missed.gesture.power, 0);
  assert.equal(missed.gesture.lastInvalidReason, 'project-miss');
  await touch.end();
  await page.waitForFunction(() => __gp.mode === 'aim' && !__gp.dragging, { timeout: 5_000 });
  const afterMiss = await page.evaluate(() => ({ strokes: __gp.strokes, cancel: __gp.gesture.lastCancelReason, transition: __gp.lastTransition }));
  assert.equal(afterMiss.strokes, 0);
  assert.equal(afterMiss.cancel, 'project-miss');
  assert.match(afterMiss.transition.reason, /gesture-cancel:project-miss/);
  assert.deepEqual(errors, []);
  await page.close();
  return { targets, grabbed: grabbed.gesture.target, firstRepeat: first.gesture.target, afterMiss };
}

/* ---------------- ten real-touch shots + interpolation/lie gate ---------------- */
async function targetScreenForShortShot(page, side){
  return page.evaluate(({ side }) => {
    const ball = __gp.ballState;
    const gesture = __gp.gesture;
    const angle = __gp.aimDir + side * Math.PI / 2;
    const distance = 0.74;
    const point = new __dbg.THREE.Vector3(
      ball.x + Math.sin(angle) * distance,
      gesture.planeY,
      ball.z + Math.cos(angle) * distance,
    ).project(__dbg.camera);
    return [(point.x + 1) * innerWidth / 2, (1 - point.y) * innerHeight / 2];
  }, { side });
}

async function runManualShots(page, { count, offset }){
  let priorLie = await page.evaluate(() => __gp.lie);
  const originalTee = structuredClone(priorLie);
  const stableResetReason = await page.evaluate(() => __gp.lastResetReason);
  const shots = [];
  for(let i = 0; i < count; i++){
    const beforeStrokes = await page.evaluate(() => __gp.strokes);
    const end = await targetScreenForShortShot(page, (i + offset) % 2 ? 1 : -1);
    assert.ok(end[0] > 40 && end[0] < 1154 && end[1] > 80 && end[1] < 790, 'short-shot target must be on canvas');
    const startY = end[1] + 85 < 800 ? end[1] + 85 : end[1] - 85;
    const start = [end[0], startY];
    const touch = await beginTouch(page, start, 100 + offset * 10 + i);
    const cameras = [(await gestureSample(page)).camera];
    for(let step = 1; step <= 4; step++){
      await touch.move([
        start[0] + (end[0] - start[0]) * step / 4,
        start[1] + (end[1] - start[1]) * step / 4,
      ]);
      cameras.push((await gestureSample(page)).camera);
    }
    assert.equal((await gestureSample(page)).gesture.valid, true, `manual shot ${offset + i + 1} target`);
    assertCameraLocked(cameras);
    await touch.end();
    await page.waitForFunction(expected => __gp.mode === 'roll' && __gp.strokes === expected, { timeout: 10_000 }, beforeStrokes + 1);

    // Do not let interpolation pass on a stationary initial snapshot. Wait for
    // a genuine physics step whose previous/current states differ in space.
    await page.waitForFunction(() => {
      const value = __gp.presentation;
      return Math.hypot(
        value.current.x - value.previous.x,
        value.current.y - value.previous.y,
        value.current.z - value.previous.z,
      ) > 1e-5;
    }, { timeout: 5_000 });
    const interpolation = await page.evaluate(() => __gp.presentation);
    const interpolationSpan = Math.hypot(
      interpolation.current.x - interpolation.previous.x,
      interpolation.current.y - interpolation.previous.y,
      interpolation.current.z - interpolation.previous.z,
    );
    assert.ok(interpolationSpan > 1e-5, 'browser interpolation fixture is degenerate');
    for(const axis of ['x', 'y', 'z']){
      const expected = interpolation.previous[axis]
        + (interpolation.current[axis] - interpolation.previous[axis]) * interpolation.alpha;
      assert.ok(closeEnough(interpolation[axis], expected, 1e-9), `browser interpolation ${axis}`);
    }

    const origin = await page.evaluate(() => __gp.lastShotOrigin);
    assert.ok(closeEnough(origin.x, priorLie.x, 1e-5), 'manual shot origin x did not preserve lie');
    assert.ok(closeEnough(origin.y, priorLie.y, 1e-5), 'manual shot origin y did not preserve lie');
    assert.ok(closeEnough(origin.z, priorLie.z, 1e-5), 'manual shot origin z did not preserve lie');
    if(i === 1){
      assert.ok(
        Math.hypot(origin.x - originalTee.x, origin.y - originalTee.y, origin.z - originalTee.z) > 0.05,
        'manual shot 2 began at the original tee instead of the first settled lie',
      );
    }
    await page.waitForFunction(expected => __gp.mode === 'aim' && __gp.cameraReady && __gp.strokes === expected, { timeout: 30_000 }, beforeStrokes + 1);
    const settled = await page.evaluate(() => ({ lie: __gp.lie, resetReason: __gp.lastResetReason }));
    assert.equal(settled.lie.reason, 'settled');
    assert.ok(
      Math.hypot(
        settled.lie.x - origin.x,
        settled.lie.y - origin.y,
        settled.lie.z - origin.z,
      ) > 0.05,
      `manual shot ${offset + i + 1} did not move meaningfully before settling`,
    );
    assert.equal(
      settled.resetReason,
      stableResetReason,
      `manual shot ${offset + i + 1} changed lastResetReason without a hole/replay reset`,
    );
    priorLie = settled.lie;
    shots.push({ origin, lie: priorLie, interpolationSpan, resetReason: settled.resetReason });
  }
  return shots;
}

async function tenManualShotsGate(){
  const { page, errors } = await openGolf();
  await startToAim(page);
  const all = await runManualShots(page, { count: 7, offset: 0 });

  // The eighth-stroke pickup closes Hole 1 without counting as a manual test
  // shot; continue the same uninterrupted session with three shots on Hole 2.
  await page.evaluate(() => { __gp.setAuto(true); __gp.setWarp(10); });
  await page.waitForFunction(() => __gp.mode === 'sunk', { timeout: 30_000, polling: 100 });
  await page.evaluate(() => __gp.setAuto(false));
  await page.waitForFunction(() => __gp.mode === 'card', { timeout: 10_000 });
  await tapElement(page, '#btnNext');
  await page.waitForFunction(() => __gp.mode === 'aim' && __gp.cameraReady && __gp.hole === 2, { timeout: 10_000 });
  all.push(...await runManualShots(page, { count: 3, offset: 7 }));

  assert.equal(all.length, 10);
  assert.deepEqual(errors, []);
  await page.close();
  return all;
}

/* ---------------- cancellation paths ---------------- */
async function cancellationGate(){
  const { page, errors } = await openGolf();
  await startToAim(page);
  const strokes = await page.evaluate(() => __gp.strokes);
  let touch = await beginTouch(page, [620, 700], 201);
  await touch.move([620, 560]);
  await touch.cancel();
  await page.waitForFunction(() => __gp.mode === 'aim' && !__gp.dragging);
  let cancelled = await page.evaluate(() => ({ strokes: __gp.strokes, reason: __gp.gesture.lastCancelReason }));
  assert.deepEqual(cancelled, { strokes, reason: 'pointercancel' });

  await page.evaluate(() => {
    const canvas = document.getElementById('gl');
    const event = (type, id, x, y, target = canvas) => target.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y,
      bubbles: true, cancelable: true,
    }));
    event('pointerdown', 301, 620, 700);
    event('pointermove', 301, 620, 560, window);
    event('lostpointercapture', 301, 620, 560);
  });
  await page.waitForFunction(() => __gp.mode === 'aim' && !__gp.dragging);
  cancelled = await page.evaluate(() => ({ strokes: __gp.strokes, reason: __gp.gesture.lastCancelReason }));
  assert.deepEqual(cancelled, { strokes, reason: 'lostpointercapture' });

  touch = await beginTouch(page, [620, 700], 401);
  await touch.move([620, 560]);
  await touch.second([680, 600], 402);
  await touch.cancel().catch(() => {});
  await page.waitForFunction(() => __gp.mode === 'aim' && !__gp.dragging);
  cancelled = await page.evaluate(() => ({ strokes: __gp.strokes, reason: __gp.gesture.lastCancelReason }));
  assert.deepEqual(cancelled, { strokes, reason: 'multitouch' });
  await assertScreenAudit(page, 'aim cancellation');
  assert.deepEqual(errors, []);
  await page.close();
  return cancelled;
}

/* ---------------- completed-vs-cancelled UI + full round ---------------- */
async function cardReplayGate(){
  const { page, errors } = await openGolf();
  await assertScreenAudit(page, 'title');
  await canceledTouchOnElement(page, '#tapGo', 501);
  assert.equal(await page.evaluate(() => __gp.mode), 'title', 'cancelled title touch must not activate');
  await startToAim(page);

  // Reach Hole 1 card, but disable AUTO before card entry so its task is never armed.
  await page.evaluate(() => { __gp.setAuto(true); __gp.setWarp(10); });
  await page.waitForFunction(() => __gp.mode === 'sunk', { timeout: 60_000, polling: 100 });
  await page.evaluate(() => __gp.setAuto(false));
  await page.waitForFunction(() => __gp.mode === 'card', { timeout: 10_000 });
  await assertScreenAudit(page, 'hole card');
  const beforeNext = await page.evaluate(() => ({ mode: __gp.mode, hole: __gp.hole, origin: __gp.lastShotOrigin }));
  assert.ok(beforeNext.origin, 'completed Hole 1 must have a shot origin');
  await canceledTouchOnElement(page, '#btnNext', 502);
  assert.deepEqual(await page.evaluate(() => ({ mode: __gp.mode, hole: __gp.hole })), { mode: 'card', hole: 1 }, 'cancelled Next touch activated');
  await tapElement(page, '#btnNext');
  await page.waitForFunction(() => __gp.mode === 'aim' && __gp.cameraReady && __gp.hole === 2, { timeout: 10_000 });
  const next = await page.evaluate(() => ({ hole: __gp.hole, strokes: __gp.strokes, origin: __gp.lastShotOrigin, reset: __gp.lastResetReason }));
  assert.deepEqual(next, { hole: 2, strokes: 0, origin: null, reset: 'next-button' });

  await page.evaluate(() => { __gp.setAuto(true); __gp.setWarp(10); });
  await page.waitForFunction(() => __gp.mode === 'results', { timeout: 120_000, polling: 150 });
  await page.evaluate(() => __gp.setAuto(false));
  await assertScreenAudit(page, 'results');
  const final = await page.evaluate(() => ({ hole: __gp.hole, total: __gp.total, mode: __gp.mode }));
  assert.equal(final.hole, 6);
  assert.ok(final.total > 0);
  await canceledTouchOnElement(page, '#btnAgain', 503);
  assert.equal(await page.evaluate(() => __gp.mode), 'results', 'cancelled Play Again touch activated');
  await tapElement(page, '#btnAgain');
  await page.waitForFunction(() => __gp.mode === 'aim' && __gp.cameraReady && __gp.hole === 1, { timeout: 10_000 });
  const replay = await page.evaluate(() => ({
    hole: __gp.hole, strokes: __gp.strokes, total: __gp.total,
    origin: __gp.lastShotOrigin, reset: __gp.lastResetReason,
    lie: __gp.lie, camera: __gp.camTransform, spring: __gp.springState,
  }));
  assert.equal(replay.strokes, 0);
  assert.equal(replay.total, 0);
  assert.equal(replay.origin, null);
  assert.equal(replay.reset, 'play-again-button');
  assert.equal(replay.lie.reason, 'play-again-button');
  assertVector(replay.camera.position, replay.spring.position, 1e-5, 'replay camera/spring');
  assert.ok(closeEnough(replay.camera.fov, replay.spring.fov, 1e-5));
  assert.deepEqual(errors, []);
  await page.close();
  return { beforeNext, next, final, replay };
}

try {
  const pure = pureSimulationGate();
  artifactServer = await createFreshArtifactServer();
  browser = await puppeteer.launch({
    headless: true,
    executablePath: resolveChromeExecutable(),
    protocolTimeout: 180_000,
    args: ['--no-sandbox', '--mute-audio'],
  });
  const absolute = await absoluteTargetGate();
  const manual = await tenManualShotsGate();
  const cancellation = await cancellationGate();
  const flow = await cardReplayGate();
  const manualEvidence = {
    count: manual.length,
    minDisplacement: Math.min(...manual.map(shot => Math.hypot(
      shot.lie.x - shot.origin.x,
      shot.lie.y - shot.origin.y,
      shot.lie.z - shot.origin.z,
    ))),
    minInterpolationSpan: Math.min(...manual.map(shot => shot.interpolationSpan)),
    resetReasons: [...new Set(manual.map(shot => shot.resetReason))],
    shot2OriginDistanceFromTee: Math.hypot(
      manual[1].origin.x - manual[0].origin.x,
      manual[1].origin.y - manual[0].origin.y,
      manual[1].origin.z - manual[0].origin.z,
    ),
  };
  const result = {
    ok: true,
    mode: CANDIDATE_MODE ? 'candidate' : 'standalone',
    releaseEligible: !CANDIDATE_MODE,
    freshArtifactSha256: artifactServer.hash,
    pure: {
      lie: pure.sixty.state,
      mixedFrames: pure.mixed.frames,
      stallDropped: pure.stalled.runner.droppedTime,
      interpolationAlpha: pure.interpolationAlpha,
    },
    absolute,
    manualShots: manualEvidence,
    cancellation,
    flow,
  };
  if(CANDIDATE_MODE){
    const envelope = {
      version: 1,
      mode: 'candidate',
      releaseEligible: false,
      world: 'golf',
      candidateFresh: { sha256: artifactServer.hash },
      result,
    };
    const pending = `${CANDIDATE_REPORT_PATH}.pending-${process.pid}`;
    await writeFile(pending, `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx' });
    await rename(pending, CANDIDATE_REPORT_PATH);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await artifactServer?.close();
}
