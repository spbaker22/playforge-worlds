import assert from 'node:assert/strict';
import test from 'node:test';
import { HOLES, frames, heightLocal } from './course.js';
import {
  AIM_GUIDE_LIFT,
  AIM_GUIDE_SEGMENTS,
  AIM_GUIDE_WIDTH,
  MAX_SHOT_SPEED,
  MAX_TARGET_DISTANCE,
  MIN_SHOT_SPEED,
  MIN_TARGET_DISTANCE,
  MOUSE_AIM_ENTER_PX,
  MOUSE_AIM_EXIT_PX,
  shotPowerFromSpeed,
  shotSpeedFromPower,
  targetPowerFromDistance,
  writeTerrainGuidePositions,
} from './putting.js';

test('close target distances produce smooth, playable low-speed putts', () => {
  assert.equal(MIN_TARGET_DISTANCE, 0.18);
  assert.equal(MOUSE_AIM_ENTER_PX, 4);
  assert.equal(MOUSE_AIM_EXIT_PX, 2);
  assert.equal(shotSpeedFromPower(0), MIN_SHOT_SPEED);
  assert.equal(shotSpeedFromPower(1), MAX_SHOT_SPEED);
  assert.equal(shotPowerFromSpeed(MIN_SHOT_SPEED), 0);
  assert.equal(shotPowerFromSpeed(MAX_SHOT_SPEED), 1);

  const distances = [0.20, 0.30, 0.48, 0.50, 0.75];
  const speeds = distances.map(distance => {
    const power = targetPowerFromDistance(distance, MIN_TARGET_DISTANCE, MAX_TARGET_DISTANCE);
    assert.ok(power > 0, `${distance}m target must be playable`);
    return shotSpeedFromPower(power);
  });
  for(let index = 1; index < speeds.length; index += 1){
    assert.ok(speeds[index] > speeds[index - 1], 'close-putt speed mapping must be monotonic');
  }
  assert.ok(speeds[0] < 0.9, `0.20m putt speed ${speeds[0]} should stay near the low-speed floor`);
  assert.ok(speeds.at(-1) < 1.8, `0.75m putt speed ${speeds.at(-1)} should remain controllable`);
});

test('Hole 2 guide ribbon follows the mound with fixed terrain clearance', () => {
  const hole = HOLES[1];
  const frame = frames()[1];
  const start = frame.toWorld(0, 1);
  const end = frame.toWorld(0, 15);
  const positions = new Float32Array((AIM_GUIDE_SEGMENTS + 1) * 2 * 3);
  const localScratch = [0, 0];
  const toLocalResult = frame.toLocal(start[0], start[1], localScratch);
  assert.equal(toLocalResult, localScratch, 'terrain sampling should reuse caller scratch storage');

  writeTerrainGuidePositions(
    positions,
    AIM_GUIDE_SEGMENTS,
    start[0],
    start[1],
    end[0],
    end[1],
    AIM_GUIDE_WIDTH,
    AIM_GUIDE_LIFT,
    frame.toLocal,
    (x, z) => hole.base + heightLocal(hole, x, z),
    localScratch,
  );

  let minY = Infinity, maxY = -Infinity;
  for(let vertex = 0; vertex < positions.length; vertex += 3){
    const x = positions[vertex], y = positions[vertex + 1], z = positions[vertex + 2];
    const [localX, localZ] = frame.toLocal(x, z, localScratch);
    const clearance = y - (hole.base + heightLocal(hole, localX, localZ));
    assert.ok(Math.abs(clearance - AIM_GUIDE_LIFT) < 2e-5, `guide clearance drifted to ${clearance}`);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  assert.ok(maxY - minY > 0.25, 'Hole 2 guide must visibly rise over the mound instead of remaining flat');
});
