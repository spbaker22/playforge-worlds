import assert from 'node:assert/strict';
import {
  assertProcessTableSnapshot,
  bindProcessSnapshotIdentity,
  captureProcessTableSnapshotSync,
  exactProcessSnapshotIdentityState,
  processSnapshotArgsUnavailable,
  processSnapshotCommandUnavailable,
  processSnapshotDescendantClosure,
  processSnapshotMarkerMatches,
  signalExactProcessSnapshotIdentity,
} from './runner.phase4.lock.mjs';

const LIVE = 'LIVE';
const PROVEN_DEAD = 'PROVEN_DEAD';
const UNKNOWN = 'UNKNOWN';

/** Monotonic elapsed grace for argv-unavailable only; never an identity verdict. */
export function advanceArgsUnavailableGrace(startedAt, pending, {
  now = Date.now(),
  graceMs = 250,
} = {}){
  assert.ok(startedAt === null || (Number.isFinite(startedAt) && startedAt >= 0),
    'argv-unavailable grace start');
  assert.equal(typeof pending, 'boolean', 'argv-unavailable pending flag');
  assert.ok(Number.isFinite(now) && now >= 0, 'argv-unavailable grace clock');
  assert.ok(Number.isFinite(graceMs) && graceMs > 0, 'argv-unavailable grace duration');
  if(!pending) return Object.freeze({ startedAt: null, expired: false });
  const effectiveStart = startedAt === null ? now : startedAt;
  return Object.freeze({
    startedAt: effectiveStart,
    expired: now - effectiveStart >= graceMs,
  });
}

function identitiesFrom(remembered){
  if(remembered instanceof Map) return [...remembered.values()];
  assert.ok(Array.isArray(remembered), 'remembered process identities must be a Map or array');
  return [...remembered];
}

function unknownSignalError(signal, identity, result){
  const error = new Error(
    `refused to ${signal} owned PID ${identity?.pid ?? 'unknown'} because exact identity is UNKNOWN: ${result?.reason || 'unknown'}`,
  );
  error.identityState = UNKNOWN;
  return error;
}

/**
 * Signal every already-bound identity. An UNKNOWN/error is recorded but can
 * never prevent a later exact LIVE identity from receiving the same signal.
 */
export function signalExactIdentitySet(remembered, signal, {
  signalIdentity = signalExactProcessSnapshotIdentity,
  deferUnknown = () => false,
} = {}){
  assert.equal(typeof signal, 'string', 'owned-process signal');
  assert.equal(typeof signalIdentity, 'function', 'exact identity signaler');
  assert.equal(typeof deferUnknown, 'function', 'UNKNOWN deferral classifier');
  const errors = [];
  const results = [];
  const deferred = [];
  for(const identity of identitiesFrom(remembered)){
    try {
      const result = signalIdentity(identity, signal);
      results.push(Object.freeze({ identity, result }));
      if(result?.state === UNKNOWN){
        if(deferUnknown(identity, result)) deferred.push(Object.freeze({ identity, result }));
        else errors.push(unknownSignalError(signal, identity, result));
      }
    } catch(error){
      errors.push(error);
      results.push(Object.freeze({ identity, error }));
    }
  }
  return Object.freeze({
    ok: errors.length === 0,
    results: Object.freeze(results),
    errors: Object.freeze(errors),
    deferred: Object.freeze(deferred),
  });
}

export function capturedChildHandleExited(child, identity){
  if(!child || !identity || child.pid !== identity.pid) return false;
  return child.exitCode !== null || child.signalCode !== null;
}

/** A bound direct-child exit may resolve only its own stale argv fallback. */
export function exactDirectChildIdentityState(identity, child, options = {}){
  const state = exactProcessSnapshotIdentityState(identity, options);
  if(state.state === UNKNOWN && state.reason === 'args-unavailable'
    && capturedChildHandleExited(child, identity)
    && processSnapshotArgsUnavailable(identity, state.record)){
    return {
      state: PROVEN_DEAD,
      processStart: null,
      reason: 'captured-child-handle-exited',
    };
  }
  return state;
}

/**
 * A first-seen Darwin `(ucomm)` row proves provisional lineage only. It may
 * become signal authority solely after one full-command row preserves every
 * captured stable field, including the PPID that established that lineage.
 */
export function provisionalProcessSnapshotIdentityState(identity, {
  snapshot,
  platform = process.platform,
  pidExistenceProbe,
} = {}){
  try {
    assertProcessTableSnapshot([identity]);
    assert.ok(processSnapshotCommandUnavailable(identity, { platform }),
      'provisional identity must be an argv-unavailable row');
    assertProcessTableSnapshot(snapshot);
  } catch(error){
    return { state: UNKNOWN, reason: 'invalid-provisional-identity', error };
  }
  const current = snapshot.find(record => record.pid === identity.pid);
  if(!current){
    const options = { snapshot };
    if(pidExistenceProbe !== undefined) options.pidExistenceProbe = pidExistenceProbe;
    return exactProcessSnapshotIdentityState(identity, options);
  }
  if(current.processStart !== identity.processStart){
    return { state: PROVEN_DEAD, processStart: null, reason: 'pid-reused' };
  }
  if(current.state.startsWith('Z')){
    return { state: PROVEN_DEAD, processStart: null, reason: 'zombie' };
  }
  if(current.ppid !== identity.ppid){
    return { state: UNKNOWN, processStart: current.processStart, reason: 'provisional-parent-changed', record: current };
  }
  if(current.pgid !== identity.pgid){
    return { state: UNKNOWN, processStart: current.processStart, reason: 'process-group-changed', record: current };
  }
  if(current.ucomm !== identity.ucomm){
    return { state: UNKNOWN, processStart: current.processStart, reason: 'ucomm-changed', record: current };
  }
  if(processSnapshotCommandUnavailable(current, { platform })){
    return { state: UNKNOWN, processStart: current.processStart, reason: 'args-unavailable', record: current };
  }
  return { state: LIVE, processStart: current.processStart, reason: 'args-restored', record: current };
}

function validatedOwnedRecordBindingOptions(snapshot, record, provenance, bindingOptions = {}){
  assert.ok(provenance && typeof provenance === 'object',
    'owned snapshot record requires provenance');
  let effectiveBindingOptions = { ...bindingOptions };
  if(provenance.kind === 'descendant'){
    const descendants = processSnapshotDescendantClosure(snapshot, provenance.rootRecord, {
      includeRoots: false,
    });
    assert.ok(descendants.includes(record),
      'owned snapshot record lacks exact live-descendant provenance');
  } else if(provenance.kind === 'marker'){
    assert.equal(typeof provenance.marker, 'string', 'owned snapshot marker provenance');
    assert.ok(processSnapshotMarkerMatches(snapshot, provenance.marker).includes(record),
      'owned snapshot record lacks exact marker provenance');
    effectiveBindingOptions = {
      ...effectiveBindingOptions,
      expectedCommandMarker: provenance.marker,
    };
  } else {
    throw new Error('owned snapshot record provenance must be descendant or marker');
  }
  return effectiveBindingOptions;
}

/** Capture a first-seen fallback as nonsignallable provisional ownership. */
export function captureProvisionalOwnedSnapshotIdentity(remembered, provisional, snapshot, record, {
  provenance,
  bindingOptions = {},
  platform = process.platform,
  now = Date.now(),
} = {}){
  assert.ok(remembered instanceof Map && provisional instanceof Map,
    'provisional ownership requires exact and provisional Maps');
  assertProcessTableSnapshot(snapshot);
  assert.equal(processSnapshotCommandUnavailable(record, { platform }), true,
    'provisional ownership requires argv-unavailable record');
  const effectiveBindingOptions = validatedOwnedRecordBindingOptions(
    snapshot,
    record,
    provenance,
    bindingOptions,
  );
  const existing = remembered.get(record.pid);
  if(existing){
    const priorState = exactProcessSnapshotIdentityState(existing, { snapshot });
    assert.equal(priorState.state, PROVEN_DEAD,
      'provisional replacement requires explicit old-identity death proof');
    assert.equal(priorState.reason, 'pid-reused',
      'provisional replacement requires same-snapshot PID reuse proof');
    remembered.delete(record.pid);
  }
  assert.equal(provisional.has(record.pid), false,
    'provisional PID is already captured');
  const entry = Object.freeze({
    identity: record,
    startedAt: now,
    provenance,
    bindingOptions: Object.freeze(effectiveBindingOptions),
  });
  provisional.set(record.pid, entry);
  return entry;
}

/** Advance provisional ownership without ever signalling the fallback row. */
export function advanceProvisionalOwnedSnapshotIdentity(remembered, provisional, snapshot, pid, {
  platform = process.platform,
} = {}){
  assert.ok(remembered instanceof Map && provisional instanceof Map,
    'provisional ownership requires exact and provisional Maps');
  const entry = provisional.get(pid);
  assert.ok(entry, `provisional PID ${pid} is not captured`);
  const state = provisionalProcessSnapshotIdentityState(entry.identity, { snapshot, platform });
  if(state.state === PROVEN_DEAD){
    provisional.delete(pid);
    return state;
  }
  if(state.state !== LIVE) return state;
  assert.equal(remembered.has(pid), false,
    'provisional promotion cannot overwrite exact authority');
  const identity = bindProcessSnapshotIdentity(
    snapshot,
    state.record,
    entry.bindingOptions || {},
  );
  remembered.set(pid, identity);
  provisional.delete(pid);
  return { ...state, identity };
}

/**
 * Replace a dead PID-keyed authority only when the replacement is independently
 * owned in this same atomic snapshot. Bare numerical PID reuse is insufficient.
 */
export function replaceProvenDeadOwnedSnapshotIdentity(remembered, snapshot, record, {
  provenance,
  bindingOptions = {},
  platform = process.platform,
} = {}){
  assert.ok(remembered instanceof Map, 'owned identity replacement requires a Map');
  assertProcessTableSnapshot(snapshot);
  const existing = remembered.get(record?.pid);
  assert.ok(existing, 'owned identity replacement requires prior PID authority');
  const priorState = exactProcessSnapshotIdentityState(existing, { snapshot });
  assert.equal(priorState.state, PROVEN_DEAD,
    'owned identity replacement requires explicit old-identity death proof');
  assert.equal(priorState.reason, 'pid-reused',
    'owned identity replacement requires same-snapshot PID reuse proof');
  assert.equal(processSnapshotCommandUnavailable(record, { platform }), false,
    'argv-unavailable replacement must remain provisional');

  const effectiveBindingOptions = validatedOwnedRecordBindingOptions(
    snapshot,
    record,
    provenance,
    bindingOptions,
  );

  const replacement = bindProcessSnapshotIdentity(snapshot, record, effectiveBindingOptions);
  remembered.set(replacement.pid, replacement);
  return replacement;
}

function validateCapturedGroupIdentity(identity){
  assert.ok(identity && typeof identity === 'object', 'captured process-group identity');
  for(const field of ['pid', 'pgid']){
    assert.ok(Number.isSafeInteger(identity[field]) && identity[field] > 0,
      `captured process-group identity ${field}`);
  }
  assert.equal(identity.pgid, identity.pid, 'captured leader must own its process group');
  assert.ok(typeof identity.processStart === 'string' && identity.processStart.length > 0,
    'captured process-group start');
  assert.ok(typeof identity.ucomm === 'string' && identity.ucomm.length > 0,
    'captured process-group ucomm');
  assert.ok(typeof identity.command === 'string' && identity.command.length > 0,
    'captured process-group command');
}

/**
 * Revalidate a captured POSIX group from one atomic process-table view.
 * Once the captured leader is absent, a still-live group requires at least one
 * independently supplied exact member identity to prove group continuity.
 */
export function inspectCapturedProcessGroup(identity, {
  snapshotProbe = captureProcessTableSnapshotSync,
  priorExactMemberIdentities = [],
} = {}){
  validateCapturedGroupIdentity(identity);
  assert.equal(typeof snapshotProbe, 'function', 'captured process-group snapshot probe');
  assert.ok(Array.isArray(priorExactMemberIdentities),
    'captured process-group prior exact member identities');

  let snapshot;
  try {
    snapshot = snapshotProbe();
    assertProcessTableSnapshot(snapshot);
  } catch(error){
    return Object.freeze({ signalled: false, state: UNKNOWN, reason: 'snapshot-failed', error });
  }

  const leader = snapshot.find(record => record?.pid === identity.pid);
  if(leader){
    if(leader.processStart !== identity.processStart){
      return Object.freeze({ signalled: false, state: PROVEN_DEAD, reason: 'process-group-reused' });
    }
    if(leader.pgid !== identity.pgid){
      return Object.freeze({ signalled: false, state: UNKNOWN, reason: 'leader-process-group-changed' });
    }
    if(leader.ucomm !== identity.ucomm){
      return Object.freeze({ signalled: false, state: UNKNOWN, reason: 'leader-ucomm-changed' });
    }
    if(leader.command !== identity.command){
      if(processSnapshotArgsUnavailable(identity, leader)){
        return Object.freeze({ signalled: false, state: UNKNOWN, reason: 'leader-args-unavailable' });
      }
      return Object.freeze({ signalled: false, state: UNKNOWN, reason: 'leader-command-changed' });
    }
  }

  const members = snapshot.filter(record => record?.pgid === identity.pgid
    && typeof record?.state === 'string' && !record.state.startsWith('Z'));
  if(members.length === 0){
    return Object.freeze({ signalled: false, state: PROVEN_DEAD, reason: 'process-group-empty' });
  }

  if(!leader){
    const memberPids = new Set(members.map(record => record.pid));
    const exactSurvivor = priorExactMemberIdentities.find(memberIdentity => {
      if(!memberIdentity || memberIdentity.pgid !== identity.pgid
        || !memberPids.has(memberIdentity.pid)) return false;
      return exactProcessSnapshotIdentityState(memberIdentity, { snapshot }).state === LIVE;
    });
    if(!exactSurvivor){
      return Object.freeze({
        signalled: false,
        state: UNKNOWN,
        reason: 'leader-absent-without-exact-member-authority',
        memberPids: Object.freeze(members.map(record => record.pid)),
      });
    }
  }

  return Object.freeze({
    signalled: false,
    state: LIVE,
    memberPids: Object.freeze(members.map(record => record.pid)),
  });
}

/**
 * Revalidate and signal a captured POSIX process group from one atomic table
 * snapshot. After leader exit, an independently captured exact surviving
 * member must prove continuity. If the numerical PGID is empty, reused, or
 * leaderless without that authority, no negative-PGID signal occurs.
 */
export function signalCapturedProcessGroup(identity, signal, {
  snapshotProbe = captureProcessTableSnapshotSync,
  signalGroup = (pgid, requestedSignal) => process.kill(-pgid, requestedSignal),
  priorExactMemberIdentities = [],
} = {}){
  validateCapturedGroupIdentity(identity);
  assert.equal(typeof signal, 'string', 'captured process-group signal');
  assert.equal(typeof signalGroup, 'function', 'captured process-group signaler');
  const inspected = inspectCapturedProcessGroup(identity, {
    snapshotProbe,
    priorExactMemberIdentities,
  });
  if(inspected.state !== LIVE) return inspected;

  try {
    signalGroup(identity.pgid, signal);
  } catch(error){
    if(error?.code === 'ESRCH'){
      return Object.freeze({ signalled: false, state: PROVEN_DEAD, reason: 'process-group-disappeared' });
    }
    return Object.freeze({ signalled: false, state: UNKNOWN, reason: 'process-group-signal-failed', error });
  }
  return Object.freeze({
    signalled: true,
    state: LIVE,
    memberPids: inspected.memberPids,
  });
}
