/* Playforge engine — authoritative screen activation and interaction audit. */

const INTERACTIVE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';
const INACTIVE = '.screen.hide,.screen[hidden],.screen[inert],[data-screen].hide,[data-screen][hidden],[data-screen][inert]';

function resolveElement(screen, root = document){
  if(typeof screen === 'string'){
    const id = screen.startsWith('#') ? screen.slice(1) : screen;
    return root.getElementById?.(id) || root.querySelector?.(screen);
  }
  return screen;
}

/**
 * Make a screen authoritative active/inactive state in one operation.
 * Inactive screens are hidden, inert, aria-hidden, unfocusable, and carry the
 * opacity class. Active screens reverse all four flags and optionally focus
 * their first interactive child (or a supplied selector/element).
 */
export function setScreenActive(screen, active, {
  root = document,
  hiddenClass = 'hide',
  focus = active,
} = {}){
  const element = resolveElement(screen, root);
  if(!element) throw new TypeError('setScreenActive requires an existing screen element');

  const next = Boolean(active);
  if(!next && element.contains(root.activeElement)) root.activeElement?.blur?.();

  element.classList.toggle(hiddenClass, !next);
  element.hidden = !next;
  element.inert = !next;
  element.setAttribute('aria-hidden', String(!next));
  element.dataset.screenActive = String(next);

  if(next && focus){
    let target = null;
    if(typeof focus === 'string') target = element.querySelector(focus);
    else if(focus?.nodeType === 1) target = focus;
    else target = element.querySelector('[autofocus]') || element.querySelector(INTERACTIVE);
    target?.focus?.({ preventScroll: true });
  }

  return element;
}

/**
 * Sample the viewport plus every inactive control's bounds and report any
 * inactive screen descendant returned by elementFromPoint(). Intended for
 * automated human-path diagnostics, not per-frame use.
 */
export function auditInactiveScreenHits({
  root = document,
  step = 16,
  inactiveSelector = INACTIVE,
} = {}){
  if(!root?.elementFromPoint) throw new TypeError('auditInactiveScreenHits requires a Document');
  if(!Number.isFinite(step) || step <= 0) throw new RangeError('step must be greater than zero');

  const view = root.defaultView || globalThis;
  const width = view.innerWidth || root.documentElement.clientWidth;
  const height = view.innerHeight || root.documentElement.clientHeight;
  const points = [];
  for(let y = step / 2; y < height; y += step){
    for(let x = step / 2; x < width; x += step) points.push([x, y]);
  }

  for(const control of root.querySelectorAll(`:is(${inactiveSelector}) :is(${INTERACTIVE})`)){
    const r = control.getBoundingClientRect();
    if(r.width <= 0 || r.height <= 0) continue;
    const inset = Math.min(2, r.width / 4, r.height / 4);
    points.push(
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + inset, r.top + inset],
      [r.right - inset, r.bottom - inset],
    );
  }

  const seen = new Set();
  const violations = [];
  for(const [x, y] of points){
    if(x < 0 || y < 0 || x >= width || y >= height) continue;
    const hit = root.elementFromPoint(x, y);
    const screen = hit?.closest?.(inactiveSelector);
    if(!screen) continue;
    const key = `${screen.id}|${hit.id}|${Math.round(x)}|${Math.round(y)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    violations.push({
      x: Math.round(x),
      y: Math.round(y),
      screen: screen.id || null,
      target: hit.id || hit.tagName?.toLowerCase() || null,
    });
  }

  return {
    ok: violations.length === 0,
    samples: points.length,
    inactiveScreens: root.querySelectorAll(inactiveSelector).length,
    interactiveDescendants: root.querySelectorAll(`:is(${inactiveSelector}) :is(${INTERACTIVE})`).length,
    violations,
  };
}

/** Verify that every inactive screen carries the complete authoritative state. */
export function auditInactiveScreenState({ root = document, inactiveSelector = INACTIVE } = {}){
  const screens = [...root.querySelectorAll(inactiveSelector)];
  const violations = [];
  for(const screen of screens){
    const missing = [];
    if(!screen.hidden) missing.push('hidden');
    if(!screen.inert) missing.push('inert');
    if(screen.getAttribute('aria-hidden') !== 'true') missing.push('aria-hidden');
    if(!screen.classList.contains('hide')) missing.push('hide-class');
    if(missing.length) violations.push({ screen: screen.id || null, missing });
  }
  return { ok: violations.length === 0, screens: screens.length, violations };
}
