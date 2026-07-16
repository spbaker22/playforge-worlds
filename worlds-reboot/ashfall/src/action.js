import { ASHFALL_BOUNDS } from './rules.js';

const finite = (value, name) => {
  if(!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Converts one captured pointer gesture into direct ground targets or one tap.
 * Screen-to-ground projection belongs to the presentation layer; this module
 * keeps the interaction contract deterministic and independently testable.
 */
export function createAshfallActionController({
  minX = ASHFALL_BOUNDS.minX,
  maxX = ASHFALL_BOUNDS.maxX,
  minZ = ASHFALL_BOUNDS.minZ,
  maxZ = ASHFALL_BOUNDS.maxZ,
  tapSlop = 14,
  tapSeconds = 0.34,
} = {}){
  if(!(minX < maxX) || !(minZ < maxZ)) throw new RangeError('action bounds must have positive area');
  if(!Number.isFinite(tapSlop) || tapSlop < 0) throw new RangeError('tapSlop must be non-negative');
  if(!Number.isFinite(tapSeconds) || tapSeconds <= 0) throw new RangeError('tapSeconds must be positive');

  let active = null;
  let sequence = 0;
  let lastTarget = Object.freeze({ x: 0, z: 0 });

  function begin({ pointerId, screenX, screenY, groundX, groundZ, playerX, playerZ, time = 0 }){
    if(active) return false;
    if(!Number.isInteger(pointerId) && typeof pointerId !== 'number') throw new TypeError('pointerId must be numeric');
    const values = { screenX, screenY, groundX, groundZ, playerX, playerZ, time };
    for(const [name, value] of Object.entries(values)) finite(value, name);
    active = {
      pointerId,
      sequence: ++sequence,
      screenX,
      screenY,
      lastScreenX: screenX,
      lastScreenY: screenY,
      startedAt: time,
      offsetX: playerX - groundX,
      offsetZ: playerZ - groundZ,
      tapTarget: Object.freeze({ x: clamp(groundX, minX, maxX), z: clamp(groundZ, minZ, maxZ) }),
      distance: 0,
      moves: 0,
    };
    lastTarget = Object.freeze({ x: playerX, z: playerZ });
    return snapshot();
  }

  function move({ pointerId, screenX, screenY, groundX, groundZ }){
    if(!active || pointerId !== active.pointerId) return null;
    finite(screenX, 'screenX'); finite(screenY, 'screenY');
    finite(groundX, 'groundX'); finite(groundZ, 'groundZ');
    active.lastScreenX = screenX;
    active.lastScreenY = screenY;
    active.distance = Math.max(active.distance, Math.hypot(screenX - active.screenX, screenY - active.screenY));
    active.moves += 1;
    lastTarget = Object.freeze({
      x: clamp(groundX + active.offsetX, minX, maxX),
      z: clamp(groundZ + active.offsetZ, minZ, maxZ),
    });
    return lastTarget;
  }

  function end({ pointerId, screenX, screenY, time = 0, cancelled = false }){
    if(!active || pointerId !== active.pointerId) return null;
    finite(screenX, 'screenX'); finite(screenY, 'screenY'); finite(time, 'time');
    const owner = active;
    active = null;
    const distance = Math.max(owner.distance, Math.hypot(screenX - owner.screenX, screenY - owner.screenY));
    const duration = Math.max(0, time - owner.startedAt);
    const type = !cancelled && distance <= tapSlop && duration <= tapSeconds ? 'dash' : cancelled ? 'cancel' : 'move';
    const target = type === 'dash' ? owner.tapTarget : lastTarget;
    return Object.freeze({ type, sequence: owner.sequence, distance, duration, target });
  }

  function cancel(pointerId = active?.pointerId){
    if(!active || pointerId !== active.pointerId) return null;
    return end({
      pointerId,
      screenX: active.lastScreenX,
      screenY: active.lastScreenY,
      time: active.startedAt,
      cancelled: true,
    });
  }

  function snapshot(){
    return Object.freeze({
      active: Boolean(active),
      pointerId: active?.pointerId ?? null,
      sequence,
      distance: active?.distance ?? 0,
      moves: active?.moves ?? 0,
      target: lastTarget,
    });
  }

  return Object.freeze({ begin, move, end, cancel, snapshot, get state(){ return snapshot(); } });
}
