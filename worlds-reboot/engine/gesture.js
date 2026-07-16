/* Playforge engine — robust, test-visible pointer gesture sessions. */

const defaultView = target => target?.ownerDocument?.defaultView || target?.defaultView || globalThis.window;
const defaultDocument = (target, view) => target?.ownerDocument || (target?.nodeType === 9 ? target : view?.document);

function thresholdPx(value, view){
  const resolved = typeof value === 'function' ? value(view) : value;
  if(!Number.isFinite(resolved) || resolved < 0) throw new RangeError('gesture thresholds must be non-negative');
  return resolved <= 1 ? Math.min(view.innerWidth, view.innerHeight) * resolved : resolved;
}

function ignored(target, selectors){
  return Boolean(target?.closest && selectors.some(selector => target.closest(selector)));
}

function cloneState(state){
  return {
    enabled: state.enabled,
    disposed: state.disposed,
    lifecycle: state.lifecycle,
    phase: state.phase,
    active: state.active,
    engaged: state.engaged,
    pointerId: state.pointerId,
    pointerType: state.pointerType,
    x0: state.x0,
    y0: state.y0,
    x: state.x,
    y: state.y,
    dx: state.dx,
    dy: state.dy,
    distance: state.distance,
    direction: state.direction,
    sampleCount: state.sampleCount,
    sequence: state.sequence,
    lastCancelReason: state.lastCancelReason,
    lastError: state.lastError ? { ...state.lastError } : null,
  };
}

/**
 * Create one owned pointer gesture session on an explicit target.
 *
 * deadzone/hysteresis values <= 1 are fractions of the shorter viewport edge;
 * larger values are CSS pixels. axisLock keeps the first resolved direction.
 * While active, global capture listeners observe moves/releases and any second
 * pointer, including pointers outside the target or over ignored descendants.
 * Callback failures are reported through onError, cancel active work safely,
 * and never escape DOM dispatch or prevent disable()/dispose() cleanup.
 */
export function createGestureSession({
  target = null,
  ignore = [],
  deadzone = 0.018,
  hysteresis = 0.006,
  axisLock = true,
  preventDefault = true,
  onStart = null,
  onMove = null,
  onDirection = null,
  onEnd = null,
  onCancel = null,
  onError = null,
} = {}){
  if(!target?.addEventListener) throw new TypeError('createGestureSession requires an explicit EventTarget');
  if(!Array.isArray(ignore)) throw new TypeError('ignore must be an array of selectors');

  const view = defaultView(target);
  const doc = defaultDocument(target, view);
  if(!view?.addEventListener || !doc?.addEventListener) throw new TypeError('gesture target must belong to a document');

  const state = {
    enabled: true,
    disposed: false,
    lifecycle: 'ready',
    phase: 'idle',
    active: false,
    engaged: false,
    pointerId: null,
    pointerType: null,
    x0: 0, y0: 0, x: 0, y: 0, dx: 0, dy: 0, distance: 0,
    direction: null,
    sampleCount: 0,
    sequence: 0,
    lastCancelReason: null,
    lastError: null,
  };
  let captureTarget = null;
  let lifecycle = 'ready';
  const permanentRemovers = [];
  const activeRemovers = [];

  const listen = (node, type, handler, options) => {
    node?.addEventListener?.(type, handler, options);
    return () => node?.removeEventListener?.(type, handler, options);
  };

  function prevent(event){
    if(preventDefault && event?.cancelable) event.preventDefault();
  }

  function reportError(callback, error){
    state.lastError = { callback, message: error?.message || String(error) };
    try { onError?.(error, { callback, state: cloneState(state) }); } catch {}
  }

  function call(callbackName, callback, args, { cancelOnError = false } = {}){
    if(typeof callback !== 'function') return true;
    try {
      callback(...args);
      return true;
    } catch(error){
      reportError(callbackName, error);
      if(cancelOnError && state.active) cancel(`callback-error:${callbackName}`);
      return false;
    }
  }

  function directionFor(dx, dy){
    const ax = Math.abs(dx), ay = Math.abs(dy);
    const margin = thresholdPx(hysteresis, view);
    if(ax >= ay + margin) return dx < 0 ? 'left' : 'right';
    if(ay >= ax + margin) return dy < 0 ? 'up' : 'down';
    return null;
  }

  function applySample(sample){
    if(!Number.isFinite(sample.clientX) || !Number.isFinite(sample.clientY)) return true;
    state.x = sample.clientX;
    state.y = sample.clientY;
    state.dx = state.x - state.x0;
    state.dy = state.y - state.y0;
    state.distance = Math.hypot(state.dx, state.dy);
    state.sampleCount += 1;

    if(!state.engaged && state.distance >= thresholdPx(deadzone, view)){
      state.engaged = true;
      state.phase = 'active';
    }
    if(!state.engaged) return true;

    const candidate = directionFor(state.dx, state.dy);
    if(!candidate || (axisLock && state.direction)) return true;
    if(candidate !== state.direction){
      state.direction = candidate;
      return call('onDirection', onDirection, [cloneState(state), sample], { cancelOnError: true });
    }
    return true;
  }

  function samplesFor(event){
    let samples = [];
    try { samples = event.getCoalescedEvents?.() || []; } catch {}
    if(!samples.length) return [event];
    const last = samples.at(-1);
    if(last.clientX !== event.clientX || last.clientY !== event.clientY) samples.push(event);
    return samples;
  }

  function releaseCapture(pointerId){
    const captured = captureTarget;
    captureTarget = null;
    try {
      if(captured?.hasPointerCapture?.(pointerId)) captured.releasePointerCapture(pointerId);
    } catch {}
  }

  function stopGlobalObservation(){
    for(const remove of activeRemovers.splice(0)) remove();
  }

  function resetActive(){
    state.phase = 'idle';
    state.active = false;
    state.engaged = false;
    state.pointerId = null;
    state.pointerType = null;
    state.direction = null;
    state.dx = state.dy = state.distance = 0;
  }

  function finishActive(){
    const pointerId = state.pointerId;
    stopGlobalObservation();
    resetActive();
    releaseCapture(pointerId);
  }

  function cancel(reason = 'manual', event = null){
    if(!state.active) return false;
    state.phase = 'cancelled';
    state.lastCancelReason = reason;
    const final = cloneState(state);
    finishActive();
    call('onCancel', onCancel, [final, event, reason]);
    return true;
  }

  function observeSecondPointer(event){
    if(!state.active || event.pointerId === state.pointerId) return;
    prevent(event);
    cancel('multitouch', event);
  }

  function startGlobalObservation(){
    activeRemovers.push(
      listen(view, 'pointerdown', observeSecondPointer, { capture: true, passive: false }),
      listen(view, 'pointermove', pointerMove, { capture: true, passive: false }),
      listen(view, 'pointerup', pointerUp, { capture: true, passive: false }),
      listen(view, 'pointercancel', pointerCancel, { capture: true, passive: false }),
      listen(view, 'lostpointercapture', lostPointerCapture, true),
      listen(captureTarget, 'lostpointercapture', lostPointerCapture),
    );
  }

  function pointerDown(event){
    if(state.disposed || !state.enabled) return;
    // This fallback preserves the second-pointer invariant even when a host
    // dispatches directly at the local target without a normal capture phase.
    if(state.active){
      if(event.pointerId !== state.pointerId){
        prevent(event);
        cancel('multitouch', event);
      }
      return;
    }
    if(ignored(event.target, ignore) || event.isPrimary === false) return;
    prevent(event);
    state.sequence += 1;
    state.phase = 'tracking';
    state.active = true;
    state.engaged = false;
    state.pointerId = event.pointerId;
    state.pointerType = event.pointerType || 'unknown';
    state.x0 = state.x = event.clientX;
    state.y0 = state.y = event.clientY;
    state.dx = state.dy = state.distance = 0;
    state.direction = null;
    state.sampleCount = 1;
    state.lastCancelReason = null;
    state.lastError = null;
    captureTarget = event.target;
    try { captureTarget?.setPointerCapture?.(event.pointerId); } catch {}
    startGlobalObservation();
    call('onStart', onStart, [cloneState(state), event], { cancelOnError: true });
  }

  function pointerMove(event){
    if(!state.active || event.pointerId !== state.pointerId) return;
    prevent(event);
    const samples = samplesFor(event);
    for(const sample of samples){
      if(!applySample(sample) || !state.active) return;
    }
    call('onMove', onMove, [cloneState(state), event, samples], { cancelOnError: true });
  }

  function pointerUp(event){
    if(!state.active || event.pointerId !== state.pointerId) return;
    prevent(event);
    for(const sample of samplesFor(event)){
      if(!applySample(sample) || !state.active) return;
    }
    state.phase = 'ended';
    const final = cloneState(state);
    finishActive();
    call('onEnd', onEnd, [final, event]);
  }

  function pointerCancel(event){
    if(state.active && event.pointerId === state.pointerId){
      prevent(event);
      cancel('pointercancel', event);
    }
  }

  function lostPointerCapture(event){
    if(state.active && event.pointerId === state.pointerId) cancel('lostpointercapture', event);
  }

  function visibilityChange(event){
    if(doc.hidden) cancel('visibilitychange', event);
  }

  permanentRemovers.push(
    listen(target, 'pointerdown', pointerDown, { passive: false }),
    listen(view, 'blur', event => cancel('blur', event)),
    listen(view, 'orientationchange', event => cancel('orientationchange', event)),
    listen(doc, 'visibilitychange', visibilityChange),
  );

  function setEnabled(value){
    if(state.disposed || lifecycle !== 'ready') return false;
    const enabled = Boolean(value);
    if(state.enabled === enabled) return enabled;
    if(enabled){
      state.enabled = true;
      return true;
    }

    lifecycle = 'disabling';
    state.lifecycle = lifecycle;
    state.enabled = false;
    try { cancel('disabled'); }
    finally {
      // onCancel/onError may attempt enable(); disabling remains authoritative.
      state.enabled = false;
      lifecycle = 'ready';
      state.lifecycle = lifecycle;
    }
    return false;
  }

  function dispose(){
    if(state.disposed || lifecycle !== 'ready') return false;
    lifecycle = 'disposing';
    state.lifecycle = lifecycle;
    state.enabled = false;
    try { cancel('disposed'); }
    finally {
      stopGlobalObservation();
      for(const remove of permanentRemovers.splice(0)) remove();
      state.disposed = true;
      state.enabled = false;
      lifecycle = 'disposed';
      state.lifecycle = lifecycle;
    }
    return true;
  }

  return {
    enable: () => setEnabled(true),
    disable: () => setEnabled(false),
    cancel,
    dispose,
    snapshot: () => cloneState(state),
    get state(){ return cloneState(state); },
  };
}
