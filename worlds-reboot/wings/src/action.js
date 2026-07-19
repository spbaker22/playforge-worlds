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

export const WING_TWO_POINTER_TUNING = Object.freeze({
  steeringFraction: 0.65,
  holdSeconds: 0.22,
  flickDistance: 44,
});

export const WING_ACTION_CONTEXTS = Object.freeze({
  race: Object.freeze({ id: 'race', tap: 'context', hold: 'boost' }),
  combat: Object.freeze({ id: 'combat', tap: 'fire', hold: 'boost' }),
  defense: Object.freeze({ id: 'defense', tap: 'fire', hold: 'shield' }),
  rescue: Object.freeze({ id: 'rescue', tap: 'context', hold: 'shield' }),
});

export function normalizeWingActionContext(value = 'combat'){
  if(typeof value === 'string'){
    const preset = WING_ACTION_CONTEXTS[value];
    if(!preset) throw new RangeError(`unknown wing action context ${value}`);
    return preset;
  }
  if(!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('wing action context must be a preset or object');
  if(!['fire', 'context'].includes(value.tap)) throw new RangeError('wing action tap must be fire or context');
  if(!['boost', 'shield'].includes(value.hold)) throw new RangeError('wing action hold must be boost or shield');
  return Object.freeze({
    id: typeof value.id === 'string' && value.id.length > 0 ? value.id : 'custom',
    tap: value.tap,
    hold: value.hold,
  });
}

function wingFlickCommand(dx, dy){
  if(Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'roll-left' : 'roll-right';
  return dy < 0 ? 'loop' : 'dive-flip';
}

function emptyRightAction(reason = 'initial'){
  return {
    active: false,
    pointerId: null,
    originX: 0,
    originY: 0,
    currentX: 0,
    currentY: 0,
    peakDx: 0,
    peakDy: 0,
    peakDistance: 0,
    elapsed: 0,
    mode: 'idle',
    context: null,
    gestureSequence: 0,
    samples: 0,
    lastEndReason: reason,
  };
}

export function createWingTwoPointerController({
  control = 'guided',
  dragSpan = CONTROL_ORB_RADIUS,
  viewportWidth = 1000,
  actionContext = 'combat',
} = {}){
  if(!Number.isFinite(viewportWidth) || viewportWidth <= 0) throw new RangeError('viewportWidth must be positive');
  const steering = createWingActionController({ control, dragSpan });
  let width = viewportWidth;
  let context = normalizeWingActionContext(actionContext);
  let right = emptyRightAction();
  let gestureSequence = 0;
  let commandSequence = 0;
  let queue = [];
  let held = { boost: false, shield: false };
  let lastCancelReason = 'initial';

  function queueCommand(type, gesture = right){
    queue.push(Object.freeze({
      id: `wing-command-${commandSequence.toString(36).padStart(5, '0')}`,
      type,
      gestureSequence: gesture.gestureSequence,
      context: gesture.context?.id || context.id,
    }));
    commandSequence += 1;
  }

  function beginRight(pointerId, x, y){
    if(right.active || steering.snapshot().pointerId === pointerId) return false;
    gestureSequence += 1;
    right = {
      ...emptyRightAction(null),
      active: true,
      pointerId,
      originX: x,
      originY: y,
      currentX: x,
      currentY: y,
      mode: 'pending',
      context,
      gestureSequence,
      samples: 1,
    };
    return true;
  }

  function begin(pointerId, x, y){
    if(pointerId === null || pointerId === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    if(right.pointerId === pointerId || steering.snapshot().pointerId === pointerId) return false;
    if(x < width * WING_TWO_POINTER_TUNING.steeringFraction) return steering.begin(pointerId, x, y);
    return beginRight(pointerId, x, y);
  }

  function moveRight(x, y){
    right.currentX = x;
    right.currentY = y;
    right.samples += 1;
    const dx = x - right.originX;
    const dy = y - right.originY;
    const distance = Math.hypot(dx, dy);
    if(distance > right.peakDistance){
      right.peakDistance = distance;
      right.peakDx = dx;
      right.peakDy = dy;
    }
    if(right.mode === 'pending' && right.peakDistance >= WING_TWO_POINTER_TUNING.flickDistance) right.mode = 'flick';
    return true;
  }

  function move(pointerId, x, y){
    if(!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if(pointerId === right.pointerId && right.active) return moveRight(x, y);
    return steering.move(pointerId, x, y);
  }

  function finishRight(reason){
    const gesture = right;
    if(gesture.mode === 'hold'){
      held = { ...held, [gesture.context.hold]: false };
      queueCommand(`${gesture.context.hold}-end`, gesture);
    } else if(gesture.mode === 'flick' || gesture.peakDistance >= WING_TWO_POINTER_TUNING.flickDistance){
      queueCommand(wingFlickCommand(gesture.peakDx, gesture.peakDy), gesture);
    } else {
      queueCommand(gesture.context.tap, gesture);
    }
    right = { ...emptyRightAction(reason), gestureSequence: gesture.gestureSequence };
    return true;
  }

  function end(pointerId, reason = 'release'){
    if(right.active && pointerId === right.pointerId) return finishRight(reason);
    return steering.end(pointerId, reason);
  }

  function cancelPointer(pointerId, reason = 'cancel'){
    if(right.active && pointerId === right.pointerId){
      const gesture = right;
      held = { ...held, [gesture.context.hold]: false };
      queue = queue.filter(command => command.gestureSequence !== gesture.gestureSequence);
      right = { ...emptyRightAction(reason), gestureSequence: gesture.gestureSequence };
      lastCancelReason = reason;
      return true;
    }
    if(steering.snapshot().pointerId === pointerId){
      steering.reset(reason);
      lastCancelReason = reason;
      return true;
    }
    return false;
  }

  function cancelAll(reason = 'cancel'){
    const hadInput = right.active || steering.snapshot().active || queue.length > 0 || held.boost || held.shield;
    steering.reset(reason);
    right = { ...emptyRightAction(reason), gestureSequence: right.gestureSequence };
    held = { boost: false, shield: false };
    queue = [];
    lastCancelReason = reason;
    return hadInput;
  }

  function reset(reason = 'reset'){
    cancelAll(reason);
    return snapshot();
  }

  function actionTelegraph(){
    if(!right.active || right.mode === 'flick') return null;
    return Object.freeze({
      type: right.context.hold,
      progress: right.mode === 'hold' ? 1 : Math.min(1, right.elapsed / WING_TWO_POINTER_TUNING.holdSeconds),
      armed: right.mode === 'hold',
    });
  }

  function buildSnapshot(steeringState = steering.snapshot(), commands = Object.freeze([])){
    return Object.freeze({
      bank: steeringState.bank,
      pitch: steeringState.pitch,
      targetBank: steeringState.targetBank,
      targetPitch: steeringState.targetPitch,
      steeringActive: steeringState.active,
      steeringPointerId: steeringState.pointerId,
      actionActive: right.active,
      actionPointerId: right.pointerId,
      actionMode: right.mode,
      actionElapsed: right.elapsed,
      actionSamples: right.samples,
      held: Object.freeze({ ...held }),
      telegraph: actionTelegraph(),
      commands,
      queuedCommandCount: queue.length,
      commandSequence,
      gestureSequence,
      actionContext: context,
      steeringFraction: WING_TWO_POINTER_TUNING.steeringFraction,
      viewportWidth: width,
      lastCancelReason,
      control: steeringState.control,
    });
  }

  function fixedStep(dt){
    if(!Number.isFinite(dt) || dt < 0) throw new RangeError('dt must be non-negative');
    const steeringState = steering.tick(dt);
    if(right.active){
      right.elapsed += dt;
      if(right.mode === 'pending' && right.elapsed >= WING_TWO_POINTER_TUNING.holdSeconds){
        right.mode = 'hold';
        held = { ...held, [right.context.hold]: true };
        queueCommand(`${right.context.hold}-start`);
      }
    }
    const commands = Object.freeze(queue.splice(0, queue.length));
    return buildSnapshot(steeringState, commands);
  }

  function snapshot(){
    return buildSnapshot();
  }

  function setContext(nextContext){
    context = normalizeWingActionContext(nextContext);
    return snapshot();
  }

  function setViewportWidth(nextWidth){
    if(!Number.isFinite(nextWidth) || nextWidth <= 0) throw new RangeError('viewportWidth must be positive');
    width = nextWidth;
    return snapshot();
  }

  return Object.freeze({
    begin,
    move,
    end,
    cancelPointer,
    cancel: cancelAll,
    cancelAll,
    reset,
    fixedStep,
    consumeFixedStep: fixedStep,
    tick: fixedStep,
    snapshot,
    setContext,
    setViewportWidth,
  });
}

export const createWingDualActionController = createWingTwoPointerController;
