import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exactMarkerProcessRecords,
  signalExactMarkerProcesses,
} from './phase-marker-processes.mjs';
import { signalExactProcessSnapshotIdentity } from './runner.phase4.lock.mjs';

function record(overrides = {}){
  return Object.freeze({
    pid: 710_001,
    ppid: 1,
    pgid: 710_001,
    state: 'S',
    processStart: 'posix-lstart-utc:Tue Jul 14 20:00:01 2026',
    ucomm: 'node',
    command: 'phase-marker-reuse-proof:worker',
    ...overrides,
  });
}

test('marker PID reuse is revalidated and never receives a numeric signal', () => {
  const original = record();
  const reused = record({
    processStart: 'posix-lstart-utc:Tue Jul 14 20:00:02 2026',
    command: 'unrelated-reused-process',
  });
  const signals = [];
  const result = signalExactMarkerProcesses('phase-marker-reuse-proof', 'SIGKILL', {
    excludePids: new Set(),
    snapshotProbe: () => Object.freeze([original]),
    signalIdentity: (identity, signal) => signalExactProcessSnapshotIdentity(identity, signal, {
      snapshotProbe: () => Object.freeze([reused]),
      signalProcess: (...args) => signals.push(args),
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [{
    pid: original.pid,
    signalled: false,
    state: 'PROVEN_DEAD',
    reason: 'pid-reused',
  }]);
  assert.deepEqual(signals, []);
});

test('Darwin argv fallback remains UNKNOWN and grants no signal authority', () => {
  const fallback = record({ command: '(node)' });
  let signalCalls = 0;
  const result = signalExactMarkerProcesses('node', 'SIGTERM', {
    excludePids: new Set(),
    snapshotProbe: () => Object.freeze([fallback]),
    signalIdentity: () => { signalCalls += 1; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.identities.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(signalCalls, 0);
});

test('fresh marker proof can retain zombies for explicit residue detection', () => {
  const zombie = record({ state: 'Z' });
  const snapshotProbe = () => Object.freeze([zombie]);
  assert.deepEqual(exactMarkerProcessRecords('phase-marker-reuse-proof', {
    excludePids: new Set(), snapshotProbe,
  }).records, []);
  assert.deepEqual(exactMarkerProcessRecords('phase-marker-reuse-proof', {
    excludePids: new Set(), includeZombies: true, snapshotProbe,
  }).records, [zombie]);
});
