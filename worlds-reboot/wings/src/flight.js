/* PAPER WINGS - fixed-step flight, gate, recovery, and terminal simulation. */
import { evaluateGate, raceStanding, routePointAtS } from './route.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const approach = (current, target, rate, dt) => target + (current - target) * Math.exp(-rate * dt);

export const FLIGHT_STATUS = Object.freeze({
  READY: 'ready',
  FLYING: 'flying',
  RECOVERING: 'recovering',
  FINISHED: 'finished',
  FAILED: 'failed',
});

export function createFlightState(route, { control = 'guided', race = 'rivals' } = {}){
  if(!route?.gates?.length) throw new TypeError('createFlightState requires a route');
  return {
    status: FLIGHT_STATUS.READY,
    time: 0,
    s: 0,
    x: 0,
    y: 33,
    bank: 0,
    pitch: 0,
    speed: 0,
    gateIndex: 0,
    gatesPassed: 0,
    misses: 0,
    retriesAtGate: 0,
    recoveryRemaining: 0,
    recoveryFromX: 0,
    recoveryFromY: 33,
    event: null,
    eventSequence: 0,
    finishTime: null,
    rank: race === 'rivals' ? 4 : 1,
    control: control === 'direct' ? 'direct' : 'guided',
    race: race === 'solo' ? 'solo' : 'rivals',
  };
}

export function startFlight(state){
  if(state.status !== FLIGHT_STATUS.READY) return false;
  state.status = FLIGHT_STATUS.FLYING;
  state.speed = 18;
  state.event = 'start';
  state.eventSequence += 1;
  return true;
}

function triggerEvent(state, event){
  state.event = event;
  state.eventSequence += 1;
}

function beginRecovery(state, gate){
  state.misses += 1;
  state.retriesAtGate += 1;
  if(state.retriesAtGate >= 3){
    state.status = FLIGHT_STATUS.FAILED;
    state.speed = 0;
    triggerEvent(state, 'failed');
    return;
  }
  state.status = FLIGHT_STATUS.RECOVERING;
  state.recoveryRemaining = 1.15;
  state.recoveryFromX = state.x;
  state.recoveryFromY = state.y;
  state.s = Math.max(0, gate.s - 40);
  state.speed = 9;
  triggerEvent(state, 'miss');
}

function tickRecovery(state, dt, route){
  const gate = route.gates[state.gateIndex];
  state.recoveryRemaining = Math.max(0, state.recoveryRemaining - dt);
  const t = 1 - state.recoveryRemaining / 1.15;
  const eased = t * t * (3 - 2 * t);
  const lead = routePointAtS(route, Math.max(0, gate.s - 40));
  state.x = state.recoveryFromX + (lead.x - state.recoveryFromX) * eased;
  state.y = state.recoveryFromY + (lead.y - state.recoveryFromY) * eased;
  state.bank = approach(state.bank, 0, 7, dt);
  state.pitch = approach(state.pitch, 0, 7, dt);
  if(state.recoveryRemaining <= 0){
    state.status = FLIGHT_STATUS.FLYING;
    state.speed = 15;
    triggerEvent(state, 'recovered');
  }
}

function finishFlight(state, route){
  state.status = FLIGHT_STATUS.FINISHED;
  state.finishTime = state.time;
  state.speed = 0;
  const standing = raceStanding(route.finishS, state.time, route, state.race);
  state.rank = state.race === 'solo'
    ? 1
    : 1 + standing.entries.filter(entry => entry.s >= route.finishS - 0.01).length;
  triggerEvent(state, 'finished');
}

export function stepFlight(state, dt, axes, route){
  if(!state || !route) throw new TypeError('stepFlight requires state and route');
  if(!Number.isFinite(dt) || dt < 0) throw new RangeError('dt must be non-negative');
  state.event = null;
  if(state.status === FLIGHT_STATUS.RECOVERING){
    state.time += dt;
    tickRecovery(state, dt, route);
    return state;
  }
  if(state.status !== FLIGHT_STATUS.FLYING) return state;

  state.time += dt;
  const bankInput = clamp(Number.isFinite(axes?.bank) ? axes.bank : 0, -1, 1);
  const pitchInput = clamp(Number.isFinite(axes?.pitch) ? axes.pitch : 0, -1, 1);
  state.bank = approach(state.bank, bankInput, 10, dt);
  state.pitch = approach(state.pitch, pitchInput, 10, dt);

  const guided = state.control === 'guided';
  const cruise = guided ? 21.2 : 22.2;
  state.speed = approach(state.speed, cruise - Math.abs(state.bank) * 1.4 + Math.max(0, -state.pitch) * 0.8, 2.4, dt);
  const previousS = state.s;
  state.s += state.speed * dt;
  const routePoint = routePointAtS(route, state.s);
  state.x += state.bank * (guided ? 15.5 : 19.5) * dt;
  state.y += state.pitch * (guided ? 10.5 : 13.5) * dt;

  if(guided){
    const assist = Math.min(1, dt * 0.75);
    state.x += (routePoint.x - state.x) * assist * 0.18;
    state.y += (routePoint.y - state.y) * assist * 0.12;
  }
  state.x = clamp(state.x, -78, 78);
  state.y = clamp(state.y, 13, 65);

  const gate = route.gates[state.gateIndex];
  if(gate && previousS < gate.s && state.s >= gate.s){
    const verdict = evaluateGate(gate, state.x, state.y, state.control);
    if(verdict.passed){
      state.gateIndex += 1;
      state.gatesPassed += 1;
      state.retriesAtGate = 0;
      triggerEvent(state, 'gate');
    } else {
      beginRecovery(state, gate);
      return state;
    }
  }

  if(state.gateIndex >= route.gates.length && state.s >= route.finishS){
    finishFlight(state, route);
  } else {
    state.rank = raceStanding(state.s, state.time, route, state.race).rank;
  }
  return state;
}

export function flightStanding(state, route){
  if(!state || !route) throw new TypeError('flightStanding requires state and route');
  const standing = raceStanding(state.s, state.time, route, state.race);
  if(state.status !== FLIGHT_STATUS.FINISHED) return standing;
  return Object.freeze({ ...standing, rank: state.rank });
}

export function flightSnapshot(state){
  return Object.freeze({
    status: state.status,
    time: state.time,
    s: state.s,
    x: state.x,
    y: state.y,
    bank: state.bank,
    pitch: state.pitch,
    speed: state.speed,
    gateIndex: state.gateIndex,
    gatesPassed: state.gatesPassed,
    misses: state.misses,
    retriesAtGate: state.retriesAtGate,
    recoveryRemaining: state.recoveryRemaining,
    event: state.event,
    eventSequence: state.eventSequence,
    finishTime: state.finishTime,
    rank: state.rank,
    control: state.control,
    race: state.race,
  });
}
