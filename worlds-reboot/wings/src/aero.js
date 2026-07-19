/* PAPER WINGS - deterministic altitude, airspeed, wind-energy, boost, and shield reducer. */

export const AERO_STATE_VERSION = 1;

export const AERO_ACTION = Object.freeze({
  TICK: 'tick',
  SET_BOOST: 'set-boost',
  SET_SHIELD: 'set-shield',
  ADD_ENERGY: 'add-energy',
  IMPACT: 'impact',
  REPAIR: 'repair',
});

export const AERO_TUNING = Object.freeze({
  minAltitude: 8,
  maxAltitude: 140,
  minSpeed: 12,
  cruiseSpeed: 24,
  maxSpeed: 48,
  climbSpeedCost: 7,
  diveSpeedGain: 11,
  boostSpeedGain: 14,
  pitchLift: 11,
  thermalLift: 10,
  naturalSink: 0.65,
  speedResponse: 3.2,
  verticalResponse: 4.4,
  maxEnergy: 100,
  thermalEnergyRate: 8,
  boostEnergyRate: 20,
  shieldEnergyRate: 12,
  shieldImpactCost: 18,
  maxIntegrity: 3,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const approach = (current, target, rate, dt) => target + (current - target) * Math.exp(-rate * dt);

function eventState(state, event){
  return { ...state, event, eventSequence: state.eventSequence + 1 };
}

export function createAeroState(options = {}){
  const maxIntegrity = clamp(Math.floor(finite(options.maxIntegrity, AERO_TUNING.maxIntegrity)), 1, 99);
  const integrity = clamp(Math.floor(finite(options.integrity, maxIntegrity)), 0, maxIntegrity);
  return {
    version: AERO_STATE_VERSION,
    status: integrity > 0 ? 'active' : 'disabled',
    time: 0,
    altitude: clamp(finite(options.altitude, 36), AERO_TUNING.minAltitude, AERO_TUNING.maxAltitude),
    speed: clamp(finite(options.speed, AERO_TUNING.cruiseSpeed), AERO_TUNING.minSpeed, AERO_TUNING.maxSpeed),
    verticalSpeed: finite(options.verticalSpeed, 0),
    energy: clamp(finite(options.energy, 50), 0, AERO_TUNING.maxEnergy),
    integrity,
    maxIntegrity,
    boostActive: false,
    shieldActive: false,
    shieldHits: 0,
    unshieldedHits: 0,
    event: null,
    eventSequence: 0,
  };
}

function tick(state, action){
  const dt = action.dt;
  if(!Number.isFinite(dt) || dt < 0) throw new RangeError('aero tick dt must be non-negative');
  if(state.status !== 'active' || dt === 0) return { ...state, event: null };
  const pitch = clamp(finite(action.pitch, 0), -1, 1);
  const thermal = clamp(finite(action.thermal, 0), 0, 1);
  const boost = state.boostActive && state.energy > 0;
  const shield = state.shieldActive && state.energy > 0;
  const desiredSpeed = clamp(
    AERO_TUNING.cruiseSpeed
      - Math.max(0, pitch) * AERO_TUNING.climbSpeedCost
      + Math.max(0, -pitch) * AERO_TUNING.diveSpeedGain
      + (boost ? AERO_TUNING.boostSpeedGain : 0),
    AERO_TUNING.minSpeed,
    AERO_TUNING.maxSpeed,
  );
  const speed = approach(state.speed, desiredSpeed, AERO_TUNING.speedResponse, dt);
  const stallSink = speed < 15 ? (15 - speed) * 0.8 : 0;
  const desiredVertical = pitch * AERO_TUNING.pitchLift + thermal * AERO_TUNING.thermalLift - AERO_TUNING.naturalSink - stallSink;
  let verticalSpeed = approach(state.verticalSpeed, desiredVertical, AERO_TUNING.verticalResponse, dt);
  let altitude = clamp(state.altitude + verticalSpeed * dt, AERO_TUNING.minAltitude, AERO_TUNING.maxAltitude);
  if((altitude === AERO_TUNING.minAltitude && verticalSpeed < 0) || (altitude === AERO_TUNING.maxAltitude && verticalSpeed > 0)) verticalSpeed = 0;
  const gain = thermal * AERO_TUNING.thermalEnergyRate * dt + Math.max(0, finite(action.energyGainRate, 0)) * dt;
  const drainRate = (boost ? AERO_TUNING.boostEnergyRate : 0) + (shield ? AERO_TUNING.shieldEnergyRate : 0);
  const energy = clamp(state.energy + gain - drainRate * dt, 0, AERO_TUNING.maxEnergy);
  const exhausted = energy <= 0;
  return {
    ...state,
    time: state.time + dt,
    altitude,
    speed,
    verticalSpeed,
    energy,
    boostActive: boost && !exhausted,
    shieldActive: shield && !exhausted,
    event: exhausted && (boost || shield) ? 'energy-empty' : null,
    eventSequence: exhausted && (boost || shield) ? state.eventSequence + 1 : state.eventSequence,
  };
}

export function reduceAero(state, action){
  if(!state || state.version !== AERO_STATE_VERSION) throw new TypeError('valid aero state is required');
  if(!action || typeof action.type !== 'string') throw new TypeError('aero action is required');
  switch(action.type){
    case AERO_ACTION.TICK:
      return tick(state, action);
    case AERO_ACTION.SET_BOOST: {
      const active = action.active === true && state.status === 'active' && state.energy > 0;
      if(active === state.boostActive) return { ...state, event: null };
      return eventState({ ...state, boostActive: active, event: null }, active ? 'boost-on' : 'boost-off');
    }
    case AERO_ACTION.SET_SHIELD: {
      const active = action.active === true && state.status === 'active' && state.energy > 0;
      if(active === state.shieldActive) return { ...state, event: null };
      return eventState({ ...state, shieldActive: active, event: null }, active ? 'shield-on' : 'shield-off');
    }
    case AERO_ACTION.ADD_ENERGY: {
      const amount = Math.max(0, finite(action.amount, 0));
      const energy = clamp(state.energy + amount, 0, AERO_TUNING.maxEnergy);
      return amount > 0 ? eventState({ ...state, energy, event: null }, action.source ? `energy:${action.source}` : 'energy') : { ...state, event: null };
    }
    case AERO_ACTION.IMPACT: {
      if(state.status !== 'active') return { ...state, event: null };
      if(state.shieldActive && state.energy >= AERO_TUNING.shieldImpactCost){
        return eventState({ ...state, energy: state.energy - AERO_TUNING.shieldImpactCost, shieldHits: state.shieldHits + 1, event: null }, 'shielded-impact');
      }
      const damage = clamp(Math.floor(finite(action.damage, 1)), 1, state.maxIntegrity);
      const integrity = Math.max(0, state.integrity - damage);
      return eventState({ ...state, integrity, status: integrity > 0 ? 'active' : 'disabled', boostActive: integrity > 0 && state.boostActive, shieldActive: false, unshieldedHits: state.unshieldedHits + 1, event: null }, integrity > 0 ? 'impact' : 'disabled');
    }
    case AERO_ACTION.REPAIR: {
      const amount = clamp(Math.floor(finite(action.amount, 1)), 0, state.maxIntegrity);
      const integrity = Math.min(state.maxIntegrity, state.integrity + amount);
      return amount > 0 ? eventState({ ...state, integrity, status: integrity > 0 ? 'active' : state.status, event: null }, 'repair') : { ...state, event: null };
    }
    default:
      throw new RangeError(`unknown aero action ${action.type}`);
  }
}

export function aeroSnapshot(state){
  if(!state || state.version !== AERO_STATE_VERSION) throw new TypeError('valid aero state is required');
  return Object.freeze({ ...state });
}
