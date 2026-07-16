import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixedStepRunner } from '../engine/fixed-step.js';
import { createModeScope } from '../engine/mode.js';
import { createStateTrace } from '../engine/trace.js';
import { resolveChromeExecutable } from './chrome-path.mjs';

const closeTo = (actual, expected, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be within ${epsilon} of ${expected}`);
};

test('state trace locks reserved fields and deep-clones ingress/egress', () => {
  let now = 10;
  const trace = createStateTrace({ limit: 2, clock: () => now++ });
  const detail = { type: 'forged', sequence: 99, time: -1, nested: { score: 1 } };
  const first = trace.record('real', detail);
  detail.nested.score = 7;
  first.nested.score = 8;
  trace.transition('TITLE', 'PLAY', 'start', {
    type: 'forged-transition', from: 'FAKE', to: 'FAKE', reason: 'fake', nested: { value: 2 },
  });
  trace.record('third', { value: 3 });

  const snapshot = trace.snapshot();
  assert.deepEqual(snapshot.map(entry => entry.sequence), [2, 3]);
  assert.equal(snapshot[0].type, 'transition');
  assert.equal(snapshot[0].from, 'TITLE');
  assert.equal(snapshot[0].to, 'PLAY');
  assert.equal(snapshot[0].reason, 'start');
  snapshot[0].nested.value = 42;
  assert.equal(trace.snapshot()[0].nested.value, 2);
  assert.equal(trace.size, 2);
  assert.equal(trace.last.type, 'third');
  assert.equal(first.type, 'real');
  assert.equal(first.sequence, 1);
  assert.equal(first.time, 10);
});

test('mode tasks use only explicit tick time and stale work cannot fire', () => {
  const events = [];
  const allowed = new Set(['null>TITLE', 'TITLE>PLAY', 'PLAY>RESULTS']);
  const scope = createModeScope({
    initial: 'TITLE',
    canTransition: (from, to) => allowed.has(`${from}>${to}`),
    handlers: {
      TITLE: { enter: () => events.push('enter:title'), exit: () => events.push('exit:title') },
      PLAY: { enter: () => events.push('enter:play'), exit: () => events.push('exit:play') },
      RESULTS: { enter: () => events.push('enter:results') },
    },
  });

  assert.equal(scope.transition('PLAY', { reason: 'tap-start' }).ok, true);
  let secondDueTaskFired = false;
  scope.schedule(0.1, current => {
    events.push('task:finish');
    current.transition('RESULTS', { reason: 'finished' });
  }, { label: 'finish' });
  scope.schedule(0.1, () => { secondDueTaskFired = true; }, { label: 'stale-same-tick' });
  let cleanupReason = null;
  scope.own(reason => { cleanupReason = reason; }, { label: 'gesture' });
  let guardedFired = false;
  const staleGuard = scope.guard(() => { guardedFired = true; }, { label: 'async-result' });

  assert.equal(secondDueTaskFired, false, 'mode task must not use wall time');
  assert.equal(scope.tick(0.05).fired, 0);
  assert.equal(scope.mode, 'PLAY');
  const tick = scope.tick(0.05);
  staleGuard();
  assert.equal(tick.fired, 1);
  assert.equal(scope.mode, 'RESULTS');
  assert.equal(secondDueTaskFired, false);
  assert.equal(guardedFired, false);
  assert.equal(cleanupReason, 'leave:PLAY:finished');
  assert.deepEqual(events, [
    'enter:title', 'exit:title', 'enter:play', 'task:finish', 'exit:play', 'enter:results',
  ]);
  assert.ok(scope.trace.snapshot().some(entry => entry.type === 'task-skipped' && entry.label === 'stale-same-tick'));
  assert.ok(scope.trace.snapshot().some(entry => entry.type === 'guard-skipped' && entry.label === 'async-result'));
});

test('an earlier due task can cancel a later due sibling in the same tick', () => {
  const scope = createModeScope({ initial: 'ACTIVE' });
  const fired = [];
  let cancelSibling;
  scope.schedule(0, () => {
    fired.push('first');
    assert.equal(cancelSibling(), true);
  }, { label: 'first' });
  cancelSibling = scope.schedule(0, () => fired.push('cancelled-sibling'), { label: 'sibling' });

  const result = scope.tick(0);
  assert.equal(result.fired, 1);
  assert.deepEqual(fired, ['first']);
  assert.equal(scope.pendingTasks, 0);
  assert.ok(scope.trace.snapshot().some(entry => entry.type === 'task-cancelled' && entry.label === 'sibling'));
});

test('mode transitions reject reentrancy and all teardown registrations', () => {
  const probes = [];
  let scope;
  const handlers = {
    A: {
      exit(current){
        probes.push(['exit-transition', current.transition('C', { reason: 'reentrant-exit' }).code]);
        probes.push(['exit-task-cancel', current.schedule(0, () => probes.push(['bad-task']))()]);
        probes.push(['exit-effect-cancel', current.own(() => probes.push(['bad-effect']))()]);
      },
    },
    B: {
      enter(current){
        probes.push(['enter-transition', current.transition('C', { reason: 'reentrant-enter' }).code]);
      },
    },
  };
  scope = createModeScope({ initial: 'A', handlers });
  scope.own(() => {
    probes.push(['cleanup-transition', scope.transition('C', { reason: 'reentrant-cleanup' }).code]);
    probes.push(['cleanup-task-cancel', scope.schedule(0, () => probes.push(['bad-cleanup-task']))()]);
    probes.push(['cleanup-effect-cancel', scope.own(() => probes.push(['bad-cleanup-effect']))()]);
  }, { label: 'active-effect' });

  const result = scope.transition('B', { reason: 'advance' });
  assert.equal(result.ok, true);
  assert.equal(scope.mode, 'B');
  assert.equal(scope.pendingTasks, 0);
  scope.tick(0);
  assert.deepEqual(probes, [
    ['exit-transition', 'transition-busy'],
    ['exit-task-cancel', false],
    ['exit-effect-cancel', false],
    ['cleanup-transition', 'transition-busy'],
    ['cleanup-task-cancel', false],
    ['cleanup-effect-cancel', false],
    ['enter-transition', 'transition-busy'],
  ]);
  assert.equal(scope.trace.snapshot().filter(entry => entry.type === 'registration-rejected').length, 4);
});

test('exit and cleanup failures neutralize mode after complete teardown', () => {
  let cleanupRan = false;
  const scope = createModeScope({
    initial: 'BROKEN',
    handlers: { BROKEN: { exit(){ throw new Error('exit exploded'); } } },
  });
  scope.schedule(1, () => assert.fail('failed transition leaked task'), { label: 'must-cancel' });
  scope.own(() => { cleanupRan = true; }, { label: 'must-clean' });
  const oldSignal = scope.signal;
  const result = scope.transition('NEXT', { reason: 'probe-exit-error' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'exit-hook-error');
  assert.equal(cleanupRan, true);
  assert.equal(oldSignal.aborted, true);
  assert.equal(scope.mode, null);
  assert.equal(scope.phase, 'idle');
  assert.equal(scope.pendingTasks, 0);
  assert.equal(scope.signal.aborted, true);
  assert.equal(scope.transition('SAFE', { reason: 'recover' }).ok, true);
  assert.equal(scope.mode, 'SAFE');
});

test('enter failure tears down work registered by the failing hook', () => {
  let enterCleanup = false;
  let leakedTask = false;
  const scope = createModeScope({
    initial: 'READY',
    handlers: {
      BAD: {
        enter(current){
          current.schedule(0, () => { leakedTask = true; }, { label: 'enter-task' });
          current.own(() => { enterCleanup = true; }, { label: 'enter-effect' });
          throw new Error('enter exploded');
        },
      },
    },
  });
  const result = scope.transition('BAD', { reason: 'probe-enter-error' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'enter-hook-error');
  assert.equal(enterCleanup, true);
  assert.equal(scope.mode, null);
  assert.equal(scope.pendingTasks, 0);
  assert.equal(scope.signal.aborted, true);
  scope.tick(0);
  assert.equal(leakedTask, false);
});

test('cleanup-only failure is contained and reported as teardown failure', () => {
  const scope = createModeScope({ initial: 'ACTIVE' });
  scope.own(() => { throw new Error('cleanup exploded'); }, { label: 'broken-effect' });
  const result = scope.transition('NEXT', { reason: 'cleanup-probe' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'teardown-error');
  assert.equal(scope.mode, null);
  assert.equal(scope.phase, 'idle');
  assert.equal(scope.pendingTasks, 0);
  assert.ok(scope.trace.snapshot().some(entry => entry.type === 'cleanup-error' && entry.label === 'broken-effect'));
});

test('task callback errors are contained and do not block sibling tasks', () => {
  const scope = createModeScope({ initial: 'ACTIVE' });
  let sibling = false;
  scope.schedule(0, () => { throw new Error('task exploded'); }, { label: 'bad-task' });
  scope.schedule(0, () => { sibling = true; }, { label: 'sibling-task' });
  const result = scope.tick(0);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'task-error');
  assert.equal(result.fired, 2);
  assert.equal(sibling, true);
  assert.ok(scope.trace.snapshot().some(entry => entry.type === 'task-error' && entry.label === 'bad-task'));
});

test('dispose finalizes despite hook and cleanup failures', () => {
  const rejected = [];
  let scope;
  scope = createModeScope({
    initial: 'ACTIVE',
    handlers: {
      ACTIVE: {
        exit(current){
          rejected.push(current.transition('OTHER', { reason: 'dispose-reentrant' }).code);
          rejected.push(current.schedule(0, () => {})());
          throw new Error('dispose exit exploded');
        },
      },
    },
  });
  scope.own(() => {
    rejected.push(scope.own(() => {})());
    throw new Error('dispose cleanup exploded');
  }, { label: 'bad-cleanup' });

  const result = scope.dispose('shutdown');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'dispose-hook-error');
  assert.deepEqual(rejected, ['transition-busy', false, false]);
  assert.equal(scope.active, false);
  assert.equal(scope.mode, null);
  assert.equal(scope.phase, 'disposed');
  assert.equal(scope.pendingTasks, 0);
  assert.equal(scope.signal.aborted, true);
  assert.equal(scope.dispose('again').code, 'scope-disposed');
  assert.equal(scope.transition('OTHER', { reason: 'after-dispose' }).code, 'scope-disposed');
});

test('transition guard failures leave the active mode and its work intact', () => {
  let taskFired = false;
  const scope = createModeScope({
    initial: 'ACTIVE',
    canTransition(from, to){
      if(from === 'ACTIVE' && to === 'BAD') throw new Error('guard exploded');
      return true;
    },
  });
  scope.schedule(0, () => { taskFired = true; });
  const result = scope.transition('BAD', { reason: 'guard-probe' });
  assert.equal(result.code, 'guard-error');
  assert.equal(scope.mode, 'ACTIVE');
  scope.tick(0);
  assert.equal(taskFired, true);
});

test('fixed-step runner separates clocks and freezes destructive simulation', () => {
  const updates = [];
  const runner = createFixedStepRunner({
    step: 0.1,
    maxFrame: 0.5,
    maxSteps: 3,
    onStep: (dt, state) => updates.push([dt, state.simulationTime]),
  });

  const first = runner.advance(0.25);
  assert.equal(first.steps, 2);
  closeTo(first.simulationTime, 0.2);
  closeTo(first.alpha, 0.5);
  closeTo(first.wallTime, 0.25);
  closeTo(first.cinematicTime, 0.25);

  runner.setSimulating(false);
  const terminal = runner.advance(1, { cinematicScale: 0.5 });
  assert.equal(terminal.steps, 0);
  closeTo(terminal.simulationTime, 0.2);
  closeTo(terminal.wallTime, 1.25);
  closeTo(terminal.cinematicTime, 0.75);
  assert.equal(updates.length, 2, 'terminal presentation must not advance simulation');

  runner.setSimulating(true);
  const capped = runner.advance(0.5);
  assert.equal(capped.steps, 3);
  closeTo(capped.simulationTime, 0.5);
  closeTo(capped.alpha, 0);
  closeTo(capped.dropped, 0.2);
  closeTo(capped.droppedTime, 0.25);
});

test('fixed-step catch-up stops immediately when a step reaches terminal state', () => {
  let runner;
  let updates = 0;
  runner = createFixedStepRunner({
    step: 0.1,
    maxFrame: 1,
    maxSteps: 20,
    onStep(){
      updates += 1;
      if(updates === 1) runner.setSimulating(false);
    },
  });
  const result = runner.advance(0.8);
  assert.equal(result.steps, 1);
  assert.equal(updates, 1);
  closeTo(result.simulationTime, 0.1);
  closeTo(result.accumulator, 0);
  closeTo(result.dropped, 0.7);
  assert.equal(result.simulating, false);
  runner.advance(0.8);
  assert.equal(updates, 1);
});

test('fixed-step cap/drop math leaves no near-one alpha or zero-delta stale step', () => {
  for(const step of [1 / 60, 1 / 120]){
    let updates = 0;
    const runner = createFixedStepRunner({
      step,
      maxFrame: 1,
      maxSteps: 2,
      onStep(){ updates += 1; },
    });
    const capped = runner.advance(step * 5);
    assert.equal(capped.steps, 2, `capped steps at ${step}`);
    assert.equal(updates, 2, `updates at ${step}`);
    closeTo(capped.dropped, step * 3, step * 1e-8);
    closeTo(capped.accumulator, 0, step * 1e-8);
    closeTo(capped.alpha, 0, 1e-8);

    const zero = runner.advance(0);
    assert.equal(zero.steps, 0, `advance(0) must not consume a stale step at ${step}`);
    assert.equal(updates, 2);
    closeTo(zero.accumulator, 0, step * 1e-8);
    closeTo(zero.alpha, 0, 1e-8);
  }
});

test('fixed-step exact 60 Hz and 120 Hz frames normalize floating residuals', () => {
  for(const step of [1 / 60, 1 / 120]){
    let updates = 0;
    const runner = createFixedStepRunner({ step, maxFrame: 1, maxSteps: 4, onStep(){ updates += 1; } });
    for(let frame = 0; frame < 20; frame++){
      const result = runner.advance(step);
      assert.equal(result.steps, 1);
      assert.ok(result.alpha < 1e-8, `alpha residual ${result.alpha} at ${step}`);
    }
    assert.equal(updates, 20);
    assert.equal(runner.advance(0).steps, 0);
  }
});

test('fixed-step allocation-free advanceInto reuses caller and step outputs without changing legacy snapshots', () => {
  const stepStates = [];
  const runner = createFixedStepRunner({
    step: 0.1,
    maxFrame: 1,
    maxSteps: 8,
    onStep(_dt, state){ stepStates.push(state); },
  });
  const options = { simulate: true, timeScale: 1, cinematicScale: 1 };
  const output = {};
  const first = runner.advanceInto(0.25, options, output);
  assert.equal(first, output, 'advanceInto must return the caller-owned output');
  assert.equal(first.steps, 2);
  assert.equal(stepStates.length, 2);
  assert.equal(stepStates[0], stepStates[1], 'advanceInto must reuse one step-state view');

  const stableStepView = stepStates[0];
  const second = runner.advanceInto(0.1, options, output);
  assert.equal(second, output);
  assert.equal(stepStates.at(-1), stableStepView, 'step-state identity changed between frames');
  let metrics = runner.metrics;
  assert.equal(metrics.advanceIntoCalls, 2);
  assert.equal(metrics.reusedFrameWrites, 2);
  assert.equal(metrics.reusedStepWrites, 3);
  assert.equal(metrics.legacyStepSnapshotAllocations, 0);
  assert.equal(metrics.legacyFrameSnapshotAllocations, 0);

  const legacyA = runner.advance(0);
  const legacyB = runner.advance(0);
  assert.notEqual(legacyA, legacyB, 'legacy advance must retain fresh-snapshot semantics');
  metrics = runner.metrics;
  assert.equal(metrics.legacyAdvanceCalls, 2);
  assert.equal(metrics.legacyFrameSnapshotAllocations, 2);
});

test('trace rejects non-finite clocks without consuming sequence numbers', () => {
  const times = [Number.NaN, 12];
  const trace = createStateTrace({ clock: () => times.shift() });
  assert.throws(() => trace.record('bad-time'), /finite number/);
  const valid = trace.record('valid-time');
  assert.equal(valid.sequence, 1);
  assert.equal(valid.time, 12);
  assert.throws(() => createStateTrace({ clock: 12 }), /must be a function/);
  assert.throws(() => createStateTrace({ clock: () => Infinity }).record('infinite'), /finite number/);
  assert.throws(() => createStateTrace({ clock: () => '12' }).record('string'), /finite number/);
});

test('portable Chrome resolver honors any existing explicit candidate', () => {
  const nonExecutable = new URL('../package.json', import.meta.url).pathname;
  const candidates = process.platform === 'win32'
    ? ['/missing/chrome', process.execPath]
    : ['/missing/chrome', nonExecutable, process.execPath];
  const executable = resolveChromeExecutable({ env: {}, bundledPath: null, extraCandidates: candidates });
  assert.equal(executable, process.execPath);
});
