import test from 'node:test';
import assert from 'node:assert/strict';
import { createWingRoute, raceStanding } from './route.js';
import { createFlightState, flightSnapshot, flightStanding, FLIGHT_STATUS, startFlight, stepFlight } from './flight.js';

function runCentered(route, { seconds = 60, control = 'guided', race = 'solo', forceMisses = 0 } = {}){
  const state = createFlightState(route, { control, race });
  startFlight(state);
  const dt = 1 / 120;
  let forced = 0;
  for(let i = 0; i < seconds / dt && ![FLIGHT_STATUS.FINISHED, FLIGHT_STATUS.FAILED].includes(state.status); i += 1){
    const point = route.gates[Math.min(state.gateIndex, route.gates.length - 1)];
    if(forced < forceMisses && state.status === FLIGHT_STATUS.FLYING && state.s + state.speed * dt >= point.s){
      state.x = 70;
      state.y = 60;
      forced += 1;
    }
    const bank = Math.max(-1, Math.min(1, (point.x - state.x) / 11));
    const pitch = Math.max(-1, Math.min(1, (point.y - state.y) / 8));
    stepFlight(state, dt, { bank, pitch }, route);
  }
  return state;
}

test('same fixed-step input produces identical flight snapshots', () => {
  const route = createWingRoute('quick');
  const a = createFlightState(route);
  const b = createFlightState(route);
  startFlight(a);
  startFlight(b);
  for(let i = 0; i < 800; i += 1){
    const axes = { bank: Math.sin(i * 0.013) * 0.35, pitch: Math.cos(i * 0.009) * 0.2 };
    stepFlight(a, 1 / 120, axes, route);
    stepFlight(b, 1 / 120, axes, route);
  }
  assert.deepEqual(flightSnapshot(a), flightSnapshot(b));
});

test('crossing a centered gate advances exactly once', () => {
  const route = createWingRoute('quick');
  const state = createFlightState(route, { race: 'solo' });
  startFlight(state);
  const gate = route.gates[0];
  state.s = gate.s - 0.1;
  state.x = gate.x;
  state.y = gate.y;
  state.speed = 20;
  stepFlight(state, 0.01, { bank: 0, pitch: 0 }, route);
  assert.equal(state.gatesPassed, 1);
  assert.equal(state.gateIndex, 1);
  assert.equal(state.event, 'gate');
});

test('a miss recovers to an approach and allows a retry', () => {
  const route = createWingRoute('quick');
  const state = createFlightState(route);
  startFlight(state);
  const gate = route.gates[0];
  state.s = gate.s - 0.1;
  state.x = 70;
  state.y = 60;
  stepFlight(state, 0.01, { bank: 0, pitch: 0 }, route);
  assert.equal(state.status, FLIGHT_STATUS.RECOVERING);
  assert.equal(state.misses, 1);
  for(let i = 0; i < 150; i += 1) stepFlight(state, 0.01, {}, route);
  assert.equal(state.status, FLIGHT_STATUS.FLYING);
  assert.equal(state.gateIndex, 0);
  assert.ok(state.s < gate.s);
});

test('three misses at one gate produce a terminal fail', () => {
  const route = createWingRoute('quick');
  const state = createFlightState(route);
  startFlight(state);
  const gate = route.gates[0];
  for(let miss = 0; miss < 3; miss += 1){
    state.status = FLIGHT_STATUS.FLYING;
    state.s = gate.s - 0.01;
    state.x = 70;
    state.y = 60;
    stepFlight(state, 0.01, {}, route);
  }
  assert.equal(state.status, FLIGHT_STATUS.FAILED);
  assert.equal(state.misses, 3);
});

test('guided autopilot completes the six-gate route', () => {
  const state = runCentered(createWingRoute('quick'));
  assert.equal(state.status, FLIGHT_STATUS.FINISHED);
  assert.equal(state.gatesPassed, 6);
  assert.equal(state.rank, 1);
});

test('a clean quick race narrowly wins and one recovery costs position', () => {
  const route = createWingRoute('quick');
  const clean = runCentered(route, { race: 'rivals' });
  const recovered = runCentered(route, { race: 'rivals', forceMisses: 1 });
  assert.equal(clean.status, FLIGHT_STATUS.FINISHED);
  assert.equal(clean.rank, 1);
  assert.ok(clean.finishTime < 19.5);
  assert.ok(clean.finishTime > 18);
  assert.equal(recovered.status, FLIGHT_STATUS.FINISHED);
  assert.equal(recovered.misses, 1);
  assert.ok(recovered.finishTime > clean.finishTime);
  assert.ok(recovered.rank > clean.rank);
});

test('recovered quick terminal standing keeps the authoritative result rank', () => {
  const route = createWingRoute('quick');
  const live = createFlightState(route, { race: 'rivals' });
  startFlight(live);
  stepFlight(live, 1, { bank: 0, pitch: 0 }, route);
  assert.deepEqual(flightStanding(live, route), raceStanding(live.s, live.time, route, live.race));

  const recovered = runCentered(route, { race: 'rivals', forceMisses: 1 });
  assert.equal(recovered.status, FLIGHT_STATUS.FINISHED);
  assert.equal(recovered.rank, 3);
  assert.equal(raceStanding(recovered.s, recovered.time, route, recovered.race).rank, 1);
  assert.equal(flightStanding(recovered, route).rank, 3);
  assert.equal(flightStanding(recovered, route).total, 4);
});

test('both control profiles complete the authored twelve-gate route deterministically', () => {
  for(const control of ['guided', 'direct']){
    const route = createWingRoute('full');
    const first = createFlightState(route, { control, race: 'solo' });
    const second = createFlightState(route, { control, race: 'solo' });
    startFlight(first);
    startFlight(second);
    for(let i = 0; i < 70 * 120 && first.status === FLIGHT_STATUS.FLYING; i += 1){
      const gate = route.gates[Math.min(first.gateIndex, route.gates.length - 1)];
      const axes = {
        bank: Math.max(-1, Math.min(1, (gate.x - first.x) / 11)),
        pitch: Math.max(-1, Math.min(1, (gate.y - first.y) / 8)),
      };
      stepFlight(first, 1 / 120, axes, route);
      stepFlight(second, 1 / 120, axes, route);
    }
    assert.equal(first.status, FLIGHT_STATUS.FINISHED);
    assert.equal(first.gatesPassed, 12);
    assert.deepEqual(flightSnapshot(first), flightSnapshot(second));
  }
});
