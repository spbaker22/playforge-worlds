/* LOW TIDE — fixed-step fishing round simulation. */
import { fishForCast, harborZoneForCast, scoreFish } from './fish.js';

const SESSIONS = Object.freeze({ quick: 45, full: 90 });
const ACTIVE_CAST_PHASES = new Set(['casting', 'waiting', 'bite', 'reeling']);
export const TIDE_TENSION = Object.freeze({
  relaxed: Object.freeze({ limit: 0.96, snapGrace: 0.42, riseScale: 0.79, recovery: 0.52, hookWindow: 1.3 }),
  standard: Object.freeze({ limit: 0.88, snapGrace: 0.22, riseScale: 1, recovery: 0.43, hookWindow: 0.92 }),
});

export function tideDuration(session){ return SESSIONS[session] ?? SESSIONS.full; }
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function copyFish(fish){ return fish ? Object.freeze({ ...fish }) : null; }
function copyZone(zone){ return zone ? Object.freeze({ id: zone.id, label: zone.label, hint: zone.hint }) : null; }
function freezeState(state){
  return Object.freeze({
    status: state.status,
    phase: state.phase,
    session: state.session,
    tensionMode: state.tensionMode,
    scoring: state.scoring,
    time: state.time,
    duration: state.duration,
    remaining: Math.max(0, state.duration - state.time),
    overtime: state.overtime,
    phaseTime: state.phaseTime,
    seed: state.seed,
    castIndex: state.castIndex,
    castPower: state.castPower,
    castLateral: state.castLateral,
    castStartedAt: state.castStartedAt,
    castZone: copyZone(state.castZone),
    castFlight: state.castFlight,
    castProgress: state.castFlight > 0 ? clamp(state.phaseTime / state.castFlight, 0, 1) : 0,
    waitRemaining: Math.max(0, state.waitRemaining),
    biteRemaining: Math.max(0, state.biteRemaining),
    reelHeld: state.reelHeld,
    tension: state.tension,
    overTension: state.overTension,
    reelProgress: state.reelProgress,
    catches: state.catches,
    snaps: state.snaps,
    missedBites: state.missedBites,
    haulKg: Math.round(state.haulKg * 10) / 10,
    score: state.score,
    bestFish: copyFish(state.bestFish),
    currentFish: copyFish(state.currentFish),
    lastOutcome: state.lastOutcome ? Object.freeze({ ...state.lastOutcome, fish: copyFish(state.lastOutcome.fish), zone: copyZone(state.lastOutcome.zone) }) : null,
    finishReason: state.finishReason,
  });
}

export function createTideSim({
  session = 'full',
  tension = 'standard',
  scoring = 'haul',
  seed = 0x10f71de,
  duration = null,
  fishPlan = null,
} = {}){
  if(!Object.hasOwn(SESSIONS, session)) throw new RangeError(`unsupported tideSession: ${session}`);
  if(!Object.hasOwn(TIDE_TENSION, tension)) throw new RangeError(`unsupported tideTension: ${tension}`);
  if(scoring !== 'haul' && scoring !== 'trophy') throw new RangeError(`unsupported tideScoring: ${scoring}`);
  if(duration !== null && (!Number.isFinite(duration) || duration <= 0)) throw new RangeError('duration must be positive');
  if(fishPlan !== null && typeof fishPlan !== 'function') throw new TypeError('fishPlan must be a function');
  const profile = TIDE_TENSION[tension];
  const config = Object.freeze({ session, tension, scoring, seed: seed >>> 0, duration: duration ?? tideDuration(session), ...profile });
  let state;
  let events = [];

  function emit(type, detail = {}){ events.push(Object.freeze({ type, time: state.time, ...detail })); }
  function setPhase(phase, detail = {}){
    const from = state.phase;
    state.phase = phase;
    state.phaseTime = 0;
    emit('phase', { from, to: phase, ...detail });
  }

  function initialState(){
    return {
      status: 'running', phase: 'aim', session, tensionMode: tension, scoring,
      time: 0, duration: config.duration, overtime: false, phaseTime: 0, seed: config.seed,
      castIndex: 0, castPower: 0, castLateral: 0, castStartedAt: null, castZone: null, castFlight: 0,
      waitRemaining: 0, biteRemaining: 0,
      reelHeld: false, tension: 0, overTension: 0, reelProgress: 0,
      catches: 0, snaps: 0, missedBites: 0, haulKg: 0, score: 0,
      bestFish: null, currentFish: null, lastOutcome: null, finishReason: null,
    };
  }

  function plannedFish(power, lateral, zone){
    const index = state.castIndex;
    const request = Object.freeze({ seed: config.seed, castIndex: index, scoring, castPower: power, castLateral: lateral, zone });
    const planned = fishPlan?.(request);
    const selected = planned || fishForCast(request);
    return Object.freeze({ ...selected, zone: zone.id, zoneLabel: zone.label });
  }

  function cast(power, lateral = 0){
    if(state.status !== 'running' || state.phase !== 'aim' || state.time >= state.duration) return false;
    if(!Number.isFinite(power) || !Number.isFinite(lateral)) return false;
    state.castPower = clamp(power, 0.08, 1);
    state.castLateral = clamp(lateral, -1, 1);
    state.castStartedAt = state.time;
    state.castZone = harborZoneForCast({ castPower: state.castPower, castLateral: state.castLateral });
    state.currentFish = plannedFish(state.castPower, state.castLateral, state.castZone);
    state.castIndex += 1;
    state.castFlight = 0.62 + state.castPower * 0.7;
    state.lastOutcome = null;
    setPhase('casting', { power: state.castPower, lateral: state.castLateral, zone: state.castZone.id, fishId: state.currentFish.id });
    emit('cast', { power: state.castPower, lateral: state.castLateral, zone: state.castZone.id, flight: state.castFlight });
    return true;
  }

  function hook(){
    if(state.status !== 'running' || state.phase !== 'bite' || state.biteRemaining <= 0) return false;
    state.reelHeld = false;
    state.tension = 0.27 + state.currentFish.fight * 0.08;
    state.overTension = 0;
    state.reelProgress = 0;
    setPhase('reeling', { fishId: state.currentFish.id });
    emit('hooked', { fishId: state.currentFish.id, weightKg: state.currentFish.weightKg });
    return true;
  }

  function setReeling(held){
    if(state.status !== 'running' || state.phase !== 'reeling') return false;
    const next = Boolean(held);
    if(next === state.reelHeld) return false;
    state.reelHeld = next;
    emit(next ? 'reel-start' : 'reel-stop', { tension: state.tension, progress: state.reelProgress });
    return true;
  }

  function resolveCatch(){
    const fish = state.currentFish;
    const points = scoreFish(fish, scoring);
    state.reelHeld = false;
    state.catches += 1;
    state.haulKg += fish.weightKg;
    state.score += points;
    if(!state.bestFish || fish.weightKg > state.bestFish.weightKg) state.bestFish = fish;
    state.lastOutcome = { type: 'catch', fish, zone: state.castZone, points, reason: 'landed' };
    setPhase('catch', { fishId: fish.id, zone: state.castZone.id, points });
    emit('catch', { fish: copyFish(fish), zone: state.castZone.id, points, haulKg: state.haulKg });
  }

  function resolveSnap(reason){
    const fish = state.currentFish;
    state.reelHeld = false;
    state.snaps += 1;
    if(reason === 'missed-bite') state.missedBites += 1;
    state.lastOutcome = { type: 'snap', fish, zone: state.castZone, points: 0, reason };
    setPhase('snap', { fishId: fish?.id ?? null, zone: state.castZone?.id ?? null, reason });
    emit('snap', { fish: copyFish(fish), zone: state.castZone?.id ?? null, reason });
  }

  function finish(reason = 'time'){
    if(state.status === 'finished') return false;
    state.reelHeld = false;
    state.status = 'finished';
    state.finishReason = reason;
    setPhase('finished', { reason });
    emit('finished', { reason, score: state.score, haulKg: state.haulKg, catches: state.catches });
    return true;
  }

  function nextCast(){
    if(state.status !== 'running' || (state.phase !== 'catch' && state.phase !== 'snap')) return false;
    if(state.time >= state.duration || state.overtime) return finish('last-fish');
    const outcome = state.lastOutcome?.type ?? 'unknown';
    state.currentFish = null;
    state.castPower = 0; state.castLateral = 0; state.castStartedAt = null; state.castZone = null; state.castFlight = 0;
    state.waitRemaining = 0; state.biteRemaining = 0;
    state.tension = 0; state.overTension = 0; state.reelProgress = 0;
    setPhase('aim', { after: outcome });
    emit('next-cast', { after: outcome, remaining: Math.max(0, state.duration - state.time) });
    return true;
  }

  function updateReeling(dt){
    const fish = state.currentFish;
    const wave = 0.72 + Math.sin(state.phaseTime * (2.1 + fish.fight * 1.7) + fish.surgePhase) * 0.18;
    const surge = Math.pow(Math.max(0, Math.sin(state.phaseTime * 1.38 + fish.surgePhase * 0.71)), 8);
    const pull = clamp(fish.fight * wave + surge * 0.22, 0.16, 1.12);
    if(state.reelHeld){
      state.tension += (0.125 + pull * 0.22 + surge * 0.21) * config.riseScale * dt;
      const caution = clamp((state.tension - 0.66) / 0.28, 0, 1);
      state.reelProgress += (0.108 + (1 - Math.min(1, pull)) * 0.058) * (1 - caution * 0.42) * dt;
    } else {
      state.tension -= (config.recovery - pull * 0.075) * dt;
      state.reelProgress -= 0.004 * dt;
    }
    state.tension = clamp(state.tension, 0.04, 1.18);
    state.reelProgress = clamp(state.reelProgress, 0, 1);
    if(state.tension >= config.limit) state.overTension += dt;
    else state.overTension = Math.max(0, state.overTension - dt * 2.4);
    if(state.overTension >= config.snapGrace) resolveSnap('line-tension');
    else if(state.reelProgress >= 1) resolveCatch();
  }

  function step(dt){
    if(!Number.isFinite(dt) || dt <= 0) throw new RangeError('dt must be positive');
    if(state.status !== 'running') return snapshot();
    const activeCastAtStart = ACTIVE_CAST_PHASES.has(state.phase);
    state.time = Math.min(state.duration, state.time + dt);
    state.phaseTime += dt;
    if(state.time >= state.duration && activeCastAtStart) state.overtime = true;

    if(state.phase === 'casting' && state.phaseTime >= state.castFlight){
      state.waitRemaining = state.currentFish.biteDelay;
      setPhase('waiting', { fishId: state.currentFish.id });
      emit('splash', { power: state.castPower, lateral: state.castLateral });
    } else if(state.phase === 'waiting'){
      state.waitRemaining -= dt;
      if(state.waitRemaining <= 0){
        state.biteRemaining = config.hookWindow;
        setPhase('bite', { window: config.hookWindow, fishId: state.currentFish.id });
        emit('bite', { fishId: state.currentFish.id, window: config.hookWindow });
      }
    } else if(state.phase === 'bite'){
      state.biteRemaining -= dt;
      if(state.biteRemaining <= 0) resolveSnap('missed-bite');
    } else if(state.phase === 'reeling') updateReeling(dt);

    if(state.time >= state.duration && state.status === 'running'){
      if(ACTIVE_CAST_PHASES.has(state.phase)) state.overtime = true;
      else if(state.phase !== 'catch' && state.phase !== 'snap') finish('time');
    }
    return snapshot();
  }

  function reset(){
    state = initialState();
    events = [];
    emit('reset', { session, tension, scoring, duration: state.duration });
    return snapshot();
  }
  function snapshot(){ return freezeState(state); }
  function drainEvents(){
    if(events.length === 0) return Object.freeze([]);
    const drained = Object.freeze(events);
    events = [];
    return drained;
  }

  state = initialState();
  emit('reset', { session, tension, scoring, duration: state.duration });
  return Object.freeze({ cast, hook, setReeling, nextCast, finish, step, reset, snapshot, drainEvents, config, get state(){ return snapshot(); } });
}
