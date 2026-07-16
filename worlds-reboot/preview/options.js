const STORAGE_KEY = 'playforge.preview.options.v1';

export const PREVIEW_DEFAULTS = Object.freeze({
  sound: 'on',
  quality: 'auto',
  golf: Object.freeze({
    format: 'front-six',
    practiceHole: 1,
    cupAssist: 'standard',
    rivals: 'standard',
  }),
  runner: Object.freeze({
    format: 'full-training',
    pace: 'standard',
    safety: 3,
    swipe: 'standard',
  }),
  ashfall: Object.freeze({
    mode: 'full',
    intensity: 'standard',
  }),
  wings: Object.freeze({
    route: 'full',
    control: 'guided',
    race: 'rivals',
  }),
  tide: Object.freeze({
    session: 'full',
    tension: 'standard',
    scoring: 'haul',
  }),
});

const VALUES = Object.freeze({
  sound: Object.freeze(['on', 'off']),
  quality: Object.freeze(['auto', 'performance']),
  golfFormat: Object.freeze(['front-six', 'quick-three', 'practice']),
  golfCupAssist: Object.freeze(['standard', 'family']),
  golfRivals: Object.freeze(['standard', 'relaxed']),
  runnerFormat: Object.freeze(['full-training', 'final-relay']),
  runnerPace: Object.freeze(['standard', 'calm']),
  runnerSafety: Object.freeze([5, 3, 1]),
  runnerSwipe: Object.freeze(['standard', 'easy']),
  ashfallMode: Object.freeze(['quick', 'full']),
  ashfallIntensity: Object.freeze(['calm', 'standard', 'inferno']),
  wingsRoute: Object.freeze(['quick', 'full']),
  wingsControl: Object.freeze(['guided', 'direct']),
  wingsRace: Object.freeze(['solo', 'rivals']),
  tideSession: Object.freeze(['quick', 'full']),
  tideTension: Object.freeze(['relaxed', 'standard']),
  tideScoring: Object.freeze(['haul', 'trophy']),
});

const choose = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const integer = value => Number.parseInt(String(value), 10);

function cloneDefaults(){
  return {
    sound: PREVIEW_DEFAULTS.sound,
    quality: PREVIEW_DEFAULTS.quality,
    golf: { ...PREVIEW_DEFAULTS.golf },
    runner: { ...PREVIEW_DEFAULTS.runner },
    ashfall: { ...PREVIEW_DEFAULTS.ashfall },
    wings: { ...PREVIEW_DEFAULTS.wings },
    tide: { ...PREVIEW_DEFAULTS.tide },
  };
}

export function normalizePreviewOptions(candidate = {}){
  const golf = candidate?.golf || {};
  const runner = candidate?.runner || {};
  const ashfall = candidate?.ashfall || {};
  const wings = candidate?.wings || {};
  const tide = candidate?.tide || {};
  const practiceHole = integer(golf.practiceHole);
  const safety = integer(runner.safety);
  return {
    sound: choose(candidate.sound, VALUES.sound, PREVIEW_DEFAULTS.sound),
    quality: choose(candidate.quality, VALUES.quality, PREVIEW_DEFAULTS.quality),
    golf: {
      format: choose(golf.format, VALUES.golfFormat, PREVIEW_DEFAULTS.golf.format),
      practiceHole: Number.isInteger(practiceHole) && practiceHole >= 1 && practiceHole <= 6
        ? practiceHole : PREVIEW_DEFAULTS.golf.practiceHole,
      cupAssist: choose(golf.cupAssist, VALUES.golfCupAssist, PREVIEW_DEFAULTS.golf.cupAssist),
      rivals: choose(golf.rivals, VALUES.golfRivals, PREVIEW_DEFAULTS.golf.rivals),
    },
    runner: {
      format: choose(runner.format, VALUES.runnerFormat, PREVIEW_DEFAULTS.runner.format),
      pace: choose(runner.pace, VALUES.runnerPace, PREVIEW_DEFAULTS.runner.pace),
      safety: choose(safety, VALUES.runnerSafety, PREVIEW_DEFAULTS.runner.safety),
      swipe: choose(runner.swipe, VALUES.runnerSwipe, PREVIEW_DEFAULTS.runner.swipe),
    },
    ashfall: {
      mode: choose(ashfall.mode, VALUES.ashfallMode, PREVIEW_DEFAULTS.ashfall.mode),
      intensity: choose(ashfall.intensity, VALUES.ashfallIntensity, PREVIEW_DEFAULTS.ashfall.intensity),
    },
    wings: {
      route: choose(wings.route, VALUES.wingsRoute, PREVIEW_DEFAULTS.wings.route),
      control: choose(wings.control, VALUES.wingsControl, PREVIEW_DEFAULTS.wings.control),
      race: choose(wings.race, VALUES.wingsRace, PREVIEW_DEFAULTS.wings.race),
    },
    tide: {
      session: choose(tide.session, VALUES.tideSession, PREVIEW_DEFAULTS.tide.session),
      tension: choose(tide.tension, VALUES.tideTension, PREVIEW_DEFAULTS.tide.tension),
      scoring: choose(tide.scoring, VALUES.tideScoring, PREVIEW_DEFAULTS.tide.scoring),
    },
  };
}

function safeStorage(storage){
  try {
    if(!storage) return null;
    const value = storage.getItem(STORAGE_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function applyUrlOverrides(state, params){
  const next = normalizePreviewOptions(state);
  if(params.has('sound')) next.sound = params.get('sound');
  if(params.has('quality')) next.quality = params.get('quality');
  if(params.has('golfFormat')) next.golf.format = params.get('golfFormat');
  if(params.has('golfHole')) next.golf.practiceHole = integer(params.get('golfHole'));
  if(params.has('golfCup')) next.golf.cupAssist = params.get('golfCup');
  if(params.has('golfRivals')) next.golf.rivals = params.get('golfRivals');
  if(params.has('runnerFormat')) next.runner.format = params.get('runnerFormat');
  if(params.has('runnerPace')) next.runner.pace = params.get('runnerPace');
  if(params.has('runnerSafety')) next.runner.safety = integer(params.get('runnerSafety'));
  if(params.has('runnerSwipe')) next.runner.swipe = params.get('runnerSwipe');
  if(params.has('ashMode')) next.ashfall.mode = params.get('ashMode');
  if(params.has('ashIntensity')) next.ashfall.intensity = params.get('ashIntensity');
  if(params.has('wingsRoute')) next.wings.route = params.get('wingsRoute');
  if(params.has('wingsControl')) next.wings.control = params.get('wingsControl');
  if(params.has('wingsRace')) next.wings.race = params.get('wingsRace');
  if(params.has('tideSession')) next.tide.session = params.get('tideSession');
  if(params.has('tideTension')) next.tide.tension = params.get('tideTension');
  if(params.has('tideScoring')) next.tide.scoring = params.get('tideScoring');
  return normalizePreviewOptions(next);
}

export function readPreviewOptions({
  url = typeof location === 'undefined' ? null : new URL(location.href),
  storage = typeof localStorage === 'undefined' ? null : localStorage,
} = {}){
  const stored = safeStorage(storage);
  const state = normalizePreviewOptions(stored || cloneDefaults());
  return url ? applyUrlOverrides(state, url.searchParams) : state;
}

export function writePreviewOptions(options, {
  storage = typeof localStorage === 'undefined' ? null : localStorage,
} = {}){
  const normalized = normalizePreviewOptions(options);
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch {}
  return normalized;
}

export function setPreviewOption(options, path, value){
  const next = normalizePreviewOptions(options);
  const [group, key] = path.split('.');
  if(key && ['golf', 'runner', 'ashfall', 'wings', 'tide'].includes(group)) next[group][key] = value;
  else if(!key && (group === 'sound' || group === 'quality')) next[group] = value;
  return normalizePreviewOptions(next);
}

export function previewGameHref(game, options, {
  base = `./${game}/index.html`,
  fast = false,
} = {}){
  if(!['golf', 'runner', 'ashfall', 'wings', 'tide'].includes(game)) throw new RangeError(`Unknown preview game: ${game}`);
  const state = normalizePreviewOptions(options);
  const params = new URLSearchParams({
    preview: '1',
    sound: state.sound,
    quality: state.quality,
  });
  if(game === 'golf'){
    params.set('golfFormat', state.golf.format);
    params.set('golfHole', String(state.golf.practiceHole));
    params.set('golfCup', state.golf.cupAssist);
    params.set('golfRivals', state.golf.rivals);
  } else if(game === 'runner') {
    params.set('runnerFormat', state.runner.format);
    params.set('runnerPace', state.runner.pace);
    params.set('runnerSafety', String(state.runner.safety));
    params.set('runnerSwipe', state.runner.swipe);
  } else if(game === 'ashfall') {
    params.set('ashMode', state.ashfall.mode);
    params.set('ashIntensity', state.ashfall.intensity);
  } else if(game === 'wings') {
    params.set('wingsRoute', state.wings.route);
    params.set('wingsControl', state.wings.control);
    params.set('wingsRace', state.wings.race);
  } else {
    params.set('tideSession', state.tide.session);
    params.set('tideTension', state.tide.tension);
    params.set('tideScoring', state.tide.scoring);
  }
  if(fast) params.set('fast', '1');
  return `${base}?${params}`;
}

export function golfRoundHoles(options){
  const state = normalizePreviewOptions(options);
  if(state.golf.format === 'practice') return [state.golf.practiceHole - 1];
  if(state.golf.format === 'quick-three') return [0, 1, 2];
  return [0, 1, 2, 3, 4, 5];
}

export function golfFormatLabel(options){
  const state = normalizePreviewOptions(options);
  if(state.golf.format === 'practice') return `Practice · Hole ${state.golf.practiceHole}`;
  return state.golf.format === 'quick-three' ? 'Quick Three' : 'Front Six';
}

export function runnerFormatLabel(options){
  return normalizePreviewOptions(options).runner.format === 'final-relay' ? 'Final Relay · 112M' : 'Full Training · 150M';
}

function updateCurrentUrl(state){
  const url = new URL(location.href);
  url.searchParams.set('sound', state.sound);
  url.searchParams.set('quality', state.quality);
  history.replaceState(null, '', url);
}

function siblingPreviewHubUrl(game, currentUrl){
  if(!['golf', 'runner', 'ashfall', 'wings', 'tide'].includes(game)) throw new RangeError(`Unknown preview game: ${game}`);
  const gameDirectory = new URL('./', currentUrl);
  const expectedSuffix = `/${game}/`;
  if(gameDirectory.origin !== currentUrl.origin || !gameDirectory.pathname.endsWith(expectedSuffix)){
    throw new Error(`Preview game must run from its versioned ${expectedSuffix} directory`);
  }
  const hub = new URL('../index.html', gameDirectory);
  const roundTrip = new URL(`./${game}/`, hub);
  if(hub.origin !== currentUrl.origin || roundTrip.origin !== currentUrl.origin || roundTrip.pathname !== gameDirectory.pathname){
    throw new Error('Preview hub must be the same-origin sibling of the game directory');
  }
  hub.search = '';
  hub.hash = '';
  return hub;
}

function appendControl(parent, element, { id, text, className = 'pcAction' } = {}){
  element.id = id;
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

export function createPreviewMenuOpenState({ onOpenChange = null } = {}){
  if(onOpenChange !== null && typeof onOpenChange !== 'function'){
    throw new TypeError('onOpenChange must be a function or null');
  }
  let open = false;
  return Object.freeze({
    set(next){
      const normalized = Boolean(next);
      if(normalized === open) return false;
      open = normalized;
      onOpenChange?.(open);
      return true;
    },
    get open(){ return open; },
  });
}

export function mountPreviewGameChrome({ game, options, onSoundChange = null, onOpenChange = null } = {}){
  const url = new URL(location.href);
  if(url.searchParams.get('preview') !== '1') return null;
  const hub = siblingPreviewHubUrl(game, url);
  let state = writePreviewOptions(options);
  const openState = createPreviewMenuOpenState({ onOpenChange });
  const style = document.createElement('style');
  style.textContent = `
    #pcScrim{position:fixed;z-index:69;inset:0;border:0;margin:0;padding:0;background:rgba(3,5,12,.22);touch-action:none;overscroll-behavior:contain;cursor:default}
    #pcScrim[hidden]{display:none}
    #previewChrome{position:fixed;z-index:70;right:max(12px,env(safe-area-inset-right));top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:8px;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif}
    #previewChrome button,#previewChrome a{min-width:44px;min-height:44px;border:1px solid rgba(255,255,255,.2);background:rgba(7,9,19,.86);color:#f8fbff;box-shadow:0 8px 24px rgba(0,0,0,.3);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);font:800 11px/1 -apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;letter-spacing:.08em;text-decoration:none;display:flex;align-items:center;justify-content:center;touch-action:manipulation;transition:transform .18s ease,background .18s ease,border-color .18s ease}
    #previewChrome button:active,#previewChrome a:active{transform:scale(.97)}
    #previewChrome button:focus-visible,#previewChrome a:focus-visible{outline:3px solid #fff;outline-offset:2px}
    #pcMenu{width:58px;height:48px;padding:0;border-radius:10px;pointer-events:auto}
    #pcMenu[aria-expanded="true"]{background:rgba(27,34,52,.96);border-color:rgba(255,255,255,.42)}
    #pcSheet{width:min(224px,calc(100vw - 96px));padding:10px;border:1px solid rgba(255,255,255,.18);border-radius:14px;background:rgba(8,11,22,.92);box-shadow:0 18px 52px rgba(0,0,0,.38);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);pointer-events:auto}
    #pcSheet[hidden]{display:none}
    #pcSheet .pcHead{min-height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 2px 7px 8px;color:rgba(248,251,255,.66);font-size:10px;font-weight:800;letter-spacing:.18em}
    #pcSheet #pcClose{width:44px;height:44px;padding:0;border-radius:9px;background:rgba(255,255,255,.06);box-shadow:none;font-size:17px}
    #pcSheet .pcActions{display:grid;gap:7px}
    #pcSheet .pcAction{width:100%;height:44px;justify-content:flex-start;padding:0 13px;border-radius:9px;box-shadow:none}
    body.previewMode #mute{display:none!important}
  `;
  document.head.append(style);
  document.body.classList.add('previewMode');
  const scrim = document.createElement('div');
  scrim.id = 'pcScrim';
  scrim.hidden = true;
  scrim.setAttribute('aria-hidden', 'true');
  const root = document.createElement('nav');
  root.id = 'previewChrome';
  root.setAttribute('aria-label', 'Preview controls');

  const sheet = document.createElement('section');
  sheet.id = 'pcSheet';
  sheet.hidden = true;
  sheet.setAttribute('aria-label', 'Game menu');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  const heading = document.createElement('div');
  heading.className = 'pcHead';
  const headingText = document.createElement('span');
  headingText.textContent = 'GAME MENU';
  const close = appendControl(heading, document.createElement('button'), { id: 'pcClose', text: '×', className: '' });
  close.type = 'button';
  close.setAttribute('aria-label', 'Close game menu');
  heading.prepend(headingText);
  const actions = document.createElement('div');
  actions.className = 'pcActions';
  const back = appendControl(actions, document.createElement('a'), { id: 'pcBack', text: '← BACK TO GAMES' });
  back.href = hub.href;
  const reset = appendControl(actions, document.createElement('button'), { id: 'pcReset', text: 'RESET GAME' });
  reset.type = 'button';
  const sound = appendControl(actions, document.createElement('button'), {
    id: 'pcSound',
    text: state.sound === 'off' ? 'SOUND · OFF' : 'SOUND · ON',
  });
  sound.type = 'button';
  const quality = appendControl(actions, document.createElement('button'), {
    id: 'pcQuality',
    text: state.quality === 'performance' ? 'QUALITY · FAST' : 'QUALITY · AUTO',
  });
  quality.type = 'button';
  sheet.append(heading, actions);

  const menu = appendControl(root, document.createElement('button'), { id: 'pcMenu', text: 'MENU', className: '' });
  menu.type = 'button';
  menu.setAttribute('aria-controls', 'pcSheet');
  menu.setAttribute('aria-expanded', 'false');
  menu.setAttribute('aria-haspopup', 'dialog');
  root.prepend(sheet);
  document.body.append(scrim, root);

  let scrimPointerId = null;
  let scrimCloseTimer = null;
  const releaseScrimPointer = () => {
    if(scrimPointerId === null) return;
    try {
      if(scrim.hasPointerCapture?.(scrimPointerId)) scrim.releasePointerCapture(scrimPointerId);
    } catch {}
    scrimPointerId = null;
  };
  const resetScrimSequence = () => {
    releaseScrimPointer();
    if(scrimCloseTimer !== null){
      clearTimeout(scrimCloseTimer);
      scrimCloseTimer = null;
    }
  };
  const setOpen = open => {
    const next = Boolean(open);
    if(next === openState.open) return false;
    resetScrimSequence();
    if(!openState.set(next)) return false;
    sheet.hidden = !next;
    scrim.hidden = !next;
    menu.setAttribute('aria-expanded', String(next));
    if(next) close.focus({ preventScroll: true });
    else menu.focus({ preventScroll: true });
    return true;
  };
  menu.addEventListener('pointerdown', event => {
    if(event.pointerType === 'mouse') return;
    event.preventDefault();
    event.stopPropagation();
    try { menu.setPointerCapture?.(event.pointerId); } catch {}
    setOpen(!openState.open);
  }, { passive: false });
  for(const eventName of ['pointerup', 'pointercancel']){
    menu.addEventListener(eventName, event => {
      if(event.pointerType === 'mouse') return;
      event.preventDefault();
      event.stopPropagation();
      try {
        if(menu.hasPointerCapture?.(event.pointerId)) menu.releasePointerCapture(event.pointerId);
      } catch {}
    }, { passive: false });
  }
  menu.addEventListener('click', event => {
    // Touch and pen sequences toggle on pointerdown so a game-level
    // preventDefault() cannot suppress MENU. Their synthetic click is only a
    // compatibility tail and must never toggle a second time.
    if(event.pointerType && event.pointerType !== 'mouse'){
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    setOpen(!openState.open);
  });
  close.addEventListener('click', event => {
    event.stopPropagation();
    setOpen(false);
  });
  scrim.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
    if(!openState.open || scrimPointerId !== null) return;
    scrimPointerId = event.pointerId;
    try { scrim.setPointerCapture?.(event.pointerId); } catch {}
  }, { passive: false });
  scrim.addEventListener('pointercancel', event => {
    event.preventDefault();
    event.stopPropagation();
    if(event.pointerId === scrimPointerId) releaseScrimPointer();
  }, { passive: false });
  scrim.addEventListener('pointerup', event => {
    event.preventDefault();
    event.stopPropagation();
    if(event.pointerId !== scrimPointerId) return;
    releaseScrimPointer();
    // Keep the scrim mounted until the compatibility click has had a chance
    // to target it. If the browser suppresses click, this closes next task.
    scrimCloseTimer = setTimeout(() => {
      scrimCloseTimer = null;
      setOpen(false);
    }, 0);
  }, { passive: false });
  scrim.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if(scrimCloseTimer === null) return;
    clearTimeout(scrimCloseTimer);
    scrimCloseTimer = null;
    setOpen(false);
  });
  document.addEventListener('keydown', event => {
    if(!openState.open) return;
    if(event.key === 'Escape'){
      event.preventDefault();
      setOpen(false);
      return;
    }
    if(event.key !== 'Tab') return;
    const focusable = [...sheet.querySelectorAll('a[href],button:not([disabled])')]
      .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
    if(focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if(event.shiftKey && document.activeElement === first){
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if(!event.shiftKey && document.activeElement === last){
      event.preventDefault();
      first.focus({ preventScroll: true });
    } else if(!sheet.contains(document.activeElement)){
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  });
  reset.addEventListener('click', () => location.reload());
  quality.addEventListener('click', () => {
    state = setPreviewOption(state, 'quality', state.quality === 'auto' ? 'performance' : 'auto');
    writePreviewOptions(state);
    updateCurrentUrl(state);
    location.reload();
  });
  sound.addEventListener('click', event => {
    state = setPreviewOption(state, 'sound', state.sound === 'on' ? 'off' : 'on');
    writePreviewOptions(state);
    updateCurrentUrl(state);
    event.currentTarget.textContent = state.sound === 'off' ? 'SOUND · OFF' : 'SOUND · ON';
    onSoundChange?.(state.sound);
  });
  return root;
}

export { STORAGE_KEY as PREVIEW_STORAGE_KEY };
