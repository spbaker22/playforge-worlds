import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWingRoute,
  evaluateGate,
  raceStanding,
  rivalFinishTime,
  rivalProgress,
  routePointAtS,
  WING_RIVALS,
} from './route.js';

test('full and quick routes expose twelve and six authored gates', () => {
  assert.equal(createWingRoute('full').gates.length, 12);
  assert.equal(createWingRoute('quick').gates.length, 6);
  assert.equal(new Set(createWingRoute('full').gates.map(gate => gate.id)).size, 12);
});

test('route sampling is deterministic and lands on gate centers', () => {
  const route = createWingRoute('full');
  for(const gate of route.gates){
    assert.deepEqual(routePointAtS(route, gate.s), { x: gate.x, y: gate.y });
  }
  assert.deepEqual(routePointAtS(route, 211.25), routePointAtS(route, 211.25));
});

test('guided gates offer a larger but bounded flight window', () => {
  const gate = createWingRoute('full').gates[0];
  const x = gate.x + gate.radius * 1.1;
  assert.equal(evaluateGate(gate, x, gate.y, 'guided').passed, true);
  assert.equal(evaluateGate(gate, x, gate.y, 'direct').passed, false);
});

test('race mode includes three distinct authored rivals', () => {
  assert.equal(WING_RIVALS.length, 3);
  assert.equal(new Set(WING_RIVALS.map(rival => rival.style)).size, 3);
  const standing = raceStanding(0, 8, createWingRoute('quick'), 'rivals');
  assert.equal(standing.entries.length, 3);
  assert.ok(standing.rank >= 1 && standing.rank <= 4);
});

test('quick rivals use competitive sprint times while full times stay unchanged', () => {
  const quick = createWingRoute('quick');
  const full = createWingRoute('full');
  assert.deepEqual(WING_RIVALS.map(profile => rivalFinishTime(profile, quick)), [19.5, 21.5, 23.5]);
  assert.deepEqual(WING_RIVALS.map(profile => rivalFinishTime(profile, full)), [37.8, 40.4, 43.1]);
  for(const profile of WING_RIVALS){
    assert.equal(rivalProgress(profile, rivalFinishTime(profile, quick), quick), quick.finishS);
    assert.equal(rivalProgress(profile, rivalFinishTime(profile, full), full), full.finishS);
  }
});
