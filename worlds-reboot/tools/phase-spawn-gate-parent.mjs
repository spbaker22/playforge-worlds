import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  bindProcessSnapshotIdentity,
  captureProcessTableSnapshotSync,
  probeProcessIdentity,
} from './runner.phase4.lock.mjs';
import {
  TRUSTED_DESCENDANT_NODE_OPTION,
  TRUSTED_GATE_MODULE_URL,
  assertCapturedBeforeGateRelease,
  recordCapturedGatedProcess,
  registerFreshSpawnGateCapability,
  revokeSpawnGateCapability,
} from './phase-spawn-capability.mjs';
import {
  decodePhaseNodeCommand,
  PHASE_NODE_COMMAND_PATH,
} from './phase-node-command-spec.mjs';

const CAPTURE_PAUSE = new Int32Array(new SharedArrayBuffer(4));

export function createPhaseSpawnGate(descendantMarker){
  assert.match(descendantMarker || '', /^[A-Za-z0-9:_-]{8,220}$/, 'spawn gate descendant marker');
  return Object.freeze({
    nonce: randomBytes(24).toString('hex'),
    fd: 3,
    descendantMarker,
  });
}

export function gatedNodeArguments(title, args){
  assert.match(title, /^[A-Za-z0-9:_-]{8,220}$/, 'gated process title');
  assert.ok(Array.isArray(args), 'gated Node args');
  assert.equal(args.length, 3, 'gated Node dispatcher argv length');
  assert.equal(args[0], '--', 'gated Node dispatcher option terminator');
  assert.equal(args[1], PHASE_NODE_COMMAND_PATH, 'gated Node dispatcher path');
  assert.match(args[2] || '', /^[A-Za-z0-9_-]{1,32768}$/,
    'gated Node canonical command payload');
  decodePhaseNodeCommand(args[2]);
  return [`--title=${title}`, '--import', TRUSTED_GATE_MODULE_URL, ...args];
}

export function gatedChildEnvironment(environment, gate){
  assert.match(gate?.nonce || '', /^[0-9a-f]{48}$/, 'spawn gate nonce');
  assert.equal(gate.fd, 3, 'spawn gate fd');
  const inheritedNodeOptions = environment.NODE_OPTIONS || '';
  assert.ok(inheritedNodeOptions === '' || inheritedNodeOptions === TRUSTED_DESCENDANT_NODE_OPTION,
    'gated child refuses inherited NODE_OPTIONS executable authority');
  const sanitized = {
    ...environment,
    PLAYFORGE_INTERNAL_SPAWN_GATE_FD: String(gate.fd),
    PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE: gate.nonce,
    PLAYFORGE_INTERNAL_DESCENDANT_MARKER: gate.descendantMarker,
  };
  delete sanitized.NODE_OPTIONS;
  registerFreshSpawnGateCapability(gate);
  return sanitized;
}

export function captureGatedProcessIdentitySync(pid, options){
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid, 'gated child PID');
  const deadline = Date.now() + 500;
  let lastError = null;
  while(Date.now() <= deadline){
    const snapshot = captureProcessTableSnapshotSync();
    const record = snapshot.find(candidate => candidate.pid === pid);
    if(!record){
      const liveness = probeProcessIdentity(pid);
      if(liveness.state === 'PROVEN_DEAD'){
        const error = new Error(`gated PID ${pid} exited before exact snapshot capture`);
        error.identityState = 'PROVEN_DEAD';
        throw error;
      }
      lastError = new Error(`gated PID ${pid} was omitted from a nonempty required-self snapshot`);
    } else {
      try {
        const identity = bindProcessSnapshotIdentity(snapshot, record, options);
        recordCapturedGatedProcess(identity);
        return identity;
      }
      catch(error){
        if(error?.identityState === 'PROVEN_DEAD') throw error;
        lastError = error;
      }
    }
    Atomics.wait(CAPTURE_PAUSE, 0, 0, 5);
  }
  const error = new Error(`gated PID ${pid} exact snapshot identity did not stabilize: ${lastError?.message || 'unknown'}`, {
    cause: lastError || undefined,
  });
  error.identityState = 'UNKNOWN';
  throw error;
}

export async function releasePhaseSpawnGate(child, gate){
  assert.equal(child?.stdio?.[gate.fd]?.writable, true, 'spawn gate pipe is not writable');
  assertCapturedBeforeGateRelease(child, gate);
  const stream = child.stdio[gate.fd];
  const payload = `GO ${gate.nonce}\n`;
  await new Promise((resolve, reject) => {
    const onError = error => reject(new Error(`spawn gate write failed: ${error.message}`, { cause: error }));
    stream.once('error', onError);
    stream.end(payload, 'utf8', () => {
      stream.removeListener('error', onError);
      resolve();
    });
  });
  stream.destroy();
  stream.unref?.();
}

export function abortPhaseSpawnGate(child, gate){
  revokeSpawnGateCapability(gate, child);
  const stream = child?.stdio?.[gate?.fd];
  if(!stream) return;
  stream.destroy();
  stream.unref?.();
}
