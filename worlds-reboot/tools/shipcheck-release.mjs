/* Bounded, ordered Playforge release gate with explicit process ownership. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentityHandleScope } from './active-handle-scope.mjs';
import {
  bindProcessSnapshotIdentity,
  captureProcessTableSnapshotSync,
  exactProcessSnapshotIdentityState,
  processSnapshotDescendantClosure,
  processSnapshotCommandUnavailable,
  processSnapshotMarkerMatches,
  removeExactDeadPhase4Claims,
} from './runner.phase4.lock.mjs';
import {
  advanceArgsUnavailableGrace,
  advanceProvisionalOwnedSnapshotIdentity,
  captureProvisionalOwnedSnapshotIdentity,
  exactDirectChildIdentityState,
  inspectCapturedProcessGroup,
  provisionalProcessSnapshotIdentityState,
  replaceProvenDeadOwnedSnapshotIdentity,
  signalCapturedProcessGroup,
  signalExactIdentitySet,
} from './phase-process-cleanup.mjs';
import { finalizeCapturedGatedProcessGroup } from './phase-group-finalizer.mjs';
import {
  createCandidateHandoff,
  prepareCommitGateCandidatesSync,
  publishCommitGrantSync,
  publishCommitRevokeSync,
  readCommitCoordinationStateSync,
} from './runner.phase4.handoff.mjs';
import { assertPhase4InputManifestUnchangedSync } from './runner.phase4.frozen.mjs';
import {
  PHASE4_SHOT_NAMES,
  PHASE4_SHOT_VIEWPORTS,
  validateBaselineOldReport,
  validateStrictParityReport,
} from './runner.phase4.promotion.mjs';
import { readPhase4SupervisorReportSync } from './runner.phase4.supervisor-report.mjs';
import {
  assertPinnedRuntimeUnchangedSync,
  capturePinnedRuntimeSync,
} from './pinned-runtime.mjs';
import {
  abortPhaseSpawnGate,
  captureGatedProcessIdentitySync,
  createPhaseSpawnGate,
  gatedChildEnvironment,
  releasePhaseSpawnGate,
} from './phase-spawn-gate-parent.mjs';
import {
  RECOVERY_ANCESTOR_MARKER_ENV,
  acknowledgeCapturedGatedSentinelIfAlone,
  capturedGatedTargetResult,
  createCapturedSentinelProtocol,
  gatedNodeCommandArguments,
} from './phase-isolated-node.mjs';

if(process.platform === 'win32'){
  throw new Error('Playforge release verification requires POSIX process-group isolation; win32 is unsupported');
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inside = (parent, candidate) => {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const inheritedPhase4Controls = Object.keys(process.env)
  .filter(name => name.startsWith('RUNNER_PHASE4_'))
  .sort();
if(inheritedPhase4Controls.length){
  throw new Error(`release preflight refuses inherited Phase 4 controls: ${inheritedPhase4Controls.join(', ')}`);
}
const pinnedRuntime = capturePinnedRuntimeSync();
const rawTimeout = process.env.PLAYFORGE_RELEASE_TIMEOUT_MS;
const timeoutMs = rawTimeout === undefined || rawTimeout === '' ? 900_000 : Number(rawTimeout);
if(!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0){
  throw new RangeError('PLAYFORGE_RELEASE_TIMEOUT_MS must be a positive integer');
}
const injectDetachedMarker = process.env.PLAYFORGE_RELEASE_INJECT_DETACHED_MARKER === '1';
const injectToolchainProbe = process.env.PLAYFORGE_RELEASE_INJECT_TOOLCHAIN_PROBE === '1';
if(process.env.PLAYFORGE_RELEASE_INJECT_TOOLCHAIN_PROBE !== undefined && !injectToolchainProbe){
  throw new Error('PLAYFORGE_RELEASE_INJECT_TOOLCHAIN_PROBE must be exactly 1');
}
const recoveryFastExit = process.env.PLAYFORGE_RELEASE_INJECT_RECOVERY_FAST_EXIT ?? null;
if(recoveryFastExit !== null
  && (!injectToolchainProbe || !['0', '1'].includes(recoveryFastExit))){
  throw new Error('recovery fast-exit injection requires hostile-toolchain fixture and exit 0|1');
}
const transactionCrashPoint = process.env.PLAYFORGE_RELEASE_INJECT_TRANSACTION_CRASH || null;
const readyFixtureName = process.env.PLAYFORGE_RELEASE_INJECT_READY_FIXTURE || null;
const transactionConfigPath = process.env.PLAYFORGE_RELEASE_TRANSACTION_CONFIG
  ? path.resolve(process.env.PLAYFORGE_RELEASE_TRANSACTION_CONFIG) : null;
const transactionRecoveryRoot = process.env.PLAYFORGE_RELEASE_TEST_RECOVERY_ROOT
  ? path.resolve(process.env.PLAYFORGE_RELEASE_TEST_RECOVERY_ROOT) : null;
const markerOverride = process.env.PLAYFORGE_RELEASE_RUN_MARKER;
const transactionCrashFixture = transactionCrashPoint !== null;
const terminalClassificationFixture = readyFixtureName === 'sandbox-hang-after-final-ack';
const samplerFailureFixture = readyFixtureName === 'sandbox-sampler-scan-failure';
const sandboxReadyFixture = [
  'sandbox-hang-after-final-ack',
  'sandbox-hang-after-revoke',
  'sandbox-mutate-input-before-grant',
  'sandbox-sampler-scan-failure',
].includes(readyFixtureName);
const fixtureMode = injectDetachedMarker
  ? 'detached-marker'
  : injectToolchainProbe ? 'hostile-toolchain'
  : transactionCrashFixture ? `transaction-${transactionCrashPoint}`
    : readyFixtureName ? `ready-${readyFixtureName}` : null;
const forceFixtureSuccess = process.env.PLAYFORGE_RELEASE_FIXTURE_FORCE_SUCCESS === '1';
if(forceFixtureSuccess && !fixtureMode){
  throw new Error('fixture success control requires an explicit release fixture');
}
if([injectDetachedMarker, injectToolchainProbe, transactionCrashFixture, readyFixtureName !== null]
  .filter(Boolean).length > 1){
  throw new Error('release negative fixtures are mutually exclusive');
}
if(markerOverride && !fixtureMode){
  throw new Error('PLAYFORGE_RELEASE_RUN_MARKER is test-only and requires an explicit release fixture');
}
if(fixtureMode
  && !/^playforge-release-negative-[A-Za-z0-9_-]{24,120}$/.test(markerOverride || '')){
  throw new RangeError('release fixture requires a strong playforge-release-negative-* marker');
}
if(readyFixtureName !== null
  && ![
    'sampled-unmarked-detached',
    'exit-zero-after-grant',
    'sandbox-hang-after-final-ack',
    'sandbox-hang-after-revoke',
    'sandbox-mutate-input-before-grant',
    'sandbox-sampler-scan-failure',
  ].includes(readyFixtureName)){
  throw new Error('unknown outer READY fixture');
}
if(readyFixtureName && forceFixtureSuccess){
  throw new Error('READY fixture does not support forced success');
}
if(transactionCrashFixture || sandboxReadyFixture){
  if(transactionCrashFixture
    && !['mid-install', 'commit-intent', 'final-commit-ack'].includes(transactionCrashPoint)){
    throw new Error('unknown outer transaction crash fixture');
  }
  if(!transactionConfigPath || !transactionRecoveryRoot){
    throw new Error('outer transaction crash fixture requires config and recovery root');
  }
  assert.equal(inside(path.resolve(tmpdir()), transactionRecoveryRoot), true,
    'sandbox transaction fixture recovery root must be inside the system temporary directory');
  assert.match(path.basename(transactionRecoveryRoot), /^phase4-transaction-playforge-release-negative-/,
    'sandbox transaction fixture recovery root must use its strong marker prefix');
  assert.equal(inside(transactionRecoveryRoot, transactionConfigPath), true,
    'outer transaction fixture config must be inside its recovery root');
  assert.ok(path.basename(transactionRecoveryRoot).includes(markerOverride),
    'outer transaction fixture root must be bound to its exact marker');
}
const marker = markerOverride
  || `playforge-release-${process.pid}-${Date.now().toString(36)}-${randomBytes(12).toString('hex')}`;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const PHASE4_RELEASE_CLAIMS = path.join(ROOT, 'runner', '.phase4-release-claims');
const PHASE4_HARNESS = path.join(ROOT, 'tools', 'shipcheck-phase4.mjs');
const TRANSACTION_CRASH_HARNESS = path.join(ROOT, 'tools', 'runner.phase4.transaction-crash.fixture.mjs');
const READY_FIXTURE_HARNESS = path.join(ROOT, 'tools', 'runner.phase4.ready.fixture.mjs');
const FAST_RECOVERY_FIXTURE = path.join(ROOT, 'tools', 'phase-fast-recovery.fixture.mjs');
const DETACHED_MARKER_FIXTURE = path.join(ROOT, 'tools', 'release-detached-marker.fixture.mjs');
const SUCCESS_FIXTURE = path.join(ROOT, 'tools', 'phase-success.fixture.mjs');
const FOUNDATION_UNIT = path.join(ROOT, 'tools', 'foundation.unit.test.mjs');
const FOUNDATION_BROWSER = path.join(ROOT, 'tools', 'foundation.browser.mjs');
const POST_BROWSER = path.join(ROOT, 'tools', 'post.browser.mjs');
const POST_WATCHDOG = path.join(ROOT, 'tools', 'post.browser.watchdog.test.mjs');
const GOLF_PHASE2 = path.join(ROOT, 'tools', 'golf.phase2.mjs');
const RUNNER_PHASE3 = path.join(ROOT, 'tools', 'shipcheck-runner.mjs');
const PHASE4_PROCESS_SNAPSHOT = path.join(ROOT, 'tools', 'runner.phase4.process-snapshot.test.mjs');
const PHASE4_SPAWN_GATE = path.join(ROOT, 'tools', 'phase-spawn-gate.test.mjs');
const PHASE_GROUP_FINALIZER = path.join(ROOT, 'tools', 'phase-group-finalizer.test.mjs');
const PHASE_MARKER_PROCESSES = path.join(ROOT, 'tools', 'phase-marker-processes.test.mjs');
const BROWSER_CONTAINMENT = path.join(ROOT, 'tools', 'browser-containment.test.mjs');
const PHASE_ISOLATED_INTEGRATION = path.join(ROOT, 'tools', 'phase-isolated-node.integration.test.mjs');
const PHASE4_WATCHDOG = path.join(ROOT, 'tools', 'runner.phase4.watchdog.test.mjs');
const PHASE4_RECOVERY_TIMEOUT_MS = 15_000;
const PROCESS_ARGS_UNAVAILABLE_GRACE_MS = 250;
const rawAckCompletionTimeout = process.env.PLAYFORGE_RELEASE_ACK_COMPLETION_TIMEOUT_MS;
if(rawAckCompletionTimeout !== undefined && !readyFixtureName){
  throw new Error('ACK completion timeout override is valid only for an explicit READY fixture');
}
const PHASE4_ACK_COMPLETION_TIMEOUT_MS = rawAckCompletionTimeout === undefined
  ? 30_000 : Number(rawAckCompletionTimeout);
if(!Number.isSafeInteger(PHASE4_ACK_COMPLETION_TIMEOUT_MS)
  || PHASE4_ACK_COMPLETION_TIMEOUT_MS < 100 || PHASE4_ACK_COMPLETION_TIMEOUT_MS > 30_000){
  throw new RangeError('PLAYFORGE_RELEASE_ACK_COMPLETION_TIMEOUT_MS must be 100..30000');
}
const PHASE4_ACK_MINIMUM_MARGIN_MS = 5_000;
const injectedSamplerFailure = process.env.PLAYFORGE_RELEASE_INJECT_SAMPLER_FAILURE || null;
if(injectedSamplerFailure !== null
  && (!samplerFailureFixture || !['timeout', 'malformed'].includes(injectedSamplerFailure))){
  throw new Error('sampler failure injection requires sandbox-sampler-scan-failure and timeout|malformed');
}
const rawRecoveryProofFailure = process.env.PLAYFORGE_RELEASE_INJECT_RECOVERY_PROOF_FAILURE;
const injectRecoveryProofFailure = rawRecoveryProofFailure === '1';
if(rawRecoveryProofFailure !== undefined && !injectRecoveryProofFailure){
  throw new Error('PLAYFORGE_RELEASE_INJECT_RECOVERY_PROOF_FAILURE must be exactly 1');
}
if(injectRecoveryProofFailure && !samplerFailureFixture){
  throw new Error('recovery proof failure injection requires sandbox-sampler-scan-failure');
}
const RECOVERY_PROJECT_ROOT = transactionRecoveryRoot || ROOT;
let samplerFailureArmed = false;
let recoveryProofFailureArmed = false;

const normalPhases = Object.freeze([
  Object.freeze({ name: 'foundation-unit', args: ['--test', FOUNDATION_UNIT], commandMarker: FOUNDATION_UNIT }),
  Object.freeze({ name: 'foundation-browser', args: [FOUNDATION_BROWSER], commandMarker: FOUNDATION_BROWSER }),
  Object.freeze({ name: 'post-browser-direct', args: [POST_BROWSER], commandMarker: POST_BROWSER }),
  Object.freeze({
    name: 'post-browser-watchdog-negative',
    args: ['--test', '--test-timeout=30000', POST_WATCHDOG],
    commandMarker: POST_WATCHDOG,
  }),
  Object.freeze({
    name: 'golf-phase2-candidate',
    args: [GOLF_PHASE2, '--candidate'],
    commandMarker: GOLF_PHASE2,
    candidateWorld: 'golf',
  }),
  Object.freeze({
    name: 'runner-phase3-candidate',
    args: [RUNNER_PHASE3, '--candidate'],
    commandMarker: RUNNER_PHASE3,
    candidateWorld: 'runner',
  }),
  Object.freeze({
    name: 'runner-phase4-watchdog-negative',
    args: [
      '--test',
      '--test-concurrency=1',
      '--test-timeout=300000',
      PHASE_GROUP_FINALIZER,
      PHASE_MARKER_PROCESSES,
      BROWSER_CONTAINMENT,
      PHASE4_PROCESS_SNAPSHOT,
      PHASE4_SPAWN_GATE,
      PHASE_ISOLATED_INTEGRATION,
      PHASE4_WATCHDOG,
    ],
    commandMarker: PHASE4_WATCHDOG,
  }),
  Object.freeze({
    name: 'runner-phase4',
    args: [PHASE4_HARNESS, '--release'],
    commandMarker: PHASE4_HARNESS,
    consumesCandidates: true,
  }),
]);
const phases = injectDetachedMarker
  ? [Object.freeze({
    name: 'detached-marker-fixture',
    args: [DETACHED_MARKER_FIXTURE, marker],
    commandMarker: marker,
  })]
  : injectToolchainProbe
    ? [Object.freeze({
      name: 'hostile-toolchain-foundation-fixture',
      args: ['--test', FOUNDATION_UNIT],
      commandMarker: FOUNDATION_UNIT,
    })]
  : readyFixtureName
    ? [Object.freeze({
      name: `ready-${readyFixtureName}-fixture`,
      args: [READY_FIXTURE_HARNESS, readyFixtureName],
      commandMarker: READY_FIXTURE_HARNESS,
      consumesCandidates: true,
    })]
  : transactionCrashFixture
    ? [Object.freeze({
      name: `transaction-${transactionCrashPoint}-fixture`,
      args: forceFixtureSuccess
        ? [SUCCESS_FIXTURE]
        : [TRANSACTION_CRASH_HARNESS, transactionConfigPath],
      commandMarker: forceFixtureSuccess ? SUCCESS_FIXTURE : TRANSACTION_CRASH_HARNESS,
    })]
    : normalPhases;

async function ownedTreeEntries(root){
  const found = [];
  async function visit(current){
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch(error){
      if(error?.code === 'ENOENT') return;
      throw error;
    }
    for(const entry of entries){
      const absolute = path.join(current, entry.name);
      found.push({
        path: path.relative(root, absolute),
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
      });
      if(entry.isDirectory()) await visit(absolute);
    }
  }
  await visit(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function exactKeys(value, expected, label){
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has missing or extra keys`);
}

async function consumeCandidateReport(reportPath, expectedWorld){
  let report;
  try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
  catch(error){ throw new Error(`${expectedWorld} candidate report is unreadable: ${error.message}`, { cause: error }); }
  exactKeys(report, ['version', 'mode', 'releaseEligible', 'world', 'candidateFresh', 'result'], `${expectedWorld} candidate report`);
  assert.equal(report.version, 1, `${expectedWorld} candidate report version`);
  assert.equal(report.mode, 'candidate', `${expectedWorld} candidate mode`);
  assert.equal(report.releaseEligible, false, `${expectedWorld} candidate mode must be noneligible`);
  assert.equal(report.world, expectedWorld, `${expectedWorld} candidate world`);
  exactKeys(report.candidateFresh, ['sha256'], `${expectedWorld} candidateFresh`);
  assert.match(report.candidateFresh.sha256, /^[0-9a-f]{64}$/, `${expectedWorld} candidate SHA-256`);
  assert.equal(report.result?.ok, true, `${expectedWorld} candidate gameplay result`);
  assert.equal(report.result?.mode, 'candidate', `${expectedWorld} candidate result mode`);
  assert.equal(report.result?.releaseEligible, false, `${expectedWorld} candidate result eligibility`);
  assert.equal(report.result?.freshArtifactSha256, report.candidateFresh.sha256,
    `${expectedWorld} candidate result hash mismatch`);
  await rm(reportPath, { force: false });
  return report.candidateFresh.sha256;
}

function readHttpTotal(url, label, milliseconds = 15_000){
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const finish = (error, value) => {
      if(settled) return;
      settled = true;
      clearTimeout(deadline);
      if(error) reject(error); else resolve(value);
    };
    const request = httpGet(url, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if(bytes > 50 * 1024 * 1024){
          request.destroy(new Error(`${label} exceeded maximum response size`));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', error => finish(error));
      response.once('end', () => {
        if(response.statusCode !== 200){
          finish(new Error(`${label} returned HTTP ${response.statusCode}`));
          return;
        }
        finish(null, Buffer.concat(chunks));
      });
    });
    request.once('error', error => finish(error));
    request.setTimeout(Math.min(10_000, milliseconds), () => {
      request.destroy(new Error(`${label} socket timeout`));
    });
    deadline = setTimeout(() => request.destroy(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
  });
}

function parityUrl(origin, pathname, phase){
  const url = new URL(pathname, origin);
  url.searchParams.set('playforgeRelease', `${phase}-${marker}`);
  return url.href;
}

async function validateAuthorizedCommittedGeneration(report, projectRoot = ROOT){
  assertPhase4InputManifestUnchangedSync(projectRoot, report.parentBuildInputs,
    'outer terminal Phase 4 build inputs');
  validateStrictParityReport(report.installedNetworkParity, report.candidateFresh);
  assert.deepEqual(report.validatedArtifacts.worlds, report.candidateFresh,
    'terminal validated world hashes differ from candidate chain');
  const runner = path.join(projectRoot, 'runner');
  const golf = path.join(projectRoot, 'golf');
  const parity = { skipped: false };
  const localhost = process.env.PLAYFORGE_LOCALHOST_ORIGIN || 'http://127.0.0.1:8091';
  const lan = process.env.PLAYFORGE_LAN_ORIGIN || 'http://192.168.1.137:8091';
  for(const row of [
    {
      world: 'runner', pathname: '/runner/gridlock-run-v1.html',
      dist: path.join(runner, 'dist', 'index.html'), standalone: path.join(runner, 'gridlock-run-v1.html'),
    },
    {
      world: 'golf', pathname: '/golf/stackyard-golf-v1.html',
      dist: path.join(golf, 'dist', 'index.html'), standalone: path.join(golf, 'stackyard-golf-v1.html'),
    },
  ]){
    parity[row.world] = {
      fresh: report.candidateFresh[row.world],
      dist: sha256(await readFile(row.dist)),
      standalone: sha256(await readFile(row.standalone)),
      localhost: sha256(await readHttpTotal(
        parityUrl(localhost, row.pathname, 'terminal-localhost'), `${row.world} terminal localhost parity`,
      )),
      lan: sha256(await readHttpTotal(
        parityUrl(lan, row.pathname, 'terminal-lan'), `${row.world} terminal LAN parity`,
      )),
    };
  }
  validateStrictParityReport(parity, report.candidateFresh);

  const expectedShots = Object.keys(PHASE4_SHOT_VIEWPORTS).flatMap(viewport => (
    PHASE4_SHOT_NAMES.map(name => `phase4-shots/${viewport}/${name}.png`)
  )).sort();
  const observedShots = report.validatedArtifacts.shots
    .map(row => String(row.relativePath).split(path.sep).join('/')).sort();
  assert.deepEqual(observedShots, expectedShots, 'terminal screenshot report set');
  for(const row of report.validatedArtifacts.shots){
    const relative = String(row.relativePath).split(path.sep).join('/');
    assert.ok(expectedShots.includes(relative), `terminal screenshot path ${relative}`);
    assert.equal(sha256(await readFile(path.join(runner, relative))), row.sha256,
      `terminal screenshot changed: ${relative}`);
  }
  assert.equal(report.validatedArtifacts.frameBoard.relativePath, 'gridlock-run-v1-frames.png',
    'terminal frame-board path');
  assert.equal(sha256(await readFile(path.join(runner, 'gridlock-run-v1-frames.png'))),
    report.validatedArtifacts.frameBoard.sha256, 'terminal frame-board changed');
  return { classification: 'ACKED_NEW', parity };
}

/**
 * Every outer ownership scan crosses this one nonthrowing boundary.
 * A scanner failure is evidence of UNKNOWN ownership, never evidence of death.
 */
function safeScan(label, operation){
  try {
    if(recoveryProofFailureArmed){
      throw new Error('injected recovery proof snapshot failure');
    }
    if(samplerFailureArmed && injectedSamplerFailure){
      const detail = injectedSamplerFailure === 'timeout'
        ? 'timed out after its pinned deadline'
        : 'returned a malformed process row';
      throw new Error(`injected persistent ${injectedSamplerFailure} scanner failure: ${detail}`);
    }
    const identities = operation();
    assert.ok(Array.isArray(identities), `${label} did not return an identity array`);
    return { ok: true, identities, error: null };
  } catch(cause){
    return {
      ok: false,
      identities: [],
      error: new Error(`${label} is UNKNOWN: ${cause.message}`, { cause }),
    };
  }
}

const safeProcessSnapshot = () => safeScan(
  'release atomic process-table snapshot',
  () => captureProcessTableSnapshotSync(),
);

const rememberedGroupSets = new WeakMap();
const rememberedGroups = remembered => {
  let groups = rememberedGroupSets.get(remembered);
  if(!groups){
    groups = new Map();
    rememberedGroupSets.set(remembered, groups);
  }
  // Exact leader identities may also have arrived through a proven PID-reuse
  // replacement path, so resynchronize from the authoritative identity Map.
  for(const identity of remembered.values()){
    if(identity.pgid === identity.pid) groups.set(identity.pgid, identity);
  }
  return groups;
};

function rememberIdentity(identity, remembered){
  if(!identity) return;
  const existing = remembered.get(identity.pid);
  if(existing){
    assert.equal(existing.processStart, identity.processStart,
      `PID ${identity.pid} was reused while still in the owned identity set`);
    assert.equal(existing.pgid, identity.pgid,
      `PID ${identity.pid} changed process group while still owned`);
    assert.equal(existing.ucomm, identity.ucomm,
      `PID ${identity.pid} changed ucomm while still owned`);
    assert.equal(existing.command, identity.command,
      `PID ${identity.pid} changed command while still owned`);
    if(existing.pgid === existing.pid) rememberedGroups(remembered).set(existing.pgid, existing);
    return;
  }
  remembered.set(identity.pid, identity);
  if(identity.pgid === identity.pid) rememberedGroups(remembered).set(identity.pgid, identity);
}

const rememberedPidSet = remembered => new Set(remembered.keys());
const provisionalIdentitySets = new WeakMap();
const provisionalIdentities = remembered => {
  let provisional = provisionalIdentitySets.get(remembered);
  if(!provisional){
    provisional = new Map();
    provisionalIdentitySets.set(remembered, provisional);
  }
  return provisional;
};

function provisionalIdentityError(identity, state){
  return new Error(
    `owned provisional PID ${identity.pid} is UNKNOWN: ${state.reason || 'unknown'}`
    + ` (captured=${JSON.stringify(identity.command)}, observed=${JSON.stringify(state.record?.command || null)})`,
  );
}

const provisionalGraceExpired = entry => (
  Date.now() - entry.startedAt >= PROCESS_ARGS_UNAVAILABLE_GRACE_MS
);

function refreshProvisionalIdentities(snapshot, remembered){
  const provisionalPendingErrors = [];
  const hardErrors = [];
  const provisional = provisionalIdentities(remembered);
  for(const [pid, entry] of provisional){
    const state = advanceProvisionalOwnedSnapshotIdentity(
      remembered,
      provisional,
      snapshot,
      pid,
    );
    if(state.state === 'PROVEN_DEAD'){
      // Shared transition already removed dead provisional authority.
    } else if(state.state === 'LIVE'){
      // Shared transition already promoted the full-command identity.
    } else {
      const error = provisionalIdentityError(entry.identity, state);
      if(state.reason === 'args-unavailable' && !provisionalGraceExpired(entry)){
        provisionalPendingErrors.push(error);
      }
      else hardErrors.push(error);
    }
  }
  return { provisionalPendingErrors, hardErrors };
}

/**
 * A discovery row for an already-owned PID is only an observation of that
 * bound identity.  In particular, Darwin's transient `(ucomm)` argv fallback
 * must never be rebound as a new command identity.
 */
function rememberSnapshotRecord(snapshot, record, remembered, {
  provenance,
  bindingOptions = {},
} = {}){
  const provisional = provisionalIdentities(remembered);
  const existing = remembered.get(record.pid);
  if(existing){
    const state = exactProcessSnapshotIdentityState(existing, { snapshot });
    if(state.state === 'LIVE'){
      return { argsUnavailablePending: false, provisionalPending: false, error: null };
    }
    if(state.state === 'PROVEN_DEAD'){
      if(state.reason === 'pid-reused'){
        if(processSnapshotCommandUnavailable(record)){
          captureProvisionalOwnedSnapshotIdentity(
            remembered,
            provisional,
            snapshot,
            record,
            {
            provenance,
              bindingOptions,
            },
          );
          return { argsUnavailablePending: false, provisionalPending: true,
            error: provisionalIdentityError(record, { reason: 'args-unavailable', record }) };
        }
        replaceProvenDeadOwnedSnapshotIdentity(remembered, snapshot, record, {
          provenance,
          bindingOptions,
        });
      }
      return { argsUnavailablePending: false, provisionalPending: false, error: null };
    }
    const error = new Error(
      `owned PID ${existing.pid} identity is UNKNOWN during rediscovery: ${state.reason || 'unknown'}`
      + ` (captured=${JSON.stringify(existing.command)}, observed=${JSON.stringify(state.record?.command || null)})`,
    );
    return {
      argsUnavailablePending: state.reason === 'args-unavailable',
      provisionalPending: false,
      error,
    };
  }
  const provisionalEntry = provisional.get(record.pid);
  if(provisionalEntry){
    const state = advanceProvisionalOwnedSnapshotIdentity(
      remembered,
      provisional,
      snapshot,
      record.pid,
    );
    if(state.state === 'LIVE'){
      return { argsUnavailablePending: false, provisionalPending: false, error: null };
    }
    if(state.state === 'PROVEN_DEAD'){
      return { argsUnavailablePending: false, provisionalPending: false, error: null };
    }
    return {
      argsUnavailablePending: false,
      provisionalPending: state.reason === 'args-unavailable'
        && !provisionalGraceExpired(provisionalEntry),
      error: provisionalIdentityError(provisionalEntry.identity, state),
    };
  }
  if(processSnapshotCommandUnavailable(record)){
    captureProvisionalOwnedSnapshotIdentity(
      remembered,
      provisional,
      snapshot,
      record,
      { provenance, bindingOptions },
    );
    return {
      argsUnavailablePending: false,
      provisionalPending: true,
      error: provisionalIdentityError(record, {
        reason: 'args-unavailable',
        record,
      }),
    };
  }
  rememberIdentity(bindProcessSnapshotIdentity(snapshot, record, bindingOptions), remembered);
  return { argsUnavailablePending: false, provisionalPending: false, error: null };
}

function rememberOwned(childIdentity, remembered, { child = null } = {}){
  const hardErrors = [];
  const pendingErrors = [];
  const provisionalPendingErrors = [];
  let markerIdentities = [];
  const scanned = safeProcessSnapshot();
  if(!scanned.ok) hardErrors.push(scanned.error);
  const snapshot = scanned.ok ? scanned.identities : null;
  if(snapshot){
    const provisional = refreshProvisionalIdentities(snapshot, remembered);
    provisionalPendingErrors.push(...provisional.provisionalPendingErrors);
    hardErrors.push(...provisional.hardErrors);
  }
  if(childIdentity){
    try { rememberIdentity(childIdentity, remembered); }
    catch(error){ hardErrors.push(error); }
    if(snapshot){
      const childState = exactDirectChildIdentityState(childIdentity, child, { snapshot });
      if(childState.state === 'UNKNOWN'){
        const error = new Error(
          `owned child identity became unknowable: ${childState.reason || 'unknown'}`
          + ` (captured=${JSON.stringify(childIdentity.command)}, observed=${JSON.stringify(childState.record?.command || null)},`
          + ` state=${JSON.stringify(childState.record?.state || null)})`,
        );
        if(childState.reason === 'args-unavailable') pendingErrors.push(error);
        else hardErrors.push(error);
      } else if(childState.state === 'LIVE'){
        let descendants = [];
        try {
          descendants = processSnapshotDescendantClosure(snapshot, childState.record, { includeRoots: false });
        } catch(error){ hardErrors.push(error); }
        for(const record of descendants){
          try {
            const result = rememberSnapshotRecord(snapshot, record, remembered, {
              provenance: { kind: 'descendant', rootRecord: childState.record },
            });
            if(result.error){
              if(result.argsUnavailablePending) pendingErrors.push(result.error);
              else if(result.provisionalPending) provisionalPendingErrors.push(result.error);
              else hardErrors.push(result.error);
            }
          } catch(error){
            if(error?.identityState !== 'PROVEN_DEAD') hardErrors.push(error);
          }
        }
      }
    }
  }
  if(snapshot){
    try {
      markerIdentities = processSnapshotMarkerMatches(snapshot, marker)
        .filter(record => record.pid !== process.pid && !record.state.startsWith('Z'));
    } catch(error){ hardErrors.push(error); }
    for(const record of markerIdentities){
      try {
        const result = rememberSnapshotRecord(snapshot, record, remembered, {
          provenance: { kind: 'marker', marker },
          bindingOptions: { expectedCommandMarker: marker },
        });
        if(result.error){
          if(result.argsUnavailablePending) pendingErrors.push(result.error);
          else if(result.provisionalPending) provisionalPendingErrors.push(result.error);
          else hardErrors.push(result.error);
        }
      } catch(error){
        if(error?.identityState !== 'PROVEN_DEAD') hardErrors.push(error);
      }
    }
  }
  return {
    ok: hardErrors.length === 0 && pendingErrors.length === 0
      && provisionalPendingErrors.length === 0,
    identities: [...remembered.values()],
    markerIdentities,
    snapshot,
    argsUnavailablePending: pendingErrors.length > 0,
    provisionalPending: provisionalPendingErrors.length > 0,
    hardError: hardErrors.length
      ? new AggregateError(hardErrors, 'release ownership scan is UNKNOWN') : null,
    error: (hardErrors.length || pendingErrors.length || provisionalPendingErrors.length)
      ? new AggregateError(
        [...hardErrors, ...pendingErrors, ...provisionalPendingErrors],
        'release ownership scan is UNKNOWN',
      ) : null,
  };
}

function ownedSurvivors(child, childIdentity, remembered){
  const observed = rememberOwned(childIdentity, remembered, { child });
  const errors = observed.hardError ? [observed.hardError] : [];
  let argsUnavailablePending = observed.argsUnavailablePending;
  let provisionalPending = observed.provisionalPending;
  const pids = new Set();
  for(const identity of remembered.values()){
    try {
      const state = observed.snapshot
        ? (childIdentity?.pid === identity.pid
          ? exactDirectChildIdentityState(identity, child, { snapshot: observed.snapshot })
          : exactProcessSnapshotIdentityState(identity, { snapshot: observed.snapshot }))
        : { state: 'UNKNOWN', reason: 'atomic-snapshot-unavailable' };
      if(state.state !== 'PROVEN_DEAD') pids.add(identity.pid);
      if(state.state === 'UNKNOWN'){
        if(childIdentity?.pid === identity.pid && state.reason === 'args-unavailable'){
          argsUnavailablePending = true;
        } else {
          errors.push(new Error(`owned PID ${identity.pid} identity is UNKNOWN: ${state.reason || 'unknown'}`));
        }
      }
    } catch(error){
      pids.add(identity.pid);
      errors.push(error);
    }
  }
  for(const entry of provisionalIdentities(remembered).values()){
    const identity = entry.identity;
    pids.add(identity.pid);
    if(!observed.snapshot){
      errors.push(new Error(
        `owned provisional PID ${identity.pid} is UNKNOWN: atomic-snapshot-unavailable`,
      ));
      continue;
    }
    const state = provisionalProcessSnapshotIdentityState(identity, {
      snapshot: observed.snapshot,
    });
    if(state.state === 'PROVEN_DEAD'){
      pids.delete(identity.pid);
      provisionalIdentities(remembered).delete(identity.pid);
    } else if(state.state === 'UNKNOWN' && state.reason === 'args-unavailable'){
      if(provisionalGraceExpired(entry)) errors.push(provisionalIdentityError(identity, state));
      else provisionalPending = true;
    } else if(state.state !== 'LIVE'){
      errors.push(provisionalIdentityError(identity, state));
    }
  }
  if(process.platform !== 'win32'){
    for(const groupIdentity of rememberedGroups(remembered).values()){
      if(!observed.snapshot){
        pids.add(groupIdentity.pgid);
        errors.push(new Error(
          `owned process-group ${groupIdentity.pgid} is UNKNOWN: atomic-snapshot-unavailable`,
        ));
        continue;
      }
      const priorExactMemberIdentities = [...remembered.values()]
        .filter(identity => identity.pgid === groupIdentity.pgid);
      const group = inspectCapturedProcessGroup(groupIdentity, {
        snapshotProbe: () => observed.snapshot,
        priorExactMemberIdentities,
      });
      if(group.state === 'LIVE') group.memberPids.forEach(pid => pids.add(pid));
      else if(group.state === 'UNKNOWN'){
        if(group.reason === 'leader-args-unavailable'
          && groupIdentity.pid === childIdentity?.pid){
          argsUnavailablePending = true;
          pids.add(groupIdentity.pid);
        } else {
          errors.push(group.error || new Error(
            `owned process-group ${groupIdentity.pgid} is UNKNOWN: ${group.reason || 'unknown'}`,
          ));
        }
      }
    }
  }
  return {
    ok: errors.length === 0 && !argsUnavailablePending && !provisionalPending,
    marker: observed.markerIdentities,
    pids: [...pids],
    argsUnavailablePending,
    provisionalPending,
    error: errors.length ? new AggregateError(errors, 'release survivor proof is UNKNOWN') : null,
  };
}

function childHandleIsRunning(child){
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function signalCapturedChildHandle(child, childIdentity, signal){
  assert.ok(childIdentity, 'captured child identity is required for handle-bound termination');
  if(child) assert.equal(child.pid, childIdentity.pid, 'child handle PID changed before termination');
  if(process.platform !== 'win32' && childIdentity.pgid === childIdentity.pid){
    const result = signalCapturedProcessGroup(childIdentity, signal);
    if(result.state === 'UNKNOWN'){
      if(result.reason === 'leader-args-unavailable') return result;
      throw result.error || new Error(
        `captured process-group ${signal} is UNKNOWN: ${result.reason || 'unknown'}`,
      );
    }
    return result;
  }
  if(childHandleIsRunning(child)){
    child.kill(signal);
    return { signalled: true, state: 'LIVE', memberPids: [childIdentity.pid] };
  }
  return { signalled: false, state: 'PROVEN_DEAD', reason: 'captured-handle-closed' };
}

function signalRememberedExact(remembered, signal, errors, childIdentity = null){
  const result = signalExactIdentitySet(remembered, signal, {
    deferUnknown: (identity, outcome) => identity.pid === childIdentity?.pid
      && outcome.reason === 'args-unavailable',
  });
  errors.push(...result.errors);
  return result;
}

async function terminateOwned(child, childIdentity, remembered){
  const errors = [];
  let argsUnavailableSince = null;
  const observeArgsUnavailable = pending => {
    const grace = advanceArgsUnavailableGrace(argsUnavailableSince, pending, {
      graceMs: PROCESS_ARGS_UNAVAILABLE_GRACE_MS,
    });
    argsUnavailableSince = grace.startedAt;
    return grace.expired;
  };
  if(process.platform === 'win32'){
    if(childHandleIsRunning(child)){
      const result = spawnSync('taskkill', ['/pid', String(childIdentity.pid), '/T', '/F'], {
        stdio: 'ignore', timeout: 5_000,
      });
      if(result.error || result.status !== 0){
        errors.push(result.error || new Error(`taskkill exited ${result.status}`));
      }
    }
  } else {
    // Finalize every retained exact group while its sentinel leader is still
    // available. Per-PID cleanup follows even when one group is UNKNOWN.
    for(const groupIdentity of rememberedGroups(remembered).values()){
      const priorExactMemberIdentities = [...remembered.values()]
        .filter(identity => identity.pgid === groupIdentity.pgid);
      try {
        await finalizeCapturedGatedProcessGroup({
          identity: groupIdentity,
          child: groupIdentity.pid === childIdentity?.pid ? child : null,
        }, {
          label: `release retained process group ${groupIdentity.pgid}`,
          priorExactMemberIdentities,
        });
      } catch(error){ errors.push(error); }
    }
    // The handle and already-captured group are the first teardown authority.
    // No fallible discovery scan is allowed to stand between abort and TERM.
    if(childIdentity){
      try {
        const result = signalCapturedChildHandle(child, childIdentity, 'SIGTERM');
        observeArgsUnavailable(result?.reason === 'leader-args-unavailable');
      }
      catch(error){ errors.push(error); }
    }
    const exactTerm = signalRememberedExact(remembered, 'SIGTERM', errors, childIdentity);
    observeArgsUnavailable(exactTerm.deferred.length > 0 || argsUnavailableSince !== null);
    const termDeadline = Date.now() + 750;
    while(childHandleIsRunning(child) && Date.now() < termDeadline) await sleep(25);
    if(childIdentity){
      try {
        const result = signalCapturedChildHandle(child, childIdentity, 'SIGKILL');
        observeArgsUnavailable(result?.reason === 'leader-args-unavailable' || argsUnavailableSince !== null);
      }
      catch(error){ errors.push(error); }
    }
    const exactKill = signalRememberedExact(remembered, 'SIGKILL', errors, childIdentity);
    observeArgsUnavailable(exactKill.deferred.length > 0 || argsUnavailableSince !== null);
    const killDeadline = Date.now() + 2_000;
    while(childHandleIsRunning(child) && Date.now() < killDeadline) await sleep(25);
    if(childHandleIsRunning(child)){
      errors.push(new Error('captured child handle remained live after bounded TERM/KILL'));
    }
  }
  // Discovery/proof happens only after the handle-bound abort. Its errors are
  // aggregated, and UNKNOWN can therefore never skip teardown or become PASS.
  let survivors = ownedSurvivors(child, childIdentity, remembered);
  observeArgsUnavailable(survivors.argsUnavailablePending);
  if(survivors.error) errors.push(survivors.error);
  if(survivors.marker.length || survivors.pids.length){
    if(!survivors.argsUnavailablePending){
      if(childIdentity){
        try { signalCapturedChildHandle(child, childIdentity, 'SIGKILL'); }
        catch(error){ errors.push(error); }
      }
      signalRememberedExact(remembered, 'SIGKILL', errors, childIdentity);
    }
  }
  const proofDeadline = Date.now() + 500;
  while((survivors.marker.length || survivors.pids.length) && Date.now() < proofDeadline){
    if(survivors.argsUnavailablePending && argsUnavailableSince !== null
      && Date.now() - argsUnavailableSince >= PROCESS_ARGS_UNAVAILABLE_GRACE_MS) break;
    await sleep(25);
    survivors = ownedSurvivors(child, childIdentity, remembered);
    const wasPending = argsUnavailableSince !== null;
    observeArgsUnavailable(survivors.argsUnavailablePending);
    if(survivors.error) errors.push(survivors.error);
    if(wasPending && !survivors.argsUnavailablePending
      && (survivors.marker.length || survivors.pids.length)){
      if(childIdentity){
        try { signalCapturedChildHandle(child, childIdentity, 'SIGKILL'); }
        catch(error){ errors.push(error); }
      }
      signalRememberedExact(remembered, 'SIGKILL', errors, childIdentity);
    }
  }
  if(survivors.argsUnavailablePending){
    errors.push(new Error(
      `owned PID ${childIdentity?.pid ?? 'unknown'} argv remained unavailable past bounded cleanup grace`,
    ));
  }
  return {
    ...survivors,
    ok: errors.length === 0 && survivors.ok,
    error: errors.length ? new AggregateError(errors, 'release bounded process teardown was not fully provable') : null,
  };
}

function releaseChildHandles(child){
  for(const stream of child?.stdio || []){
    stream?.removeAllListeners?.();
    stream?.destroy?.();
    stream?.unref?.();
  }
  child?.removeAllListeners?.();
  child?.unref?.();
}

async function terminateUncapturedChildHandle(child, closePromise){
  if(!child) return;
  if(child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.race([closePromise, sleep(750)]);
  if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.race([closePromise, sleep(2_000)]);
  if(child.exitCode === null && child.signalCode === null){
    throw new Error('uncaptured spawned child did not exit after handle-bound TERM/KILL');
  }
}

async function awaitProvenDeadFastExit(closePromise, label){
  const result = await Promise.race([
    closePromise,
    sleep(2_000).then(() => ({ closeTimedOut: true })),
  ]);
  if(result.closeTimedOut){
    throw new Error(`${label} was proven dead but its bound ChildProcess handle did not close`);
  }
  return result;
}

async function completeCapturedSentinelTarget(owned, label){
  const result = await capturedGatedTargetResult(owned);
  const acknowledgement = await acknowledgeCapturedGatedSentinelIfAlone(owned);
  if(!acknowledgement.acknowledged){
    if(result.code === 0){
      const error = new Error(
        `${label} reported success with a non-sentinel or UNKNOWN captured process group`,
      );
      error.targetResult = result;
      error.acknowledgement = acknowledgement;
      throw error;
    }
    return result;
  }
  if(acknowledgement.final?.state !== 'PROVEN_DEAD'){
    const error = new Error(
      `${label} sentinel ACK lacked final process-group death proof: ${acknowledgement.final?.state || 'UNKNOWN'}`,
    );
    error.targetResult = result;
    error.acknowledgement = acknowledgement;
    throw error;
  }
  return result;
}

function errorSummary(error){
  if(error instanceof AggregateError){
    return `${error.message}: ${error.errors.map(errorSummary).join(' | ')}`;
  }
  return error?.message || String(error);
}

function createCaughtOwnershipSampler(callback, label){
  let timer = null;
  let failure = null;
  let argsUnavailableSince = null;
  let resolveFailure;
  const failurePromise = new Promise(resolve => { resolveFailure = resolve; });
  timer = setInterval(() => {
    if(failure) return;
    try {
      const result = callback();
      if(result?.hardError) throw result.hardError;
      if(result?.argsUnavailablePending){
        const grace = advanceArgsUnavailableGrace(argsUnavailableSince, true, {
          graceMs: PROCESS_ARGS_UNAVAILABLE_GRACE_MS,
        });
        argsUnavailableSince = grace.startedAt;
        if(!grace.expired) return;
        throw result.error || new Error('process argv remained unavailable past bounded sampler grace');
      }
      argsUnavailableSince = advanceArgsUnavailableGrace(argsUnavailableSince, false).startedAt;
      if(result?.provisionalPending) return;
      if(result?.ok === false) throw result.error;
    }
    catch(error){
      failure = new Error(`${label} failed: ${errorSummary(error)}`, { cause: error });
      clearInterval(timer);
      timer = null;
      resolveFailure(failure);
    }
  }, 50);
  return {
    failurePromise,
    get failure(){ return failure; },
    stop(){ if(timer) clearInterval(timer); timer = null; },
  };
}

async function awaitSettledProvisionalOwnership(callback){
  const deadline = Date.now() + PROCESS_ARGS_UNAVAILABLE_GRACE_MS;
  let result = callback();
  while(result?.provisionalPending && !result?.hardError
    && !result?.argsUnavailablePending && Date.now() < deadline){
    await sleep(25);
    result = callback();
  }
  return result;
}

function describeResource(resource){
  return {
    type: resource?.constructor?.name || typeof resource,
    fd: Number.isInteger(resource?.fd) ? resource.fd : Number.isInteger(resource?._handle?.fd) ? resource._handle.fd : null,
    pid: Number.isInteger(resource?.pid) ? resource.pid : null,
  };
}

async function assertNoIntroducedResources(scope){
  const deadline = Date.now() + 3_000;
  let ownership;
  do {
    ownership = scope.classify();
    if(!ownership.handles.length && !ownership.requests.length) return;
    await sleep(25);
  } while(Date.now() < deadline);
  throw new Error(`release supervisor leaked resources: ${JSON.stringify({
    handles: ownership.handles.map(describeResource),
    requests: ownership.requests.map(describeResource),
  })}`);
}

async function assertOnlyExpectedPhase4ChildResources(scope, child){
  const deadline = Date.now() + 3_000;
  let unexpectedHandles;
  let unexpectedRequests;
  do {
    const ownership = scope.classify();
    unexpectedHandles = ownership.handles.filter(handle => (
      handle !== child && handle?.pid !== child?.pid
    ));
    unexpectedRequests = ownership.requests;
    if(!unexpectedHandles.length && !unexpectedRequests.length) return;
    await sleep(25);
  } while(Date.now() < deadline);
  assert.deepEqual(unexpectedHandles.map(describeResource), [],
    'release pre-grant supervisor has unexpected active handles');
  assert.deepEqual(unexpectedRequests.map(describeResource), [],
    'release pre-grant supervisor has unexpected active requests');
}

async function phase4PromotionResidues(projectRoot = ROOT){
  const locations = [
    {
      root: projectRoot,
      matches: name => name === '.phase4-promotion-journal.json'
        || name === '.phase4-promotion-journal.pending.json'
        || name.startsWith('.phase4-backups-')
        || name.startsWith('.phase4-committed-backups-'),
    },
    {
      root: path.join(projectRoot, 'runner'),
      matches: name => name.startsWith('.phase4-shots-stage-')
        || name.startsWith('.gridlock-run-v1-frames-stage-')
        || name.startsWith('.runner-dist-stage-')
        || name.startsWith('.runner-standalone-stage-'),
    },
    {
      root: path.join(projectRoot, 'golf'),
      matches: name => name.startsWith('.golf-dist-stage-')
        || name.startsWith('.golf-standalone-stage-'),
    },
  ];
  const found = [];
  for(const location of locations){
    let entries;
    try { entries = await readdir(location.root, { withFileTypes: true }); }
    catch(error){
      if(error?.code === 'ENOENT') continue;
      throw error;
    }
    for(const entry of entries){
      if(location.matches(entry.name)) found.push(path.join(location.root, entry.name));
    }
  }
  return found.sort();
}

async function runBoundedPhase4Recovery({ tempRoot, remembered, projectRoot = ROOT }){
  const recoveryMarker = `${marker}-recovery`;
  assert.ok(recoveryMarker.length <= 160, 'derived Phase 4 recovery marker is too long');
  const recoveryTempRoot = path.join(tempRoot, 'phase4-recovery');
  await mkdir(recoveryTempRoot, { recursive: false });
  const output = [];
  const stdoutOutput = [];
  let outputBytes = 0;
  const appendOutput = chunk => {
    if(outputBytes >= 1_048_576) return;
    const bounded = Buffer.from(chunk).subarray(0, 1_048_576 - outputBytes);
    output.push(bounded);
    outputBytes += bounded.length;
  };
  let child = null;
  let childIdentity = null;
  let closePromise = null;
  let sampler = null;
  let recoveryTimer = null;
  let fastExitResult = null;
  let spawnGate = null;
  let protocol = null;
  let owned = null;
  let completionPromise = null;
  const errors = [];
  const hygieneErrors = [];
  try {
    const recoveryArguments = recoveryFastExit === null
      ? [PHASE4_HARNESS, '--recover-only', `--test-marker=${recoveryMarker}`]
      : [FAST_RECOVERY_FIXTURE, recoveryMarker, recoveryFastExit];
    if(recoveryFastExit === null && projectRoot !== ROOT){
      recoveryArguments.push(`--test-recovery-root=${projectRoot}`);
    }
    assertPinnedRuntimeUnchangedSync(pinnedRuntime);
    spawnGate = createPhaseSpawnGate(recoveryMarker);
    child = spawn(pinnedRuntime.nodePath, gatedNodeCommandArguments(recoveryMarker, recoveryArguments), {
      cwd: ROOT,
      env: gatedChildEnvironment({
        ...process.env,
        PATH: pinnedRuntime.safePath,
        npm_execpath: pinnedRuntime.npmCliPath,
        npm_node_execpath: pinnedRuntime.nodePath,
        PLAYFORGE_RELEASE_RUN_MARKER: marker,
        [RECOVERY_ANCESTOR_MARKER_ENV]: marker,
        TMPDIR: recoveryTempRoot,
        TMP: recoveryTempRoot,
        TEMP: recoveryTempRoot,
      }, spawnGate),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ipc'],
    });
    protocol = createCapturedSentinelProtocol(child, recoveryArguments);
    protocol.result.catch(() => {});
    activeChild = child;
    closePromise = protocol.closed;
    child.stdout.on('data', chunk => {
      stdoutOutput.push(Buffer.from(chunk));
      appendOutput(chunk);
    });
    child.stderr.on('data', appendOutput);
    try {
      childIdentity = captureGatedProcessIdentitySync(child.pid, {
        expectedCommandMarker: recoveryMarker,
        expectedCommand: recoveryMarker,
        requireOwnProcessGroup: process.platform !== 'win32',
      });
      rememberIdentity(childIdentity, remembered);
      activeChildIdentity = childIdentity;
      owned = Object.freeze({ child, identity: childIdentity, gate: spawnGate, protocol });
    } catch(error){
      abortPhaseSpawnGate(child, spawnGate);
      if(error?.identityState === 'PROVEN_DEAD'){
        fastExitResult = await awaitProvenDeadFastExit(closePromise, 'Phase 4 recovery child');
      } else {
        await terminateUncapturedChildHandle(child, closePromise);
        throw error;
      }
    }
    let timeoutPromise = null;
    if(childIdentity){
      sampler = createCaughtOwnershipSampler(
        () => rememberOwned(childIdentity, remembered, { child }),
        'Phase 4 recovery ownership sampler',
      );
      const preGoOwnership = await awaitSettledProvisionalOwnership(
        () => rememberOwned(childIdentity, remembered, { child }),
      );
      if(!preGoOwnership.ok){
        abortPhaseSpawnGate(child, spawnGate);
        throw preGoOwnership.error;
      }
      await releasePhaseSpawnGate(child, spawnGate);
      completionPromise = completeCapturedSentinelTarget(owned, 'Phase 4 recovery');
      timeoutPromise = new Promise(resolve => {
        recoveryTimer = setTimeout(() => resolve({ timedOut: true }), PHASE4_RECOVERY_TIMEOUT_MS);
      });
    }
    let result = fastExitResult || await Promise.race([
      completionPromise,
      timeoutPromise,
      sampler.failurePromise.then(error => ({ samplerFailure: error })),
    ]);
    if(result.samplerFailure){
      // Recovery itself is the fail-safe rollback path. A discovery scanner
      // failure is recorded and stops sampling, but the exact captured child
      // is allowed to finish inside its existing hard deadline.
      hygieneErrors.push(result.samplerFailure);
      sampler.stop();
      result = await Promise.race([completionPromise, timeoutPromise]);
    }
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    if(result.timedOut){
      const survivors = await terminateOwned(child, childIdentity, remembered);
      if(survivors.error) hygieneErrors.push(survivors.error);
      if(survivors.marker.length || survivors.pids.length){
        errors.push(new Error(`Phase 4 recovery watchdog survivors: ${JSON.stringify(survivors)}`));
      }
      await Promise.race([closePromise, sleep(2_000)]);
      errors.push(new Error(`Phase 4 recovery exceeded ${PHASE4_RECOVERY_TIMEOUT_MS}ms`));
    } else if(result.error){
      errors.push(new Error(`Phase 4 recovery failed to spawn: ${result.error.message}`, { cause: result.error }));
    } else if(result.code !== 0){
      errors.push(new Error(`Phase 4 recovery exited ${result.code}${result.signal ? ` (${result.signal})` : ''}`));
    }
  } finally {
    if(recoveryTimer) clearTimeout(recoveryTimer);
    if(sampler) sampler.stop();
    if(child){
      const survivors = ownedSurvivors(child, childIdentity, remembered);
      if(survivors.error) hygieneErrors.push(survivors.error);
      if(survivors.marker.length || survivors.pids.length){
        const forced = await terminateOwned(child, childIdentity, remembered);
        if(forced.error) hygieneErrors.push(forced.error);
        errors.push(new Error(`Phase 4 recovery left owned processes: ${JSON.stringify(survivors)}`));
        if(forced.marker.length || forced.pids.length){
          errors.push(new Error(`Phase 4 recovery hygiene survivors: ${JSON.stringify(forced)}`));
        }
      }
      releaseChildHandles(child);
      if(activeChild === child) activeChild = null;
      if(activeChildIdentity === childIdentity) activeChildIdentity = null;
    }
    try {
      const claims = await removeExactDeadPhase4Claims({
        claimDirectory: PHASE4_RELEASE_CLAIMS,
        ownedPids: rememberedPidSet(remembered),
      });
      if(claims.length){
        errors.push(new Error(`Phase 4 recovery left owned claims before hygiene: ${JSON.stringify(claims)}`));
      }
    } catch(error){ errors.push(error); }
    try {
      const tempResidues = await ownedTreeEntries(recoveryTempRoot);
      if(tempResidues.length){
        errors.push(new Error(`Phase 4 recovery left temp residue before hygiene: ${JSON.stringify(tempResidues)}`));
      }
      await rm(recoveryTempRoot, { recursive: true, force: true });
    } catch(error){ errors.push(error); }
  }
  const transcript = Buffer.concat(output).toString('utf8');
  if(!errors.length){
    const residues = await phase4PromotionResidues(projectRoot);
    if(residues.length){
      errors.push(new Error(`Phase 4 recovery reported success with promotion residue: ${JSON.stringify(residues)}`));
    }
  }
  if(errors.length){
    const excerpt = transcript.slice(-8_192);
    throw new AggregateError(errors,
      `bounded Phase 4 recovery failed; promotion evidence was preserved: ${errors.map(errorSummary).join(' | ')}`
      + (excerpt ? `\n${excerpt}` : ''));
  }
  let recoveryReport;
  try {
    recoveryReport = JSON.parse(Buffer.concat(stdoutOutput).toString('utf8'));
    exactKeys(recoveryReport,
      recoveryReport.transactionId === undefined
        ? ['recovered', 'action'] : ['recovered', 'action', 'transactionId'],
      'Phase 4 recovery terminal report');
    assert.equal(typeof recoveryReport.recovered, 'boolean', 'Phase 4 recovery report recovered');
    assert.ok(['none', 'discarded-pending-metadata', 'rolled-back', 'finished-commit'].includes(recoveryReport.action),
      'Phase 4 recovery report action');
    if(recoveryReport.transactionId !== undefined){
      assert.match(recoveryReport.transactionId, /^[A-Za-z0-9_-]{8,160}$/,
        'Phase 4 recovery report transaction id');
    }
    if(recoveryFastExit !== null){
      assert.equal(recoveryReport.transactionId, recoveryMarker,
        'fast recovery result was not bound to the exact spawned recovery marker');
    }
  } catch(error){
    throw new Error(`bounded Phase 4 recovery returned an invalid terminal report: ${error.message}`, {
      cause: error,
    });
  }
  console.log('release: RECOVERY Phase 4 transaction resolved');
  return { ...recoveryReport, hygieneErrors };
}

await new Promise(resolve => setImmediate(resolve));
const handleScope = createIdentityHandleScope({ ignoredHandles: [process.stdin, process.stdout, process.stderr] });
const releaseTempRoot = await mkdtemp(path.join(tmpdir(), `${marker}-tmp-`));
const phaseTempRoots = new Set();
let activeChild = null;
let activeChildIdentity = null;
let activePhase = null;
let timedOut = false;
let terminationError = null;
const remembered = new Map();
const candidateHashes = {};
if(readyFixtureName){
  if(sandboxReadyFixture){
    const sandboxConfig = JSON.parse(await readFile(transactionConfigPath, 'utf8'));
    candidateHashes.runner = sandboxConfig.validated.worlds.runner.sha256;
    candidateHashes.golf = sandboxConfig.validated.worlds.golf.sha256;
  } else {
    candidateHashes.runner = '1'.repeat(64);
    candidateHashes.golf = '2'.repeat(64);
  }
}
const completedPhaseNames = [];
let candidateHandoffIssued = false;
let activeCommitDecision = null;
let commitDecisionWon = false;
let commitGrantPublished = false;
let commitDeadlineReached = false;
let commitGraceExpired = false;
let commitGraceTimer = null;
let watchdogTermination = Promise.resolve({ marker: [], pids: [] });
let recoveredAuthorizedCommit = false;
let samplerFailureObserved = false;
const releaseDeadline = Date.now() + timeoutMs;

const beginWatchdogTermination = message => {
  if(timedOut) return;
  timedOut = true;
  process.stderr.write(`${JSON.stringify({
    ok: false, phase: activePhase,
    error: message, marker,
  }, null, 2)}\n`);
  watchdogTermination = terminateOwned(activeChild, activeChildIdentity, remembered)
    .then(result => {
      if(result.error) terminationError = result.error;
      return result;
    })
    .catch(error => {
      terminationError = error;
      return { ok: false, marker: [], pids: [], error };
    });
};

const beginCommitGrace = () => {
  commitDecisionWon = true;
  commitDeadlineReached = true;
  if(commitGraceTimer) return;
  commitGraceTimer = setTimeout(() => {
    commitGraceExpired = true;
    timedOut = true;
    process.stderr.write(`${JSON.stringify({
      ok: false,
      phase: activePhase,
      error: 'Playforge deadline won during bounded COMMIT_GRANTED completion grace',
      marker,
    }, null, 2)}\n`);
    watchdogTermination = terminateOwned(activeChild, activeChildIdentity, remembered)
      .then(result => {
        if(result.error) terminationError = result.error;
        return result;
      })
      .catch(error => {
        terminationError = error;
        return { ok: false, marker: [], pids: [], error };
      });
  }, PHASE4_ACK_COMPLETION_TIMEOUT_MS);
};

const watchdog = setTimeout(() => {
  if(activeCommitDecision){
    try {
      const outcome = publishCommitRevokeSync(activeCommitDecision);
      if(outcome.decision === 'COMMIT_GRANTED'){
        // COMMIT_GRANTED only grants a bounded grace window. The child still
        // holds exact OLD until its guarded durable FINAL_COMMIT_ACK journal.
        beginCommitGrace();
        return;
      }
    } catch(error){
      terminationError = error;
    }
  }
  beginWatchdogTermination(`Playforge release gate exceeded outer watchdog (${timeoutMs}ms)`);
}, timeoutMs);

async function runPhase(phase, index){
  activePhase = phase.name;
  console.log(`release: START ${phase.name}`);
  const phaseTempRoot = path.join(releaseTempRoot, `${String(index + 1).padStart(2, '0')}-${phase.name}`);
  await mkdir(phaseTempRoot, { recursive: false });
  if(timedOut) throw new Error(`release timeout cancelled ${phase.name} during temp setup`);
  phaseTempRoots.add(phaseTempRoot);
  assert.ok(Array.isArray(phase.args) && phase.args.length > 0,
    `release phase ${phase.name} must declare a direct pinned-Node invocation`);
  const args = phase.args;
  const command = assertPinnedRuntimeUnchangedSync(pinnedRuntime).nodePath;
  const candidateReportPath = phase.candidateWorld
    ? path.join(phaseTempRoot, `${phase.candidateWorld}-candidate-report.json`) : null;
  const candidateHandoffPath = phase.consumesCandidates
    ? path.join(phaseTempRoot, 'phase4-candidate-handoff.json') : null;
  const supervisorReportPath = phase.consumesCandidates
    ? path.join(phaseTempRoot, 'phase4-supervisor-report.json') : null;
  let commitDecision = null;
  let supervisorReport = null;
  if(phase.consumesCandidates){
    assert.match(candidateHashes.runner || '', /^[0-9a-f]{64}$/, 'Runner candidate hash missing before Phase 4');
    assert.match(candidateHashes.golf || '', /^[0-9a-f]{64}$/, 'Golf candidate hash missing before Phase 4');
    const handoff = await createCandidateHandoff({
      handoffPath: candidateHandoffPath,
      tempRoot: phaseTempRoot,
      outerMarker: marker,
      candidateFresh: candidateHashes,
    });
    if(timedOut){
      await rm(candidateHandoffPath, { force: true });
      throw new Error('release timeout cancelled Phase 4 during candidate handoff setup');
    }
    const paths = prepareCommitGateCandidatesSync({
      handoffPath: candidateHandoffPath,
      tempRoot: phaseTempRoot,
      nonce: handoff.nonce,
    });
    commitDecision = {
      handoffPath: candidateHandoffPath,
      tempRoot: phaseTempRoot,
      nonce: handoff.nonce,
      ...paths,
    };
    activeCommitDecision = commitDecision;
    candidateHandoffIssued = true;
  }
  if(timedOut) throw new Error(`release timeout cancelled ${phase.name} before spawn`);
  const childTitle = `${marker}:${phase.name}`;
  const spawnGate = createPhaseSpawnGate(childTitle);
  const child = spawn(command, gatedNodeCommandArguments(childTitle, args), {
    cwd: ROOT,
    env: gatedChildEnvironment({
      ...process.env,
      PATH: pinnedRuntime.safePath,
      npm_execpath: pinnedRuntime.npmCliPath,
      npm_node_execpath: pinnedRuntime.nodePath,
      PLAYFORGE_RELEASE_RUN_MARKER: marker,
      [RECOVERY_ANCESTOR_MARKER_ENV]: marker,
      TMPDIR: phaseTempRoot,
      TMP: phaseTempRoot,
      TEMP: phaseTempRoot,
      ...(candidateReportPath ? { PLAYFORGE_CANDIDATE_REPORT_PATH: candidateReportPath } : {}),
      ...(candidateHandoffPath ? { PLAYFORGE_CANDIDATE_HANDOFF_PATH: candidateHandoffPath } : {}),
      ...(supervisorReportPath ? { PLAYFORGE_PHASE4_SUPERVISOR_REPORT_PATH: supervisorReportPath } : {}),
    }, spawnGate),
    detached: process.platform !== 'win32',
    stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'ipc'],
  });
  const protocol = createCapturedSentinelProtocol(child, args);
  protocol.result.catch(() => {});
  activeChild = child;
  const closePromise = protocol.closed;
  let childIdentity = null;
  let fastExitResult = null;
  let owned = null;
  let completionPromise = null;
  try {
    childIdentity = captureGatedProcessIdentitySync(child.pid, {
      expectedCommandMarker: marker,
      expectedCommand: childTitle,
      requireOwnProcessGroup: process.platform !== 'win32',
    });
    rememberIdentity(childIdentity, remembered);
    activeChildIdentity = childIdentity;
    owned = Object.freeze({ child, identity: childIdentity, gate: spawnGate, protocol });
  } catch(error){
    abortPhaseSpawnGate(child, spawnGate);
    if(error?.identityState === 'PROVEN_DEAD'){
      fastExitResult = await awaitProvenDeadFastExit(closePromise, `release phase ${phase.name}`);
    } else {
    let cleanupError = null;
    try { await terminateUncapturedChildHandle(child, closePromise); }
    catch(caught){ cleanupError = caught; }
    if(commitDecision){
      try { publishCommitRevokeSync(commitDecision); }
      catch(caught){ cleanupError = cleanupError ? new AggregateError([cleanupError, caught]) : caught; }
    }
    if(activeChild === child) activeChild = null;
    releaseChildHandles(child);
    throw cleanupError
      ? new AggregateError([error, cleanupError], `release phase ${phase.name} identity capture and cleanup failed`)
      : error;
    }
  }
  const sampler = createCaughtOwnershipSampler(
    () => rememberOwned(childIdentity, remembered, { child }),
    `release phase ${phase.name} ownership sampler`,
  );
  let result;
  let decisionOutcome = null;
  let phaseError = null;
  try {
    if(childIdentity){
      await releasePhaseSpawnGate(child, spawnGate);
      completionPromise = completeCapturedSentinelTarget(
        owned,
        `release phase ${phase.name}`,
      );
    }
    else assert.ok(fastExitResult, 'uncaptured gated phase lacks a proven-dead close result');
    if(!commitDecision){
      const observed = fastExitResult
        ? { closed: true, value: fastExitResult }
        : await Promise.race([
          completionPromise.then(value => ({ closed: true, value })),
          sampler.failurePromise.then(error => ({ samplerFailure: error })),
        ]);
      if(observed.samplerFailure) throw observed.samplerFailure;
      result = observed.value;
    } else {
      let grantPublished = false;
      while(!result){
        const observed = fastExitResult
          ? { closed: true, value: fastExitResult }
          : await Promise.race([
            completionPromise.then(value => ({ closed: true, value })),
            sampler.failurePromise.then(error => ({ samplerFailure: error })),
            sleep(20).then(() => ({ poll: true })),
          ]);
        if(observed.samplerFailure) throw observed.samplerFailure;
        if(observed.closed){
          result = observed.value;
          break;
        }
        const coordination = readCommitCoordinationStateSync(commitDecision, phaseTempRoot);
        if(!coordination.ready || coordination.decision !== 'OPEN') continue;
        if(samplerFailureFixture && !samplerFailureArmed){
          samplerFailureArmed = true;
          const injected = await Promise.race([
            sampler.failurePromise.then(error => ({ error })),
            sleep(1_000).then(() => ({ timedOut: true })),
          ]);
          if(injected.timedOut){
            throw new Error('injected ownership sampler failure did not fire after READY');
          }
          samplerFailureObserved = true;
          throw injected.error;
        }

        supervisorReport = readPhase4SupervisorReportSync({
          reportPath: supervisorReportPath,
          tempRoot: phaseTempRoot,
          expected: {
            expectedTransactionId: marker,
            expectedDecisionNonce: commitDecision.nonce,
            expectedCandidateFresh: candidateHashes,
            expectedState: 'READY',
          },
        });

        const readyOwnership = await awaitSettledProvisionalOwnership(
          () => rememberOwned(childIdentity, remembered, { child }),
        );
        if(!readyOwnership.ok) throw readyOwnership.error;
        const dispatcherState = exactProcessSnapshotIdentityState(childIdentity, {
          snapshot: readyOwnership.snapshot,
        });
        assert.equal(dispatcherState?.state, 'LIVE',
          'Phase 4 READY dispatcher is not provably live');
        const phase4Pid = coordination.readyIdentity?.phase4Pid;
        const phase4Identity = remembered.get(phase4Pid);
        assert.ok(phase4Identity,
          'Phase 4 READY publisher was not exactly captured as a dispatcher descendant');
        assert.equal(phase4Identity.pgid, childIdentity.pgid,
          'Phase 4 READY publisher escaped the captured dispatcher group');
        assert.equal(coordination.readyIdentity?.phase4ProcessStart, phase4Identity.processStart,
          'Phase 4 READY publisher process identity changed');
        const phase4State = exactProcessSnapshotIdentityState(phase4Identity, {
          snapshot: readyOwnership.snapshot,
        });
        assert.equal(phase4State?.state, 'LIVE',
          'Phase 4 READY publisher is not provably live');
        const dispatcherDescendants = processSnapshotDescendantClosure(
          readyOwnership.snapshot,
          dispatcherState.record,
          { includeRoots: false },
        );
        assert.deepEqual(dispatcherDescendants.map(record => record.pid), [phase4Pid],
          'Phase 4 READY dispatcher retained an unexpected target topology');
        const readyDescendants = processSnapshotDescendantClosure(
          readyOwnership.snapshot,
          phase4State.record,
          { includeRoots: false },
        );
        assert.deepEqual(readyDescendants, [],
          'Phase 4 READY publisher retained unexpected descendants');
        const allowedReadyPids = new Set([childIdentity.pid, phase4Pid]);
        const capturedExtras = [...remembered.values()]
          .filter(captured => !allowedReadyPids.has(captured.pid))
          .map(captured => ({
            pid: captured.pid,
            ...exactProcessSnapshotIdentityState(captured, { snapshot: readyOwnership.snapshot }),
          }))
          .filter(entry => entry.state !== 'PROVEN_DEAD');
        assert.deepEqual(capturedExtras, [],
          'Phase 4 READY retained a LIVE/UNKNOWN previously sampled detached process');
        assert.deepEqual(readyOwnership.markerIdentities.filter(item => !allowedReadyPids.has(item.pid)), [],
          'Phase 4 READY retained unexpected marker processes');
        const expectedReadyResidue = [
          commitDecision.grantCandidatePath,
          commitDecision.revokeCandidatePath,
          commitDecision.readyCandidatePath,
          commitDecision.readyPath,
          supervisorReportPath,
        ].map(file => ({
          path: path.relative(phaseTempRoot, file),
          type: 'file',
        })).sort((a, b) => a.path.localeCompare(b.path));
        assert.deepEqual(await ownedTreeEntries(phaseTempRoot), expectedReadyResidue,
          'Phase 4 READY boundary had unregistered temp residue');
        await assertOnlyExpectedPhase4ChildResources(handleScope, child);

        // All yielding hygiene is complete. Re-read the atomic gate and wall
        // clock before the one no-yield link that grants finalization.
        const finalCoordination = readCommitCoordinationStateSync(commitDecision, phaseTempRoot);
        if(finalCoordination.decision !== 'OPEN') continue;
        if(timedOut || commitDeadlineReached
          || Date.now() > releaseDeadline - PHASE4_ACK_MINIMUM_MARGIN_MS){
          decisionOutcome = publishCommitRevokeSync(commitDecision);
          commitDeadlineReached = true;
          continue;
        }
        decisionOutcome = publishCommitGrantSync(commitDecision);
        assert.equal(decisionOutcome.decision, 'COMMIT_GRANTED',
          'outer release failed to win COMMIT_GRANTED before its deadline');
        grantPublished = true;
        commitDecisionWon = true;
        commitGrantPublished = true;
        clearTimeout(watchdog);

        let completionTimer;
        const completion = await Promise.race([
          completionPromise.then(value => ({ closed: true, value })),
          sampler.failurePromise.then(error => ({ samplerFailure: error })),
          new Promise(resolve => {
            completionTimer = setTimeout(() => resolve({ timedOut: true }),
              PHASE4_ACK_COMPLETION_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(completionTimer);
        if(completion.samplerFailure) throw completion.samplerFailure;
        if(completion.timedOut){
          commitGraceExpired = true;
          timedOut = true;
          watchdogTermination = terminateOwned(child, childIdentity, remembered)
            .then(termination => {
              if(termination.error) terminationError = termination.error;
              return termination;
            })
            .catch(error => {
              terminationError = error;
              return { ok: false, marker: [], pids: [], error };
            });
          await watchdogTermination;
          result = await Promise.race([
            closePromise,
            sleep(2_000).then(() => ({ code: null, signal: 'POST_GRANT_TIMEOUT' })),
          ]);
        } else {
          result = completion.value;
        }
      }
      if(!grantPublished && !decisionOutcome){
        decisionOutcome = publishCommitRevokeSync(commitDecision);
      }
    }
    if(result?.error) throw new Error(`release phase ${phase.name} failed to spawn: ${result.error.message}`, {
      cause: result.error,
    });
  } catch(error){
    phaseError = error;
    if(commitDecision && !decisionOutcome){
      try { decisionOutcome = publishCommitRevokeSync(commitDecision); }
      catch(decisionError){ phaseError = new AggregateError([error, decisionError], 'Phase 4 gate failure'); }
    }
    const survivors = await terminateOwned(child, childIdentity, remembered);
    if(survivors.error){
      phaseError = new AggregateError([phaseError, survivors.error], 'Phase 4 gate cleanup was not fully provable');
    }
    if(survivors.marker.length || survivors.pids.length){
      phaseError = new AggregateError([
        phaseError,
        new Error(`Phase 4 gate cleanup survivors: ${JSON.stringify(survivors)}`),
      ], 'Phase 4 gate cleanup failed');
    }
    await Promise.race([closePromise, sleep(2_000)]);
  } finally {
    sampler.stop();
    const finalOwnership = childIdentity
      ? await terminateOwned(child, childIdentity, remembered)
      : ownedSurvivors(null, null, remembered);
    if(finalOwnership.error){
      const error = finalOwnership.error;
      phaseError = phaseError
        ? new AggregateError([phaseError, error], `release phase ${phase.name} final ownership scan failed`)
        : error;
    }
    if(finalOwnership.marker.length || finalOwnership.pids.length){
      const error = new Error(
        `release phase ${phase.name} final process cleanup survivors: ${JSON.stringify(finalOwnership)}`,
      );
      phaseError = phaseError
        ? new AggregateError([phaseError, error], `release phase ${phase.name} final process cleanup failed`)
        : error;
    }
    if(activeChild === child) activeChild = null;
    if(activeChildIdentity === childIdentity) activeChildIdentity = null;
    releaseChildHandles(child);
    if(commitDecision){
      decisionOutcome ||= publishCommitRevokeSync(commitDecision);
      if(decisionOutcome.decision === 'COMMIT_GRANTED'){
        commitDecisionWon = true;
      }
      if(commitGraceTimer){
        clearTimeout(commitGraceTimer);
        commitGraceTimer = null;
      }
    }
  }
  if(phaseError) throw phaseError;
  return {
    result, phaseTempRoot, candidateReportPath, decisionOutcome,
    supervisorReportPath, supervisorReport,
  };
}

let failed = null;
const cleanupErrors = [];
try {
  activePhase = 'phase4-recovery-preflight';
  const preflightRecovery = await runBoundedPhase4Recovery({
    tempRoot: releaseTempRoot, remembered, projectRoot: RECOVERY_PROJECT_ROOT,
  });
  cleanupErrors.push(...preflightRecovery.hygieneErrors);
  if(cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Phase 4 recovery preflight hygiene failed');
  activePhase = null;
  for(const [index, phase] of phases.entries()){
    if(timedOut) break;
    const {
      result, phaseTempRoot, candidateReportPath, decisionOutcome,
      supervisorReportPath, supervisorReport,
    } = await runPhase(phase, index);
    let phaseCompleted = result.code === 0;
    let terminalRecovery = null;
    let terminalReport = supervisorReport;
    if(phase.consumesCandidates){
      activePhase = `${phase.name}-terminal-classification`;
      terminalRecovery = await runBoundedPhase4Recovery({
        tempRoot: releaseTempRoot,
        remembered,
        projectRoot: RECOVERY_PROJECT_ROOT,
      });
      cleanupErrors.push(...terminalRecovery.hygieneErrors);
      if(terminalRecovery.hygieneErrors.length) break;
      activePhase = phase.name;
      if(supervisorReport){
        terminalReport = readPhase4SupervisorReportSync({
          reportPath: supervisorReportPath,
          tempRoot: phaseTempRoot,
          expected: {
            expectedTransactionId: marker,
            expectedDecisionNonce: activeCommitDecision.nonce,
            expectedCandidateFresh: candidateHashes,
          },
        });
      }
      if(decisionOutcome?.decision === 'COMMIT_GRANTED'){
        if(terminalRecovery.action === 'finished-commit'){
          assert.equal(terminalRecovery.transactionId, marker,
            'terminal committed recovery transaction mismatch');
          await validateAuthorizedCommittedGeneration(terminalReport, RECOVERY_PROJECT_ROOT);
          phaseCompleted = true;
          recoveredAuthorizedCommit ||= result.code !== 0 || timedOut || commitGraceExpired;
          // A bounded completion kill after durable FINAL_COMMIT_ACK is an
          // authorized recovered commit, never a timeout+NEW result.
          timedOut = false;
          commitDeadlineReached = false;
          commitGraceExpired = false;
        } else if(terminalRecovery.action === 'rolled-back'){
          assert.equal(terminalRecovery.transactionId, marker,
            'terminal rollback recovery transaction mismatch');
          phaseCompleted = false;
        } else {
          throw new Error(`COMMIT_GRANTED lacked a durable terminal recovery receipt: ${JSON.stringify(terminalRecovery)}`);
        }
      }
    }
    const survivors = ownedSurvivors(null, null, remembered);
    if(survivors.error){
      cleanupErrors.push(survivors.error);
      break;
    }
    if(survivors.marker.length || survivors.pids.length){
      cleanupErrors.push(new Error(`release phase ${phase.name} left owned processes: ${JSON.stringify(survivors)}`));
      break;
    }
    if(result.code === 0 && phase.candidateWorld){
      try {
        candidateHashes[phase.candidateWorld] = await consumeCandidateReport(
          candidateReportPath, phase.candidateWorld,
        );
      } catch(error){
        cleanupErrors.push(error);
        break;
      }
    }
    if(phase.consumesCandidates){
      if(commitDeadlineReached || commitGraceExpired){
        timedOut = true;
        process.stderr.write(`${JSON.stringify({
          ok: false,
          phase: phase.name,
          error: 'Playforge deadline won before durable FINAL_COMMIT_ACK',
          marker,
        }, null, 2)}\n`);
        break;
      }
      if(result.code === 0 && decisionOutcome?.decision !== 'COMMIT_GRANTED'){
        cleanupErrors.push(new Error('Phase 4 exited 0 without outer COMMIT_GRANTED'));
        break;
      }
      if(!phaseCompleted){
        failed = { phase, result };
        break;
      }
    }
    try {
      const claims = await removeExactDeadPhase4Claims({
        claimDirectory: PHASE4_RELEASE_CLAIMS,
        ownedPids: rememberedPidSet(remembered),
      });
      if(claims.length){
        cleanupErrors.push(new Error(`release phase ${phase.name} left owned Phase 4 claims before hygiene: ${JSON.stringify(claims)}`));
        break;
      }
    } catch(error){
      cleanupErrors.push(error);
      break;
    }
    if(phase.consumesCandidates){
      const expectedDecisionResidue = [
        activeCommitDecision.decisionPath,
        activeCommitDecision.grantCandidatePath,
        activeCommitDecision.revokeCandidatePath,
        activeCommitDecision.readyPath,
        activeCommitDecision.readyCandidatePath,
        supervisorReportPath,
      ].map(file => ({
        path: path.relative(phaseTempRoot, file),
        type: 'file',
      })).sort((a, b) => a.path.localeCompare(b.path));
      const observedDecisionResidue = await ownedTreeEntries(phaseTempRoot);
      assert.deepEqual(observedDecisionResidue, expectedDecisionResidue,
        'Phase 4 terminal commit-gate boundary had unregistered temp residue');
      await assertNoIntroducedResources(handleScope);
      for(const file of [
        activeCommitDecision.decisionPath,
        activeCommitDecision.grantCandidatePath,
        activeCommitDecision.revokeCandidatePath,
        activeCommitDecision.readyPath,
        activeCommitDecision.readyCandidatePath,
        supervisorReportPath,
      ]) await rm(file, { force: true });
      activeCommitDecision = null;
    }
    const tempResidues = await ownedTreeEntries(phaseTempRoot);
    if(tempResidues.length){
      cleanupErrors.push(new Error(`release phase ${phase.name} left owned temp residue before hygiene: ${JSON.stringify(tempResidues)}`));
      break;
    }
    await rm(phaseTempRoot, { recursive: true, force: true });
    phaseTempRoots.delete(phaseTempRoot);
    try { await assertNoIntroducedResources(handleScope); }
    catch(error){
      cleanupErrors.push(error);
      break;
    }
    // Completed PIDs are no longer relevant ownership evidence. Dropping them
    // here prevents PID reuse in a later, long-running phase from becoming a
    // false survivor while each phase still receives a full pre-cleanup check.
    remembered.clear();
    rememberedGroups(remembered).clear();
    provisionalIdentities(remembered).clear();
    if(fixtureMode && !terminalClassificationFixture){
      failed = { phase, result: result.code === 0 ? { code: 1, signal: null } : result };
      if(result.code === 0){
        cleanupErrors.push(new Error(`release fixture ${fixtureMode} unexpectedly exited 0; fixtures are unconditionally ineligible`));
      }
      break;
    }
    if(!phaseCompleted){
      failed = { phase, result };
      break;
    }
    completedPhaseNames.push(phase.name);
    if(!terminalClassificationFixture) console.log(`release: PASS ${phase.name}`);
  }
} catch(error){
  cleanupErrors.push(error);
} finally {
  clearTimeout(watchdog);
  if(timedOut){
    const survivors = await watchdogTermination;
    if(survivors.error) cleanupErrors.push(survivors.error);
    if(survivors.marker.length || survivors.pids.length){
      cleanupErrors.push(new Error(`release watchdog survivors: ${JSON.stringify(survivors)}`));
    }
  } else if(activeChild){
    const survivors = await terminateOwned(activeChild, activeChildIdentity, remembered);
    if(survivors.error) cleanupErrors.push(survivors.error);
    if(survivors.marker.length || survivors.pids.length){
      cleanupErrors.push(new Error(`release finalizer survivors: ${JSON.stringify(survivors)}`));
    }
  }
  const naturalSurvivors = ownedSurvivors(null, null, remembered);
  if(naturalSurvivors.error) cleanupErrors.push(naturalSurvivors.error);
  if(naturalSurvivors.marker.length || naturalSurvivors.pids.length){
    const forced = await terminateOwned(null, null, remembered);
    if(forced.error) cleanupErrors.push(forced.error);
    cleanupErrors.push(new Error(`release observed process residue before hygiene: ${JSON.stringify(naturalSurvivors)}`));
    if(forced.marker.length || forced.pids.length) cleanupErrors.push(new Error(`release hygiene survivors: ${JSON.stringify(forced)}`));
  }
  try {
    const claims = await removeExactDeadPhase4Claims({
      claimDirectory: PHASE4_RELEASE_CLAIMS,
      ownedPids: rememberedPidSet(remembered),
    });
    if(claims.length) cleanupErrors.push(new Error(`release observed owned Phase 4 claims before hygiene: ${JSON.stringify(claims)}`));
  } catch(error){
    cleanupErrors.push(error);
  }
  if(timedOut || failed || cleanupErrors.length){
    try {
      if(samplerFailureObserved){
        assert.equal(samplerFailureFixture, true,
          'synthetic ownership failure epoch requires its exact fixture');
        assert.equal(samplerFailureArmed, true,
          'synthetic ownership failure epoch ended before failed-phase cleanup');
        assert.ok(cleanupErrors.length > 0,
          'synthetic ownership failure must remain recorded before recovery');
        // End only the test-owned discovery outage. Remembered identities and
        // every recorded UNKNOWN/error remain intact for a new proof epoch.
        samplerFailureArmed = false;
        recoveryProofFailureArmed = injectRecoveryProofFailure;
      }
      const finalRecovery = await runBoundedPhase4Recovery({
        tempRoot: releaseTempRoot, remembered, projectRoot: RECOVERY_PROJECT_ROOT,
      });
      cleanupErrors.push(...finalRecovery.hygieneErrors);
      if(samplerFailureObserved){
        assert.equal(finalRecovery.action, 'rolled-back',
          'persistent ownership scanner failure must recover exact OLD');
        assert.equal(finalRecovery.transactionId, marker,
          'persistent ownership scanner recovery transaction mismatch');
      }
    } catch(error){
      cleanupErrors.push(error);
    }
  }
  if(activeCommitDecision){
    for(const file of [
      activeCommitDecision.decisionPath,
      activeCommitDecision.grantCandidatePath,
      activeCommitDecision.revokeCandidatePath,
      activeCommitDecision.readyPath,
      activeCommitDecision.readyCandidatePath,
      path.join(activeCommitDecision.tempRoot, 'phase4-supervisor-report.json'),
    ]) await rm(file, { force: true }).catch(error => cleanupErrors.push(error));
    activeCommitDecision = null;
  }
  for(const phaseTempRoot of phaseTempRoots){
    try {
      const residues = await ownedTreeEntries(phaseTempRoot);
      if(residues.length){
        cleanupErrors.push(new Error(`release observed owned temp residue before hygiene in ${path.basename(phaseTempRoot)}: ${JSON.stringify(residues)}`));
      }
      await rm(phaseTempRoot, { recursive: true, force: true });
    } catch(error){
      cleanupErrors.push(new Error(`release could not clean owned phase temp ${phaseTempRoot}: ${error.message}`, { cause: error }));
    }
  }
  try {
    const unexpected = await ownedTreeEntries(releaseTempRoot);
    if(unexpected.length){
      cleanupErrors.push(new Error(`release temp root contained unregistered residue before hygiene: ${JSON.stringify(unexpected)}`));
    }
    await rm(releaseTempRoot, { recursive: true, force: true });
  } catch(error){
    cleanupErrors.push(new Error(`release could not remove its temp root: ${error.message}`, { cause: error }));
  }
  try { await assertNoIntroducedResources(handleScope); }
  catch(error){ cleanupErrors.push(error); }
}

if(timedOut){
  if(terminationError) cleanupErrors.push(terminationError);
  for(const error of cleanupErrors){
    console.error(`release cleanup: ${error.stack || error}\nrelease cleanup detail: ${errorSummary(error)}`);
  }
  process.exitCode = 124;
} else if(cleanupErrors.length){
  for(const error of cleanupErrors){
    console.error(`release cleanup: ${error.stack || error}\nrelease cleanup detail: ${errorSummary(error)}`);
  }
  process.exitCode = 1;
} else if(failed){
  const { phase, result } = failed;
  console.error(`release: FAIL ${phase.name}${result.signal ? ` (${result.signal})` : ''}`);
  process.exitCode = Number.isInteger(result.code) && result.code !== 0 ? result.code : 1;
} else {
  if(terminalClassificationFixture){
    assert.equal(recoveredAuthorizedCommit, true,
      'terminal classifier fixture requires a recovered authorized commit');
    assert.deepEqual(completedPhaseNames, phases.map(phase => phase.name),
      'terminal classifier fixture phase chain');
    assert.equal(commitDecisionWon, true, 'terminal classifier fixture COMMIT_GRANTED');
    console.log('release fixture: FIXTURE_OK ACKED_NEW terminal classification');
    process.exitCode = 42;
  } else {
    assert.equal(fixtureMode, null, 'release fixtures must never pass');
    assert.deepEqual(completedPhaseNames, normalPhases.map(phase => phase.name),
      'release success requires the complete ordered normal phase chain');
    assert.equal(candidateHandoffIssued, true, 'release success requires a live candidate handoff to Phase 4');
    assert.equal(commitDecisionWon, true, 'release success requires atomic COMMIT_GRANTED');
    assert.equal(commitGrantPublished, true, 'release success requires outer COMMIT_GRANTED publication');
    assert.match(candidateHashes.runner || '', /^[0-9a-f]{64}$/, 'release success Runner candidate hash');
    assert.match(candidateHashes.golf || '', /^[0-9a-f]{64}$/, 'release success Golf candidate hash');
    console.log('release: PASS all gates');
  }
}
