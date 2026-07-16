/* Gridlock Run — guarded, tick-owned race and recovery lifecycle. */
import { createModeScope } from '../../engine/mode.js';

const MODES = Object.freeze([
  'title',
  'intro',
  'countdown',
  'tutorial',
  'race',
  'crash',
  'recover',
  'failed',
  'finish',
  'results',
]);

const ACTIVE_MODES = new Set(['tutorial', 'race']);
const ALLOWED = new Map([
  [null, new Set(['title'])],
  ['title', new Set(['intro'])],
  ['intro', new Set(['countdown'])],
  ['countdown', new Set(['tutorial', 'race'])],
  ['tutorial', new Set(['race', 'crash'])],
  ['race', new Set(['crash', 'finish'])],
  ['crash', new Set(['recover', 'failed'])],
  ['recover', new Set(['tutorial', 'race'])],
  ['failed', new Set(['results'])],
  ['finish', new Set(['results'])],
  ['results', new Set(['countdown'])],
]);

const DEFAULT_DURATIONS = Object.freeze({
  intro: 6.4,
  countdown: 3,
  crash: 0.55,
  failed: 1.2,
  finish: 2.3,
});

const clone = value => value === null || value === undefined ? value : structuredClone(value);

function resolveDurations(overrides){
  if(overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)){
    throw new TypeError('durations must be an object');
  }
  // Only modes whose presentation is flow-timed belong here. Recovery is
  // simulation-owned and deliberately ignores any legacy `recover` override.
  const durations = { ...DEFAULT_DURATIONS };
  for(const mode of Object.keys(DEFAULT_DURATIONS)){
    if(overrides[mode] !== undefined) durations[mode] = overrides[mode];
  }
  for(const mode of Object.keys(DEFAULT_DURATIONS)){
    if(!Number.isFinite(durations[mode]) || durations[mode] < 0){
      throw new RangeError(`duration for ${mode} must be a non-negative number`);
    }
  }
  return Object.freeze(durations);
}

/**
 * Own the legal Runner graph and its cinematic transition timers. Recovery is
 * the intentional exception: the pure simulation must finish its rewind and
 * the host must forward that event through completeRecovery(). Supplied mode
 * handlers receive this facade, so transitions cannot bypass diagnostics or
 * crash/recovery bookkeeping.
 *
 * The host must call tick(deltaSeconds). No wall-clock timeout is used here.
 */
export function createRunnerFlow({
  handlers = {},
  trace,
  durations: durationOverrides = {},
  initial = null,
} = {}){
  if(handlers === null || typeof handlers !== 'object' || Array.isArray(handlers)){
    throw new TypeError('handlers must be an object');
  }
  if(initial !== null && !MODES.includes(initial)) throw new RangeError(`unknown initial mode: ${initial}`);

  const durations = resolveDurations(durationOverrides);
  let scope = null;
  let api = null;
  let lastTransition = null;
  let countdownTarget = 'tutorial';
  let recoveryTarget = 'race';

  function scheduleAutomatic(mode, request){
    if(mode === 'intro'){
      scope.schedule(durations.intro, () => api.transition('countdown', {
        reason: 'intro-complete',
        detail: { nextMode: countdownTarget },
      }), { label: 'intro-to-countdown' });
      return;
    }

    if(mode === 'countdown'){
      const nextMode = request.detail?.nextMode === 'race' ? 'race' : 'tutorial';
      countdownTarget = nextMode;
      scope.schedule(durations.countdown, () => api.transition(nextMode, {
        reason: 'countdown-complete',
      }), { label: `countdown-to-${nextMode}` });
      return;
    }

    if(mode === 'crash'){
      const shieldsRemaining = request.detail?.shieldsRemaining;
      const canRecover = Number.isFinite(shieldsRemaining) && shieldsRemaining > 0;
      const nextMode = canRecover ? 'recover' : 'failed';
      scope.schedule(durations.crash, () => api.transition(nextMode, {
        reason: canRecover ? 'crash-recovery-ready' : 'shields-exhausted',
        detail: canRecover
          ? { shieldsRemaining, resumeMode: recoveryTarget }
          : { shieldsRemaining },
      }), { label: `crash-to-${nextMode}` });
      return;
    }

    if(mode === 'failed'){
      scope.schedule(durations.failed, () => api.transition('results', {
        reason: 'failure-presentation-complete',
      }), { label: 'failed-to-results' });
      return;
    }

    if(mode === 'finish'){
      scope.schedule(durations.finish, () => api.transition('results', {
        reason: 'finish-presentation-complete',
      }), { label: 'finish-to-results' });
    }
  }

  const composedHandlers = Object.fromEntries(MODES.map(mode => [mode, {
    enter(_scope, request){
      handlers[mode]?.enter?.(api, request);
      scheduleAutomatic(mode, request);
    },
    exit(_scope, request){ handlers[mode]?.exit?.(api, request); },
  }]));

  scope = createModeScope({
    handlers: composedHandlers,
    trace,
    canTransition(from, to){ return ALLOWED.get(from)?.has(to) === true; },
  });

  function transition(to, options = {}){
    let detail = options.detail ?? null;

    if(to === 'intro' || to === 'countdown'){
      const requested = detail?.nextMode;
      if(requested === 'tutorial' || requested === 'race') countdownTarget = requested;
      else if(to === 'intro') countdownTarget = 'tutorial';
    }

    if(to === 'crash'){
      const requestedResume = detail?.resumeMode;
      if(ACTIVE_MODES.has(requestedResume)) recoveryTarget = requestedResume;
      else if(ACTIVE_MODES.has(scope.mode)) recoveryTarget = scope.mode;
      detail = { ...(detail || {}), resumeMode: recoveryTarget };
    }

    if(to === 'recover' && ACTIVE_MODES.has(detail?.resumeMode)){
      recoveryTarget = detail.resumeMode;
    }

    const normalized = detail === (options.detail ?? null) ? options : { ...options, detail };
    const result = scope.transition(to, normalized);
    lastTransition = {
      ...result,
      detail: clone(normalized.detail ?? null),
      generation: scope.generation,
    };
    return result;
  }

  /** Resume only after the pure simulation emits `recovery-complete`. */
  function completeRecovery(detail = null){
    if(detail !== null && (typeof detail !== 'object' || Array.isArray(detail))){
      throw new TypeError('recovery detail must be an object or null');
    }
    return transition(recoveryTarget, {
      reason: 'recovery-complete',
      detail: { ...(detail || {}), resumeMode: recoveryTarget },
    });
  }

  function snapshot(){
    return {
      active: scope.active,
      mode: scope.mode,
      modeTime: scope.modeTime,
      generation: scope.generation,
      phase: scope.phase,
      pendingTasks: scope.pendingTasks,
      countdownTarget,
      recoveryTarget,
      durations: { ...durations },
      lastTransition: clone(lastTransition),
    };
  }

  api = {
    transition,
    completeRecovery,
    schedule: (...args) => scope.schedule(...args),
    tick: (...args) => scope.tick(...args),
    own: (...args) => scope.own(...args),
    guard: (...args) => scope.guard(...args),
    is: (...args) => scope.is(...args),
    dispose: (...args) => scope.dispose(...args),
    snapshot,
    get state(){ return snapshot(); },
    get active(){ return scope.active; },
    get mode(){ return scope.mode; },
    get modeTime(){ return scope.modeTime; },
    get generation(){ return scope.generation; },
    get phase(){ return scope.phase; },
    get signal(){ return scope.signal; },
    get pendingTasks(){ return scope.pendingTasks; },
    get trace(){ return scope.trace; },
    get lastTransition(){ return clone(lastTransition); },
    get durations(){ return { ...durations }; },
  };

  if(initial !== null) transition(initial, { reason: 'initial' });
  return api;
}
