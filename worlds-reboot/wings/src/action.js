/* PAPER WINGS - single-pointer drag grammar with deterministic spring centering. */

const CONTROL_PROFILES = Object.freeze({
  guided: Object.freeze({ maxBank: 0.72, maxPitch: 0.56, follow: 11.5, center: 4.8 }),
  direct: Object.freeze({ maxBank: 1.0, maxPitch: 0.82, follow: 15.0, center: 2.8 }),
});

export const CONTROL_ORB_RADIUS = 42;

const approach = (current, target, rate, dt) => target + (current - target) * Math.exp(-rate * dt);

export function wingControlTargets(control, dx, dy, radius = CONTROL_ORB_RADIUS){
  if(!Number.isFinite(dx) || !Number.isFinite(dy)) throw new TypeError('control deltas must be finite');
  if(!Number.isFinite(radius) || radius <= 0) throw new RangeError('control radius must be positive');
  const normalized = control === 'direct' ? 'direct' : 'guided';
  const profile = CONTROL_PROFILES[normalized];
  const distance = Math.hypot(dx, dy);
  const indicatorScale = distance > radius ? radius / distance : 1;
  const indicatorX = dx * indicatorScale;
  const indicatorY = dy * indicatorScale;
  return Object.freeze({
    control: normalized,
    radius,
    indicatorX,
    indicatorY,
    targetBank: indicatorX === 0 ? 0 : indicatorX / radius * profile.maxBank,
    targetPitch: indicatorY === 0 ? 0 : -indicatorY / radius * profile.maxPitch,
  });
}

export function createWingActionController({ control = 'guided', dragSpan = CONTROL_ORB_RADIUS } = {}){
  const normalizedControl = control === 'direct' ? 'direct' : 'guided';
  const profile = CONTROL_PROFILES[normalizedControl];
  if(!Number.isFinite(dragSpan) || dragSpan <= 0) throw new RangeError('dragSpan must be positive');
  const state = {
    active: false,
    pointerId: null,
    originX: 0,
    originY: 0,
    currentX: 0,
    currentY: 0,
    targetBank: 0,
    targetPitch: 0,
    indicatorX: 0,
    indicatorY: 0,
    bank: 0,
    pitch: 0,
    sequence: 0,
    samples: 0,
    lastEndReason: 'initial',
  };

  function updateTargets(x, y){
    const target = wingControlTargets(normalizedControl, x - state.originX, y - state.originY, dragSpan);
    state.targetBank = target.targetBank;
    state.targetPitch = target.targetPitch;
    state.indicatorX = target.indicatorX;
    state.indicatorY = target.indicatorY;
  }

  function begin(pointerId, x, y){
    if(state.active || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    state.active = true;
    state.pointerId = pointerId;
    state.originX = state.currentX = x;
    state.originY = state.currentY = y;
    state.targetBank = 0;
    state.targetPitch = 0;
    state.indicatorX = 0;
    state.indicatorY = 0;
    state.sequence += 1;
    state.samples = 1;
    state.lastEndReason = null;
    return true;
  }

  function move(pointerId, x, y){
    if(!state.active || pointerId !== state.pointerId || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    state.currentX = x;
    state.currentY = y;
    state.samples += 1;
    updateTargets(x, y);
    return true;
  }

  function end(pointerId, reason = 'release'){
    if(!state.active || pointerId !== state.pointerId) return false;
    state.active = false;
    state.pointerId = null;
    state.targetBank = 0;
    state.targetPitch = 0;
    state.indicatorX = 0;
    state.indicatorY = 0;
    state.lastEndReason = reason;
    return true;
  }

  function cancel(reason = 'cancel'){
    if(!state.active){
      state.targetBank = 0;
      state.targetPitch = 0;
      state.indicatorX = 0;
      state.indicatorY = 0;
      state.lastEndReason = reason;
      return false;
    }
    return end(state.pointerId, reason);
  }

  function reset(reason = 'reset'){
    state.active = false;
    state.pointerId = null;
    state.originX = 0;
    state.originY = 0;
    state.currentX = 0;
    state.currentY = 0;
    state.targetBank = 0;
    state.targetPitch = 0;
    state.indicatorX = 0;
    state.indicatorY = 0;
    state.bank = 0;
    state.pitch = 0;
    state.samples = 0;
    state.lastEndReason = reason;
    return snapshot();
  }

  function tick(dt){
    if(!Number.isFinite(dt) || dt < 0) throw new RangeError('dt must be non-negative');
    const rate = state.active ? profile.follow : profile.center;
    state.bank = approach(state.bank, state.targetBank, rate, dt);
    state.pitch = approach(state.pitch, state.targetPitch, rate, dt);
    if(!state.active){
      if(Math.abs(state.bank) < 0.0001) state.bank = 0;
      if(Math.abs(state.pitch) < 0.0001) state.pitch = 0;
    }
    return snapshot();
  }

  function snapshot(){
    return Object.freeze({
      active: state.active,
      pointerId: state.pointerId,
      bank: state.bank,
      pitch: state.pitch,
      targetBank: state.targetBank,
      targetPitch: state.targetPitch,
      indicatorX: state.indicatorX,
      indicatorY: state.indicatorY,
      controlRadius: dragSpan,
      maxBank: profile.maxBank,
      maxPitch: profile.maxPitch,
      sequence: state.sequence,
      samples: state.samples,
      lastEndReason: state.lastEndReason,
      control: normalizedControl,
    });
  }

  return Object.freeze({ begin, move, end, cancel, reset, tick, snapshot });
}

export { CONTROL_PROFILES };
