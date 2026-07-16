/* Playforge engine — tablet-first pointer verbs. No keyboard required.
   dragSteer: relative horizontal drag w/ on-screen puck (the racing grammar).
   dragVector: live 2D drag from touch-down (aim / pitch+bank / move).
   taps: tap vs hold discrimination. */
import { clamp, $ } from './util.js';
export { createGestureSession } from './gesture.js';

/* Racing grammar: drag anywhere, ~16% of screen width = full lock. */
export function dragSteer({ puckId = 'puck', dotId = 'puckDot', ignore = [], onDown = null } = {}){
  const puck = $(puckId), dot = $(dotId);
  const st = { steer: 0, active: false };
  let ptrId = null, x0 = 0, captureTarget = null;
  addEventListener('pointerdown', e => {
    if(e.isPrimary === false) return;
    if(onDown && onDown(e)) return;
    if(ignore.some(sel => e.target.closest(sel))) return;
    if(ptrId !== null) return;
    e.preventDefault();
    ptrId = e.pointerId; x0 = e.clientX; st.active = true;
    captureTarget = e.target;
    try { captureTarget.setPointerCapture?.(ptrId); } catch {}
    if(puck){
      puck.style.left = (e.clientX - 65) + 'px';
      puck.style.top = (e.clientY - 32) + 'px';
      puck.style.opacity = 0.85;
    }
  });
  addEventListener('pointermove', e => {
    if(e.pointerId !== ptrId) return;
    e.preventDefault();
    st.steer = clamp((e.clientX - x0) / Math.min(innerWidth * 0.16, 170), -1, 1);
    if(dot) dot.style.transform = `translate(${-50 + st.steer * 58}%,-50%)`;
  });
  const end = e => {
    if(e.pointerId === ptrId){
      e.preventDefault();
      try { captureTarget?.releasePointerCapture?.(ptrId); } catch {}
      ptrId = null; st.steer = 0; st.active = false;
      captureTarget = null;
      if(puck) puck.style.opacity = 0;
      if(dot) dot.style.transform = 'translate(-50%,-50%)';
    }
  };
  addEventListener('pointerup', end); addEventListener('pointercancel', end);
  return st;
}

/* Free 2D drag: dx/dy in px from touch-down, normalized nx/ny by a radius. */
export function dragVector({ radius = 150, ignore = [], onDown = null, onEnd = null, onStart = null, onCancel = null } = {}){
  const st = { dx: 0, dy: 0, nx: 0, ny: 0, active: false, x0: 0, y0: 0, x: 0, y: 0 };
  let ptrId = null, captureTarget = null;
  addEventListener('pointerdown', e => {
    if(e.isPrimary === false) return;
    if(onDown && onDown(e)) return;
    if(ignore.some(sel => e.target.closest(sel))) return;
    if(ptrId !== null) return;
    e.preventDefault();
    ptrId = e.pointerId;
    captureTarget = e.target;
    try { captureTarget.setPointerCapture?.(ptrId); } catch {}
    st.x0 = st.x = e.clientX; st.y0 = st.y = e.clientY;
    st.dx = st.dy = st.nx = st.ny = 0;
    st.active = true;
    if(onStart) onStart(st, e);
  });
  addEventListener('pointermove', e => {
    if(e.pointerId !== ptrId) return;
    e.preventDefault();
    st.x = e.clientX; st.y = e.clientY;
    st.dx = e.clientX - st.x0; st.dy = e.clientY - st.y0;
    st.nx = clamp(st.dx / radius, -1, 1); st.ny = clamp(st.dy / radius, -1, 1);
  });
  const end = (e, cancelled = false) => {
    if(e.pointerId === ptrId){
      e.preventDefault();
      st.x = e.clientX; st.y = e.clientY;
      st.dx = e.clientX - st.x0; st.dy = e.clientY - st.y0;
      st.nx = clamp(st.dx / radius, -1, 1); st.ny = clamp(st.dy / radius, -1, 1);
      try { captureTarget?.releasePointerCapture?.(ptrId); } catch {}
      ptrId = null;
      if(cancelled){ if(onCancel) onCancel(st, e); }
      else if(onEnd) onEnd(st, e);
      st.active = false;
      st.dx = st.dy = st.nx = st.ny = 0;
      captureTarget = null;
    }
  };
  addEventListener('pointerup', e => end(e, false));
  addEventListener('pointercancel', e => end(e, true));
  return st;
}

/* Tap (short press, small movement) vs hold. */
export function taps({ maxMs = 260, maxMove = 16, ignore = [], onTap = null, onHoldStart = null, onHoldEnd = null } = {}){
  let t0 = 0, x0 = 0, y0 = 0, ptrId = null, holding = false, holdTimer = null, captureTarget = null;
  addEventListener('pointerdown', e => {
    if(e.isPrimary === false) return;
    if(ignore.some(sel => e.target.closest(sel))) return;
    if(ptrId !== null) return;
    e.preventDefault();
    ptrId = e.pointerId; t0 = performance.now(); x0 = e.clientX; y0 = e.clientY; holding = false;
    captureTarget = e.target;
    try { captureTarget.setPointerCapture?.(ptrId); } catch {}
    const activeId = ptrId;
    if(onHoldStart) holdTimer = setTimeout(() => {
      if(ptrId !== activeId) return;
      holding = true; onHoldStart(e);
    }, maxMs + 40);
  });
  const end = (e, cancelled = false) => {
    if(e.pointerId !== ptrId) return;
    e.preventDefault();
    try { captureTarget?.releasePointerCapture?.(ptrId); } catch {}
    ptrId = null;
    captureTarget = null;
    clearTimeout(holdTimer);
    const dt = performance.now() - t0;
    const moved = Math.hypot(e.clientX - x0, e.clientY - y0);
    if(holding){ if(onHoldEnd) onHoldEnd(e); }
    else if(!cancelled && dt <= maxMs && moved <= maxMove && onTap) onTap(e);
  };
  addEventListener('pointerup', e => end(e, false));
  addEventListener('pointercancel', e => end(e, true));
}
