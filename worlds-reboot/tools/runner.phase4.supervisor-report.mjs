import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const SHA256 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{48}$/;

function inside(parent, candidate){
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative);
}

function fsyncDirectorySync(directory){
  const descriptor = openSync(directory, 'r');
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function exactKeys(value, expected, label){
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has missing or extra keys`);
}

export function validatePhase4SupervisorReport(report, {
  expectedTransactionId,
  expectedDecisionNonce,
  expectedCandidateFresh,
  expectedState = null,
} = {}){
  exactKeys(report, [
    'version', 'transactionId', 'decisionNonce', 'state', 'candidateFresh',
    'parentBuildInputs', 'baselineOld', 'validatedArtifacts', 'installedNetworkParity',
  ], 'Phase 4 supervisor report');
  assert.equal(report.version, 1, 'Phase 4 supervisor report version');
  assert.match(report.transactionId, /^[A-Za-z0-9_-]{8,160}$/,
    'Phase 4 supervisor report transaction id');
  assert.match(report.decisionNonce, NONCE, 'Phase 4 supervisor report decision nonce');
  assert.ok(report.state === 'READY' || report.state === 'ACKED_NEW',
    'Phase 4 supervisor report state');
  if(expectedTransactionId !== undefined){
    assert.equal(report.transactionId, expectedTransactionId,
      'Phase 4 supervisor report transaction mismatch');
  }
  if(expectedDecisionNonce !== undefined){
    assert.equal(report.decisionNonce, expectedDecisionNonce,
      'Phase 4 supervisor report decision nonce mismatch');
  }
  if(expectedState !== null) assert.equal(report.state, expectedState, 'Phase 4 supervisor report state mismatch');
  exactKeys(report.candidateFresh, ['runner', 'golf'], 'Phase 4 supervisor candidateFresh');
  for(const world of ['runner', 'golf']){
    assert.match(report.candidateFresh[world], SHA256, `Phase 4 supervisor ${world} candidate hash`);
    if(expectedCandidateFresh){
      assert.equal(report.candidateFresh[world], expectedCandidateFresh[world],
        `Phase 4 supervisor ${world} candidate chain mismatch`);
    }
  }
  assert.equal(report.parentBuildInputs?.version, 1, 'Phase 4 supervisor build-input manifest version');
  assert.ok(Array.isArray(report.parentBuildInputs.files), 'Phase 4 supervisor build-input files');
  assert.equal(report.baselineOld?.skipped, false, 'Phase 4 supervisor baseline must be authoritative');
  assert.ok(Array.isArray(report.validatedArtifacts?.shots), 'Phase 4 supervisor screenshot manifest');
  assert.equal(report.validatedArtifacts.shots.length, 12, 'Phase 4 supervisor screenshot count');
  assert.ok(report.validatedArtifacts.frameBoard, 'Phase 4 supervisor frame board');
  assert.ok(report.installedNetworkParity && typeof report.installedNetworkParity === 'object',
    'Phase 4 supervisor installed network parity');
  return report;
}

export function writePhase4SupervisorReportSync({ reportPath, tempRoot, report }){
  const resolved = path.resolve(reportPath);
  assert.equal(inside(tempRoot, resolved), true, 'Phase 4 supervisor report escaped TMPDIR');
  validatePhase4SupervisorReport(report);
  const pending = `${resolved}.pending-${process.pid}`;
  rmSync(pending, { force: true });
  let descriptor;
  try {
    descriptor = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    chmodSync(pending, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(report)}\n`);
    fsyncSync(descriptor);
  } finally {
    if(descriptor !== undefined) closeSync(descriptor);
  }
  renameSync(pending, resolved);
  fsyncDirectorySync(path.dirname(resolved));
  return resolved;
}

export function readPhase4SupervisorReportSync({ reportPath, tempRoot, expected }){
  const resolved = path.resolve(reportPath);
  assert.equal(inside(tempRoot, resolved), true, 'Phase 4 supervisor report escaped TMPDIR');
  const status = lstatSync(resolved, { bigint: true });
  assert.equal(status.isFile(), true, 'Phase 4 supervisor report must be a regular file');
  assert.equal(status.isSymbolicLink(), false, 'Phase 4 supervisor report must not be a symlink');
  assert.equal(status.mode & 0o777n, 0o600n, 'Phase 4 supervisor report mode must be 0600');
  assert.equal(status.nlink, 1n, 'Phase 4 supervisor report must have one link');
  assert.ok(status.size > 0n && status.size <= 2_000_000n, 'Phase 4 supervisor report size');
  return validatePhase4SupervisorReport(JSON.parse(readFileSync(resolved, 'utf8')), expected);
}
