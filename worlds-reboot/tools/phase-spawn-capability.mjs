import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TRUSTED_GATE_MODULE_URL = pathToFileURL(
  fileURLToPath(new URL('./phase-spawn-gate.mjs', import.meta.url)),
).href;
export const TRUSTED_DESCENDANT_MODULE_URL = pathToFileURL(
  fileURLToPath(new URL('./phase-descendant-marker.mjs', import.meta.url)),
).href;
export const TRUSTED_DESCENDANT_NODE_OPTION = `--import=${TRUSTED_DESCENDANT_MODULE_URL}`;

const FRESH_CAPABILITY_MS = 30_000;
const capabilities = new Map();
const capturedProcesses = new Map();

function assertGateShape(gate){
  assert.match(gate?.nonce || '', /^[0-9a-f]{48}$/, 'spawn gate nonce');
  assert.equal(gate.fd, 3, 'spawn gate fd');
  assert.match(gate.descendantMarker || '', /^[A-Za-z0-9:_-]{8,220}$/,
    'spawn gate descendant marker');
}

function pruneExpired(now = Date.now()){
  for(const [nonce, entry] of capabilities){
    if(now - entry.createdAt > FRESH_CAPABILITY_MS) capabilities.delete(nonce);
  }
}

export function registerFreshSpawnGateCapability(gate){
  assertGateShape(gate);
  pruneExpired();
  assert.equal(capabilities.has(gate.nonce), false, 'spawn gate capability was already registered');
  capabilities.set(gate.nonce, {
    nonce: gate.nonce,
    fd: gate.fd,
    descendantMarker: gate.descendantMarker,
    createdAt: Date.now(),
    state: 'REGISTERED',
    token: null,
    pid: null,
  });
}

export function beginFreshSpawnGateLaunch({ nonce, fd, descendantMarker, commandPayload }){
  pruneExpired();
  const entry = capabilities.get(nonce);
  assert.ok(entry, 'detached gated Node launch lacks a fresh registered capability');
  assert.equal(entry.state, 'REGISTERED', 'spawn gate capability is not fresh');
  assert.equal(fd, entry.fd, 'detached gated Node launch changed gate fd');
  assert.equal(descendantMarker, entry.descendantMarker,
    'detached gated Node launch changed descendant marker');
  const token = Object.freeze({
    nonce,
    commandPayload,
    generation: Symbol('phase-spawn-gate-launch'),
  });
  entry.state = 'LAUNCHING';
  entry.token = token;
  return token;
}

export function completeFreshSpawnGateLaunch(token, pid){
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'detached gated Node PID');
  const entry = capabilities.get(token?.nonce);
  assert.equal(entry?.state, 'LAUNCHING', 'spawn gate launch was not pending');
  assert.equal(entry.token, token, 'spawn gate launch token mismatch');
  entry.state = 'LAUNCHED';
  entry.pid = pid;
  entry.token = null;
}

export function assertFreshSpawnGateLaunchToken(token, {
  nonce,
  fd,
  descendantMarker,
  commandPayload,
}){
  const entry = capabilities.get(nonce);
  assert.equal(entry?.state, 'LAUNCHING', 'spawn gate launch token is not pending');
  assert.equal(entry.token, token, 'spawn gate launch token mismatch');
  assert.equal(entry.fd, fd, 'spawn gate launch token fd mismatch');
  assert.equal(entry.descendantMarker, descendantMarker,
    'spawn gate launch token marker mismatch');
  assert.equal(token.commandPayload, commandPayload,
    'spawn gate launch token command payload mismatch');
}

export function cancelFreshSpawnGateLaunch(token){
  const entry = capabilities.get(token?.nonce);
  if(entry?.state !== 'LAUNCHING' || entry.token !== token) return;
  capabilities.delete(token.nonce);
}

export function recordCapturedGatedProcess(identity){
  assert.ok(Number.isSafeInteger(identity?.pid) && identity.pid > 0, 'captured gated process PID');
  capturedProcesses.set(identity.pid, identity);
}

export function assertCapturedBeforeGateRelease(child, gate){
  assertGateShape(gate);
  assert.equal(child?.pid > 0, true, 'spawn gate child PID');
  pruneExpired();
  const entry = capabilities.get(gate.nonce);
  assert.ok(entry, 'spawn gate release lacks a fresh capability');
  assert.ok(entry.state === 'REGISTERED' || entry.state === 'LAUNCHED',
    `spawn gate release has invalid capability state ${entry.state}`);
  if(entry.state === 'LAUNCHED'){
    assert.equal(entry.pid, child.pid, 'spawn gate release child differs from launched child');
  }
  const captured = capturedProcesses.get(child.pid);
  assert.ok(captured, 'spawn gate GO requires exact identity capture before release');
  assert.equal(captured.pid, child.pid, 'spawn gate captured PID mismatch');
  capabilities.delete(gate.nonce);
  capturedProcesses.delete(child.pid);
}

export function revokeSpawnGateCapability(gate, child = null){
  if(gate?.nonce) capabilities.delete(gate.nonce);
  if(Number.isSafeInteger(child?.pid) && child.pid > 0) capturedProcesses.delete(child.pid);
}
