import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { link, lstat, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { probeProcessIdentity } from './runner.phase4.lock.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const MARKER = /^playforge-release-[A-Za-z0-9_-]{16,180}$/;
const NONCE = /^[0-9a-f]{48}$/;

function inside(parent, candidate){
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative);
}

function exactKeys(value, expected, label){
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has missing or extra keys`);
}

function validateHashes(candidateFresh){
  exactKeys(candidateFresh, ['runner', 'golf'], 'candidate handoff candidateFresh');
  assert.match(candidateFresh.runner, SHA256, 'candidate handoff Runner SHA-256');
  assert.match(candidateFresh.golf, SHA256, 'candidate handoff Golf SHA-256');
  return { runner: candidateFresh.runner, golf: candidateFresh.golf };
}

async function fsyncDirectory(directory){
  const handle = await open(directory, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

function fsyncDirectorySync(directory){
  const descriptor = openSync(directory, 'r');
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function commitDecisionPaths(handoffPath, nonce){
  const base = path.resolve(handoffPath);
  return {
    decisionPath: `${base}.commit-gate`,
    grantCandidatePath: `${base}.grant-${nonce}`,
    revokeCandidatePath: `${base}.revoke-${nonce}`,
    readyPath: `${base}.ready`,
    readyCandidatePath: `${base}.ready-${nonce}`,
  };
}

function decisionContents(nonce, decision){
  assert.match(nonce, NONCE, 'commit decision nonce');
  assert.ok(decision === 'COMMIT_GRANTED' || decision === 'REVOKED', 'commit decision kind');
  return `PLAYFORGE_PHASE4_COMMIT_GATE 1 ${nonce} ${decision}\n`;
}

function readyContents(nonce, phase4Pid, phase4ProcessStart){
  assert.match(nonce, NONCE, 'commit READY nonce');
  assert.ok(Number.isSafeInteger(phase4Pid) && phase4Pid > 0, 'commit READY Phase 4 PID');
  assert.equal(typeof phase4ProcessStart, 'string', 'commit READY Phase 4 process start');
  assert.ok(phase4ProcessStart.length > 0 && phase4ProcessStart.length <= 200,
    'commit READY Phase 4 process start length');
  return `${JSON.stringify({
    version: 1,
    nonce,
    phase4Pid,
    phase4ProcessStart,
  })}\n`;
}

function readReadyIdentitySync(readyPath, nonce){
  const payload = JSON.parse(readFileSync(readyPath, 'utf8'));
  exactKeys(payload, ['version', 'nonce', 'phase4Pid', 'phase4ProcessStart'], 'commit READY');
  assert.equal(payload.version, 1, 'commit READY version');
  assert.equal(payload.nonce, nonce, 'commit READY nonce mismatch');
  // Reusing the serializer centralizes the strict PID/start validation.
  assert.equal(readFileSync(readyPath, 'utf8'),
    readyContents(payload.nonce, payload.phase4Pid, payload.phase4ProcessStart),
    'commit READY serialization changed');
  return {
    phase4Pid: payload.phase4Pid,
    phase4ProcessStart: payload.phase4ProcessStart,
  };
}

function prepareDecisionCandidateSync({ handoffPath, tempRoot, nonce, decision }){
  const paths = commitDecisionPaths(handoffPath, nonce);
  const candidatePath = decision === 'COMMIT_GRANTED' ? paths.grantCandidatePath : paths.revokeCandidatePath;
  assert.equal(inside(tempRoot, candidatePath), true, 'commit decision candidate escaped Phase 4 TMPDIR');
  let descriptor;
  try { descriptor = openSync(candidatePath, 'wx', 0o600); }
  catch(error){
    if(error?.code === 'EEXIST'
      && readFileSync(candidatePath, 'utf8') === decisionContents(nonce, decision)) return paths;
    throw error;
  }
  try {
    chmodSync(candidatePath, 0o600);
    writeFileSync(descriptor, decisionContents(nonce, decision));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectorySync(path.dirname(candidatePath));
  return paths;
}

function publishDecisionSync({ handoffPath, tempRoot, nonce, decision, prepare }){
  const paths = commitDecisionPaths(handoffPath, nonce);
  const candidatePath = decision === 'COMMIT_GRANTED' ? paths.grantCandidatePath : paths.revokeCandidatePath;
  assert.equal(inside(tempRoot, paths.decisionPath), true, 'commit decision escaped Phase 4 TMPDIR');
  if(prepare) prepareDecisionCandidateSync({ handoffPath, tempRoot, nonce, decision });
  assert.equal(readFileSync(candidatePath, 'utf8'), decisionContents(nonce, decision),
    `${decision} decision candidate changed`);
  try {
    linkSync(candidatePath, paths.decisionPath);
    fsyncDirectorySync(path.dirname(paths.decisionPath));
  } catch(error){
    if(error?.code !== 'EEXIST') throw error;
  }
  const published = readFileSync(paths.decisionPath, 'utf8');
  if(published === decisionContents(nonce, 'COMMIT_GRANTED')) return { decision: 'COMMIT_GRANTED', ...paths };
  if(published === decisionContents(nonce, 'REVOKED')) return { decision: 'REVOKED', ...paths };
  throw new Error('commit decision publication is malformed or not bound to this release');
}

export function prepareCommitGateCandidatesSync({ handoffPath, tempRoot, nonce }){
  const paths = prepareDecisionCandidateSync({
    handoffPath, tempRoot, nonce, decision: 'COMMIT_GRANTED',
  });
  prepareDecisionCandidateSync({ handoffPath, tempRoot, nonce, decision: 'REVOKED' });
  return paths;
}

export function publishCommitGrantSync({ handoffPath, tempRoot, nonce }){
  return publishDecisionSync({
    handoffPath,
    tempRoot,
    nonce,
    decision: 'COMMIT_GRANTED',
    prepare: false,
  });
}

export function publishCommitRevokeSync({ handoffPath, tempRoot, nonce }){
  return publishDecisionSync({ handoffPath, tempRoot, nonce, decision: 'REVOKED', prepare: false });
}

export function publishCommitReadySync(authorization, tempRoot){
  const paths = commitDecisionPaths(authorization.handoffPath, authorization.nonce);
  assert.equal(inside(tempRoot, paths.readyPath), true, 'commit READY escaped Phase 4 TMPDIR');
  assertCandidateAuthorizationLive(authorization);
  const identity = probeProcessIdentity(process.pid);
  assert.equal(identity?.state, 'LIVE', 'Phase 4 READY publisher is not provably live');
  const contents = readyContents(authorization.nonce, process.pid, identity.processStart);
  const descriptor = openSync(paths.readyCandidatePath, 'wx', 0o600);
  try {
    chmodSync(paths.readyCandidatePath, 0o600);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  linkSync(paths.readyCandidatePath, paths.readyPath);
  fsyncDirectorySync(path.dirname(paths.readyPath));
  return paths;
}

export function readCommitCoordinationStateSync(authorization, tempRoot){
  const paths = commitDecisionPaths(authorization.handoffPath, authorization.nonce);
  assert.equal(inside(tempRoot, paths.decisionPath), true, 'commit coordination escaped Phase 4 TMPDIR');
  let decision = 'OPEN';
  try {
    const contents = readFileSync(paths.decisionPath, 'utf8');
    if(contents === decisionContents(authorization.nonce, 'COMMIT_GRANTED')) decision = 'COMMIT_GRANTED';
    else if(contents === decisionContents(authorization.nonce, 'REVOKED')) decision = 'REVOKED';
    else throw new Error('commit coordination decision is malformed');
  } catch(error){ if(error?.code !== 'ENOENT') throw error; }
  let ready = false;
  let readyIdentity = null;
  try {
    readyIdentity = readReadyIdentitySync(paths.readyPath, authorization.nonce);
    ready = true;
  } catch(error){ if(error?.code !== 'ENOENT') throw error; }
  return { decision, ready, readyIdentity, ...paths };
}

export function assertCandidateAuthorizationLive(
  authorization,
  processProbe = probeProcessIdentity,
){
  assert.ok(authorization && typeof authorization === 'object', 'candidate authorization is required');
  const current = processProbe(authorization.outerPid);
  assert.equal(current?.state, 'LIVE', 'candidate-authorizing outer release is not provably live');
  assert.equal(current.processStart, authorization.outerProcessStart,
    'candidate-authorizing outer release process identity changed');
  return authorization;
}

export async function createCandidateHandoff({
  handoffPath,
  tempRoot,
  outerMarker,
  candidateFresh,
  processProbe = probeProcessIdentity,
}){
  const resolvedPath = path.resolve(handoffPath);
  assert.equal(inside(tempRoot, resolvedPath), true, 'candidate handoff must be inside its phase temp root');
  assert.match(outerMarker, MARKER, 'candidate handoff outer marker');
  const hashes = validateHashes(candidateFresh);
  const outer = processProbe(process.pid);
  assert.equal(outer?.state, 'LIVE', 'cannot prove outer release process is live');
  assert.equal(typeof outer.processStart, 'string', 'cannot establish outer release process start identity');
  const nonce = randomBytes(24).toString('hex');
  const payload = {
    version: 1,
    outerMarker,
    outerPid: process.pid,
    outerProcessStart: outer.processStart,
    nonce,
    createdAt: Date.now(),
    candidateFresh: hashes,
  };
  const pending = `${resolvedPath}.pending-${process.pid}-${nonce}`;
  let handle = null;
  try {
    try {
      await lstat(resolvedPath);
      throw new Error('candidate handoff target already exists');
    } catch(error){
      if(error?.code !== 'ENOENT') throw error;
    }
    handle = await open(pending, 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(payload)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await link(pending, resolvedPath);
    await fsyncDirectory(path.dirname(resolvedPath));
    await unlink(pending);
    await fsyncDirectory(path.dirname(resolvedPath));
    return payload;
  } catch(error){
    if(handle) await handle.close().catch(() => {});
    await unlink(pending).catch(() => {});
    throw error;
  }
}

export async function consumeCandidateHandoff({
  handoffPath,
  tempRoot,
  expectedOuterMarker,
  now = Date.now(),
  maxAgeMs = 300_000,
  processProbe = probeProcessIdentity,
}){
  assert.equal(typeof handoffPath, 'string', 'live outer candidate handoff path is required');
  const resolvedPath = path.resolve(handoffPath);
  assert.equal(inside(tempRoot, resolvedPath), true, 'candidate handoff escaped the active Phase 4 TMPDIR');
  assert.match(expectedOuterMarker || '', MARKER, 'live outer release marker is required');
  assert.ok(Number.isSafeInteger(now) && now > 0, 'candidate handoff validation time');
  assert.ok(Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0, 'candidate handoff maximum age');

  let handle;
  try {
    handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch(error){
    throw new Error(`candidate handoff is unavailable: ${error.message}`, { cause: error });
  }
  try {
    const status = await handle.stat({ bigint: true });
    assert.equal(status.isFile(), true, 'candidate handoff must be a regular file');
    assert.equal(status.mode & 0o777n, 0o600n, 'candidate handoff mode must be exactly 0600');
    assert.equal(status.nlink, 1n, 'candidate handoff must have exactly one link');
    if(typeof process.getuid === 'function') assert.equal(status.uid, BigInt(process.getuid()), 'candidate handoff owner');
    assert.ok(status.size > 0n && status.size <= 8_192n, 'candidate handoff size');
    const pathStatus = await lstat(resolvedPath, { bigint: true });
    assert.equal(pathStatus.isSymbolicLink(), false, 'candidate handoff must not be a symlink');
    assert.equal(pathStatus.dev, status.dev, 'candidate handoff device changed during validation');
    assert.equal(pathStatus.ino, status.ino, 'candidate handoff inode changed during validation');
    const payload = JSON.parse((await handle.readFile()).toString('utf8'));
    exactKeys(payload, [
      'version', 'outerMarker', 'outerPid', 'outerProcessStart', 'nonce', 'createdAt', 'candidateFresh',
    ], 'candidate handoff');
    assert.equal(payload.version, 1, 'candidate handoff version');
    assert.equal(payload.outerMarker, expectedOuterMarker, 'candidate handoff outer marker mismatch');
    assert.ok(Number.isSafeInteger(payload.outerPid) && payload.outerPid > 0, 'candidate handoff outer PID');
    assert.equal(typeof payload.outerProcessStart, 'string', 'candidate handoff outer process start');
    assert.ok(payload.outerProcessStart.length > 0 && payload.outerProcessStart.length <= 200,
      'candidate handoff outer process start length');
    assert.match(payload.nonce, NONCE, 'candidate handoff nonce');
    assert.ok(Number.isSafeInteger(payload.createdAt), 'candidate handoff createdAt');
    assert.ok(payload.createdAt <= now + 5_000, 'candidate handoff was created in the future');
    assert.ok(payload.createdAt >= now - maxAgeMs, 'candidate handoff is stale');
    const hashes = validateHashes(payload.candidateFresh);
    const authorization = {
      outerMarker: payload.outerMarker,
      outerPid: payload.outerPid,
      outerProcessStart: payload.outerProcessStart,
      nonce: payload.nonce,
      createdAt: payload.createdAt,
      candidateFresh: hashes,
      handoffPath: resolvedPath,
      ...commitDecisionPaths(resolvedPath, payload.nonce),
    };
    assertCandidateAuthorizationLive(authorization, processProbe);
    await unlink(resolvedPath);
    await fsyncDirectory(path.dirname(resolvedPath));
    return authorization;
  } finally {
    await handle.close();
  }
}
