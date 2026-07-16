import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL_ORB_RADIUS, CONTROL_PROFILES, createWingActionController, wingControlTargets } from './action.js';

test('one pointer drag maps right to bank and up to pitch', () => {
  const action = createWingActionController({ control: 'guided', dragSpan: 100 });
  assert.equal(action.begin(7, 200, 200), true);
  assert.equal(action.move(7, 275, 150), true);
  const sample = action.tick(0.3);
  assert.ok(sample.bank > 0.5);
  assert.ok(sample.pitch > 0.25);
  assert.equal(sample.active, true);
});

test('the visible orb edge is the usable control edge for both profiles', () => {
  for(const control of ['guided', 'direct']){
    const profile = CONTROL_PROFILES[control];
    const bankEdge = wingControlTargets(control, CONTROL_ORB_RADIUS, 0);
    assert.equal(bankEdge.indicatorX, CONTROL_ORB_RADIUS);
    assert.equal(bankEdge.indicatorY, 0);
    assert.equal(bankEdge.targetBank, profile.maxBank);
    assert.equal(bankEdge.targetPitch, 0);
    const pitchEdge = wingControlTargets(control, 0, -CONTROL_ORB_RADIUS);
    assert.equal(pitchEdge.indicatorX, 0);
    assert.equal(pitchEdge.indicatorY, -CONTROL_ORB_RADIUS);
    assert.equal(pitchEdge.targetBank, 0);
    assert.equal(pitchEdge.targetPitch, profile.maxPitch);

    const action = createWingActionController({ control });
    action.begin(9, 100, 100);
    action.move(9, 100 + CONTROL_ORB_RADIUS, 100);
    const snapshot = action.snapshot();
    assert.equal(snapshot.indicatorX, CONTROL_ORB_RADIUS);
    assert.equal(snapshot.indicatorY, 0);
    assert.equal(snapshot.targetBank, snapshot.maxBank);
    assert.equal(snapshot.targetPitch, 0);

  }
});

test('drag overshoot saturates at the 42px orb edge', () => {
  for(const control of ['guided', 'direct']){
    const edge = wingControlTargets(control, CONTROL_ORB_RADIUS, 0);
    const overshoot = wingControlTargets(control, CONTROL_ORB_RADIUS * 2, 0);
    assert.equal(overshoot.indicatorX, CONTROL_ORB_RADIUS);
    assert.equal(overshoot.targetBank, edge.targetBank);

    const diagonal = wingControlTargets(control, CONTROL_ORB_RADIUS * 2, -CONTROL_ORB_RADIUS * 2);
    assert.ok(Math.abs(Math.hypot(diagonal.indicatorX, diagonal.indicatorY) - CONTROL_ORB_RADIUS) < 1e-12);
  }
});

test('small orb movement produces a proportional smooth command', () => {
  for(const control of ['guided', 'direct']){
    const profile = CONTROL_PROFILES[control];
    const target = wingControlTargets(control, CONTROL_ORB_RADIUS * 0.1, -CONTROL_ORB_RADIUS * 0.1);
    assert.ok(Math.abs(target.targetBank - profile.maxBank * 0.1) < 1e-12);
    assert.ok(Math.abs(target.targetPitch - profile.maxPitch * 0.1) < 1e-12);
    const action = createWingActionController({ control });
    action.begin(4, 0, 0);
    action.move(4, CONTROL_ORB_RADIUS * 0.1, 0);
    const first = action.tick(1 / 120).bank;
    const second = action.tick(1 / 120).bank;
    assert.ok(first > 0 && second > first);
    assert.ok(second < target.targetBank);
  }
});

test('secondary pointers cannot steal the active gesture', () => {
  const action = createWingActionController({ dragSpan: 100 });
  action.begin(1, 0, 0);
  assert.equal(action.begin(2, 10, 10), false);
  assert.equal(action.move(2, 90, 90), false);
  assert.equal(action.end(2), false);
  assert.equal(action.snapshot().pointerId, 1);
});

test('release centers smoothly without snapping or circling', () => {
  const action = createWingActionController({ control: 'guided', dragSpan: 100 });
  action.begin(1, 0, 0);
  action.move(1, 100, -70);
  const held = action.tick(0.2);
  action.end(1);
  const first = action.tick(1 / 60);
  assert.ok(first.bank > 0 && first.bank < held.bank);
  for(let i = 0; i < 180; i += 1) action.tick(1 / 60);
  const settled = action.snapshot();
  assert.ok(Math.abs(settled.bank) < 0.0001);
  assert.ok(Math.abs(settled.pitch) < 0.0001);
});

test('direct control is more sensitive than guided control', () => {
  const guided = createWingActionController({ control: 'guided', dragSpan: 100 });
  const direct = createWingActionController({ control: 'direct', dragSpan: 100 });
  for(const action of [guided, direct]){
    action.begin(1, 0, 0);
    action.move(1, 50, 0);
    action.tick(0.5);
  }
  assert.ok(direct.snapshot().bank > guided.snapshot().bank);
});

test('reset removes every carried axis and pointer before a replay', () => {
  const action = createWingActionController({ control: 'direct', dragSpan: 100 });
  action.begin(17, 240, 180);
  action.move(17, 330, 90);
  action.tick(0.25);
  assert.notEqual(action.snapshot().bank, 0);
  assert.notEqual(action.snapshot().pitch, 0);

  const reset = action.reset('replay');
  assert.deepEqual({
    active: reset.active,
    pointerId: reset.pointerId,
    bank: reset.bank,
    pitch: reset.pitch,
    targetBank: reset.targetBank,
    targetPitch: reset.targetPitch,
    indicatorX: reset.indicatorX,
    indicatorY: reset.indicatorY,
    samples: reset.samples,
    lastEndReason: reset.lastEndReason,
  }, {
    active: false,
    pointerId: null,
    bank: 0,
    pitch: 0,
    targetBank: 0,
    targetPitch: 0,
    indicatorX: 0,
    indicatorY: 0,
    samples: 0,
    lastEndReason: 'replay',
  });
  assert.equal(action.tick(1 / 120).bank, 0);
  assert.equal(action.tick(1 / 120).pitch, 0);
});
