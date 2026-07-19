/* PAPER WINGS - deterministic aerobatic recognition, risk, and stunt-chain reducer. */

export const STUNT_STATE_VERSION = 1;
export const STUNT_CHAIN_WINDOW = 4;
const TAU = Math.PI * 2;

export const STUNT_ACTION = Object.freeze({
  BEGIN: 'begin',
  TICK: 'tick',
  CANCEL: 'cancel',
  REGISTER: 'register',
});

export const STUNT_DEFINITIONS = Object.freeze({
  'axial-roll': Object.freeze({ id: 'axial-roll', requirements: Object.freeze([{ axis: 'roll', magnitude: TAU, direction: 'either' }]), maxDuration: 3, maxAltitudeLoss: 16, score: 200, energy: 12 }),
  'inside-loop': Object.freeze({ id: 'inside-loop', requirements: Object.freeze([{ axis: 'pitch', magnitude: TAU, direction: 'positive' }]), maxDuration: 4.2, maxAltitudeLoss: 24, score: 320, energy: 18 }),
  'outside-loop': Object.freeze({ id: 'outside-loop', requirements: Object.freeze([{ axis: 'pitch', magnitude: TAU, direction: 'negative' }]), maxDuration: 4.2, maxAltitudeLoss: 28, score: 380, energy: 20 }),
  'barrel-roll': Object.freeze({ id: 'barrel-roll', requirements: Object.freeze([{ axis: 'roll', magnitude: TAU, direction: 'either' }, { axis: 'pitch', magnitude: Math.PI, direction: 'either' }]), maxDuration: 4.5, maxAltitudeLoss: 24, score: 450, energy: 24 }),
  wingover: Object.freeze({ id: 'wingover', requirements: Object.freeze([{ axis: 'roll', magnitude: Math.PI, direction: 'either' }, { axis: 'yaw', magnitude: Math.PI, direction: 'either' }]), maxDuration: 3.8, maxAltitudeLoss: 20, score: 300, energy: 16 }),
  'proximity-thread': Object.freeze({ id: 'proximity-thread', requirements: Object.freeze([]), instant: true, maxDuration: 0, maxAltitudeLoss: 0, score: 250, energy: 14 }),
});

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function stuntDefinition(kind){
  return STUNT_DEFINITIONS[kind] || null;
}

export function createStuntState(){
  return {
    version: STUNT_STATE_VERSION,
    time: 0,
    active: null,
    chain: 0,
    bestChain: 0,
    chainRemaining: 0,
    completions: 0,
    failures: 0,
    energyEarned: 0,
    completedStuntIds: [],
    failedStuntIds: [],
    lastResult: null,
    event: null,
    eventSequence: 0,
  };
}

function isResolved(state, id){
  return state.completedStuntIds.includes(id) || state.failedStuntIds.includes(id);
}

function requirementProgress(rotation, requirement){
  const value = rotation[requirement.axis];
  if(requirement.direction === 'positive') return clamp(value / requirement.magnitude, 0, 1);
  if(requirement.direction === 'negative') return clamp(-value / requirement.magnitude, 0, 1);
  return clamp(Math.abs(value) / requirement.magnitude, 0, 1);
}

export function stuntProgress(active){
  if(!active) return 0;
  const definition = stuntDefinition(active.kind);
  if(!definition || definition.instant) return 0;
  return Math.min(...definition.requirements.map(requirement => requirementProgress(active.rotation, requirement)));
}

function resolveCompletion(state, id, kind, quality = 1){
  const definition = stuntDefinition(kind);
  const chain = state.chainRemaining > 0 ? state.chain + 1 : 1;
  const multiplier = 1 + Math.min(1.5, (chain - 1) * 0.25);
  const score = Math.round(definition.score * clamp(finite(quality, 1), 0.5, 2) * multiplier);
  const energy = Math.round(definition.energy * clamp(finite(quality, 1), 0.5, 2));
  const result = { id, kind, chain, multiplier, score, energy };
  return {
    ...state,
    active: null,
    chain,
    bestChain: Math.max(state.bestChain, chain),
    chainRemaining: STUNT_CHAIN_WINDOW,
    completions: state.completions + 1,
    energyEarned: state.energyEarned + energy,
    completedStuntIds: [...state.completedStuntIds, id],
    lastResult: result,
    event: `completed:${kind}`,
    eventSequence: state.eventSequence + 1,
  };
}

function resolveFailure(state, reason){
  if(!state.active) return { ...state, event: null };
  const result = { id: state.active.id, kind: state.active.kind, reason };
  return {
    ...state,
    active: null,
    failures: state.failures + 1,
    failedStuntIds: [...state.failedStuntIds, result.id],
    lastResult: result,
    event: `failed:${reason}`,
    eventSequence: state.eventSequence + 1,
  };
}

function tick(state, action){
  if(!Number.isFinite(action.dt) || action.dt < 0) throw new RangeError('stunt tick dt must be non-negative');
  const chainRemaining = Math.max(0, state.chainRemaining - action.dt);
  const chainExpired = state.chain > 0 && chainRemaining === 0;
  let next = {
    ...state,
    time: state.time + action.dt,
    chain: chainExpired ? 0 : state.chain,
    chainRemaining,
    event: chainExpired ? 'chain-expired' : null,
    eventSequence: chainExpired ? state.eventSequence + 1 : state.eventSequence,
  };
  if(!state.active) return next;
  const active = {
    ...state.active,
    elapsed: state.active.elapsed + action.dt,
    rotation: {
      roll: state.active.rotation.roll + finite(action.rollDelta, 0),
      pitch: state.active.rotation.pitch + finite(action.pitchDelta, 0),
      yaw: state.active.rotation.yaw + finite(action.yawDelta, 0),
    },
  };
  const altitude = Number.isFinite(action.altitude) ? action.altitude : active.lastAltitude;
  active.lastAltitude = altitude;
  active.minAltitude = Math.min(active.minAltitude, altitude);
  active.maxAltitude = Math.max(active.maxAltitude, altitude);
  next.active = active;
  const definition = stuntDefinition(active.kind);
  if(active.startAltitude - active.minAltitude > definition.maxAltitudeLoss) return resolveFailure(next, 'altitude-loss');
  if(stuntProgress(active) >= 1) return resolveCompletion(next, active.id, active.kind, action.quality);
  if(active.elapsed > definition.maxDuration) return resolveFailure(next, 'timeout');
  return next;
}

export function reduceStunts(state, action){
  if(!state || state.version !== STUNT_STATE_VERSION) throw new TypeError('valid stunt state is required');
  if(!action || typeof action.type !== 'string') throw new TypeError('stunt action is required');
  switch(action.type){
    case STUNT_ACTION.BEGIN: {
      if(typeof action.stuntId !== 'string' || action.stuntId.length === 0) throw new TypeError('stunts require a stable stuntId');
      const definition = stuntDefinition(action.kind);
      if(!definition || definition.instant) throw new RangeError(`unknown active stunt ${action.kind}`);
      if(isResolved(state, action.stuntId)) return { ...state, event: null };
      if(state.active) throw new RangeError(`stunt ${state.active.id} is already active`);
      const altitude = finite(action.altitude, 0);
      return {
        ...state,
        active: { id: action.stuntId, kind: action.kind, elapsed: 0, startAltitude: altitude, lastAltitude: altitude, minAltitude: altitude, maxAltitude: altitude, rotation: { roll: 0, pitch: 0, yaw: 0 } },
        lastResult: null,
        event: `began:${action.kind}`,
        eventSequence: state.eventSequence + 1,
      };
    }
    case STUNT_ACTION.TICK:
      return tick(state, action);
    case STUNT_ACTION.CANCEL:
      return resolveFailure(state, action.reason || 'cancelled');
    case STUNT_ACTION.REGISTER: {
      if(typeof action.stuntId !== 'string' || action.stuntId.length === 0) throw new TypeError('stunts require a stable stuntId');
      const definition = stuntDefinition(action.kind);
      if(!definition?.instant) throw new RangeError(`stunt ${action.kind} cannot be registered instantly`);
      if(isResolved(state, action.stuntId)) return { ...state, event: null };
      return resolveCompletion(state, action.stuntId, action.kind, action.quality);
    }
    default:
      throw new RangeError(`unknown stunt action ${action.type}`);
  }
}

export function stuntSnapshot(state){
  if(!state || state.version !== STUNT_STATE_VERSION) throw new TypeError('valid stunt state is required');
  return Object.freeze(JSON.parse(JSON.stringify(state)));
}
