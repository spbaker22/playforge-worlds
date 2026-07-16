/* Stackyard Golf — pure numeric ball simulation. No DOM, Three, audio, FX, camera, or flow. */

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (value, min, max) => {
  const t = clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
};

export function heightLocal(hole, x, z){
  let y = hole.tilt[0] * x + hole.tilt[1] * z;
  for(const mound of hole.mounds){
    const dx = x - mound.x, dz = z - mound.z;
    y += mound.a * Math.exp(-(dx * dx + dz * dz) / (2 * mound.s * mound.s));
  }
  for(const step of hole.steps){
    y += step.h * smoothstep(z, step.z0 - step.w / 2, step.z0 + step.w / 2);
  }
  const dx = x - hole.cup[0], dz = z - hole.cup[1];
  y -= 0.06 * Math.exp(-(dx * dx + dz * dz) / (2 * 0.9 * 0.9));
  return y;
}

export function gradLocal(hole, x, z){
  const epsilon = 0.18;
  return [
    (heightLocal(hole, x + epsilon, z) - heightLocal(hole, x - epsilon, z)) / (2 * epsilon),
    (heightLocal(hole, x, z + epsilon) - heightLocal(hole, x, z - epsilon)) / (2 * epsilon),
  ];
}

export function worldToLocal(hole, worldX, worldZ){
  const cos = Math.cos(hole.yaw), sin = Math.sin(hole.yaw);
  const dx = worldX - hole.org[0], dz = worldZ - hole.org[1];
  return [dx * cos - dz * sin, dx * sin + dz * cos];
}

export function localToWorld(hole, localX, localZ){
  const cos = Math.cos(hole.yaw), sin = Math.sin(hole.yaw);
  return [
    hole.org[0] + localX * cos + localZ * sin,
    hole.org[1] + (-localX * sin + localZ * cos),
  ];
}

export function copyBallState(source){
  return {
    x: source.x,
    y: source.y,
    z: source.z,
    vx: source.vx,
    vz: source.vz,
    v: source.v,
    rollT: source.rollT,
  };
}

/**
 * Deterministically reduce one fixed physics step. The input is never mutated;
 * presentation consumes returned events after adopting `state`.
 */
export function stepGolfBall(input, {
  hole,
  walls,
  ballRadius = 0.34,
  gravity = 9.8,
  cupCaptureRadius = 0.40,
  cupCaptureMaxSpeed = 4.6,
  cupLipRadius = 0.58,
} = {}, dt){
  if(!hole || !Array.isArray(walls)) throw new TypeError('stepGolfBall requires hole data and walls');
  if(!Number.isFinite(dt) || dt <= 0) throw new RangeError('stepGolfBall dt must be positive');

  const state = copyBallState(input);
  const events = [];
  let [localX, localZ] = worldToLocal(hole, state.x, state.z);
  const [gradientX, gradientZ] = gradLocal(hole, localX, localZ);
  const cos = Math.cos(hole.yaw), sin = Math.sin(hole.yaw);
  const worldGradientX = gradientX * cos + gradientZ * sin;
  const worldGradientZ = -gradientX * sin + gradientZ * cos;
  state.vx += -gravity * worldGradientX * dt;
  state.vz += -gravity * worldGradientZ * dt;

  const speedBeforeFriction = Math.hypot(state.vx, state.vz);
  if(speedBeforeFriction > 0.001){
    const deceleration = (1.35 + 0.05 * speedBeforeFriction + (speedBeforeFriction < 1.8 ? 1.4 : 0)) * dt;
    const speedAfterFriction = Math.max(0, speedBeforeFriction - deceleration);
    state.vx *= speedAfterFriction / speedBeforeFriction;
    state.vz *= speedAfterFriction / speedBeforeFriction;
  }

  state.x += state.vx * dt;
  state.z += state.vz * dt;
  [localX, localZ] = worldToLocal(hole, state.x, state.z);

  const collisionRadius = ballRadius + 0.22;
  for(const [x1, z1, x2, z2] of walls){
    const edgeX = x2 - x1, edgeZ = z2 - z1;
    const lengthSquared = edgeX * edgeX + edgeZ * edgeZ;
    if(lengthSquared < 1e-6) continue;
    const along = clamp(((localX - x1) * edgeX + (localZ - z1) * edgeZ) / lengthSquared, 0, 1);
    const closestX = x1 + edgeX * along, closestZ = z1 + edgeZ * along;
    let normalLocalX = localX - closestX, normalLocalZ = localZ - closestZ;
    const distance = Math.hypot(normalLocalX, normalLocalZ);
    if(distance >= collisionRadius || distance <= 1e-5) continue;

    normalLocalX /= distance;
    normalLocalZ /= distance;
    localX = closestX + normalLocalX * collisionRadius;
    localZ = closestZ + normalLocalZ * collisionRadius;
    const normalWorldX = normalLocalX * cos + normalLocalZ * sin;
    const normalWorldZ = -normalLocalX * sin + normalLocalZ * cos;
    const normalVelocity = state.vx * normalWorldX + state.vz * normalWorldZ;
    if(normalVelocity < 0){
      state.vx -= 1.55 * normalVelocity * normalWorldX;
      state.vz -= 1.55 * normalVelocity * normalWorldZ;
      state.vx *= 0.94;
      state.vz *= 0.94;
      const impulse = -normalVelocity;
      if(impulse > 2.2) events.push({ type: 'wall-impact', impulse });
    }
    [state.x, state.z] = localToWorld(hole, localX, localZ);
  }

  state.v = Math.hypot(state.vx, state.vz);
  state.y = hole.base + heightLocal(hole, localX, localZ) + ballRadius;

  const cupDeltaX = localX - hole.cup[0], cupDeltaZ = localZ - hole.cup[1];
  const cupDistance = Math.hypot(cupDeltaX, cupDeltaZ);
  if(cupDistance < cupCaptureRadius && state.v < cupCaptureMaxSpeed){
    events.push({ type: 'holed' });
    return { state, events, terminal: 'holed' };
  }

  if(cupDistance < cupLipRadius && state.v >= cupCaptureMaxSpeed && cupDistance > 1e-8){
    const normalLocalX = cupDeltaX / cupDistance, normalLocalZ = cupDeltaZ / cupDistance;
    const normalWorldX = normalLocalX * cos + normalLocalZ * sin;
    const normalWorldZ = -normalLocalX * sin + normalLocalZ * cos;
    const normalVelocity = state.vx * normalWorldX + state.vz * normalWorldZ;
    if(normalVelocity < 0){
      state.vx -= 1.5 * normalVelocity * normalWorldX;
      state.vz -= 1.5 * normalVelocity * normalWorldZ;
      state.vx *= 0.72;
      state.vz *= 0.72;
      state.v = Math.hypot(state.vx, state.vz);
      events.push({ type: 'lip-out' });
    }
  }

  state.rollT += dt;
  if(state.v < 0.14 && state.rollT > 0.5){
    state.vx = 0;
    state.vz = 0;
    state.v = 0;
    events.push({ type: 'settled' });
    return { state, events, terminal: 'settled' };
  }

  return { state, events, terminal: null };
}
