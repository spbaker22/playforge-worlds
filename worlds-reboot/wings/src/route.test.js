import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRouteTraversalState,
  createWingRoute,
  evaluateGate,
  lockRouteBranch,
  queryForkVolumes,
  queryHazardVolumes,
  queryProximityVolumes,
  queryThermalVolumes,
  raceStanding,
  rivalFinishTime,
  rivalProgress,
  routeBranchAtS,
  routePointAtS,
  routeSegmentAtS,
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

test('authored mission segments cover each route without gaps or overshoot', () => {
  for(const route of [createWingRoute('quick'), createWingRoute('full')]){
    assert.equal(route.segments[0].startS, 0);
    assert.equal(route.segments.at(-1).endS, route.finishS);
    route.segments.forEach((segment, index) => {
      if(index) assert.equal(segment.startS, route.segments[index - 1].endS);
      assert.equal(routeSegmentAtS(route, segment.startS).id, segment.id);
    });
    assert.ok(route.forks.every(fork => fork.rejoinS <= route.finishS));
  }
});

test('forks default safe, lock only once, and rejoin on the same global s', () => {
  const route = createWingRoute('full');
  const fork = route.forks[0];
  const empty = createRouteTraversalState(route);
  assert.equal(routeBranchAtS(route, fork.startS + 1, empty).branchId, 'safe');
  assert.equal(routeBranchAtS(route, fork.startS + 1, empty).locked, false);

  const shortcut = lockRouteBranch(empty, route, fork.id, 'shortcut');
  const relock = lockRouteBranch(shortcut, route, fork.id, 'safe');
  assert.equal(relock, shortcut);
  assert.equal(routeBranchAtS(route, fork.startS + 1, shortcut).branchId, 'shortcut');

  const midpoint = (fork.startS + fork.rejoinS) / 2;
  const safePoint = routePointAtS(route, midpoint);
  const shortcutPoint = routePointAtS(route, midpoint, { x: 0, y: 0 }, shortcut);
  assert.notDeepEqual(shortcutPoint, safePoint);
  assert.deepEqual(
    routePointAtS(route, fork.rejoinS, { x: 0, y: 0 }, shortcut),
    routePointAtS(route, fork.rejoinS),
  );
});

test('thermal, proximity, hazard, and branch volumes return deterministic influence', () => {
  const route = createWingRoute('full');
  const thermal = route.volumes.thermals[0];
  const proximity = route.volumes.proximity[0];
  const hazard = route.volumes.hazards[0];
  assert.equal(queryThermalVolumes(route, thermal)[0].influence, 1);
  assert.equal(queryProximityVolumes(route, proximity)[0].influence, 1);
  assert.equal(queryHazardVolumes(route, hazard)[0].influence, 1);
  assert.deepEqual(queryHazardVolumes(route, { s: 0, x: 1000, y: 1000 }), []);

  const fork = route.forks[0];
  const midpoint = (fork.startS + fork.rejoinS) / 2;
  const base = routePointAtS(route, midpoint);
  const hit = queryForkVolumes(route, { s: midpoint, x: base.x - 20, y: base.y - 7 });
  assert.equal(hit[0].branchId, 'shortcut');
  assert.equal(hit[0].influence, 1);
});
