import test from 'node:test';
import assert from 'node:assert/strict';
import { AERO_ACTION, AERO_TUNING, aeroSnapshot, createAeroState, reduceAero } from './aero.js';

function step(state, seconds, input){
  for(let i = 0; i < seconds * 120; i += 1) state = reduceAero(state, { type: AERO_ACTION.TICK, dt: 1 / 120, ...input });
  return state;
}

test('diving trades altitude for speed while climbing does the reverse', () => {
  const start = createAeroState({ altitude: 70, speed: 24 });
  const dive = step(start, 2, { pitch: -1 });
  const climb = step(start, 2, { pitch: 1 });
  assert.ok(dive.altitude < start.altitude);
  assert.ok(dive.speed > start.speed);
  assert.ok(climb.altitude > start.altitude);
  assert.ok(climb.speed < start.speed);
});

test('thermals restore altitude and wind energy without exceeding caps', () => {
  const start = createAeroState({ altitude: 30, energy: 95 });
  const lifted = step(start, 2, { pitch: 0, thermal: 1 });
  assert.ok(lifted.altitude > start.altitude);
  assert.equal(lifted.energy, AERO_TUNING.maxEnergy);
  const awarded = reduceAero(lifted, { type: AERO_ACTION.ADD_ENERGY, amount: 50, source: 'gate' });
  assert.equal(awarded.energy, AERO_TUNING.maxEnergy);
  assert.equal(awarded.event, 'energy:gate');
});

test('boost creates speed and boost plus shield consume the shared resource', () => {
  let powered = createAeroState({ energy: 100 });
  powered = reduceAero(powered, { type: AERO_ACTION.SET_BOOST, active: true });
  powered = reduceAero(powered, { type: AERO_ACTION.SET_SHIELD, active: true });
  powered = step(powered, 1, {});
  const coast = step(createAeroState({ energy: 100 }), 1, {});
  assert.ok(powered.speed > coast.speed);
  assert.ok(powered.energy < coast.energy);
  powered = step(powered, 4, {});
  assert.equal(powered.energy, 0);
  assert.equal(powered.boostActive, false);
  assert.equal(powered.shieldActive, false);
});

test('shield impacts spend energy before hull integrity', () => {
  let state = createAeroState({ energy: 50, integrity: 3 });
  state = reduceAero(state, { type: AERO_ACTION.SET_SHIELD, active: true });
  const shielded = reduceAero(state, { type: AERO_ACTION.IMPACT, damage: 2 });
  assert.equal(shielded.integrity, 3);
  assert.equal(shielded.energy, 50 - AERO_TUNING.shieldImpactCost);
  assert.equal(shielded.shieldHits, 1);
  assert.equal(shielded.event, 'shielded-impact');
  const hit = reduceAero({ ...shielded, energy: 0 }, { type: AERO_ACTION.IMPACT, damage: 2 });
  assert.equal(hit.integrity, 1);
  assert.equal(hit.shieldActive, false);
  const disabled = reduceAero(hit, { type: AERO_ACTION.IMPACT });
  assert.equal(disabled.status, 'disabled');
});

test('identical fixed steps are pure and deterministic', () => {
  const original = createAeroState({ altitude: 50, energy: 80 });
  let a = original;
  let b = original;
  for(let i = 0; i < 300; i += 1){
    const action = { type: AERO_ACTION.TICK, dt: 1 / 120, pitch: Math.sin(i * 0.02), thermal: i % 90 < 15 ? 0.5 : 0 };
    a = reduceAero(a, action);
    b = reduceAero(b, action);
  }
  assert.deepEqual(aeroSnapshot(a), aeroSnapshot(b));
  assert.equal(original.time, 0);
  assert.doesNotThrow(() => JSON.stringify(a));
  assert.throws(() => reduceAero(a, { type: AERO_ACTION.TICK, dt: -1 }), /non-negative/);
});
