import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { decodePhaseNodeCommandEnvelope } from './phase-node-command-spec.mjs';
import {
  bindProcessSnapshotIdentity,
  captureProcessTableSnapshotSync,
  exactProcessSnapshotIdentityState,
  processSnapshotCommandUnavailable,
} from './runner.phase4.lock.mjs';
import { signalCapturedProcessGroup } from './phase-process-cleanup.mjs';

assert.equal(process.argv.length, 3, 'gated Node dispatcher requires one payload');
assert.equal(process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_FD, undefined,
  'gated Node dispatcher retained gate fd authority');
assert.equal(process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE, undefined,
  'gated Node dispatcher retained gate nonce authority');
assert.equal(typeof process.send, 'function',
  'gated Node dispatcher requires its captured supervisor IPC channel');

const commandPayload = process.argv[2];
const command = decodePhaseNodeCommandEnvelope(commandPayload);
assert.equal(command.sentinel, true, 'gated Node dispatcher requires sentinel mode');
const payloadDigest = createHash('sha256').update(commandPayload).digest('hex');
const dispatcherMarker = process.env.PLAYFORGE_INTERNAL_DESCENDANT_MARKER;
assert.match(dispatcherMarker || '', /^[A-Za-z0-9:_-]{8,220}$/,
  'gated Node dispatcher marker');
const recoveryAncestorMarker = process.env.PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER;
assert.match(recoveryAncestorMarker || '', /^[A-Za-z0-9:_-]{8,220}$/,
  'gated Node dispatcher recovery ancestor marker');

// Bind both the exact group leader and any genuinely live, marked ancestor
// before target code starts. On supervisor loss, only a freshly revalidated
// ancestor permits the sentinel to remain for outer recovery.
const initialSnapshot = captureProcessTableSnapshotSync();
const dispatcherRecord = initialSnapshot.find(record => record.pid === process.pid);
assert.ok(dispatcherRecord && !dispatcherRecord.state.startsWith('Z'),
  'gated Node dispatcher missing from its initial atomic snapshot');
const dispatcherIdentity = bindProcessSnapshotIdentity(initialSnapshot, dispatcherRecord, {
  expectedCommandMarker: dispatcherMarker,
  requireOwnProcessGroup: true,
});
let recoveryAuthorityIdentity = null;
let ancestorPid = dispatcherRecord.ppid;
const visitedAncestors = new Set([dispatcherRecord.pid]);
while(Number.isSafeInteger(ancestorPid) && ancestorPid > 0 && !visitedAncestors.has(ancestorPid)){
  visitedAncestors.add(ancestorPid);
  const record = initialSnapshot.find(candidate => candidate.pid === ancestorPid);
  if(!record || record.state.startsWith('Z')) break;
  if(record.pgid !== dispatcherIdentity.pgid
    && !processSnapshotCommandUnavailable(record)
    && record.command.includes(recoveryAncestorMarker)){
    recoveryAuthorityIdentity = bindProcessSnapshotIdentity(initialSnapshot, record, {
      expectedCommandMarker: recoveryAncestorMarker,
    });
  }
  ancestorPid = record.ppid;
}
let sentinelAcknowledged = false;
const keepAlive = setInterval(() => {}, 1_000);
process.once('disconnect', () => {
  if(sentinelAcknowledged) return;
  const recoveryState = recoveryAuthorityIdentity
    ? exactProcessSnapshotIdentityState(recoveryAuthorityIdentity)
    : { state: 'PROVEN_DEAD', reason: 'no-validated-recovery-ancestor' };
  if(recoveryState.state === 'LIVE') return;
  try { signalCapturedProcessGroup(dispatcherIdentity, 'SIGKILL'); }
  catch { /* UNKNOWN never releases the exact leader; the marker remains discoverable. */ }
});
const targetNonce = randomBytes(24).toString('hex');
const childEnvironment = {
  ...process.env,
  PLAYFORGE_INTERNAL_TARGET_BOOTSTRAP_NONCE: targetNonce,
  PLAYFORGE_INTERNAL_TARGET_DISPATCHER_MARKER: dispatcherMarker,
};
// A dispatcher may itself run inside a node:test file process. This private
// worker flag belongs only to that process; propagating it makes a nested
// `node --test` silently behave like an already-managed test worker.
delete childEnvironment.NODE_TEST_CONTEXT;
const bootstrapUrl = new URL('./phase-target-bootstrap.mjs', import.meta.url).href;
const child = spawn(process.execPath, ['--import', bootstrapUrl, ...command.args], {
  cwd: process.cwd(),
  env: childEnvironment,
  detached: false,
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
});
const childClosed = new Promise(resolve => {
  let settled = false;
  const finish = value => {
    if(settled) return;
    settled = true;
    resolve(value);
  };
  child.once('error', error => finish({ code: 1, signal: null, error }));
  child.once('close', (code, signal) => finish({
    code: Number.isInteger(code) ? code : 1,
    signal: typeof signal === 'string' ? signal : null,
  }));
});

await new Promise((resolve, reject) => {
  child.send({
    type: 'PLAYFORGE_TARGET_BOOTSTRAP_GO',
    nonce: targetNonce,
    dispatcherPid: process.pid,
  }, error => error ? reject(new Error(`target bootstrap IPC failed: ${error.message}`, { cause: error })) : resolve());
});

let targetResult;
try {
  targetResult = await childClosed;
} finally {
  if(child.exitCode === null && child.signalCode === null){
    try { child.kill('SIGKILL'); } catch {}
  }
  try { child.disconnect?.(); } catch {}
}

const resultNonce = randomBytes(24).toString('hex');
const acknowledgement = new Promise(resolve => {
  const onMessage = message => {
    try {
      assert.deepEqual(Object.keys(message || {}), ['type', 'nonce', 'payloadDigest'],
        'dispatcher sentinel ACK keys');
      assert.equal(message.type, 'PLAYFORGE_SENTINEL_GROUP_PROVEN_ALONE',
        'dispatcher sentinel ACK type');
      assert.equal(message.nonce, resultNonce, 'dispatcher sentinel ACK nonce');
      assert.equal(message.payloadDigest, payloadDigest,
        'dispatcher sentinel ACK payload digest');
      sentinelAcknowledged = true;
      cleanup();
      resolve();
    } catch { /* Invalid or stale ACKs cannot release the exact group leader. */ }
  };
  const cleanup = () => process.removeListener('message', onMessage);
  process.on('message', onMessage);
});
await new Promise(resolve => {
  try {
    process.send({
      type: 'PLAYFORGE_TARGET_RESULT',
      nonce: resultNonce,
      payloadDigest,
      code: targetResult.code,
      signal: targetResult.signal,
    }, () => resolve());
  } catch { resolve(); }
});
await acknowledgement;
clearInterval(keepAlive);
try { process.disconnect?.(); } catch {}
if(targetResult.signal) process.kill(process.pid, targetResult.signal);
process.exitCode = targetResult.code;
