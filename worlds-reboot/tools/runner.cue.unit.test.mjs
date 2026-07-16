import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunnerCourseModel } from '../runner/src/course.js';
import { createRunnerSim } from '../runner/src/sim.js';
import {
  createRunnerCueInputBuffer,
  runnerCuePresentation,
} from '../runner/src/cue.js';

const STEP = 1 / 120;
const PACE = Object.freeze({
  standard: Object.freeze({}),
  calm: Object.freeze({
    startSpeed: 7.2,
    recoverySpeed: 7.4,
    maxSpeed: 11.8,
    acceleration: 1.65,
    rivalPaceScale: 0.7,
  }),
});

const actionFor = requirement => requirement === 'jump' ? 'jump'
  : requirement === 'slide' ? 'slide'
    : requirement === 'left' ? 'left'
      : requirement === 'right' ? 'right'
        : requirement === 'either-lane' ? 'left' : null;

function submitRoute(sim, route){
  if(route?.kind !== 'fire') return;
  sim.input(route.action.type, route.action);
}

function runFollowingVisibleCues({ format, pace }){
  const course = createRunnerCourseModel();
  const finalRelay = format === 'final-relay';
  const sim = createRunnerSim({
    course,
    config: { startS: finalRelay ? 112 : 6, ...PACE[pace] },
    initial: { lane: finalRelay ? -1 : 0 },
  });
  const buffer = createRunnerCueInputBuffer();
  const followed = new Set();
  const events = [];
  const routes = [];
  sim.drainEvents();

  for(let step = 0; step < 30000 && sim.state.status !== 'finish-pending'; step += 1){
    const state = sim.state;
    const cue = runnerCuePresentation(course, state.s, state.targetLane, { armed: buffer.armed });
    if(cue.stage === 'armed') buffer.markPresented(cue.id);
    if(cue.hazard && cue.requirement && !followed.has(cue.id)){
      const route = buffer.route({ course, s: state.s, lane: state.targetLane, action: actionFor(cue.requirement) });
      followed.add(cue.id);
      routes.push({ id: cue.id, stage: cue.stage, ...route });
      submitRoute(sim, route);
    }
    const ready = buffer.takeReady({ course, s: state.s });
    if(ready) sim.input(ready.action.type, ready.action);
    sim.step(STEP);
    events.push(...sim.drainEvents());
  }

  return { snapshot: sim.snapshot(), followed: [...followed], events, routes, buffer: buffer.snapshot() };
}

test('opening is orientation-only, cue stages are WAIT/READY/NOW, and one early input fires once', () => {
  const course = createRunnerCourseModel();
  const opening = runnerCuePresentation(course, 6, 0);
  assert.equal(opening.stage, 'orientation');
  assert.equal(opening.text, 'FOLLOW THE GLOWING ROUTE');
  assert.doesNotMatch(opening.text, /SWIPE|NOW/);

  const buffer = createRunnerCueInputBuffer();
  assert.deepEqual(buffer.route({ course, s: 6, lane: 0, action: 'jump' }), {
    kind: 'ignored', reason: 'no-active-cue',
  });
  assert.equal(buffer.armed, null);

  const waiting = runnerCuePresentation(course, 25, 0);
  assert.equal(waiting.stage, 'anticipation');
  assert.match(waiting.text, /^WAIT ·/);
  const armed = buffer.route({ course, s: 25, lane: 0, action: 'jump' });
  assert.equal(armed.kind, 'armed');
  assert.equal(buffer.route({ course, s: 26, lane: 0, action: 'jump' }).reason, 'already-armed');
  assert.match(runnerCuePresentation(course, 26, 0, { armed: buffer.armed }).text, /^READY ·/);
  assert.equal(buffer.takeReady({ course, s: 29.49 }), null);
  assert.equal(buffer.takeReady({ course, s: 29.5 }), null, 'arming cannot fire before READY is assigned to a frame');
  assert.equal(buffer.markPresented('tutorial-gap-01'), true);
  assert.equal(buffer.markPresented('tutorial-gap-01'), false, 'READY acknowledgement must be idempotent');
  assert.match(runnerCuePresentation(course, 29.5, 0, { armed: buffer.armed }).text, /^READY ·/,
    'READY copy must persist even after a slow frame crosses actionAt');
  const fired = buffer.takeReady({ course, s: 29.5 });
  assert.equal(fired.hazardId, 'tutorial-gap-01');
  assert.equal(fired.action.type, 'jump');
  assert.equal(buffer.takeReady({ course, s: 29.6 }), null);
  assert.equal(buffer.snapshot().firedCount, 1);
  assert.match(runnerCuePresentation(course, 29.5, 0).text, /^NOW ·/);
});

test('Final Relay starts from an outer lane and every lane prompt reflects current safety', () => {
  const course = createRunnerCourseModel();
  const left = runnerCuePresentation(course, 112, -1);
  const right = runnerCuePresentation(course, 112, 1);
  const center = runnerCuePresentation(course, 112, 0);
  assert.equal(left.requirement, 'right');
  assert.match(left.text, /SWIPE RIGHT TO CENTER/);
  assert.doesNotMatch(left.text, /SWIPE LEFT/);
  assert.equal(right.requirement, 'left');
  assert.match(right.text, /SWIPE LEFT TO CENTER/);
  assert.doesNotMatch(right.text, /SWIPE RIGHT/);
  assert.equal(center.requirement, null);
  assert.match(center.text, /HOLD CENTER/);
  assert.doesNotMatch(center.text, /[←→]|SWIPE/);

  const tutorial = runnerCuePresentation(course, 60, 0);
  assert.equal(tutorial.requirement, 'either-lane');
  assert.match(tutorial.text, /CLEAR LANE/);
  assert.match(runnerCuePresentation(course, 62, -1).text, /HOLD CLEAR LANE/);
});

for(const format of ['full-training', 'final-relay']){
  for(const pace of ['standard', 'calm']){
    test(`${format} ${pace} completes by following each visible cue once with zero damage`, () => {
      const result = runFollowingVisibleCues({ format, pace });
      assert.equal(result.snapshot.status, 'finish-pending');
      assert.equal(result.snapshot.s, 150);
      assert.equal(result.events.filter(event => event.type === 'crash-pending').length, 0);
      assert.equal(result.events.filter(event => event.type === 'hazard-hit').length, 0);
      assert.equal(result.snapshot.shields, 3);
      assert.deepEqual(result.followed, format === 'final-relay'
        ? ['combined-lane-gate', 'final-gap-01']
        : ['tutorial-gap-01', 'lane-blocker-01', 'slide-gate-01', 'combined-lane-gate', 'final-gap-01']);
      assert.ok(result.routes.every(route => route.kind === 'armed'), 'each first visible response should arm before actionAt');
      assert.equal(result.buffer.firedCount, result.followed.length);
    });
  }
}

test('final gap fires at 134m and the nonlethal jump recovery rewinds far enough to escape', () => {
  const course = createRunnerCourseModel();
  assert.equal(course.hazardById('final-gap-01').actionAt, 134);
  assert.equal(course.safePadById('jump-takeoff').resumeS, 23);

  const sim = createRunnerSim({ course });
  const events = [];
  sim.drainEvents();
  for(let step = 0; step < 3000 && sim.state.status !== 'crash-pending'; step += 1){
    sim.step(STEP);
    events.push(...sim.drainEvents());
  }
  assert.equal(sim.state.status, 'crash-pending');
  const crash = events.find(event => event.type === 'crash-pending');
  assert.equal(crash.hazardId, 'tutorial-gap-01');
  assert.equal(crash.safeS, 23);
  assert.equal(crash.lethal, false);
  sim.recover({ safePad: crash.safePadId, shields: sim.state.shields, duration: 0 });
  sim.drainEvents();
  assert.equal(sim.state.s, 23);

  const buffer = createRunnerCueInputBuffer();
  let followed = false;
  let repeatCrash = false;
  let cleared = false;
  for(let step = 0; step < 3000 && sim.state.s < 51; step += 1){
    const state = sim.state;
    const cue = runnerCuePresentation(course, state.s, state.targetLane, { armed: buffer.armed });
    if(cue.stage === 'armed') buffer.markPresented(cue.id);
    if(cue.id === 'tutorial-gap-01' && cue.requirement && !followed){
      submitRoute(sim, buffer.route({ course, s: state.s, lane: state.targetLane, action: 'jump' }));
      followed = true;
    }
    const ready = buffer.takeReady({ course, s: state.s });
    if(ready) sim.input(ready.action.type, ready.action);
    sim.step(STEP);
    for(const event of sim.drainEvents()){
      if(event.type === 'crash-pending') repeatCrash = true;
      if(event.type === 'hazard-cleared' && event.hazardId === 'tutorial-gap-01') cleared = true;
    }
  }
  assert.equal(followed, true);
  assert.equal(repeatCrash, false);
  assert.equal(cleared, true);
  assert.ok(sim.state.s >= 50);
});
