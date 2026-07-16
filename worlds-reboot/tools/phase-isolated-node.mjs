import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  inspectCapturedProcessGroup,
  signalCapturedProcessGroup,
} from './phase-process-cleanup.mjs';
import {
  abortPhaseSpawnGate,
  captureGatedProcessIdentitySync,
  createPhaseSpawnGate,
  gatedChildEnvironment,
  gatedNodeArguments,
  releasePhaseSpawnGate,
} from './phase-spawn-gate-parent.mjs';
import { captureProcessTableSnapshotSync } from './runner.phase4.lock.mjs';
import {
  encodePhaseNodeCommand,
  PHASE_NODE_COMMAND_PATH,
} from './phase-node-command-spec.mjs';

export const RECOVERY_ANCESTOR_MARKER_ENV = 'PLAYFORGE_INTERNAL_RECOVERY_ANCESTOR_MARKER';
const MARKER_PATTERN = /^[A-Za-z0-9:_-]{8,220}$/;
const inheritedRecoveryAncestor = process.env[RECOVERY_ANCESTOR_MARKER_ENV] || null;
if(inheritedRecoveryAncestor !== null){
  assert.match(inheritedRecoveryAncestor, MARKER_PATTERN,
    'inherited recovery ancestor marker');
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function gateStdio(stdio){
  if(Array.isArray(stdio)){
    assert.ok(stdio.length === 3 || (stdio.length === 4 && stdio[3] === 'pipe'),
      'isolated gated Node stdio must describe fd 0-2 only');
    return [...stdio.slice(0, 3), 'pipe', 'ipc'];
  }
  assert.ok(['ignore', 'inherit', 'pipe'].includes(stdio),
    'isolated gated Node stdio must be ignore, inherit, pipe, or a three-item array');
  return [stdio, stdio, stdio, 'pipe', 'ipc'];
}

export function assertPhaseIsolationSupported(platform = process.platform){
  assert.notEqual(platform, 'win32',
    'Playforge isolated phases require POSIX process-group isolation; win32 is unsupported');
}

export function scopedGatedTitle(title){
  assert.match(title || '', MARKER_PATTERN, 'local gated process title');
  const outer = inheritedRecoveryAncestor || process.env.PLAYFORGE_OUTER_GATE_TEST_MARKER;
  if(!outer) return title;
  assert.match(outer, MARKER_PATTERN, 'recovery ancestor marker');
  if(title === outer || title.startsWith(`${outer}:`)) return title;
  const available = 220 - outer.length - 1;
  assert.ok(available >= 16, 'recovery ancestor leaves no bounded local-title budget');
  const local = title.length <= available
    ? title
    : `${title.slice(0, Math.max(1, available - 17))}-${createHash('sha256').update(title).digest('hex').slice(0, 16)}`;
  const scoped = `${outer}:${local}`;
  assert.match(scoped, MARKER_PATTERN, 'scoped gated process title');
  return scoped;
}

export function gatedNodeCommandArguments(title, args){
  const payload = encodePhaseNodeCommand(args);
  return gatedNodeArguments(title, ['--', PHASE_NODE_COMMAND_PATH, payload]);
}

export function assertCapturedProcessGroupIsolated(identity){
  assertPhaseIsolationSupported();
  assert.equal(identity?.pgid, identity?.pid,
    'isolated gated Node must lead its captured process group');
  const snapshot = captureProcessTableSnapshotSync();
  const current = snapshot.find(record => record.pid === process.pid);
  assert.ok(current, 'current supervisor was omitted from the process snapshot');
  assert.notEqual(identity.pgid, current.pgid,
    'captured child process group aliases the current supervisor process group');
}

/** Attach the one-result/one-ack dispatcher protocol before gate GO. */
export function createCapturedSentinelProtocol(child, targetArgs){
  assert.equal(typeof child?.send, 'function',
    'captured gated Node requires a supervisor IPC channel');
  const expectedPayloadDigest = createHash('sha256')
    .update(encodePhaseNodeCommand(targetArgs))
    .digest('hex');
  let resultRecord = null;
  let resultSettled = false;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const settleResultError = error => {
    if(resultSettled) return;
    resultSettled = true;
    rejectResult(error);
  };
  const onMessage = message => {
    try {
      assert.equal(resultRecord, null, 'dispatcher sent more than one target result');
      assert.deepEqual(Object.keys(message || {}),
        ['type', 'nonce', 'payloadDigest', 'code', 'signal'],
        'dispatcher target result keys');
      assert.equal(message.type, 'PLAYFORGE_TARGET_RESULT',
        'dispatcher target result type');
      assert.match(message.nonce || '', /^[0-9a-f]{48}$/,
        'dispatcher target result nonce');
      assert.equal(message.payloadDigest, expectedPayloadDigest,
        'dispatcher target result payload digest');
      assert.ok(Number.isInteger(message.code) && message.code >= 0 && message.code <= 255,
        'dispatcher target result code');
      assert.ok(message.signal === null
        || (typeof message.signal === 'string' && /^SIG[A-Z0-9]+$/.test(message.signal)),
      'dispatcher target result signal');
      resultRecord = Object.freeze({
        code: message.code,
        signal: message.signal,
        nonce: message.nonce,
        payloadDigest: message.payloadDigest,
      });
      resultSettled = true;
      resolveResult(resultRecord);
    } catch(error){
      settleResultError(error);
    }
  };
  child.on('message', onMessage);

  let resolveClosed;
  let closedSettled = false;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const settleClosed = value => {
    if(closedSettled) return;
    closedSettled = true;
    child.removeListener('message', onMessage);
    resolveClosed(Object.freeze(value));
    if(!resultRecord){
      settleResultError(new Error(
        `captured dispatcher closed before reporting its target result (${value.signal || (value.code ?? 'unknown')})`,
      ));
    }
  };
  child.once('error', error => settleClosed({ code: null, signal: null, error }));
  child.once('close', (code, signal) => settleClosed({ code, signal, error: null }));

  return Object.freeze({
    child,
    result,
    closed,
    currentResult: () => resultRecord,
  });
}

/**
 * Spawn a Node child behind the one-shot gate and bind its exact process/group
 * identity before any child JavaScript can run. Callers may attach stream
 * listeners to `child` before `releaseCapturedGatedNode` sends GO.
 */
export function spawnCapturedGatedNode({
  title,
  args,
  cwd,
  env = process.env,
  stdio = 'pipe',
}){
  assertPhaseIsolationSupported();
  assert.match(title || '', MARKER_PATTERN,
    'isolated gated Node title');
  assert.ok(Array.isArray(args), 'isolated gated Node args');
  const gate = createPhaseSpawnGate(title);
  let child = null;
  let identity = null;
  let protocol = null;
  try {
    const recoveryAncestor = inheritedRecoveryAncestor
      || env?.[RECOVERY_ANCESTOR_MARKER_ENV]
      || process.env.PLAYFORGE_OUTER_GATE_TEST_MARKER
      || title;
    assert.match(recoveryAncestor, MARKER_PATTERN, 'captured gated recovery ancestor');
    child = spawn(process.execPath, gatedNodeCommandArguments(title, args), {
      cwd,
      detached: true,
      env: gatedChildEnvironment({
        ...env,
        [RECOVERY_ANCESTOR_MARKER_ENV]: recoveryAncestor,
      }, gate),
      stdio: gateStdio(stdio),
    });
    protocol = createCapturedSentinelProtocol(child, args);
    identity = captureGatedProcessIdentitySync(child.pid, {
      expectedCommand: title,
      expectedCommandMarker: title,
      requireOwnProcessGroup: true,
    });
    assertCapturedProcessGroupIsolated(identity);
    return Object.freeze({ child, identity, gate, protocol });
  } catch(error){
    abortPhaseSpawnGate(child, gate);
    if(identity){
      try { signalCapturedProcessGroup(identity, 'SIGKILL'); } catch {}
    }
    if(child?.exitCode === null && child?.signalCode === null){
      try { child.kill('SIGKILL'); } catch {}
    }
    throw error;
  }
}

export async function capturedGatedTargetResult(owned){
  assert.ok(owned?.protocol && owned.protocol.child === owned.child,
    'captured gated Node sentinel protocol');
  return owned.protocol.result;
}

/**
 * ACK only after one atomic snapshot proves that the exact captured leader is
 * the sole live group member. The trusted dispatcher cannot exit before this.
 */
export async function acknowledgeCapturedGatedSentinelIfAlone(owned, {
  closeTimeoutMs = 2_000,
  proofTimeoutMs = 1_000,
} = {}){
  assertPhaseIsolationSupported();
  assert.ok(owned?.protocol && owned.protocol.child === owned.child,
    'captured gated Node sentinel protocol');
  assert.ok(Number.isSafeInteger(closeTimeoutMs) && closeTimeoutMs > 0,
    'dispatcher ACK close timeout');
  assert.ok(Number.isSafeInteger(proofTimeoutMs) && proofTimeoutMs > 0,
    'dispatcher ACK proof timeout');
  const targetResult = owned.protocol.currentResult();
  assert.ok(targetResult, 'dispatcher target result must precede sentinel ACK');
  const initial = inspectCapturedProcessGroup(owned.identity);
  if(initial.state !== 'LIVE'
    || initial.memberPids.length !== 1
    || initial.memberPids[0] !== owned.identity.pid){
    return Object.freeze({ acknowledged: false, initial, final: initial });
  }
  assert.equal(owned.child.connected, true,
    'dispatcher IPC disconnected before sentinel ACK');
  await new Promise((resolve, reject) => {
    owned.child.send({
      type: 'PLAYFORGE_SENTINEL_GROUP_PROVEN_ALONE',
      nonce: targetResult.nonce,
      payloadDigest: targetResult.payloadDigest,
    }, error => error
      ? reject(new Error(`dispatcher sentinel ACK failed: ${error.message}`, { cause: error }))
      : resolve());
  });
  let timer;
  const closed = await Promise.race([
    owned.protocol.closed,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(
        `dispatcher did not close within ${closeTimeoutMs}ms after sentinel ACK`,
      )), closeTimeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if(closed.error) throw closed.error;

  const deadline = Date.now() + proofTimeoutMs;
  let final = inspectCapturedProcessGroup(owned.identity);
  while(final.state !== 'PROVEN_DEAD' && Date.now() < deadline){
    await sleep(20);
    final = inspectCapturedProcessGroup(owned.identity);
  }
  return Object.freeze({ acknowledged: true, initial, final, closed });
}

export async function releaseCapturedGatedNode(owned){
  assertPhaseIsolationSupported();
  assert.ok(owned?.child && owned?.gate && owned?.identity,
    'captured gated Node launch');
  assertCapturedProcessGroupIsolated(owned.identity);
  try {
    await releasePhaseSpawnGate(owned.child, owned.gate);
  } catch(error){
    abortPhaseSpawnGate(owned.child, owned.gate);
    try { signalCapturedProcessGroup(owned.identity, 'SIGKILL'); } catch {}
    if(owned.child.exitCode === null && owned.child.signalCode === null){
      try { owned.child.kill('SIGKILL'); } catch {}
    }
    throw error;
  }
}

export function abortCapturedGatedNode(owned){
  if(!owned) return;
  abortPhaseSpawnGate(owned.child, owned.gate);
}

export function signalCapturedGatedNodeGroup(owned, signal, {
  priorExactMemberIdentities = [],
} = {}){
  assertPhaseIsolationSupported();
  assert.ok(owned?.identity, 'captured gated Node identity');
  assertCapturedProcessGroupIsolated(owned.identity);
  return signalCapturedProcessGroup(owned.identity, signal, {
    priorExactMemberIdentities,
  });
}
