import test from 'node:test';
import assert from 'node:assert/strict';
import { COMBAT_ACTION, combatSnapshot, createCombatState, nextCombatSeed, reduceCombat, segmentSphereHitTime } from './combat.js';

function spawnDrone(state, fields = {}){
  return reduceCombat(state, { type: COMBAT_ACTION.SPAWN_TARGET, targetId: 'drone-a', s: 12, radius: 1, hp: 2, ...fields });
}

test('same explicit seed produces stable ids and identical projectile spread', () => {
  function run(){
    let state = createCombatState({ seed: 0x12345678 });
    state = reduceCombat(state, { type: COMBAT_ACTION.FIRE, ownerId: 'player', x: 0, y: 0, s: 0, dx: 0, dy: 0, ds: 1, speed: 50, spread: 0.08 });
    state = reduceCombat(state, { type: COMBAT_ACTION.FIRE, ownerId: 'player', x: 0, y: 0, s: 0, dx: 0, dy: 0, ds: 1, speed: 50, spread: 0.08 });
    return state;
  }
  const a = run();
  const b = run();
  assert.deepEqual(combatSnapshot(a), combatSnapshot(b));
  assert.deepEqual(a.projectiles.map(projectile => projectile.id), ['p-12345678-0000', 'p-12345678-0001']);
  assert.notEqual(a.projectiles[0].vx, a.projectiles[1].vx);
  assert.equal(nextCombatSeed(99), nextCombatSeed(99));
});

test('projectiles use swept collision and preserve destroyed target identity', () => {
  let state = spawnDrone(createCombatState({ seed: 7 }));
  state = reduceCombat(state, { type: COMBAT_ACTION.FIRE, projectileId: 'shot-1', x: 0, y: 0, s: 0, ds: 1, speed: 120, damage: 2, ttl: 1 });
  const before = state;
  state = reduceCombat(state, { type: COMBAT_ACTION.TICK, dt: 0.2 });
  assert.equal(state.projectiles.length, 0);
  assert.equal(state.targets[0].id, 'drone-a');
  assert.equal(state.targets[0].status, 'destroyed');
  assert.equal(state.targets[0].hp, 0);
  assert.ok(state.events.some(event => event.type === 'target-hit' && event.projectileId === 'shot-1'));
  assert.ok(state.events.some(event => event.type === 'target-destroyed'));
  assert.equal(before.targets[0].status, 'active', 'reducer must not mutate prior targets');
});

test('collision picks the earliest target, with stable ids breaking exact ties', () => {
  let state = createCombatState({ seed: 8 });
  state = reduceCombat(state, { type: COMBAT_ACTION.SPAWN_TARGET, targetId: 'z-target', s: 10, radius: 1, hp: 1 });
  state = reduceCombat(state, { type: COMBAT_ACTION.SPAWN_TARGET, targetId: 'a-target', s: 10, radius: 1, hp: 1 });
  state = reduceCombat(state, { type: COMBAT_ACTION.FIRE, x: 0, y: 0, s: 0, ds: 1, speed: 100, damage: 1 });
  state = reduceCombat(state, { type: COMBAT_ACTION.TICK, dt: 0.2 });
  assert.equal(state.targets.find(target => target.id === 'a-target').status, 'destroyed');
  assert.equal(state.targets.find(target => target.id === 'z-target').status, 'active');
});

test('boss damage advances authored phases and honors its shield', () => {
  let state = createCombatState({ seed: 9 });
  state = reduceCombat(state, {
    type: COMBAT_ACTION.SPAWN_BOSS,
    bossId: 'skybreaker',
    hp: 100,
    s: 50,
    phases: [
      { id: 'armor', startsAt: 1, damageMultiplier: 1 },
      { id: 'storm', startsAt: 0.6, damageMultiplier: 1 },
      { id: 'core', startsAt: 0.25, damageMultiplier: 1 },
    ],
  });
  state = reduceCombat(state, { type: COMBAT_ACTION.SET_BOSS_VULNERABLE, vulnerable: false });
  state = reduceCombat(state, { type: COMBAT_ACTION.DAMAGE_BOSS, damage: 50, sourceId: 'blocked-shot' });
  assert.equal(state.boss.hp, 100);
  assert.equal(state.events[0].type, 'boss-blocked');
  state = reduceCombat(state, { type: COMBAT_ACTION.SET_BOSS_VULNERABLE, vulnerable: true });
  state = reduceCombat(state, { type: COMBAT_ACTION.DAMAGE_BOSS, damage: 45, sourceId: 'volley-1' });
  assert.equal(state.boss.phaseIndex, 1);
  assert.ok(state.events.some(event => event.type === 'boss-phase' && event.phaseId === 'storm'));
  state = reduceCombat(state, { type: COMBAT_ACTION.DAMAGE_BOSS, damage: 60, sourceId: 'volley-2' });
  assert.equal(state.boss.status, 'destroyed');
  assert.equal(state.boss.phaseIndex, 2);
  assert.ok(state.events.some(event => event.type === 'boss-destroyed'));
});

test('expired shots disappear and every state remains plain serializable data', () => {
  let state = createCombatState({ seed: 10 });
  state = reduceCombat(state, { type: COMBAT_ACTION.FIRE, ttl: 0.1, speed: 1 });
  state = reduceCombat(state, { type: COMBAT_ACTION.TICK, dt: 0.2 });
  assert.equal(state.projectiles.length, 0);
  assert.equal(state.events[0].type, 'projectile-expired');
  assert.doesNotThrow(() => JSON.stringify(state));
  state = reduceCombat(state, { type: COMBAT_ACTION.SPAWN_TARGET, targetId: 'same' });
  assert.throws(() => reduceCombat(state, { type: COMBAT_ACTION.SPAWN_TARGET, targetId: 'same' }), /duplicate/);
});

test('collision query handles crossing, misses, and a stationary overlap', () => {
  const sphere = { x: 0, y: 0, s: 5, radius: 1 };
  assert.equal(segmentSphereHitTime({ x: 0, y: 0, s: 0 }, { x: 0, y: 0, s: 10 }, sphere), 0.5);
  assert.equal(segmentSphereHitTime({ x: 5, y: 0, s: 0 }, { x: 5, y: 0, s: 10 }, sphere), null);
  assert.equal(segmentSphereHitTime({ x: 0, y: 0, s: 5 }, { x: 0, y: 0, s: 5 }, sphere), 0);
});
