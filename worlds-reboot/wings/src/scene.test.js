import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { getMissionDressing, MISSION_IDS } from './mission-dressing.js';
import { createWingRoute } from './route.js';
import { buildAlpineWorld, buildPaperGlider, PRESENTATION_POOL_BUDGETS } from './scene.js';

function deepFreeze(value){
  if(value && typeof value === 'object' && !Object.isFrozen(value)){
    for(const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('hero paper keeps its warm face inside a dark ink silhouette hierarchy', () => {
  const hero = buildPaperGlider(0xf4eee4, 'paper', true);
  const wingUnderside = hero.getObjectByName('paper-wings-wing-underside');
  const tailUnderside = hero.getObjectByName('paper-wings-tail-underside');
  const fold = hero.getObjectByName('paper-wings-fold-spine');

  assert.equal(hero.userData.wing.material.color.getHex(), 0xf4eee4);
  assert.equal(hero.userData.wing.material.side, THREE.DoubleSide);
  for(const underside of [wingUnderside, tailUnderside]){
    assert.ok(underside?.isMesh);
    assert.equal(underside.material.color.getHex(), 0x15292e);
    assert.equal(underside.material.side, THREE.DoubleSide);
    assert.ok(underside.scale.x > 1 && underside.scale.z > 1);
  }
  assert.equal(hero.children.some(child => child.isLineSegments), false);
  assert.equal(fold.material.color.getHex(), 0x15292e);
});

test('authored gates layer a dark rim behind the stateful inner ring', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const route = createWingRoute('quick');
  const world = buildAlpineWorld(scene, camera, route, { lowfx: true, race: 'solo', reducedMotion: true });
  const [passed, current, upcoming] = world.gateViews;

  for(const gate of world.gateViews){
    assert.ok(gate.userData.rim?.isMesh);
    assert.ok(gate.userData.ring?.isMesh);
    assert.equal(gate.userData.rim.geometry.parameters.tube, 0.68);
    assert.equal(gate.userData.ring.geometry.parameters.tube, 0.44);
    assert.ok(gate.userData.rim.position.z < gate.userData.ring.position.z);
  }

  world.updateFlight({
    gateIndex: 1, s: 0, time: 0, x: 0, y: 33, bank: 0, pitch: 0, speed: 18,
  }, 0, 1 / 120);
  assert.equal(passed.userData.material.color.getHex(), 0x799c8c);
  assert.equal(passed.userData.rimMaterial.color.getHex(), 0x29443c);
  assert.equal(current.userData.material.color.getHex(), 0xff795c);
  assert.equal(current.userData.rimMaterial.color.getHex(), 0x15292e);
  assert.ok(current.userData.material.emissiveIntensity > upcoming.userData.material.emissiveIntensity);
  assert.ok(current.userData.rimMaterial.emissiveIntensity > upcoming.userData.rimMaterial.emissiveIntensity);
});

test('all eight mission dressings switch atmosphere and fixed lowfx scene budgets', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const world = buildAlpineWorld(scene, camera, createWingRoute('full'), { lowfx: true, reducedMotion: true });

  assert.deepEqual(world.campaignViews.missionIds, MISSION_IDS);
  for(const missionId of MISSION_IDS){
    const dressing = world.loadMission(missionId);
    const report = world.diagnostics({ s: 0, time: 0 });
    assert.equal(dressing, getMissionDressing(missionId));
    assert.equal(world.currentMission(), dressing);
    assert.equal(report.missionId, missionId);
    assert.equal(scene.background.getHex(), dressing.palette.skyTop);
    assert.ok(report.instances.thermals <= PRESENTATION_POOL_BUDGETS.lowfx.thermals);
    assert.ok(report.instances.windRibbons <= PRESENTATION_POOL_BUDGETS.lowfx.windRibbons);
    assert.ok(report.instances.routeForks <= PRESENTATION_POOL_BUDGETS.lowfx.routeForks);
  }
  assert.equal(world.campaignViews.targetPool.capacity, PRESENTATION_POOL_BUDGETS.lowfx.targets);
  assert.equal(world.campaignViews.projectilePool.capacity, PRESENTATION_POOL_BUDGETS.lowfx.projectiles);
  assert.throws(() => world.loadMission('missing-mission'), /Unknown Paper Wings mission/);
});

test('immutable campaign snapshots drive pooled action views without changing simulation state', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const world = buildAlpineWorld(scene, camera, createWingRoute('full'), {
    lowfx: true, reducedMotion: true, missionId: 'skybreaker-finale',
  });
  world.updateFlight({ gateIndex: 2, s: 120, time: 8, x: 3, y: 39, bank: 0.2, pitch: -0.1, speed: 31 }, 8, 1 / 60);
  const snapshot = deepFreeze({
    time: 8,
    flight: { s: 120, time: 8, x: 3, y: 39 },
    aero: { shieldActive: true, integrity: 1, maxIntegrity: 3, event: null, eventSequence: 0 },
    combat: {
      targets: [{ id: 'drone-a', kind: 'drone', team: 'enemy', x: 7, y: 44, s: 165, radius: 1.6, hp: 2, maxHp: 3, status: 'active' }],
      projectiles: [{ id: 'dart-a', team: 'player', x: 4, y: 41, s: 138, vx: 1, vy: 0.5, vs: 90, radius: 0.2 }],
      boss: {
        id: 'skybreaker', kind: 'skybreaker', x: 0, y: 52, s: 310, radius: 5,
        hp: 62, maxHp: 100, vulnerable: false, status: 'active', phaseIndex: 1,
        weakPoints: [{ id: 'weak-a', status: 'active' }, { id: 'weak-b', status: 'active' }, { id: 'weak-c', status: 'active' }],
      },
      events: [{ id: 'event-hit-a', type: 'target-hit', targetId: 'drone-a' }],
    },
    rivals: [
      { id: 'sora', s: 134, lateral: -6, altitude: 3, action: 'boost', finished: false },
      { id: 'vale', s: 118, lateral: 8, altitude: -1, action: 'attack', finished: false },
      { id: 'pip', s: 102, lateral: 2, altitude: 4, action: 'recover', finished: false },
    ],
    hazards: [
      { id: 'bolt', kind: 'lightning', x: 12, y: 49, s: 190, severity: 0.9 },
      { id: 'scrap', kind: 'debris', x: -8, y: 35, s: 208, severity: 0.7 },
      { id: 'sink', kind: 'downdraft', x: 2, y: 42, s: 225, severity: 0.8 },
    ],
    rescue: {
      pickups: [{ id: 'signal-a', kind: 'signal-balloon', x: -9, y: 46, s: 242 }],
      dropZones: [{ id: 'zone-a', kind: 'drop-zone', x: 10, y: 25, s: 266, radius: 4 }],
      parcels: [{ id: 'parcel-a', kind: 'supply-parcel', x: 8, y: 37, s: 255 }],
    },
    stunts: { active: { id: 'roll-a', kind: 'axial-roll' }, event: 'completed:axial-roll', eventSequence: 1 },
    stuntTrails: [{ id: 'trail-a', x: 3, y: 39, s: 116, intensity: 0.8 }],
  });
  const before = JSON.parse(JSON.stringify(snapshot));

  const returnedViews = world.syncSnapshot(snapshot, { time: 8, dt: 1 / 60 });
  const report = world.diagnostics(snapshot.flight);

  assert.equal(returnedViews, world.campaignViews, 'hot-path sync returns a stable object');
  assert.deepEqual(snapshot, before, 'presentation adapter must not mutate reducer fixtures');
  assert.equal(report.pools.targets.active, 1);
  assert.equal(report.pools.projectiles.active, 1);
  assert.equal(report.pools.hazards.active, 3);
  assert.equal(report.pools.rescue.active, 3);
  assert.equal(report.pools.trails.active, 7);
  assert.ok(report.pools.impacts.active >= 2);
  assert.equal(report.hero.shield, true);
  assert.equal(report.hero.integrity, 1);
  assert.equal(report.hero.hullDamage, 2);
  assert.equal(report.boss.active, true);
  assert.equal(report.boss.phase, 1);
  assert.equal(world.campaignViews.boss.userData.phaseViews[1].visible, true);
  assert.equal(world.campaignViews.boss.userData.shield.visible, true);
  assert.equal(world.rivalViews[0].mesh.userData.presentationAction, 'boost');

  world.syncPresentation({ flight: snapshot.flight, aero: snapshot.aero }, { time: 8.1, dt: 1 / 60 });
  const cleared = world.diagnostics(snapshot.flight);
  assert.equal(cleared.pools.targets.active, 0);
  assert.equal(cleared.pools.projectiles.active, 0);
  assert.equal(cleared.pools.rescue.active, 0);
  assert.equal(cleared.pools.trails.active, 0);
  assert.equal(cleared.boss.active, false);
});

test('overflow is bounded and reuses the prebuilt target slots', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const world = buildAlpineWorld(scene, camera, createWingRoute('quick'), {
    lowfx: true, missionId: 'target-run', reducedMotion: true,
  });
  const capacity = PRESENTATION_POOL_BUDGETS.lowfx.targets;
  const targets = deepFreeze(Array.from({ length: capacity + 5 }, (_, index) => ({
    id: `target-${index}`, x: index - 4, y: 38, s: 80 + index * 4, status: 'active',
  })));
  const slots = Array.from({ length: capacity }, (_, index) => world.campaignViews.targetPool.at(index));

  world.syncPresentation({ combat: { targets, projectiles: [] } });
  const full = world.diagnostics({ s: 0, time: 0 });
  assert.equal(full.pools.targets.active, capacity);
  assert.equal(full.pools.targets.dropped, 5);

  world.syncPresentation({ combat: { targets: [targets[0]], projectiles: [] } });
  assert.equal(world.diagnostics({ s: 0, time: 0 }).pools.targets.active, 1);
  assert.deepEqual(
    Array.from({ length: capacity }, (_, index) => world.campaignViews.targetPool.at(index)),
    slots,
    'snapshot reconciliation must reuse the same mesh identities',
  );
});
