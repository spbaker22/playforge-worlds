import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceArgsUnavailableGrace,
  advanceProvisionalOwnedSnapshotIdentity,
  captureProvisionalOwnedSnapshotIdentity,
  provisionalProcessSnapshotIdentityState,
  replaceProvenDeadOwnedSnapshotIdentity,
  signalExactIdentitySet,
} from './phase-process-cleanup.mjs';
import {
  bindProcessSnapshotIdentity,
  captureProcessTableSnapshotSync,
  exactProcessSnapshotIdentityState,
  processSnapshotArgsUnavailable,
  processSnapshotCommandUnavailable,
  processSnapshotDescendantClosure,
  processSnapshotMarkerMatches,
  signalExactProcessSnapshotIdentity,
} from './runner.phase4.lock.mjs';

const psRow = (prefix, ucomm, command) => `${prefix} ${ucomm.padEnd(16)} ${command}`;
const OUTPUT = [
  psRow('  100     1   100 Ss   Tue Jul 14 20:00:01 2026', 'node',
    '/usr/bin/node --title=phase4-owner /tmp/owner.mjs'),
  psRow('  101   100   100 S+   Tue Jul 14 20:00:02 2026', 'node',
    '/usr/bin/node  --title=phase4-child /tmp/child.mjs --name="two words"'),
  psRow('  102   101   100 R    Tue Jul 14 20:00:03 2026', 'helper',
    '/usr/bin/helper --phase4-child'),
  psRow('  200     1   200 Ss   Tue Jul 14 20:00:04 2026', 'node',
    '/usr/bin/node --title=unrelated /tmp/unrelated.mjs'),
  psRow('  300   100   100 R    Tue Jul 14 20:00:05 2026', 'ps',
    '/bin/ps -axww -o pid=,ppid=,pgid=,stat=,lstart=,ucomm=,command='),
  '',
].join('\n');

function snapshotFrom(output = OUTPUT, observe = null){
  return captureProcessTableSnapshotSync({
    requiredPid: 100,
    psRunner(command, args, options){
      observe?.(command, args, options);
      return { pid: 300, status: 0, stdout: output, stderr: '' };
    },
  });
}

function replaceRow(snapshot, pid, changes){
  return Object.freeze(snapshot.map(record => Object.freeze(record.pid === pid
    ? { ...record, ...changes }
    : { ...record })));
}

test('empty or missing-supervisor process tables fail closed', () => {
  assert.throws(() => captureProcessTableSnapshotSync({
    requiredPid: 100,
    psRunner: () => ({ pid: 300, status: 0, stdout: '', stderr: '' }),
  }), /returned no rows/);
  assert.throws(() => captureProcessTableSnapshotSync({
    requiredPid: 999,
    psRunner: () => ({ pid: 300, status: 0, stdout: OUTPUT, stderr: '' }),
  }), /omitted required supervisor PID 999/);
  assert.throws(() => captureProcessTableSnapshotSync({
    requiredPid: 100,
    psRunner: () => ({ status: 0, stdout: OUTPUT, stderr: '' }),
  }), /did not report its scanner PID/);
});

test('one pinned process-table snapshot preserves exact commands and immutable rows', () => {
  let calls = 0;
  const snapshot = snapshotFrom(OUTPUT, (command, args, options) => {
    calls += 1;
    assert.equal(command, '/bin/ps');
    assert.deepEqual(args, ['-axww', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,ucomm=,command=']);
    assert.equal(options.env.LC_ALL, 'C');
    assert.equal(options.env.LANG, 'C');
    assert.equal(options.env.TZ, 'UTC');
  });

  assert.equal(calls, 1);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(snapshot.every(Object.isFrozen));
  assert.equal(snapshot.some(record => record.pid === 300), false,
    'the one-shot ps scanner must never enter the ownership snapshot');
  assert.equal(snapshot[1].command,
    '/usr/bin/node  --title=phase4-child /tmp/child.mjs --name="two words"',
    'the full command must retain internal spacing and arguments');
  assert.equal(snapshot[1].processStart, 'posix-lstart-utc:Tue Jul 14 20:00:02 2026');
  assert.equal(snapshot[1].ucomm, 'node');
  assert.throws(() => { snapshot[1].ppid = 999; }, TypeError);
});

test('marker matching and descendants use exact records from the same snapshot', () => {
  const snapshot = snapshotFrom();
  const owner = processSnapshotMarkerMatches(snapshot, '--title=phase4-owner');
  assert.deepEqual(owner.map(record => record.pid), [100]);
  assert.deepEqual(processSnapshotMarkerMatches(snapshot, 'phase4-child').map(record => record.pid), [101, 102]);
  assert.deepEqual(processSnapshotDescendantClosure(snapshot, owner).map(record => record.pid), [100, 101, 102]);
  assert.deepEqual(processSnapshotDescendantClosure(snapshot, owner, { includeRoots: false })
    .map(record => record.pid), [101, 102]);

  assert.throws(() => processSnapshotDescendantClosure(snapshot, 100), /must be an object/,
    'a bare PID cannot seed ownership discovery');
  assert.throws(() => processSnapshotDescendantClosure(snapshot, { ...owner[0], command: '/tmp/forged' }),
    /not an exact member/,
    'a row sharing only the PID cannot seed ownership discovery');
});

test('PID reuse or exit before bind cannot turn a discovered row into owned state', () => {
  const discoveredSnapshot = snapshotFrom();
  const discovered = discoveredSnapshot.find(record => record.pid === 101);
  const reusedBeforeBind = replaceRow(discoveredSnapshot, 101, {
    processStart: 'posix-lstart-utc:Tue Jul 14 20:01:02 2026',
    command: '/usr/bin/node --title=hostile-reuse /tmp/hostile.mjs',
  });
  assert.throws(() => bindProcessSnapshotIdentity(reusedBeforeBind, discovered, {
    expectedCommandMarker: '--title=phase4-child',
  }), /not an exact member/,
  'the previously discovered PID must not bind after reuse');

  const exitedBeforeBind = Object.freeze(discoveredSnapshot
    .filter(record => record.pid !== discovered.pid));
  assert.throws(() => bindProcessSnapshotIdentity(exitedBeforeBind, discovered),
    /not an exact member/,
    'a process that exited between discovery and bind must not become owned');
});

test('exact snapshot identity tolerates live state/reparent changes but refuses stable identity changes', () => {
  const snapshot = snapshotFrom();
  const record = snapshot.find(candidate => candidate.pid === 101);
  const identity = bindProcessSnapshotIdentity(snapshot, record, {
    expectedCommandMarker: '--title=phase4-child',
  });
  assert.ok(Object.isFrozen(identity));
  assert.equal(exactProcessSnapshotIdentityState(identity, { snapshot }).state, 'LIVE');

  const reparentedAndRunning = replaceRow(snapshot, 101, { ppid: 1, state: 'R+' });
  assert.equal(exactProcessSnapshotIdentityState(identity, { snapshot: reparentedAndRunning }).state, 'LIVE',
    'an already-bound child remains owned after reparent and a normal ps state transition');
  const reusedPid = replaceRow(snapshot, 101, {
    processStart: 'posix-lstart-utc:Tue Jul 14 20:01:02 2026',
  });
  assert.deepEqual(
    exactProcessSnapshotIdentityState(identity, { snapshot: reusedPid }).reason,
    'pid-reused',
  );

  const signals = [];
  assert.deepEqual(signalExactProcessSnapshotIdentity(identity, 'SIGTERM', {
    snapshotProbe: () => reparentedAndRunning,
    signalProcess: (...args) => signals.push(args),
  }), { signalled: true, state: 'LIVE' });
  assert.deepEqual(signalExactProcessSnapshotIdentity(identity, 'SIGKILL', {
    snapshotProbe: () => reusedPid,
    signalProcess: (...args) => signals.push(args),
  }), { signalled: false, state: 'PROVEN_DEAD', reason: 'pid-reused' });
  assert.deepEqual(signals, [[101, 'SIGTERM']],
    'the reparented live identity is cleanup-eligible but the reused PID is not');

  const changedGroup = replaceRow(snapshot, 101, { pgid: 200 });
  assert.deepEqual(signalExactProcessSnapshotIdentity(identity, 'SIGKILL', {
    snapshotProbe: () => changedGroup,
    signalProcess: (...args) => signals.push(args),
  }), { signalled: false, state: 'UNKNOWN', reason: 'process-group-changed' });
  const changedCommand = replaceRow(snapshot, 101, { command: '/usr/bin/node /tmp/replacement.mjs' });
  assert.deepEqual(signalExactProcessSnapshotIdentity(identity, 'SIGKILL', {
    snapshotProbe: () => changedCommand,
    signalProcess: (...args) => signals.push(args),
  }), { signalled: false, state: 'UNKNOWN', reason: 'command-changed' });
  const zombie = replaceRow(snapshot, 101, { state: 'Z+' });
  assert.deepEqual(signalExactProcessSnapshotIdentity(identity, 'SIGKILL', {
    snapshotProbe: () => zombie,
    signalProcess: (...args) => signals.push(args),
  }), { signalled: false, state: 'PROVEN_DEAD', reason: 'zombie' });
  assert.deepEqual(signals, [[101, 'SIGTERM']]);
});

test('a status-0 snapshot omission is dead only when kill(0) proves ESRCH', () => {
  const snapshot = snapshotFrom();
  const record = snapshot.find(candidate => candidate.pid === 101);
  const identity = bindProcessSnapshotIdentity(snapshot, record);
  const missingRow = Object.freeze(snapshot.filter(candidate => candidate.pid !== identity.pid));

  assert.deepEqual(exactProcessSnapshotIdentityState(identity, {
    snapshot: missingRow,
    pidExistenceProbe: () => 'LIVE',
  }), {
    state: 'UNKNOWN',
    processStart: identity.processStart,
    reason: 'snapshot-omitted-live-pid',
  });
  assert.deepEqual(exactProcessSnapshotIdentityState(identity, {
    snapshot: missingRow,
    pidExistenceProbe: () => 'UNKNOWN',
  }), {
    state: 'UNKNOWN',
    processStart: identity.processStart,
    reason: 'snapshot-omitted-unproven-pid',
  });
  assert.deepEqual(exactProcessSnapshotIdentityState(identity, {
    snapshot: missingRow,
    pidExistenceProbe: () => 'PROVEN_DEAD',
  }), {
    state: 'PROVEN_DEAD',
    processStart: null,
    reason: 'pid-absent-and-esrch',
  });
});

test('Darwin argv-unavailable fallback is UNKNOWN and signal-free until stronger proof', () => {
  const snapshot = snapshotFrom();
  const record = snapshot.find(candidate => candidate.pid === 101);
  const identity = bindProcessSnapshotIdentity(snapshot, record);
  const signals = [];

  for(const state of ['Rs', 'Us', 'Ss', '?Es']){
    const fallback = replaceRow(snapshot, identity.pid, { state, command: '(node)' });
    const current = fallback.find(candidate => candidate.pid === identity.pid);
    assert.equal(processSnapshotArgsUnavailable(identity, current, { platform: 'darwin' }), true);
    assert.deepEqual(exactProcessSnapshotIdentityState(identity, { snapshot: fallback }), {
      state: 'UNKNOWN',
      processStart: identity.processStart,
      reason: 'args-unavailable',
      record: current,
    });
    assert.deepEqual(signalExactProcessSnapshotIdentity(identity, 'SIGKILL', {
      snapshotProbe: () => fallback,
      signalProcess: (...args) => signals.push(args),
    }), { signalled: false, state: 'UNKNOWN', reason: 'args-unavailable' });
  }
  assert.deepEqual(signals, [], 'argv fallback authorized a signal');

  const restored = replaceRow(snapshot, identity.pid, { state: 'R+' });
  assert.equal(exactProcessSnapshotIdentityState(identity, { snapshot: restored }).state, 'LIVE',
    'the exact original command did not recover from argv fallback');

  const sameSecondWrongLineage = replaceRow(snapshot, identity.pid, {
    ppid: 1,
    state: 'Rs',
    command: '(node)',
  });
  assert.equal(processSnapshotArgsUnavailable(identity,
    sameSecondWrongLineage.find(candidate => candidate.pid === identity.pid),
    { platform: 'darwin' }), false,
  'same-second PID/lineage ambiguity was mistaken for the captured argv fallback');
  assert.equal(exactProcessSnapshotIdentityState(identity, { snapshot: sameSecondWrongLineage }).reason,
    'command-changed');

  const wrongUcomm = replaceRow(snapshot, identity.pid, { ucomm: 'other', command: '(other)' });
  assert.equal(exactProcessSnapshotIdentityState(identity, { snapshot: wrongUcomm }).reason,
    'ucomm-changed');
  const changedStart = replaceRow(snapshot, identity.pid, {
    processStart: 'posix-lstart-utc:Tue Jul 14 20:00:03 2026',
    command: '(node)',
  });
  assert.equal(exactProcessSnapshotIdentityState(identity, { snapshot: changedStart }).reason,
    'pid-reused');
});

test('first-seen Darwin argv fallback remains provisional until exact lineage gains a full command', () => {
  const snapshot = snapshotFrom();
  const full = snapshot.find(candidate => candidate.pid === 101);
  const fallbackSnapshot = replaceRow(snapshot, full.pid, { state: 'Us', command: '(node)' });
  const provisional = fallbackSnapshot.find(candidate => candidate.pid === full.pid);
  assert.equal(processSnapshotCommandUnavailable(provisional, { platform: 'darwin' }), true);

  assert.deepEqual(provisionalProcessSnapshotIdentityState(provisional, {
    snapshot: fallbackSnapshot,
    platform: 'darwin',
  }), {
    state: 'UNKNOWN',
    processStart: provisional.processStart,
    reason: 'args-unavailable',
    record: provisional,
  });

  const restored = replaceRow(snapshot, full.pid, { state: 'R+' });
  const restoredRecord = restored.find(candidate => candidate.pid === full.pid);
  assert.deepEqual(provisionalProcessSnapshotIdentityState(provisional, {
    snapshot: restored,
    platform: 'darwin',
  }), {
    state: 'LIVE',
    processStart: provisional.processStart,
    reason: 'args-restored',
    record: restoredRecord,
  });

  const reparented = replaceRow(restored, full.pid, { ppid: 1 });
  assert.equal(provisionalProcessSnapshotIdentityState(provisional, {
    snapshot: reparented,
    platform: 'darwin',
  }).reason, 'provisional-parent-changed',
  'a full command after reparenting was incorrectly promoted to authority');

  const reused = replaceRow(restored, full.pid, {
    processStart: 'posix-lstart-utc:Tue Jul 14 20:00:03 2026',
  });
  assert.deepEqual(provisionalProcessSnapshotIdentityState(provisional, {
    snapshot: reused,
    platform: 'darwin',
  }), {
    state: 'PROVEN_DEAD',
    processStart: null,
    reason: 'pid-reused',
  });

  assert.deepEqual(provisionalProcessSnapshotIdentityState(provisional, {
    snapshot: snapshot.filter(record => record.pid !== provisional.pid),
    platform: 'darwin',
    pidExistenceProbe: () => 'PROVEN_DEAD',
  }), {
    state: 'PROVEN_DEAD',
    processStart: null,
    reason: 'pid-absent-and-esrch',
  });
});

test('outer descendant and inner marker provenance safely replace a reused owned PID', () => {
  const originalSnapshot = snapshotFrom();
  const original = bindProcessSnapshotIdentity(
    originalSnapshot,
    originalSnapshot.find(record => record.pid === 101),
  );
  const descendantSnapshot = replaceRow(originalSnapshot, original.pid, {
    processStart: 'posix-lstart-utc:Tue Jul 14 20:00:06 2026',
    state: 'R',
    command: '/usr/bin/node --title=phase4-reused-descendant /tmp/reused.mjs',
  });
  const descendant = descendantSnapshot.find(record => record.pid === original.pid);
  const descendantRoot = descendantSnapshot.find(record => record.pid === 100);
  const outerRemembered = new Map([[original.pid, original]]);
  const outerReplacement = replaceProvenDeadOwnedSnapshotIdentity(
    outerRemembered,
    descendantSnapshot,
    descendant,
    { provenance: { kind: 'descendant', rootRecord: descendantRoot } },
  );
  assert.equal(outerReplacement.processStart, descendant.processStart);
  assert.equal(outerReplacement.command, descendant.command);
  assert.equal(outerRemembered.get(original.pid), outerReplacement,
    'outer descendant replacement was not atomic in the PID-keyed map');

  const unrelatedSnapshot = replaceRow(descendantSnapshot, original.pid, { ppid: 1 });
  const unrelated = unrelatedSnapshot.find(record => record.pid === original.pid);
  const unrelatedRemembered = new Map([[original.pid, original]]);
  assert.throws(() => replaceProvenDeadOwnedSnapshotIdentity(
    unrelatedRemembered,
    unrelatedSnapshot,
    unrelated,
    { provenance: { kind: 'descendant', rootRecord: unrelatedSnapshot.find(record => record.pid === 100) } },
  ), /lacks exact live-descendant provenance/);
  assert.equal(unrelatedRemembered.get(original.pid), original,
    'bare PID reuse displaced old authority');

  const marker = 'phase4-reused-marker-proof';
  const markerSnapshot = replaceRow(descendantSnapshot, original.pid, {
    ppid: 1,
    pgid: original.pid,
    command: `/usr/bin/node --title=${marker}:owned-descendant /tmp/reused.mjs`,
  });
  const markerRecord = markerSnapshot.find(record => record.pid === original.pid);
  const innerRemembered = new Map([[original.pid, original]]);
  const innerReplacement = replaceProvenDeadOwnedSnapshotIdentity(
    innerRemembered,
    markerSnapshot,
    markerRecord,
    { provenance: { kind: 'marker', marker } },
  );
  assert.equal(innerRemembered.get(original.pid), innerReplacement,
    'inner marker replacement was not atomic in the PID-keyed map');

  const fallbackSnapshot = replaceRow(descendantSnapshot, original.pid, { command: '(node)' });
  const fallbackRemembered = new Map([[original.pid, original]]);
  assert.throws(() => replaceProvenDeadOwnedSnapshotIdentity(
    fallbackRemembered,
    fallbackSnapshot,
    fallbackSnapshot.find(record => record.pid === original.pid),
    {
      provenance: { kind: 'descendant', rootRecord: fallbackSnapshot.find(record => record.pid === 100) },
      platform: 'darwin',
    },
  ), /must remain provisional/);
  assert.equal(fallbackRemembered.get(original.pid), original,
    'argv fallback replaced exact authority');
});

test('both supervisors retire reused fallback authority until full-command promotion', () => {
  const originalSnapshot = snapshotFrom();
  const original = bindProcessSnapshotIdentity(
    originalSnapshot,
    originalSnapshot.find(record => record.pid === 101),
  );
  const fallbackSnapshot = replaceRow(originalSnapshot, original.pid, {
    processStart: 'posix-lstart-utc:Tue Jul 14 20:00:06 2026',
    state: 'Us',
    command: '(node)',
  });
  const fallback = fallbackSnapshot.find(record => record.pid === original.pid);
  const provenance = {
    kind: 'descendant',
    rootRecord: fallbackSnapshot.find(record => record.pid === 100),
  };
  const remembered = new Map([[original.pid, original]]);
  const provisional = new Map();
  const entry = captureProvisionalOwnedSnapshotIdentity(
    remembered,
    provisional,
    fallbackSnapshot,
    fallback,
    { provenance, platform: 'darwin', now: 1_000 },
  );
  assert.equal(remembered.has(original.pid), false,
    'dead exact authority survived fallback collision');
  assert.equal(provisional.get(original.pid), entry,
    'fallback collision did not become provisional ownership');

  const signals = [];
  const refused = signalExactIdentitySet(remembered, 'SIGKILL', {
    signalIdentity: (...args) => signals.push(args),
  });
  assert.equal(refused.results.length, 0,
    'provisional fallback entered the exact signallable set');
  assert.deepEqual(signals, [], 'provisional fallback authorized a signal');
  assert.equal(advanceProvisionalOwnedSnapshotIdentity(
    remembered,
    provisional,
    fallbackSnapshot,
    original.pid,
    { platform: 'darwin' },
  ).reason, 'args-unavailable', 'fallback did not block exact ownership proof');

  let grace = advanceArgsUnavailableGrace(null, true, { now: entry.startedAt, graceMs: 250 });
  grace = advanceArgsUnavailableGrace(grace.startedAt, true, { now: 1_250, graceMs: 250 });
  assert.equal(grace.expired, true,
    'persistent reused fallback did not fail its bounded pending interval');

  const fullSnapshot = replaceRow(fallbackSnapshot, original.pid, {
    state: 'R',
    command: '/usr/bin/node --title=phase4-reused-restored /tmp/restored.mjs',
  });
  const promoted = advanceProvisionalOwnedSnapshotIdentity(
    remembered,
    provisional,
    fullSnapshot,
    original.pid,
    { platform: 'darwin' },
  );
  assert.equal(promoted.state, 'LIVE');
  assert.equal(promoted.reason, 'args-restored');
  assert.equal(remembered.get(original.pid), promoted.identity,
    'full same-lineage command did not enter exact authority');
  assert.equal(provisional.has(original.pid), false,
    'promotion retained stale provisional ownership');
});
