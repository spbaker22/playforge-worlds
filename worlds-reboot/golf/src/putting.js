/* Stackyard Golf — shared putting power and terrain-guide helpers. */

const clamp01 = value => Math.max(0, Math.min(1, value));

export const MIN_SHOT_SPEED = 0.85;
export const MAX_SHOT_SPEED = 15.4;
export const SHOT_SPEED_RANGE = MAX_SHOT_SPEED - MIN_SHOT_SPEED;
export const MIN_TARGET_DISTANCE = 0.18;
export const MAX_TARGET_DISTANCE = 9.2;
export const MOUSE_AIM_ENTER_PX = 4;
export const MOUSE_AIM_EXIT_PX = 2;

export const AIM_GUIDE_SEGMENTS = 24;
export const AIM_GUIDE_WIDTH = 0.34;
export const AIM_GUIDE_LIFT = 0.085;

export function shotSpeedFromPower(power){
  return MIN_SHOT_SPEED + clamp01(power) * SHOT_SPEED_RANGE;
}

export function shotPowerFromSpeed(speed){
  return clamp01((speed - MIN_SHOT_SPEED) / SHOT_SPEED_RANGE);
}

export function targetPowerFromDistance(
  distance,
  minDistance = MIN_TARGET_DISTANCE,
  maxDistance = MAX_TARGET_DISTANCE,
){
  return clamp01((distance - minDistance) / (maxDistance - minDistance));
}

export function terrainHeightAtWorld(worldX, worldZ, toLocal, groundY, localScratch){
  const local = toLocal(worldX, worldZ, localScratch);
  return groundY(local[0], local[1]);
}

/**
 * Fill a reusable strip buffer with a terrain-following world-space ribbon.
 * The caller owns both buffers, so the animation loop performs no allocation.
 */
export function writeTerrainGuidePositions(
  positions,
  segments,
  startX,
  startZ,
  endX,
  endZ,
  width,
  lift,
  toLocal,
  groundY,
  localScratch,
){
  const expectedLength = (segments + 1) * 2 * 3;
  if(positions.length !== expectedLength) throw new RangeError(`guide position buffer must contain ${expectedLength} values`);
  const deltaX = endX - startX;
  const deltaZ = endZ - startZ;
  const length = Math.hypot(deltaX, deltaZ);
  const directionX = length > 1e-8 ? deltaX / length : 0;
  const directionZ = length > 1e-8 ? deltaZ / length : 1;
  const perpendicularX = directionZ;
  const perpendicularZ = -directionX;
  const halfWidth = width * 0.5;

  for(let sample = 0; sample <= segments; sample += 1){
    const along = sample / segments;
    const centerX = startX + deltaX * along;
    const centerZ = startZ + deltaZ * along;
    const leftX = centerX - perpendicularX * halfWidth;
    const leftZ = centerZ - perpendicularZ * halfWidth;
    const rightX = centerX + perpendicularX * halfWidth;
    const rightZ = centerZ + perpendicularZ * halfWidth;
    const offset = sample * 6;
    positions[offset] = leftX;
    positions[offset + 1] = terrainHeightAtWorld(leftX, leftZ, toLocal, groundY, localScratch) + lift;
    positions[offset + 2] = leftZ;
    positions[offset + 3] = rightX;
    positions[offset + 4] = terrainHeightAtWorld(rightX, rightZ, toLocal, groundY, localScratch) + lift;
    positions[offset + 5] = rightZ;
  }

  return positions;
}
