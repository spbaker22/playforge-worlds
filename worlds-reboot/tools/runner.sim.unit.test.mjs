import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUNNER_COURSE_SECTIONS,
  RUNNER_TUTORIAL_HAZARDS,
  createRunnerPoseOutput,
  createRunnerCourseModel,
} from '../runner/src/course.js';
import {
  DEFAULT_RUNNER_SIM_CONFIG,
  RUNNER_SIM_STATUS,
  createRunnerSim,
} from '../runner/src/sim.js';

const STEP = 1 / 120;

function fakeRawPath(){
  const calls = [];
  return {
    calls,
    at(s){
      calls.push(s);
      return {
        pos: { x: s, y: 12 + s * 0.01, z: s * 2 },
        tan: { x: 0, y: 0, z: 2 },
        right: { x: 4, y: 0, z: 0 },
      };
    },
  };
}

function stepUntil(sim, predicate, limit = 4000){
  for(let index = 0; index < limit; index += 1){
    sim.step(STEP);
    const snapshot = sim.snapshot();
    if(predicate(snapshot)) return snapshot;
  }
  assert.fail(`condition not reached after ${limit} deterministic steps`);
}

test('course is an immutable authored 0–150m tutorial with one coordinate transform', () => {
  const rawPath = fakeRawPath();
  const course = createRunnerCourseModel(rawPath, { pathOffset: 22 });
  const pose = course.poseAt(10, 1);

  assert.equal(course.length, 150);
  assert.deepEqual(course.lanes, [-1, 0, 1]);
  assert.equal(rawPath.calls.length, 1);
  assert.equal(rawPath.calls[0], 32);
  assert.deepEqual(pose.center, { x: 32, y: 12.32, z: 64 });
  assert.deepEqual(pose.position, { x: 34.35, y: 12.32, z: 64 });
  assert.equal(pose.rawS, 32);
  assert.ok(Object.isFrozen(course.hazards));
  assert.ok(Object.isFrozen(course.hazards[0]));

  assert.deepEqual(RUNNER_COURSE_SECTIONS.map(section => [section.id, section.s0, section.s1]), [
    ['safe-launch', 0, 25],
    ['jump-lesson', 25, 60],
    ['lane-lesson', 60, 90],
    ['slide-lesson', 90, 112],
    ['combined-test', 112, 150],
  ]);
  for(let index = 1; index < RUNNER_COURSE_SECTIONS.length; index += 1){
    assert.equal(RUNNER_COURSE_SECTIONS[index].s0, RUNNER_COURSE_SECTIONS[index - 1].s1);
  }
  assert.deepEqual(RUNNER_TUTORIAL_HAZARDS.map(hazard => hazard.id), [
    'tutorial-gap-01', 'lane-blocker-01', 'slide-gate-01', 'combined-lane-gate', 'final-gap-01',
  ]);
  assert.ok(RUNNER_TUTORIAL_HAZARDS.every(hazard => hazard.actionAt >= hazard.cueStart
    && hazard.actionAt < hazard.s0), 'every authored cue must own its actionable course point');
  assert.equal(course.sectionAt(55).id, 'jump-lesson');
  assert.equal(course.sectionAt(60).id, 'lane-lesson');
  assert.equal(course.sectionAt(112).id, 'combined-test');
  assert.equal(course.nextSectionAfter(111).id, 'combined-test');
  assert.equal(course.sectionBoundaryAfter(111), 112);
  assert.equal(course.cueAt(112).id, 'combined-lane-gate');
  assert.equal(course.nextCueAfter(111).id, 'combined-lane-gate');
  const combinedGate = course.hazardById('combined-lane-gate');
  assert.equal(combinedGate.s0 - combinedGate.cueStart, 15);
  assert.equal(combinedGate.actionAt, 121.5);
  assert.ok(course.decisionWindowFor(combinedGate, DEFAULT_RUNNER_SIM_CONFIG.maxSpeed) > 1);
  assert.ok(
    course.decisionSecondsFor(combinedGate, DEFAULT_RUNNER_SIM_CONFIG.maxSpeed, 0.18) >= 0.75,
    'combined cue must leave at least 0.75s after its runtime presentation fade',
  );
  assert.equal(course.checkpointAt(54).id, 'checkpoint-start');
  assert.equal(course.checkpointAt(55).id, 'checkpoint-55');
  assert.equal(course.checkpointAt(120).id, 'checkpoint-120');
  assert.equal(course.safePadBefore(35).id, 'jump-takeoff');
  assert.equal(course.safePadBefore(140).id, 'checkpoint-120-pad');
});

test('geometry/collider debug anchors are coincident to <= 1e-6 and report observed drift', () => {
  const course = createRunnerCourseModel();
  const canonical = course.debugAnchors();
  assert.equal(canonical.aligned, true);
  assert.equal(canonical.maxDelta, 0);
  assert.ok(canonical.anchors.length > 20);
  assert.ok(canonical.anchors.every(anchor => anchor.delta <= 1e-6));

  const first = canonical.anchors[0];
  const observed = course.debugAnchors({
    geometry: { [first.key]: first.canonical },
    colliders: { [first.key]: { ...first.canonical, x: first.canonical.x + 0.001 } },
  });
  assert.equal(observed.aligned, false);
  assert.equal(observed.maxDelta, Infinity);
  assert.ok(observed.missingCount > 0);
  assert.ok(observed.anchors[0].delta > 0.0009);
  const missing = course.debugAnchors({ geometry: new Map(), colliders: new Map() });
  assert.equal(missing.aligned, false);
  assert.equal(missing.maxDelta, Infinity);
  assert.equal(missing.anchors[0].geometry, null);
  assert.deepEqual(missing.anchors[0].missing, ['geometry', 'collider']);
});

test('poseAtInto reuses caller-owned output with exact diagnostic pose parity', () => {
  const course = createRunnerCourseModel();
  const output = createRunnerPoseOutput();
  const position = output.position;
  const center = output.center;
  const tangent = output.tangent;
  const right = output.right;
  const up = output.up;

  assert.strictEqual(course.poseAtInto(37.25, -0.35, output), output);
  assert.deepEqual(output, course.poseAt(37.25, -0.35));
  assert.strictEqual(course.poseAtInto(121.5, 1, output), output);
  assert.strictEqual(output.position, position);
  assert.strictEqual(output.center, center);
  assert.strictEqual(output.tangent, tangent);
  assert.strictEqual(output.right, right);
  assert.strictEqual(output.up, up);
  assert.deepEqual(output, course.poseAt(121.5, 1));
});

test('directional actions are accepted once and snapshots retain interpolation state', () => {
  const sim = createRunnerSim({ course: createRunnerCourseModel() });
  sim.drainEvents();

  sim.input('jump');
  sim.step(STEP);
  const afterJump = sim.snapshot();
  let events = sim.drainEvents();
  assert.equal(events.filter(event => event.type === 'action-accepted' && event.action === 'jump').length, 1);
  assert.equal(events.find(event => event.type === 'action-accepted')?.result, 'jump');
  assert.equal(afterJump.previousS, 6);
  assert.equal(afterJump.previous.s, 6);
  assert.ok(afterJump.s > afterJump.previousS);
  assert.ok(afterJump.y > afterJump.previousY);

  sim.restore({ s: 60, lane: 0 });
  sim.drainEvents();
  sim.input('left');
  sim.step(STEP);
  events = sim.drainEvents();
  assert.equal(events.filter(event => event.type === 'action-accepted' && event.result === 'lane-change').length, 1);
  stepUntil(sim, snapshot => !snapshot.laneChanging);
  assert.equal(sim.state.lanePosition, -1);

  sim.input('slide');
  sim.step(STEP);
  events = sim.drainEvents();
  assert.equal(events.filter(event => event.type === 'action-accepted' && event.result === 'slide').length, 1);
  assert.ok(sim.state.slideRemaining > 1.2);
});

test('hot step, presentation, pose, and empty-event paths reuse caller-owned storage', () => {
  const sim = createRunnerSim({ course: createRunnerCourseModel() });
  sim.drainEvents();
  const emptyA = sim.drainEvents();
  const emptyB = sim.drainEvents();
  assert.strictEqual(emptyA, emptyB);

  const frame = sim.createPresentationFrame();
  const rivals = frame.rivals;
  const rivalObjects = [...rivals];
  const standings = frame.standings;
  const standingObjects = [...standings];
  const standingsOutput = sim.createStandingsOutput();
  const outputStandingObjects = [...standingsOutput];
  const firstResult = sim.step(STEP, frame);
  const secondResult = sim.step(STEP, frame);
  assert.strictEqual(secondResult, firstResult);
  assert.strictEqual(sim.writePresentationFrame(frame), frame);
  assert.strictEqual(sim.writeStandingsInto(standingsOutput), standingsOutput);
  assert.strictEqual(frame.rivals, rivals);
  rivalObjects.forEach((rival, index) => assert.strictEqual(frame.rivals[index], rival));
  assert.strictEqual(frame.standings, standings);
  standingObjects.forEach((standing, index) => assert.strictEqual(frame.standings[index], standing));
  outputStandingObjects.forEach((standing, index) => assert.strictEqual(standingsOutput[index], standing));

  const snapshot = sim.snapshot();
  assert.equal(frame.time, snapshot.time);
  assert.equal(frame.s, snapshot.s);
  assert.equal(frame.speed, snapshot.speed);
  assert.equal(frame.lanePosition, snapshot.lanePosition);
  assert.equal(frame.y, snapshot.y);
  assert.equal(frame.previousS, snapshot.previousS);
  assert.equal(frame.previousY, snapshot.previousY);
  assert.equal(frame.rank, snapshot.rank);
  assert.equal(frame.finishTime, snapshot.finishTime);
  assert.equal(frame.rivals.length, snapshot.rivals.length);
  frame.rivals.forEach((rival, index) => {
    assert.equal(rival.s, snapshot.rivals[index].s);
    assert.equal(rival.previousS, snapshot.rivals[index].previousS);
    assert.equal(rival.speed, snapshot.rivals[index].speed);
    assert.equal(rival.finishTime, snapshot.rivals[index].finishTime);
  });
  frame.standings.forEach((standing, index) => {
    assert.equal(standing.id, snapshot.standings[index].id);
    assert.equal(standing.rank, snapshot.standings[index].rank);
    assert.equal(standing.s, snapshot.standings[index].s);
    assert.equal(standing.finished, Number(snapshot.standings[index].finished));
    assert.equal(standing.finishTime, snapshot.standings[index].finishTime);
  });
  assert.deepEqual(standingsOutput.map(standing => standing.id), snapshot.standings.map(standing => standing.id));
  assert.equal(sim.pendingEventCount, 0);
  const reusableEvents = ['stale'];
  assert.strictEqual(sim.drainEventsInto(reusableEvents), reusableEvents);
  assert.deepEqual(reusableEvents, []);
});

test('overhead and bar posture must remain valid through the complete authored span', () => {
  const course = createRunnerCourseModel();
  const exploit = createRunnerSim({ course, config: { slideDuration: 0.12 } });
  exploit.restore({ s: 99.7, lane: 0, speed: 11.5 });
  exploit.drainEvents();
  exploit.input('slide');
  let enteredWhileSliding = false;
  for(let index = 0; index < 180 && exploit.state.s < 104.5; index += 1){
    exploit.step(STEP);
    const state = exploit.snapshot();
    if(state.s >= 100 && state.s <= 104 && state.slideRemaining > 0) enteredWhileSliding = true;
  }
  const exploitEvents = exploit.drainEvents();
  assert.equal(enteredWhileSliding, true, 'fixture must enter the gate with an initially valid slide');
  assert.equal(exploitEvents.filter(event => event.type === 'hazard-hit' && event.hazardId === 'slide-gate-01').length, 1);
  assert.equal(exploitEvents.filter(event => event.type === 'hazard-cleared' && event.hazardId === 'slide-gate-01').length, 0);

  const bar = {
    id: 'test-bar', kind: 'bar', s0: 10, s1: 12,
    lanes: [-1, 0, 1], lethal: false, action: 'jump', h: 0.8,
    cueStart: 8, landingEnd: 14, safePadId: 'start-pad', forgiving: true, label: 'JUMP',
  };
  const barCourse = createRunnerCourseModel({ hazards: [bar] });
  const barSim = createRunnerSim({ course: barCourse });
  barSim.restore({ s: 9.9, lane: 0, speed: 10, grounded: false, jumpsUsed: 1, y: 1.0, vy: 0, coyoteRemaining: 0 });
  barSim.drainEvents();
  for(let index = 0; index < 120 && barSim.state.s < 12.5; index += 1) barSim.step(STEP);
  const barEvents = barSim.drainEvents();
  assert.equal(barEvents.filter(event => event.type === 'hazard-hit' && event.hazardId === 'test-bar').length, 1);
  assert.equal(barEvents.filter(event => event.type === 'hazard-cleared' && event.hazardId === 'test-bar').length, 0);
});

test('coyote time and jump buffering use simulation time only', () => {
  const course = createRunnerCourseModel();
  const sim = createRunnerSim({ course });
  sim.restore({ s: 33.98, lane: 0, speed: 12 });
  sim.drainEvents();
  stepUntil(sim, snapshot => !snapshot.grounded && snapshot.fallHazardId === 'tutorial-gap-01', 80);
  assert.ok(sim.state.coyoteRemaining > 0);
  sim.input('jump');
  sim.step(STEP);
  let events = sim.drainEvents();
  assert.equal(events.filter(event => event.type === 'action-accepted' && event.result === 'jump').length, 1);

  sim.restore({ s: 50, lane: 0, speed: 9, grounded: false, jumpsUsed: 2, y: 0.01, vy: -0.5 });
  sim.drainEvents();
  sim.input('jump');
  stepUntil(sim, snapshot => snapshot.vy > 0 && snapshot.jumpsUsed === 1, 12);
  events = sim.drainEvents();
  assert.equal(events.filter(event => event.type === 'jump-buffered').length, 1);
  assert.equal(events.filter(event => event.type === 'action-accepted' && event.result === 'jump').length, 1);
});

test('crash is pending exactly once, never spends a shield, and flow-owned recovery is deterministic', () => {
  const course = createRunnerCourseModel();
  const sim = createRunnerSim({ course });
  sim.restore({ s: 137.9, lane: 0, speed: 12, shields: 3, lastSafePad: 'checkpoint-120-pad' });
  sim.drainEvents();

  stepUntil(sim, snapshot => snapshot.status === 'crash-pending');
  const atCrash = sim.state;
  const firstEvents = sim.drainEvents();
  const crashEvents = firstEvents.filter(event => event.type === 'crash-pending');
  assert.equal(crashEvents.length, 1);
  assert.equal(crashEvents[0].hazardId, 'final-gap-01');
  assert.equal(crashEvents[0].lethal, true);
  assert.equal(crashEvents[0].shieldsBefore, 3);
  assert.equal(crashEvents[0].shieldsRemaining, 3);
  assert.equal(crashEvents[0].suggestedShieldsRemaining, 2);
  assert.equal(atCrash.shields, 3);

  for(let index = 0; index < 120; index += 1) sim.step(STEP);
  assert.equal(sim.drainEvents().filter(event => event.type === 'crash-pending').length, 0);
  assert.equal(sim.state.s, atCrash.s);

  const result = sim.recover({ safePad: 'checkpoint-120-pad', shields: 2, duration: 0 });
  assert.equal(result.ok, true);
  assert.equal(sim.state.status, 'running');
  assert.equal(sim.state.s, 121.5);
  assert.equal(sim.state.shields, 2);
  assert.equal(sim.state.lastSafePadId, 'checkpoint-120-pad');
});

test('debug restore reaches the final test quickly and terminal freeze stops all simulation', () => {
  const sim = createRunnerSim({ course: createRunnerCourseModel() });
  const restored = sim.restore({ s: 124, lane: -1, speed: 11, shields: 1, lastSafePad: 'checkpoint-120-pad' });
  assert.equal(restored.s, 124);
  assert.equal(restored.lane, -1);
  assert.equal(restored.shields, 1);

  sim.freeze('failed', { terminal: true });
  const frozen = sim.state;
  for(let index = 0; index < 600; index += 1) sim.step(STEP);
  assert.equal(sim.state.status, 'terminal');
  assert.equal(sim.state.s, frozen.s);
  assert.equal(sim.state.time, frozen.time);
  assert.equal(sim.resume(), false);
});

test('export/import preserves transient hazard progress and produces replay-identical rivals and events', () => {
  const course = createRunnerCourseModel();
  const original = createRunnerSim({ course });
  original.drainEvents();
  const originalFrame = original.createPresentationFrame();
  const fired = new Set();

  const preSaveStepLimit = 10_000;
  let preSaveSteps = 0;
  while(originalFrame.s < 102 && preSaveSteps < preSaveStepLimit){
    if(originalFrame.s >= 29.5 && !fired.has('jump-1')){ original.input('jump'); fired.add('jump-1'); }
    if(originalFrame.s >= 61.5 && !fired.has('lane-left')){ original.input('left'); fired.add('lane-left'); }
    if(originalFrame.s >= 89.5 && !fired.has('slide')){ original.input('slide'); fired.add('slide'); }
    original.step(STEP, originalFrame);
    preSaveSteps += 1;
  }
  assert.ok(originalFrame.s >= 102,
    `pre-save replay fixture did not reach 102m within ${preSaveStepLimit} deterministic steps`);

  const saved = original.exportState();
  assert.ok(saved.progress.resolvedHazards.includes('tutorial-gap-01'));
  assert.ok(saved.progress.resolvedHazards.includes('lane-blocker-01'));
  assert.ok(saved.progress.cuedHazards.includes('slide-gate-01'));
  assert.equal(saved.progress.resolvedHazards.includes('slide-gate-01'), false);

  const replay = createRunnerSim({ course: createRunnerCourseModel() });
  replay.importState(saved);
  assert.deepEqual(replay.exportState(), saved);
  const replayFrame = replay.createPresentationFrame();
  assert.deepEqual(replayFrame, originalFrame);

  let laneCenter = false, finalJump = false;
  for(let index = 0; index < 5000; index += 1){
    if(originalFrame.s >= 121.5 && !laneCenter){
      original.input('right');
      replay.input('right');
      laneCenter = true;
    }
    if(originalFrame.s >= 133.2 && !finalJump){
      original.input('jump');
      replay.input('jump');
      finalJump = true;
    }
    const originalResult = original.step(STEP, originalFrame);
    const replayResult = replay.step(STEP, replayFrame);
    assert.equal(replayResult.statusCode, originalResult.statusCode);
    assert.deepEqual(replayFrame, originalFrame);
    if(originalResult.statusCode === RUNNER_SIM_STATUS.FINISH_PENDING) break;
  }

  assert.equal(original.snapshot().status, 'finish-pending');
  assert.deepEqual(replay.snapshot(), original.snapshot());
  assert.deepEqual(replay.drainEvents(), original.drainEvents());
  assert.deepEqual(replay.exportState(), original.exportState());
  const finishedRivals = original.snapshot().rivals.filter(rival => rival.finished);
  assert.ok(finishedRivals.length > 0, 'at least one authoritative rival should finish during the tutorial race');
  assert.ok(finishedRivals.every(rival => rival.finishTime > 0));
});

test('the authored tutorial is completable and JET finish time agrees with authoritative rank order', () => {
  const sim = createRunnerSim({ course: createRunnerCourseModel() });
  sim.drainEvents();
  const fired = new Set();

  for(let index = 0; index < 5000 && sim.state.status === 'running'; index += 1){
    const { s } = sim.state;
    if(s >= 29.5 && !fired.has('jump-1')){ sim.input('jump'); fired.add('jump-1'); }
    if(s >= 61.5 && !fired.has('lane-left')){ sim.input('left'); fired.add('lane-left'); }
    if(s >= 89.5 && !fired.has('slide')){ sim.input('slide'); fired.add('slide'); }
    if(s >= 121.5 && !fired.has('lane-center')){ sim.input('right'); fired.add('lane-center'); }
    if(s >= 133.2 && !fired.has('jump-2')){ sim.input('jump'); fired.add('jump-2'); }
    sim.step(STEP);
  }

  const events = sim.drainEvents();
  assert.equal(sim.state.status, 'finish-pending');
  assert.equal(sim.state.s, 150);
  assert.equal(events.filter(event => event.type === 'crash-pending').length, 0);
  assert.equal(events.filter(event => event.type === 'hazard-hit').length, 0);
  assert.deepEqual(events.filter(event => event.type === 'hazard-cleared').map(event => event.hazardId), [
    'tutorial-gap-01',
    'lane-blocker-01',
    'slide-gate-01',
    'combined-lane-gate',
    'final-gap-01',
  ]);
  assert.equal(events.filter(event => event.type === 'finish-pending').length, 1);
  assert.ok(events.some(event => event.type === 'checkpoint' && event.checkpointId === 'checkpoint-55'));
  assert.ok(events.some(event => event.type === 'checkpoint' && event.checkpointId === 'checkpoint-120'));
  const final = sim.snapshot();
  assert.equal(final.rivals.length, 3);
  assert.ok(final.finishTime > 0);
  const jet = final.rivals.find(rival => rival.id === 'jet');
  assert.ok(jet.finished);
  assert.ok(jet.finishTime < final.finishTime, 'JET fixture must finish before the player');
  assert.deepEqual(final.standings.slice(0, 2).map(standing => standing.id), ['jet', 'player']);
  const playerStanding = final.standings.find(standing => standing.id === 'player');
  assert.equal(final.rank, playerStanding.rank);
  assert.equal(final.rank, 2);

  const frame = sim.createPresentationFrame();
  assert.equal(frame.rank, final.rank);
  assert.equal(frame.finishTime, final.finishTime);
  assert.deepEqual(frame.standings.map(standing => standing.id), final.standings.map(standing => standing.id));
});
