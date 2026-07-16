import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeCapturedGatedProcessGroup } from './phase-group-finalizer.mjs';

const owned = Object.freeze({
  identity: Object.freeze({ pid: 41001, pgid: 41001 }),
  child: Object.freeze({ pid: 41001, exitCode: null, signalCode: null }),
});

function sequence(values){
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

const options = overrides => ({
  label: 'synthetic group',
  wait: async () => {},
  now: () => 1_000,
  termGraceMs: 0,
  killGraceMs: 0,
  ...overrides,
});

async function captureAggregate(operation){
  try {
    await operation;
  } catch(error){
    assert.ok(error instanceof AggregateError);
    return error;
  }
  assert.fail('expected AggregateError');
}

test('UNKNOWN group is never signalled, but a later fresh LIVE proof is killed and final-proven', async () => {
  const signals = [];
  const inspectGroup = sequence([
    { state: 'UNKNOWN', reason: 'synthetic-snapshot-failure' },
    { state: 'LIVE', memberPids: [41001, 41002] },
    { state: 'PROVEN_DEAD', reason: 'process-group-empty' },
    { state: 'PROVEN_DEAD', reason: 'process-group-empty' },
  ]);

  const error = await captureAggregate(
    finalizeCapturedGatedProcessGroup(owned, options({
      inspectGroup,
      signalGroup(_capture, signal){
        signals.push(signal);
        return { state: 'LIVE', signalled: true, memberPids: [41001, 41002] };
      },
    })),
  );
  assert.deepEqual(signals, ['SIGKILL']);
  assert.equal(error.report.final.state, 'PROVEN_DEAD');
  assert.ok(error.errors.some(item => item.message.includes('synthetic-snapshot-failure')));
});

test('indeterminate TERM revalidation does not skip later independently proven KILL cleanup', async () => {
  const signals = [];
  const inspectGroup = sequence([
    { state: 'LIVE', memberPids: [41001, 41002] },
    { state: 'LIVE', memberPids: [41001, 41002] },
    { state: 'PROVEN_DEAD', reason: 'process-group-empty' },
    { state: 'PROVEN_DEAD', reason: 'process-group-empty' },
  ]);

  const error = await captureAggregate(
    finalizeCapturedGatedProcessGroup(owned, options({
      inspectGroup,
      signalGroup(_capture, signal){
        signals.push(signal);
        return signal === 'SIGTERM'
          ? { state: 'UNKNOWN', signalled: false, reason: 'synthetic-term-revalidation-failure' }
          : { state: 'LIVE', signalled: true, memberPids: [41001, 41002] };
      },
    })),
  );
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(error.report.final.state, 'PROVEN_DEAD');
  assert.ok(error.errors.some(item => item.message.includes('synthetic-term-revalidation-failure')));
});

test('persistent UNKNOWN remains unsignalled and cannot be reported clean', async () => {
  const signals = [];
  const error = await captureAggregate(
    finalizeCapturedGatedProcessGroup(owned, options({
      inspectGroup: () => ({ state: 'UNKNOWN', reason: 'persistent-snapshot-failure' }),
      signalGroup(_capture, signal){
        signals.push(signal);
        return { state: 'LIVE', signalled: true };
      },
    })),
  );
  assert.deepEqual(signals, []);
  assert.equal(error.report.final.state, 'UNKNOWN');
});

test('repeated explicit empty-group proof performs no signals and succeeds', async () => {
  const signals = [];
  const report = await finalizeCapturedGatedProcessGroup(owned, options({
    inspectGroup: () => ({ state: 'PROVEN_DEAD', reason: 'process-group-empty' }),
    signalGroup(_capture, signal){
      signals.push(signal);
      return { state: 'LIVE', signalled: true };
    },
  }));
  assert.equal(report.ok, true);
  assert.equal(report.final.state, 'PROVEN_DEAD');
  assert.deepEqual(signals, []);
});

test('initial PROVEN_DEAD is permanently latched before a reused PGID can appear LIVE', async () => {
  const signals = [];
  let inspections = 0;
  const report = await finalizeCapturedGatedProcessGroup(owned, options({
    inspectGroup(){
      inspections += 1;
      return inspections === 1
        ? { state: 'PROVEN_DEAD', reason: 'process-group-empty' }
        : { state: 'LIVE', memberPids: [41001, 41999] };
    },
    signalGroup(_capture, signal){
      signals.push(signal);
      return { state: 'LIVE', signalled: true, memberPids: [41001, 41999] };
    },
  }));
  assert.equal(inspections, 1, 'a dead numerical PGID was re-inspected after death proof');
  assert.deepEqual(signals, [], 'a reused numerical PGID was signalled after death proof');
  assert.equal(report.final.state, 'PROVEN_DEAD');
});

test('PROVEN_DEAD returned by TERM is latched and forbids a later KILL of reused PGID', async () => {
  const signals = [];
  let inspections = 0;
  const report = await finalizeCapturedGatedProcessGroup(owned, options({
    inspectGroup(){
      inspections += 1;
      return inspections === 1
        ? { state: 'LIVE', memberPids: [41001, 41002] }
        : { state: 'LIVE', memberPids: [41001, 41999] };
    },
    signalGroup(_capture, signal){
      signals.push(signal);
      return { state: 'PROVEN_DEAD', signalled: false, reason: 'process-group-disappeared' };
    },
  }));
  assert.equal(inspections, 1, 'a dead numerical PGID was re-inspected after TERM death proof');
  assert.deepEqual(signals, ['SIGTERM'], 'SIGKILL targeted a reused numerical PGID');
  assert.equal(report.final.state, 'PROVEN_DEAD');
});

test('win32 finalization is rejected before inspection or signalling', async () => {
  let inspected = false;
  let signalled = false;
  await assert.rejects(
    finalizeCapturedGatedProcessGroup(owned, options({
      platform: 'win32',
      inspectGroup(){ inspected = true; return { state: 'LIVE' }; },
      signalGroup(){ signalled = true; return { state: 'LIVE', signalled: true }; },
    })),
    /requires POSIX process-group isolation; win32 is unsupported/,
  );
  assert.equal(inspected, false);
  assert.equal(signalled, false);
});
