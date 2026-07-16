import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { HOLES, frames, heightLocal } from './src/course.js';
import { AIM_GUIDE_LIFT, AIM_GUIDE_SEGMENTS } from './src/putting.js';

const BASE = process.argv[2] || 'http://127.0.0.1:8091/preview-dist/family-preview-20260715-5/golf/';
const SCREENSHOT = process.argv[3] || '/tmp/playforge-golf-hole2-desktop-drag-fixed.png';
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(existsSync);
if(!CHROME) throw new Error('Chrome was not found');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const urlForHole = hole => {
  const url = new URL(BASE);
  url.search = new URLSearchParams({
    preview: '1',
    sound: 'off',
    quality: 'performance',
    golfFormat: 'practice',
    golfHole: String(hole),
    golfCup: 'family',
    golfRivals: 'relaxed',
  });
  return url.href;
};

async function openReady(page, hole){
  await page.goto(urlForHole(hole), { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => window.__gp?.mode === 'title', { timeout: 60_000 });
  await page.click('#tapGo');
  await page.waitForFunction(() => __gp.mode === 'aim' && __gp.cameraReady, { timeout: 30_000 });
}

async function project(page, distance, angle = null){
  return page.evaluate(({ targetDistance, requestedAngle }) => {
    const ball = __gp.ballState;
    const direction = requestedAngle ?? __gp.aimDir;
    const world = new __dbg.THREE.Vector3(
      ball.x + Math.sin(direction) * targetDistance,
      ball.y - 0.30,
      ball.z + Math.cos(direction) * targetDistance,
    );
    world.project(__dbg.camera);
    const rect = document.getElementById('gl').getBoundingClientRect();
    return {
      x: rect.left + (world.x + 1) * rect.width / 2,
      y: rect.top + (1 - world.y) * rect.height / 2,
      angle: direction,
    };
  }, { targetDistance: distance, requestedAngle: angle });
}

async function cancelMouse(page){
  await page.evaluate(() => __gp.cancelGesture('focused-browser-check'));
  await page.mouse.up();
  await page.waitForFunction(() => __gp.mode === 'aim' && !__gp.dragging);
}

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: CHROME,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
});

const errors = [];
try {
  const desktop = await browser.newPage();
  desktop.on('pageerror', error => errors.push(`desktop: ${error.message}`));
  await desktop.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
  await openReady(desktop, 2);

  const canvasCenter = await desktop.$eval('#gl', canvas => {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.5 };
  });
  await desktop.mouse.move(canvasCenter.x, canvasCenter.y);
  await desktop.mouse.down();
  await desktop.mouse.move(canvasCenter.x + 3, canvasCenter.y);
  assert.equal(await desktop.evaluate(() => __gp.gesture.targeting), false, '3px mouse move should remain below engagement');
  await desktop.mouse.move(canvasCenter.x + 4, canvasCenter.y);
  assert.equal(await desktop.evaluate(() => __gp.gesture.targeting), true, '4px mouse move should engage aiming');
  await desktop.mouse.move(canvasCenter.x + 1, canvasCenter.y);
  assert.equal(await desktop.evaluate(() => __gp.gesture.targeting), false, '1px mouse return should exit through hysteresis');
  await cancelMouse(desktop);

  const closeCases = [];
  for(const distance of [0.20, 0.30, 0.48, 0.50, 0.75]){
    const release = await project(desktop, distance);
    await desktop.mouse.move(release.x - 8, release.y);
    await desktop.mouse.down();
    await desktop.mouse.move(release.x, release.y, { steps: 2 });
    await sleep(25);
    const state = await desktop.evaluate(() => ({
      targeting: __gp.gesture.targeting,
      valid: __gp.gesture.valid,
      pointerType: __gp.gesture.session.pointerType,
      rawDistance: __gp.gesture.rawDistance,
      power: __gp.power,
      target: __gp.aimTarget,
    }));
    assert.equal(state.pointerType, 'mouse');
    assert.equal(state.targeting, true);
    assert.equal(state.valid, true, `${distance}m desktop target should be valid`);
    assert.ok(Math.abs(state.rawDistance - distance) < 0.006, `${distance}m projected target resolved to ${state.rawDistance}`);
    assert.ok(state.power > 0, `${distance}m desktop target should have nonzero power`);
    closeCases.push({ distance, rawDistance: state.rawDistance, power: state.power });
    await cancelMouse(desktop);
  }

  const correctionTarget = await project(desktop, 0.50);
  await desktop.mouse.move(correctionTarget.x - 8, correctionTarget.y);
  await desktop.mouse.down();
  await desktop.mouse.move(correctionTarget.x, correctionTarget.y);
  const beforeCorrection = await desktop.evaluate(() => __gp.gesture.currentWorld);
  await desktop.mouse.move(correctionTarget.x + 1, correctionTarget.y);
  const afterCorrection = await desktop.evaluate(() => __gp.gesture.currentWorld);
  assert.notDeepEqual(afterCorrection, beforeCorrection, '1px engaged mouse correction should update the world target');
  assert.equal(await desktop.evaluate(() => __gp.gesture.valid), true);
  await cancelMouse(desktop);

  const uphillLocalX = -2.5, uphillLocalZ = 7.2;
  const uphillWorldX = uphillLocalX * Math.cos(HOLES[1].yaw) + uphillLocalZ * Math.sin(HOLES[1].yaw);
  const uphillWorldZ = -uphillLocalX * Math.sin(HOLES[1].yaw) + uphillLocalZ * Math.cos(HOLES[1].yaw);
  const uphillDirection = Math.atan2(uphillWorldX, uphillWorldZ);
  const uphillTarget = await project(desktop, Math.hypot(uphillLocalX, uphillLocalZ), uphillDirection);
  await desktop.mouse.move(uphillTarget.x - 52, uphillTarget.y + 18);
  await desktop.mouse.down();
  await desktop.mouse.move(uphillTarget.x, uphillTarget.y, { steps: 4 });
  await sleep(80);
  assert.equal(await desktop.evaluate(() => __gp.gesture.valid), true);
  await desktop.screenshot({ path: SCREENSHOT });

  const guide = await desktop.evaluate(expectedCount => {
    let ribbon = null;
    let ring = null;
    __dbg.scene.traverse(object => {
      if(!object.isMesh || !object.material?.color) return;
      const color = object.material.color.getHex();
      if(color === 0xffe2b0 && object.geometry?.attributes?.position?.count === expectedCount) ribbon = object;
      if(color === 0xffc96b) ring = object;
    });
    if(!ribbon || !ring) throw new Error('terrain guide meshes were not found');
    ribbon.updateMatrixWorld(true);
    const point = new __dbg.THREE.Vector3();
    const attribute = ribbon.geometry.attributes.position;
    const vertices = [];
    for(let index = 0; index < attribute.count; index += 1){
      point.fromBufferAttribute(attribute, index).applyMatrix4(ribbon.matrixWorld);
      vertices.push([point.x, point.y, point.z]);
    }
    return {
      vertices,
      depthTest: ribbon.material.depthTest,
      depthWrite: ribbon.material.depthWrite,
      ringY: ring.position.y,
      target: __gp.aimTarget,
    };
  }, (AIM_GUIDE_SEGMENTS + 1) * 2);
  assert.equal(guide.depthTest, true, 'terrain guide should still be occluded by walls and hedges');
  assert.equal(guide.depthWrite, false);
  const hole = HOLES[1];
  const frame = frames()[1];
  const localScratch = [0, 0];
  const clearances = guide.vertices.map(([x, y, z]) => {
    const [localX, localZ] = frame.toLocal(x, z, localScratch);
    return y - (hole.base + heightLocal(hole, localX, localZ));
  });
  assert.ok(Math.min(...clearances) > AIM_GUIDE_LIFT - 2e-5);
  assert.ok(Math.max(...clearances) < AIM_GUIDE_LIFT + 2e-5);
  const ribbonY = guide.vertices.map(vertex => vertex[1]);
  assert.ok(Math.max(...ribbonY) - Math.min(...ribbonY) > 0.25, 'held Hole 2 ribbon should rise over the mound');
  const [targetLocalX, targetLocalZ] = frame.toLocal(guide.target[0], guide.target[2], localScratch);
  const targetGround = hole.base + heightLocal(hole, targetLocalX, targetLocalZ);
  assert.ok(Math.abs(guide.ringY - targetGround - AIM_GUIDE_LIFT) < 2e-5, 'target ring should sit at terrain height');
  await cancelMouse(desktop);

  const closeOrigin = await desktop.evaluate(() => __gp.ballState);
  const playableTarget = await project(desktop, 0.50);
  await desktop.mouse.move(playableTarget.x - 8, playableTarget.y);
  await desktop.mouse.down();
  await desktop.mouse.move(playableTarget.x, playableTarget.y, { steps: 2 });
  await desktop.mouse.up();
  await desktop.waitForFunction(() => __gp.mode === 'aim' && __gp.cameraReady && __gp.strokes === 1, { timeout: 15_000 });
  const closeResult = await desktop.evaluate(() => ({ lie: __gp.lie, origin: __gp.lastShotOrigin, strokes: __gp.strokes }));
  const closeTravel = Math.hypot(closeResult.lie.x - closeOrigin.x, closeResult.lie.z - closeOrigin.z);
  assert.equal(closeResult.strokes, 1);
  assert.equal(closeResult.origin.strokesBefore, 0);
  assert.ok(closeTravel > 0.10 && closeTravel < 1.0, `0.50m desktop putt should settle locally, travelled ${closeTravel}m`);
  const secondPlayableTarget = await project(desktop, 0.50);
  await desktop.mouse.move(secondPlayableTarget.x - 8, secondPlayableTarget.y);
  await desktop.mouse.down();
  await desktop.mouse.move(secondPlayableTarget.x, secondPlayableTarget.y, { steps: 2 });
  await desktop.mouse.up();
  await desktop.waitForFunction(() => __gp.mode === 'aim' && __gp.cameraReady && __gp.strokes === 2, { timeout: 15_000 });
  const secondCloseResult = await desktop.evaluate(() => ({ lie: __gp.lie, origin: __gp.lastShotOrigin, strokes: __gp.strokes }));
  const secondOriginDrift = Math.hypot(secondCloseResult.origin.x - closeResult.lie.x, secondCloseResult.origin.z - closeResult.lie.z);
  const secondCloseTravel = Math.hypot(secondCloseResult.lie.x - closeResult.lie.x, secondCloseResult.lie.z - closeResult.lie.z);
  assert.equal(secondCloseResult.strokes, 2);
  assert.equal(secondCloseResult.origin.strokesBefore, 1);
  assert.ok(secondOriginDrift < 1e-6, `stroke 2 should begin at stroke 1's lie, drifted ${secondOriginDrift}m`);
  assert.ok(secondCloseTravel > 0.10 && secondCloseTravel < 1.0, `second 0.50m desktop putt should settle locally, travelled ${secondCloseTravel}m`);

  const touch = await browser.newPage();
  touch.on('pageerror', error => errors.push(`touch: ${error.message}`));
  await touch.setViewport({ width: 1024, height: 768, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await openReady(touch, 1);
  const touchTarget = await project(touch, 0.74);
  const client = await touch.createCDPSession();
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  const point = (x, y) => ({ x, y, radiusX: 8, radiusY: 8, force: 0.65, id: 91 });
  const startX = touchTarget.x - 72, startY = touchTarget.y;
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(startX, startY)] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(startX + 8, startY)] });
  await sleep(25);
  assert.equal(await touch.evaluate(() => __gp.gesture.targeting), false, '8px touch move should retain the existing touch deadzone');
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(touchTarget.x, touchTarget.y)] });
  await sleep(25);
  const touchState = await touch.evaluate(() => ({
    targeting: __gp.gesture.targeting,
    valid: __gp.gesture.valid,
    pointerType: __gp.gesture.session.pointerType,
    rawDistance: __gp.gesture.rawDistance,
  }));
  assert.equal(touchState.pointerType, 'touch');
  assert.equal(touchState.targeting, true);
  assert.equal(touchState.valid, true);
  assert.ok(Math.abs(touchState.rawDistance - 0.74) < 0.008);
  await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await client.detach();
  await touch.waitForFunction(() => __gp.mode === 'aim' && !__gp.dragging);

  assert.deepEqual(errors, []);
  process.stdout.write(`${JSON.stringify({ closeCases, closeTravel, secondCloseTravel, secondOriginDrift, guide: {
    minClearance: Math.min(...clearances),
    maxClearance: Math.max(...clearances),
    yRange: Math.max(...ribbonY) - Math.min(...ribbonY),
    screenshot: path.resolve(SCREENSHOT),
  }, touch: touchState }, null, 2)}\n`);
} finally {
  await browser.close();
}
