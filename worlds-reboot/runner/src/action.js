/* Gridlock Run — immediate, axis-locked directional action gestures. */
import { createGestureSession } from '../../engine/gesture.js';

const ACTION_FOR_DIRECTION = Object.freeze({
  up: 'jump',
  down: 'slide',
  left: 'left',
  right: 'right',
});

const copyAction = action => action ? { ...action } : null;

/**
 * Resolve one swipe into one buffered Runner action as soon as its directional
 * threshold is crossed. A repeated upward gesture remains `jump`; the
 * simulation decides whether it is the grounded jump or the airborne double.
 *
 * onAction(action) is a notification of the same record stored in the queue.
 * Consumers may either react there or drain() from their fixed simulation tick.
 */
export function createRunnerActionController({
  canvas = null,
  canAct = () => true,
  onAction = null,
  onJump = null,
  onSlide = null,
  onLane = null,
  onCancel = null,
  onError = null,
  swipeThreshold = 0.032,
  directionHysteresis = 0.006,
  maxQueuedActions = 8,
} = {}){
  if(!canvas?.addEventListener) throw new TypeError('RunnerActionController requires an explicit canvas EventTarget');
  if(typeof canAct !== 'function') throw new TypeError('canAct must be a function');
  for(const [name, callback] of Object.entries({ onAction, onJump, onSlide, onLane, onCancel, onError })){
    if(callback !== null && typeof callback !== 'function') throw new TypeError(`${name} must be a function or null`);
  }
  if(!Number.isFinite(swipeThreshold) || swipeThreshold <= 0) throw new RangeError('swipeThreshold must be positive');
  if(!Number.isFinite(directionHysteresis) || directionHysteresis < 0) throw new RangeError('directionHysteresis must be non-negative');
  if(!Number.isInteger(maxQueuedActions) || maxQueuedActions < 1) throw new RangeError('maxQueuedActions must be a positive integer');

  const queue = [];
  let acceptedCount = 0;
  let rejectedCount = 0;
  let droppedCount = 0;
  let lastHandledSequence = 0;
  let lastAcceptedDirection = null;
  let lastAction = null;
  let lastCancelReason = null;
  let disposed = false;
  const metrics = {
    legacyDrainCalls: 0,
    legacyDrainAllocations: 0,
    drainIntoCalls: 0,
    drainedActions: 0,
  };

  function dispatch(gesture, event){
    // The shared session is axis locked, but keep the sequence guard here so a
    // future gesture implementation cannot dispatch twice for one pointer.
    if(gesture.sequence === lastHandledSequence) return;
    lastHandledSequence = gesture.sequence;

    const type = ACTION_FOR_DIRECTION[gesture.direction];
    if(!type) return;
    const action = Object.freeze({
      type,
      direction: gesture.direction,
      laneDelta: type === 'left' ? -1 : type === 'right' ? 1 : 0,
      sequence: gesture.sequence,
      pointerType: gesture.pointerType,
      x: gesture.x,
      y: gesture.y,
      dx: gesture.dx,
      dy: gesture.dy,
      distance: gesture.distance,
    });

    if(!canAct(action, event)){
      rejectedCount += 1;
      return;
    }

    if(queue.length >= maxQueuedActions){
      queue.shift();
      droppedCount += 1;
    }
    queue.push(action);
    acceptedCount += 1;
    lastAcceptedDirection = action.direction;
    lastAction = action;

    onAction?.(action, event);
    if(type === 'jump') onJump?.(action, event);
    else if(type === 'slide') onSlide?.(action, event);
    else onLane?.(action.laneDelta, action, event);
  }

  const gesture = createGestureSession({
    target: canvas,
    deadzone: swipeThreshold,
    hysteresis: directionHysteresis,
    axisLock: true,
    preventDefault: true,
    onDirection: dispatch,
    onCancel(state, event, reason){
      lastCancelReason = reason;
      onCancel?.(reason, state, event);
    },
    onError(error, context){ onError?.(error, context); },
  });

  // Race modes explicitly opt in; title/intro/countdown cannot accept input.
  gesture.disable();

  function consume(){
    return copyAction(queue.shift() || null);
  }

  function drain(){
    metrics.legacyDrainCalls += 1;
    metrics.legacyDrainAllocations += 1;
    const actions = queue.map(copyAction);
    metrics.drainedActions += actions.length;
    queue.length = 0;
    return actions;
  }

  /** Drain frozen action records into caller-owned storage. The legacy
   * drain() copy semantics remain available for non-hot consumers. */
  function drainInto(out){
    if(!Array.isArray(out)) throw new TypeError('drainInto requires a caller-owned array');
    metrics.drainIntoCalls += 1;
    out.length = 0;
    for(let index = 0; index < queue.length; index += 1) out.push(queue[index]);
    metrics.drainedActions += queue.length;
    queue.length = 0;
    return out;
  }

  function clear(){
    const count = queue.length;
    queue.length = 0;
    return count;
  }

  function enable(){
    if(disposed) return false;
    return gesture.enable();
  }

  function disable(){
    if(disposed) return false;
    const result = gesture.disable();
    clear();
    return result;
  }

  function cancel(reason = 'manual'){
    return disposed ? false : gesture.cancel(reason);
  }

  function dispose(){
    if(disposed) return false;
    clear();
    const result = gesture.dispose();
    disposed = true;
    return result;
  }

  function snapshot(){
    const session = gesture.snapshot();
    return {
      enabled: session.enabled,
      disposed,
      acceptedCount,
      rejectedCount,
      droppedCount,
      queuedCount: queue.length,
      queued: queue.map(copyAction),
      lastHandledSequence,
      lastAcceptedDirection,
      lastAction: copyAction(lastAction),
      lastCancelReason,
      gesture: session,
    };
  }

  return {
    enable,
    disable,
    cancel,
    dispose,
    consume,
    drain,
    drainInto,
    clear,
    snapshot,
    get state(){ return snapshot(); },
    get metrics(){ return { ...metrics }; },
  };
}
