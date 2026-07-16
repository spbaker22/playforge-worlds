/* LOW TIDE — single-owner cast / hook / reel action interpreter. */

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, name) => {
  if(!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
};

function frozenSnapshot(active, sequence, lastAction){
  return Object.freeze({
    active: Boolean(active),
    phase: active?.phase ?? null,
    pointerId: active?.pointerId ?? null,
    sequence,
    dx: active?.dx ?? 0,
    dy: active?.dy ?? 0,
    distance: active?.distance ?? 0,
    power: active?.power ?? 0,
    lateral: active?.lateral ?? 0,
    lastAction,
  });
}

/**
 * Turns pointer samples into mutually exclusive fishing actions.
 * - aim: drag and release once to cast
 * - bite: pointer-down emits one hook without becoming a reel hold
 * - reeling: a fresh pointer owns one hold/release pair
 */
export function createTideActionController({
  castDeadzone = 20,
  castRange = 260,
  lateralRange = 190,
} = {}){
  if(!Number.isFinite(castDeadzone) || castDeadzone < 0) throw new RangeError('castDeadzone must be non-negative');
  if(!Number.isFinite(castRange) || castRange <= castDeadzone) throw new RangeError('castRange must exceed castDeadzone');
  if(!Number.isFinite(lateralRange) || lateralRange <= 0) throw new RangeError('lateralRange must be positive');
  let active = null;
  let sequence = 0;
  let lastAction = null;

  function begin({ pointerId, x, y, phase, time = 0 }){
    finite(pointerId, 'pointerId'); finite(x, 'x'); finite(y, 'y'); finite(time, 'time');
    if(active) return null;
    if(phase === 'bite'){
      lastAction = Object.freeze({ type: 'hook', sequence: ++sequence, pointerId });
      return lastAction;
    }
    if(phase !== 'aim' && phase !== 'reeling') return null;
    active = { pointerId, phase, x0: x, y0: y, x, y, dx: 0, dy: 0, distance: 0, power: 0, lateral: 0, startedAt: time, sequence: ++sequence };
    if(phase === 'reeling'){
      lastAction = Object.freeze({ type: 'reel-start', sequence: active.sequence, pointerId });
      return lastAction;
    }
    return Object.freeze({ type: 'cast-start', sequence: active.sequence, pointerId });
  }

  function move({ pointerId, x, y }){
    finite(pointerId, 'pointerId'); finite(x, 'x'); finite(y, 'y');
    if(!active || pointerId !== active.pointerId || active.phase !== 'aim') return null;
    active.x = x; active.y = y;
    active.dx = x - active.x0;
    active.dy = y - active.y0;
    active.distance = Math.hypot(active.dx, active.dy);
    active.power = clamp((active.distance - castDeadzone) / (castRange - castDeadzone), 0, 1);
    active.lateral = clamp(-active.dx / lateralRange, -1, 1);
    return Object.freeze({ type: 'cast-preview', sequence: active.sequence, power: active.power, lateral: active.lateral, distance: active.distance });
  }

  function end({ pointerId, x, y, time = 0, cancelled = false }){
    finite(pointerId, 'pointerId'); finite(x, 'x'); finite(y, 'y'); finite(time, 'time');
    if(!active || pointerId !== active.pointerId) return null;
    const owner = active;
    if(owner.phase === 'aim') move({ pointerId, x, y });
    active = null;
    if(owner.phase === 'reeling'){
      lastAction = Object.freeze({ type: 'reel-stop', sequence: owner.sequence, pointerId, cancelled: Boolean(cancelled) });
      return lastAction;
    }
    if(cancelled || owner.distance < castDeadzone){
      lastAction = Object.freeze({ type: 'cast-cancel', sequence: owner.sequence, pointerId, distance: owner.distance });
      return lastAction;
    }
    lastAction = Object.freeze({
      type: 'cast', sequence: owner.sequence, pointerId,
      power: owner.power,
      lateral: owner.lateral,
      distance: owner.distance,
      duration: Math.max(0, time - owner.startedAt),
    });
    return lastAction;
  }

  function cancel(pointerId = active?.pointerId){
    if(!active || pointerId !== active.pointerId) return null;
    return end({ pointerId, x: active.x, y: active.y, time: active.startedAt, cancelled: true });
  }

  function reset(){
    if(active?.phase === 'reeling') lastAction = Object.freeze({ type: 'reel-stop', sequence: active.sequence, pointerId: active.pointerId, cancelled: true });
    active = null;
    return snapshot();
  }

  function snapshot(){ return frozenSnapshot(active, sequence, lastAction); }
  return Object.freeze({ begin, move, end, cancel, reset, snapshot, get state(){ return snapshot(); } });
}

