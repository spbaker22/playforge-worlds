import assert from 'node:assert/strict';
import {
  assertProcessTableSnapshot,
  captureProcessTableSnapshotSync,
  processSnapshotCommandUnavailable,
} from './runner.phase4.lock.mjs';

const MARKER_PATTERN = /^[A-Za-z0-9:_-]{8,220}$/;
const nonce = process.env.PLAYFORGE_INTERNAL_TARGET_BOOTSTRAP_NONCE;
const expectedDispatcherMarker = process.env.PLAYFORGE_INTERNAL_TARGET_DISPATCHER_MARKER;
let containment = null;

function exactLiveRecord(snapshot, pid, label){
  const record = snapshot.find(candidate => candidate.pid === pid);
  assert.ok(record, `${label} missing from atomic process snapshot`);
  assert.equal(record.state.startsWith('Z'), false, `${label} is a zombie`);
  return record;
}

/**
 * Prove one target's complete live ancestry from one immutable process-table
 * snapshot. Every hop must remain in the current process group until the exact
 * group-leading dispatcher, whose full argv binds the inherited marker.
 */
export function proveContainedPhaseTargetTopology(snapshot, {
  currentPid = process.pid,
  descendantMarker = process.env.PLAYFORGE_INTERNAL_DESCENDANT_MARKER,
  platform = process.platform,
  label = 'phase target',
} = {}){
  assertProcessTableSnapshot(snapshot);
  assert.ok(Number.isSafeInteger(currentPid) && currentPid > 0,
    `${label} current PID`);
  assert.match(descendantMarker || '', MARKER_PATTERN,
    `${label} descendant marker`);

  const current = exactLiveRecord(snapshot, currentPid, `${label} current process`);
  const dispatcherPgid = current.pgid;
  assert.notEqual(current.pid, dispatcherPgid,
    `${label} cannot be the dispatcher process-group leader`);

  const ancestryPids = [current.pid];
  const seen = new Set(ancestryPids);
  let cursor = current;
  while(cursor.pid !== dispatcherPgid){
    assert.ok(cursor.ppid > 0, `${label} ancestry ended before the dispatcher`);
    const parent = exactLiveRecord(snapshot, cursor.ppid, `${label} ancestor PID ${cursor.ppid}`);
    assert.equal(parent.pgid, dispatcherPgid,
      `${label} ancestry left the dispatcher process group`);
    assert.equal(seen.has(parent.pid), false, `${label} ancestry contains a PID cycle`);
    seen.add(parent.pid);
    ancestryPids.push(parent.pid);
    cursor = parent;
  }

  const dispatcher = cursor;
  assert.equal(dispatcher.pid, dispatcher.pgid,
    `${label} dispatcher is not its process-group leader`);
  assert.equal(processSnapshotCommandUnavailable(dispatcher, { platform }), false,
    `${label} dispatcher argv is unavailable`);
  assert.ok(dispatcher.command.includes(descendantMarker),
    `${label} dispatcher command marker mismatch`);

  const supervisor = exactLiveRecord(
    snapshot,
    dispatcher.ppid,
    `${label} dispatcher supervisor`,
  );
  assert.notEqual(supervisor.pgid, dispatcher.pgid,
    `${label} dispatcher group aliases its supervisor group`);

  return Object.freeze({
    proof: 'atomic-exact-topology',
    targetPid: current.pid,
    dispatcherPid: dispatcher.pid,
    dispatcherStart: dispatcher.processStart,
    dispatcherPgid: dispatcher.pgid,
    supervisorPid: supervisor.pid,
    marker: descendantMarker,
    ancestryPids: Object.freeze(ancestryPids),
  });
}

async function closeBootstrapIpc(){
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if(settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('disconnect', onDisconnect);
      error ? reject(error) : resolve();
    };
    const onDisconnect = () => finish();
    const timer = setTimeout(() => finish(
      new Error('target bootstrap dispatcher IPC did not close'),
    ), 2_000);
    process.once('disconnect', onDisconnect);
    if(!process.connected){
      finish();
      return;
    }
    try { process.disconnect(); }
    catch(error){
      if(process.connected) finish(error);
      else finish();
    }
  });
  assert.equal(process.connected, false,
    'target bootstrap dispatcher IPC remained connected');
}

if(nonce !== undefined || expectedDispatcherMarker !== undefined){
  assert.match(nonce || '', /^[0-9a-f]{48}$/, 'target bootstrap nonce');
  assert.match(expectedDispatcherMarker || '', MARKER_PATTERN,
    'target bootstrap dispatcher marker');
  assert.equal(process.env.PLAYFORGE_INTERNAL_DESCENDANT_MARKER, expectedDispatcherMarker,
    'target bootstrap inherited descendant marker mismatch');
  assert.equal(typeof process.send, 'function',
    'target bootstrap requires a live dispatcher IPC channel');
  assert.equal(process.connected, true,
    'target bootstrap dispatcher IPC channel is not connected');

  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('target bootstrap dispatcher handshake timed out')), 2_000);
    const finish = value => {
      clearTimeout(timer);
      process.removeListener('message', onMessage);
      process.removeListener('disconnect', onDisconnect);
      value instanceof Error ? reject(value) : resolve(value);
    };
    const onMessage = value => finish(value);
    const onDisconnect = () => finish(new Error('target bootstrap dispatcher disconnected before handshake'));
    process.once('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
  assert.deepEqual(Object.keys(message || {}), ['type', 'nonce', 'dispatcherPid'],
    'target bootstrap handshake keys');
  assert.equal(message.type, 'PLAYFORGE_TARGET_BOOTSTRAP_GO',
    'target bootstrap handshake type');
  assert.equal(message.nonce, nonce, 'target bootstrap handshake nonce');
  assert.equal(message.dispatcherPid, process.ppid, 'target bootstrap dispatcher PID');

  const snapshot = captureProcessTableSnapshotSync();
  const directTopology = proveContainedPhaseTargetTopology(snapshot, {
    currentPid: process.pid,
    descendantMarker: expectedDispatcherMarker,
    label: 'target bootstrap',
  });
  assert.equal(directTopology.dispatcherPid, message.dispatcherPid,
    'target bootstrap dispatcher changed after IPC handshake');
  const target = snapshot.find(record => record.pid === process.pid);
  assert.equal(target.ppid, directTopology.dispatcherPid,
    'target bootstrap direct parent changed');
  delete process.env.PLAYFORGE_INTERNAL_TARGET_BOOTSTRAP_NONCE;
  delete process.env.PLAYFORGE_INTERNAL_TARGET_DISPATCHER_MARKER;
  await closeBootstrapIpc();
  containment = Object.freeze({
    ...directTopology,
    proof: 'direct-bootstrap-ipc-closed',
    ipcClosed: true,
  });
}

export function assertContainedPhaseTarget(label = 'phase target', {
  snapshotProbe = captureProcessTableSnapshotSync,
  currentPid = process.pid,
  descendantMarker = process.env.PLAYFORGE_INTERNAL_DESCENDANT_MARKER,
  platform = process.platform,
} = {}){
  if(containment){
    assert.equal(currentPid, process.pid, `${label} direct containment PID override`);
    assert.equal(containment.targetPid, process.pid, `${label} containment PID changed`);
    assert.equal(containment.ipcClosed, true, `${label} dispatcher IPC closure proof missing`);
    assert.equal(process.connected, false, `${label} dispatcher IPC reconnected`);
    return containment;
  }
  assert.equal(typeof snapshotProbe, 'function', `${label} process snapshot probe`);
  const snapshot = snapshotProbe();
  return proveContainedPhaseTargetTopology(snapshot, {
    currentPid,
    descendantMarker,
    platform,
    label,
  });
}
