/* Authoritative Gridlock Run Phase 4 supervisor.
 *
 * The browser/build implementation lives in runner.phase4.mjs and is worker
 * only.  This process owns its worker, temporary root, artifact validation,
 * teardown, and (release mode only) promotion.  A worker can never print the
 * release verdict and it cannot choose where release artifacts are written.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentityHandleScope } from './active-handle-scope.mjs';
import {
  abortPhaseSpawnGate,
  captureGatedProcessIdentitySync,
  createPhaseSpawnGate,
  gatedChildEnvironment,
  releasePhaseSpawnGate,
} from './phase-spawn-gate-parent.mjs';
import {
  gatedNodeCommandArguments,
  releaseCapturedGatedNode,
  scopedGatedTitle,
  spawnCapturedGatedNode,
} from './phase-isolated-node.mjs';
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
import {
  acquirePhase4ReleaseLock,
  assertPhase4ReleaseClaim,
  assertPhase4ReleaseClaimSync,
  bindProcessSnapshotIdentity,
  captureProcessTableSnapshotSync,
  exactProcessSnapshotIdentityState,
  processSnapshotDescendantClosure,
  processSnapshotCommandUnavailable,
  processSnapshotMarkerMatches,
  releasePhase4ReleaseLock,
} from './runner.phase4.lock.mjs';
import {
  assertCandidateAuthorizationLive,
  consumeCandidateHandoff,
  publishCommitReadySync,
  readCommitCoordinationStateSync,
} from './runner.phase4.handoff.mjs';
import {
  assertPhase4InputManifestUnchanged,
  assertPhase4InputManifestUnchangedSync,
  buildPhase4InputManifest,
  verifyFrozenPhase4Sources,
} from './runner.phase4.frozen.mjs';
import { writePhase4SupervisorReportSync } from './runner.phase4.supervisor-report.mjs';
const WAIT_FIXTURE = fileURLToPath(new URL('./phase-wait.fixture.mjs', import.meta.url));
import {
  PHASE4_BOARD_SIZE,
  PHASE4_SHOT_NAMES,
  PHASE4_SHOT_VIEWPORTS,
  cleanupUninstalledTransaction,
  createPromotionTransaction,
  finalizeGrantedPromotionJournalSync,
  preparePromotionForCommitGate,
  installPromotionTransaction,
  pngMetadata,
  recoverPromotionJournal,
  rollbackPromotionTransaction,
  stagePromotionTransaction,
  transactionResidues,
  validateBaselineOldReport,
  validateCandidateHashChain,
  validateDevSkipReport,
  validateInstalledTransaction,
  validateStrictParityReport,
} from './runner.phase4.promotion.mjs';

if(process.platform === 'win32'){
  throw new Error('Gridlock Run Phase 4 verification requires POSIX process-group isolation; win32 is unsupported');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RUNNER = path.join(ROOT, 'runner');
const GOLF = path.join(ROOT, 'golf');
const WORKER = path.join(HERE, 'runner.phase4.mjs');
const TEMP_PREFIX = 'playforge-runner-phase4-supervisor-';
const PROCESS_ARGS_UNAVAILABLE_GRACE_MS = 250;
const RELEASE_CLAIM_DIRECTORY = path.join(RUNNER, '.phase4-release-claims');
const SHOT_VIEWPORTS = Object.freeze(Object.keys(PHASE4_SHOT_VIEWPORTS));
const SHOT_NAMES = PHASE4_SHOT_NAMES;
const FIXTURES = new Set([
  'post-boot-sync-hang',
  'page-evaluate-hang',
  'close-failure',
  'supervisor-leak',
  'unexpected-success-control',
]);
const WORKER_FIXTURES = new Set(['post-boot-sync-hang', 'page-evaluate-hang', 'close-failure']);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function positiveInteger(raw, label, fallback){
  if(raw === undefined) return fallback;
  const value = Number(raw);
  if(!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function parseArguments(argv){
  const options = {
    mode: 'release',
    fixture: null,
    testMarker: null,
    outerTimeoutMs: null,
    fixtureReadyTimeoutMs: null,
    injectTimeoutMs: null,
    armAfterFixture: false,
    lockOnlyMs: null,
    recoverOnly: false,
    testRecoveryRoot: null,
  };
  for(const argument of argv){
    if(argument === '--release'){
      options.mode = 'release';
    } else if(argument === '--dev'){
      options.mode = 'dev';
    } else if(argument === '--arm-watchdog-after-fixture'){
      options.armAfterFixture = true;
    } else if(argument.startsWith('--fixture=')){
      options.fixture = argument.slice('--fixture='.length);
    } else if(argument.startsWith('--test-marker=')){
      options.testMarker = argument.slice('--test-marker='.length);
    } else if(argument.startsWith('--outer-timeout-ms=')){
      options.outerTimeoutMs = positiveInteger(argument.slice('--outer-timeout-ms='.length), '--outer-timeout-ms');
    } else if(argument.startsWith('--fixture-ready-timeout-ms=')){
      options.fixtureReadyTimeoutMs = positiveInteger(
        argument.slice('--fixture-ready-timeout-ms='.length),
        '--fixture-ready-timeout-ms',
      );
    } else if(argument.startsWith('--inject-timeout-ms=')){
      options.injectTimeoutMs = positiveInteger(argument.slice('--inject-timeout-ms='.length), '--inject-timeout-ms');
    } else if(argument.startsWith('--lock-only-ms=')){
      options.lockOnlyMs = positiveInteger(argument.slice('--lock-only-ms='.length), '--lock-only-ms');
    } else if(argument === '--recover-only'){
      options.recoverOnly = true;
    } else if(argument.startsWith('--test-recovery-root=')){
      options.testRecoveryRoot = path.resolve(argument.slice('--test-recovery-root='.length));
    } else {
      throw new Error(`unknown Phase 4 supervisor argument: ${argument}`);
    }
  }
  if(options.fixture && !FIXTURES.has(options.fixture)){
    throw new Error(`unknown Phase 4 negative fixture: ${options.fixture}`);
  }
  if((options.armAfterFixture || options.injectTimeoutMs) && !options.fixture){
    throw new Error('negative-test controls require --fixture');
  }
  if(options.testMarker && !options.fixture && !options.lockOnlyMs && !options.recoverOnly){
    throw new Error('--test-marker requires a fixture, lock-only control, or recover-only mode');
  }
  if(options.armAfterFixture && options.fixture !== 'post-boot-sync-hang'){
    throw new Error('--arm-watchdog-after-fixture is only valid for post-boot-sync-hang');
  }
  if(options.lockOnlyMs && (options.mode !== 'release' || options.fixture)){
    throw new Error('--lock-only-ms requires release mode and no fixture');
  }
  if(options.recoverOnly && (options.mode !== 'release' || options.fixture || options.lockOnlyMs)){
    throw new Error('--recover-only requires release mode with no fixture or lock-only control');
  }
  if(options.testRecoveryRoot){
    if(!options.recoverOnly || !options.testMarker){
      throw new Error('--test-recovery-root requires recover-only mode and a test marker');
    }
    const activeTempRoot = path.resolve(tmpdir());
    const fixtureTempAnchor = path.basename(activeTempRoot) === 'phase4-recovery'
      ? path.dirname(path.dirname(activeTempRoot))
      : activeTempRoot;
    assert.equal(inside(fixtureTempAnchor, options.testRecoveryRoot), true,
      '--test-recovery-root must be inside the system temporary directory');
    assert.match(path.basename(options.testRecoveryRoot), /^phase4-transaction-playforge-release-negative-/,
      '--test-recovery-root must be a strong outer transaction fixture root');
  }
  if(options.testMarker && !/^[A-Za-z0-9_-]{8,160}$/.test(options.testMarker)){
    throw new Error('--test-marker must be 8-160 alphanumeric, underscore, or hyphen characters');
  }
  return options;
}

function assertCleanInheritedEnvironment(){
  const forbidden = Object.keys(process.env).filter(name => name.startsWith('RUNNER_PHASE4_')).sort();
  for(const legacy of [
    'PLAYFORGE_EXPECTED_RUNNER_CANDIDATE_SHA256',
    'PLAYFORGE_EXPECTED_GOLF_CANDIDATE_SHA256',
  ]){
    if(process.env[legacy] !== undefined) forbidden.push(legacy);
  }
  if(forbidden.length){
    throw new Error(`refusing inherited Phase 4 control environment: ${forbidden.join(', ')}`);
  }
}

function timebox(promise, milliseconds, label){
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function readHttpTotal(url, label, milliseconds = 30_000){
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    const finish = callback => value => {
      if(settled) return;
      settled = true;
      clearTimeout(deadline);
      callback(value);
    };
    const succeed = finish(resolve);
    const fail = finish(reject);
    const request = httpGet(url, {
      agent: false,
      headers: { connection: 'close', 'cache-control': 'no-cache' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', fail);
      response.once('end', () => {
        if((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300){
          fail(new Error(`${label} returned HTTP ${response.statusCode}`));
        } else {
          succeed(Buffer.concat(chunks));
        }
      });
    });
    request.once('error', fail);
    request.setTimeout(Math.min(10_000, milliseconds), () => request.destroy(new Error(`${label} socket timeout`)));
    deadline = setTimeout(() => request.destroy(new Error(`${label} exceeded total deadline ${milliseconds}ms`)), milliseconds);
  });
}

function cacheBustedArtifactUrl(origin, pathname, marker, phase){
  const url = new URL(pathname, origin);
  url.searchParams.set('playforgePhase4', `${phase}-${marker}`);
  return url.href;
}

async function validateParentOldBaseline(marker){
  const localhost = process.env.PLAYFORGE_LOCALHOST_ORIGIN || 'http://127.0.0.1:8091';
  const lan = process.env.PLAYFORGE_LAN_ORIGIN || 'http://192.168.1.137:8091';
  const rows = {};
  for(const row of [
    {
      world: 'runner', pathname: '/runner/gridlock-run-v1.html',
      dist: path.join(RUNNER, 'dist', 'index.html'), standalone: path.join(RUNNER, 'gridlock-run-v1.html'),
    },
    {
      world: 'golf', pathname: '/golf/stackyard-golf-v1.html',
      dist: path.join(GOLF, 'dist', 'index.html'), standalone: path.join(GOLF, 'stackyard-golf-v1.html'),
    },
  ]){
    rows[row.world] = {
      dist: sha256(await readFile(row.dist)),
      standalone: sha256(await readFile(row.standalone)),
      localhost: sha256(await readHttpTotal(
        cacheBustedArtifactUrl(localhost, row.pathname, marker, 'baseline'),
        `${row.world} parent old localhost baseline`,
      )),
      lan: sha256(await readHttpTotal(
        cacheBustedArtifactUrl(lan, row.pathname, marker, 'baseline'),
        `${row.world} parent old LAN baseline`,
      )),
    };
  }
  return validateBaselineOldReport({ skipped: false, ...rows });
}

async function validateFinalPromotedParity(validated, marker){
  const localhost = process.env.PLAYFORGE_LOCALHOST_ORIGIN || 'http://127.0.0.1:8091';
  const lan = process.env.PLAYFORGE_LAN_ORIGIN || 'http://192.168.1.137:8091';
  const parity = { skipped: false };
  for(const row of [
    {
      world: 'runner', pathname: '/runner/gridlock-run-v1.html',
      dist: path.join(RUNNER, 'dist', 'index.html'), standalone: path.join(RUNNER, 'gridlock-run-v1.html'),
    },
    {
      world: 'golf', pathname: '/golf/stackyard-golf-v1.html',
      dist: path.join(GOLF, 'dist', 'index.html'), standalone: path.join(GOLF, 'stackyard-golf-v1.html'),
    },
  ]){
    parity[row.world] = {
      // The fresh bundle was independently hashed and copied to same-fs stage
      // before the worker temp root was removed. The trusted hash value remains
      // authoritative after that parent-owned source file is intentionally gone.
      fresh: validated.worlds[row.world].sha256,
      dist: sha256(await readFile(row.dist)),
      standalone: sha256(await readFile(row.standalone)),
      localhost: sha256(await readHttpTotal(
        cacheBustedArtifactUrl(localhost, row.pathname, marker, 'installed'),
        `${row.world} parent installed localhost parity`,
      )),
      lan: sha256(await readHttpTotal(
        cacheBustedArtifactUrl(lan, row.pathname, marker, 'installed'),
        `${row.world} parent installed LAN parity`,
      )),
    };
  }
  return validateStrictParityReport(parity, {
    runner: validated.worlds.runner.sha256,
    golf: validated.worlds.golf.sha256,
  });
}

function describeResource(resource){
  return {
    type: resource?.constructor?.name || typeof resource,
    fd: Number.isInteger(resource?.fd) ? resource.fd
      : Number.isInteger(resource?._handle?.fd) ? resource._handle.fd : null,
    pid: Number.isInteger(resource?.pid) ? resource.pid : null,
    hasRef: typeof resource?.hasRef === 'function' ? resource.hasRef()
      : typeof resource?._handle?.hasRef === 'function' ? resource._handle.hasRef() : null,
    destroyed: typeof resource?.destroyed === 'boolean' ? resource.destroyed : null,
  };
}

async function assertNoIntroducedResources(scope, label = 'Phase 4 supervisor'){
  const deadline = Date.now() + 3_000;
  let ownership;
  do {
    ownership = scope.classify();
    if(ownership.handles.length === 0 && ownership.requests.length === 0){
      return { handles: [], requests: [] };
    }
    await sleep(25);
  } while(Date.now() < deadline);
  throw new Error(`${label} leaked resources: ${JSON.stringify({
    handles: ownership.handles.map(describeResource),
    requests: ownership.requests.map(describeResource),
  })}`);
}

function rememberExact(identity, remembered){
  if(!identity) return;
  const current = remembered.get(identity.pid);
  if(current){
    assert.equal(current.processStart, identity.processStart,
      `Phase 4 worker PID ${identity.pid} was reused while owned`);
    assert.equal(current.pgid, identity.pgid,
      `Phase 4 worker PID ${identity.pid} changed process group while owned`);
    assert.equal(current.ucomm, identity.ucomm,
      `Phase 4 worker PID ${identity.pid} changed ucomm while owned`);
    assert.equal(current.command, identity.command,
      `Phase 4 worker PID ${identity.pid} changed command while owned`);
    return;
  }
  remembered.set(identity.pid, identity);
}

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
    `Phase 4 provisional PID ${identity.pid} is UNKNOWN: ${state.reason || 'unknown'}`
    + ` (captured=${JSON.stringify(identity.command)}, observed=${JSON.stringify(state.record?.command || null)})`,
  );
}

const provisionalGraceExpired = entry => (
  Date.now() - entry.startedAt >= PROCESS_ARGS_UNAVAILABLE_GRACE_MS
);

function refreshProvisionalIdentities(snapshot, remembered){
  const errors = [];
  let provisionalPending = false;
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
    } else if(state.reason === 'args-unavailable' && !provisionalGraceExpired(entry)){
      provisionalPending = true;
    } else {
      errors.push(provisionalIdentityError(entry.identity, state));
    }
  }
  return { errors, provisionalPending };
}

/** Revalidate rediscovery against existing authority; never rebind argv fallback. */
function rememberSnapshotExact(snapshot, record, remembered, {
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
    return {
      argsUnavailablePending: state.reason === 'args-unavailable',
      provisionalPending: false,
      error: new Error(
        `Phase 4 owned PID ${existing.pid} identity is UNKNOWN during rediscovery: ${state.reason || 'unknown'}`
        + ` (captured=${JSON.stringify(existing.command)}, observed=${JSON.stringify(state.record?.command || null)})`,
      ),
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
  rememberExact(bindProcessSnapshotIdentity(snapshot, record, bindingOptions), remembered);
  return { argsUnavailablePending: false, provisionalPending: false, error: null };
}

function refreshOwnedProcesses(child, childIdentity, marker, remembered){
  const errors = [];
  let argsUnavailablePending = false;
  let provisionalPending = false;
  let snapshot = null;
  let markerRecords = [];
  try { snapshot = captureProcessTableSnapshotSync(); }
  catch(error){
    errors.push(error);
    return { snapshot, markerRecords, errors, argsUnavailablePending, provisionalPending };
  }
  const provisional = refreshProvisionalIdentities(snapshot, remembered);
  errors.push(...provisional.errors);
  provisionalPending ||= provisional.provisionalPending;
  if(childIdentity){
    try { rememberExact(childIdentity, remembered); }
    catch(error){ errors.push(error); }
    try {
      const state = exactDirectChildIdentityState(childIdentity, child, { snapshot });
      if(state.state === 'UNKNOWN'){
        if(state.reason === 'args-unavailable') argsUnavailablePending = true;
        else {
          errors.push(new Error(
            `Phase 4 worker identity became unknowable: ${state.reason || 'unknown'}`
            + ` (captured=${JSON.stringify(childIdentity.command)}, observed=${JSON.stringify(state.record?.command || null)},`
            + ` state=${JSON.stringify(state.record?.state || null)})`,
          ));
        }
      } else if(state.state === 'LIVE'){
        for(const record of processSnapshotDescendantClosure(snapshot, state.record, { includeRoots: false })){
          try {
            const result = rememberSnapshotExact(snapshot, record, remembered, {
              provenance: { kind: 'descendant', rootRecord: state.record },
            });
            if(result.error){
              if(result.argsUnavailablePending) argsUnavailablePending = true;
              else if(result.provisionalPending) provisionalPending = true;
              else errors.push(result.error);
            }
          }
          catch(error){ if(error?.identityState !== 'PROVEN_DEAD') errors.push(error); }
        }
      }
    } catch(error){ errors.push(error); }
  }
  try {
    markerRecords = processSnapshotMarkerMatches(snapshot, marker)
      .filter(record => record.pid !== process.pid && !record.state.startsWith('Z'));
    for(const record of markerRecords){
      try {
        const result = rememberSnapshotExact(snapshot, record, remembered, {
          provenance: { kind: 'marker', marker },
          bindingOptions: { expectedCommandMarker: marker },
        });
        if(result.error){
          if(result.argsUnavailablePending) argsUnavailablePending = true;
          else if(result.provisionalPending) provisionalPending = true;
          else errors.push(result.error);
        }
      } catch(error){ if(error?.identityState !== 'PROVEN_DEAD') errors.push(error); }
    }
  } catch(error){
    errors.push(error);
  }
  return { snapshot, markerRecords, errors, argsUnavailablePending, provisionalPending };
}

function signalRememberedProcesses(remembered, signal, childIdentity){
  return signalExactIdentitySet(remembered, signal, {
    deferUnknown: (identity, outcome) => identity.pid === childIdentity?.pid
      && outcome.reason === 'args-unavailable',
  });
}

function ownedProcessesState(child, childIdentity, marker, remembered){
  const observed = refreshOwnedProcesses(child, childIdentity, marker, remembered);
  const errors = [...observed.errors];
  let argsUnavailablePending = observed.argsUnavailablePending;
  let provisionalPending = observed.provisionalPending;
  const pidSurvivors = [];
  for(const identity of remembered.values()){
    if(!observed.snapshot){
      pidSurvivors.push(identity.pid);
      continue;
    }
    try {
      const state = childIdentity?.pid === identity.pid
        ? exactDirectChildIdentityState(identity, child, { snapshot: observed.snapshot })
        : exactProcessSnapshotIdentityState(identity, { snapshot: observed.snapshot });
      if(state.state !== 'PROVEN_DEAD') pidSurvivors.push(identity.pid);
      if(state.state === 'UNKNOWN'){
        if(childIdentity?.pid === identity.pid && state.reason === 'args-unavailable'){
          argsUnavailablePending = true;
        } else {
          errors.push(new Error(`Phase 4 owned PID ${identity.pid} is UNKNOWN: ${state.reason || 'unknown'}`));
        }
      }
    } catch(error){
      pidSurvivors.push(identity.pid);
      errors.push(error);
    }
  }
  for(const entry of provisionalIdentities(remembered).values()){
    const identity = entry.identity;
    pidSurvivors.push(identity.pid);
    if(!observed.snapshot){
      errors.push(new Error(
        `Phase 4 provisional PID ${identity.pid} is UNKNOWN: atomic-snapshot-unavailable`,
      ));
      continue;
    }
    const state = provisionalProcessSnapshotIdentityState(identity, {
      snapshot: observed.snapshot,
    });
    if(state.state === 'PROVEN_DEAD'){
      pidSurvivors.splice(pidSurvivors.lastIndexOf(identity.pid), 1);
      provisionalIdentities(remembered).delete(identity.pid);
    } else if(state.state === 'UNKNOWN' && state.reason === 'args-unavailable'){
      if(provisionalGraceExpired(entry)) errors.push(provisionalIdentityError(identity, state));
      else provisionalPending = true;
    } else if(state.state !== 'LIVE'){
      errors.push(provisionalIdentityError(identity, state));
    }
  }
  let groupSurvivors = [];
  if(process.platform !== 'win32' && childIdentity){
    if(!observed.snapshot){
      groupSurvivors = [childIdentity.pgid];
    } else {
      const group = inspectCapturedProcessGroup(childIdentity, {
        snapshotProbe: () => observed.snapshot,
      });
      if(group.state === 'LIVE') groupSurvivors = group.memberPids;
      else if(group.state === 'UNKNOWN'){
        if(group.reason === 'leader-args-unavailable'){
          argsUnavailablePending = true;
          groupSurvivors = [childIdentity.pid];
        } else {
          errors.push(group.error || new Error(`Phase 4 process-group proof is UNKNOWN: ${group.reason || 'unknown'}`));
        }
      }
    }
  }
  return {
    markerSurvivors: observed.markerRecords,
    pidSurvivors,
    groupSurvivors,
    argsUnavailablePending,
    provisionalPending,
    ok: errors.length === 0 && !argsUnavailablePending && !provisionalPending,
    error: errors.length ? new AggregateError(errors, 'Phase 4 owned-process proof is UNKNOWN') : null,
  };
}

function childProcessRunning(child){
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function signalCapturedWorkerGroup(child, childIdentity, signal){
  assert.ok(childIdentity, 'Phase 4 captured worker identity');
  if(child) assert.equal(child.pid, childIdentity.pid, 'Phase 4 worker handle identity changed');
  if(process.platform !== 'win32' && childIdentity.pgid === childIdentity.pid){
    return signalCapturedProcessGroup(childIdentity, signal);
  }
  if(childProcessRunning(child)){
    child.kill(signal);
    return { signalled: true, state: 'LIVE', memberPids: [childIdentity.pid] };
  }
  return { signalled: false, state: 'PROVEN_DEAD', reason: 'captured-handle-closed' };
}

async function terminateOwnedProcessTrees(child, childIdentity, marker, remembered = new Map()){
  const errors = [];
  const errorMessages = new Set();
  const collect = error => {
    if(!error) return;
    const message = error?.message || String(error);
    if(errorMessages.has(message)) return;
    errorMessages.add(message);
    errors.push(error);
  };
  const collectMany = additions => additions.forEach(collect);
  let argsUnavailableSince = null;
  const observeArgsUnavailable = pending => {
    const grace = advanceArgsUnavailableGrace(argsUnavailableSince, pending, {
      graceMs: PROCESS_ARGS_UNAVAILABLE_GRACE_MS,
    });
    argsUnavailableSince = grace.startedAt;
    return grace.expired;
  };
  const collectGroup = (result, signal) => {
    if(result?.state === 'UNKNOWN'){
      if(result.reason === 'leader-args-unavailable'){
        observeArgsUnavailable(true);
        return;
      }
      collect(result.error || new Error(
        `Phase 4 refused captured-group ${signal}: ${result?.reason || 'unknown'}`,
      ));
    }
  };
  if(childIdentity){
    try { rememberExact(childIdentity, remembered); }
    catch(error){ collect(error); }
  }
  if(process.platform === 'win32'){
    if(childProcessRunning(child)){
      const result = spawnSync('taskkill', ['/pid', String(childIdentity.pid), '/T', '/F'], {
        stdio: 'ignore', timeout: 5_000,
      });
      if(result.error || result.status !== 0){
        collect(result.error || new Error(`taskkill exited ${result.status}`));
      }
    }
  } else {
    try { collectGroup(signalCapturedWorkerGroup(child, childIdentity, 'SIGTERM'), 'SIGTERM'); }
    catch(error){ collect(error); }
    const exactTerm = signalRememberedProcesses(remembered, 'SIGTERM', childIdentity);
    collectMany(exactTerm.errors);
    if(exactTerm.deferred.length) observeArgsUnavailable(true);
  }
  const termDeadline = Date.now() + 750;
  let survivors = ownedProcessesState(child, childIdentity, marker, remembered);
  observeArgsUnavailable(survivors.argsUnavailablePending);
  if(survivors.error) collect(survivors.error);
  while((survivors.markerSurvivors.length || survivors.pidSurvivors.length || survivors.groupSurvivors.length)){
    if(survivors.argsUnavailablePending && argsUnavailableSince !== null
      && Date.now() - argsUnavailableSince >= PROCESS_ARGS_UNAVAILABLE_GRACE_MS) break;
    if(Date.now() >= termDeadline) break;
    await sleep(25);
    survivors = ownedProcessesState(child, childIdentity, marker, remembered);
    observeArgsUnavailable(survivors.argsUnavailablePending);
    if(survivors.error) collect(survivors.error);
  }
  if(process.platform !== 'win32'){
    // Revalidate the captured PGID even when the leader handle has closed and
    // the unmarked same-group child was too fast for descendant sampling.
    try { collectGroup(signalCapturedWorkerGroup(child, childIdentity, 'SIGKILL'), 'SIGKILL'); }
    catch(error){ collect(error); }
    const exactKill = signalRememberedProcesses(remembered, 'SIGKILL', childIdentity);
    collectMany(exactKill.errors);
    if(exactKill.deferred.length) observeArgsUnavailable(true);
  }
  const killDeadline = Date.now() + 2_000;
  survivors = ownedProcessesState(child, childIdentity, marker, remembered);
  observeArgsUnavailable(survivors.argsUnavailablePending);
  if(survivors.error) collect(survivors.error);
  while(survivors.markerSurvivors.length || survivors.pidSurvivors.length || survivors.groupSurvivors.length){
    if(survivors.argsUnavailablePending && argsUnavailableSince !== null
      && Date.now() - argsUnavailableSince >= PROCESS_ARGS_UNAVAILABLE_GRACE_MS) break;
    if(Date.now() >= killDeadline) break;
    await sleep(25);
    const wasPending = argsUnavailableSince !== null;
    survivors = ownedProcessesState(child, childIdentity, marker, remembered);
    observeArgsUnavailable(survivors.argsUnavailablePending);
    if(survivors.error) collect(survivors.error);
    if(wasPending && !survivors.argsUnavailablePending
      && (survivors.markerSurvivors.length || survivors.pidSurvivors.length || survivors.groupSurvivors.length)){
      try { collectGroup(signalCapturedWorkerGroup(child, childIdentity, 'SIGKILL'), 'SIGKILL'); }
      catch(error){ collect(error); }
      const restoredKill = signalRememberedProcesses(remembered, 'SIGKILL', childIdentity);
      collectMany(restoredKill.errors);
    }
  }
  if(survivors.argsUnavailablePending){
    collect(new Error(
      `Phase 4 worker PID ${childIdentity?.pid ?? 'unknown'} argv remained unavailable past bounded cleanup grace`,
    ));
  }
  return {
    ...survivors,
    ok: errors.length === 0 && survivors.ok,
    error: errors.length ? new AggregateError(errors, 'Phase 4 bounded process teardown was not fully provable') : null,
  };
}

function releaseChildProcessHandles(child){
  if(!child) return;
  for(const stream of child.stdio || []){
    stream?.removeAllListeners?.();
    stream?.destroy?.();
    stream?.unref?.();
  }
  child.removeAllListeners?.();
  child.unref?.();
}

async function terminateUncapturedWorkerHandle(child, exitPromise){
  if(!child) return;
  if(child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.race([exitPromise, sleep(750)]);
  if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.race([exitPromise, sleep(2_000)]);
  if(child.exitCode === null && child.signalCode === null){
    throw new Error('uncaptured Phase 4 worker did not exit after handle-bound TERM/KILL');
  }
}

function sanitizedWorkerEnvironment({ marker, tempDirectory, outputDirectory, reportPath, options }){
  const environment = {};
  for(const [name, value] of Object.entries(process.env)){
    if(!name.startsWith('RUNNER_PHASE4_')) environment[name] = value;
  }
  Object.assign(environment, {
    RUNNER_PHASE4_INTERNAL_WORKER: '1',
    RUNNER_PHASE4_RUN_MARKER: marker,
    RUNNER_PHASE4_TEMP_DIR: tempDirectory,
    RUNNER_PHASE4_OUTPUT_DIR: outputDirectory,
    RUNNER_PHASE4_REPORT_PATH: reportPath,
    RUNNER_PHASE4_MODE: options.workerMode,
  });
  if(WORKER_FIXTURES.has(options.fixture)) environment.RUNNER_PHASE4_FIXTURE = options.fixture;
  if(options.injectTimeoutMs) environment.RUNNER_PHASE4_INJECT_TIMEOUT_MS = String(options.injectTimeoutMs);
  return environment;
}

async function regularFileMetadata(file, label){
  const status = await lstat(file);
  assert.equal(status.isFile(), true, `${label} must be a regular file`);
  assert.equal(status.isSymbolicLink(), false, `${label} must not be a symbolic link`);
  const bytes = await readFile(file);
  return { bytes: bytes.length, sha256: sha256(bytes), contents: bytes };
}

function inside(parent, candidate){
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function artifactPath(outputDirectory, value, label){
  const raw = typeof value === 'string' ? value : value?.path;
  assert.equal(typeof raw, 'string', `${label} must provide a path`);
  const resolved = path.resolve(outputDirectory, raw);
  assert.equal(inside(outputDirectory, resolved), true, `${label} escaped the parent-owned output directory`);
  return resolved;
}

async function recursivePngFiles(directory){
  const files = [];
  async function visit(current){
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch(error){
      if(error?.code === 'ENOENT') return;
      throw error;
    }
    for(const entry of entries){
      const absolute = path.join(current, entry.name);
      if(entry.isDirectory()) await visit(absolute);
      else if(entry.isFile() && entry.name.toLowerCase().endsWith('.png')) files.push(path.resolve(absolute));
    }
  }
  await visit(directory);
  return files.sort();
}

function assertDevReport(report){
  assert.equal(report.mode, 'dev', 'dev worker report mode');
  assert.equal(report.releaseEligible, false, 'dev report must be release-ineligible');
  assert.equal(report.baselineOld?.skipped, true, 'dev report must explicitly skip old baseline parity');
  assert.equal(typeof report.baselineOld?.reason, 'string', 'dev baseline skip must include a reason');
  assert.ok(report.baselineOld.reason.trim(), 'dev baseline skip reason must not be empty');
  assert.deepEqual(Object.keys(report.candidateFresh || {}).sort(), ['golf', 'runner'], 'dev candidateFresh schema');
  for(const world of ['runner', 'golf']) assert.match(report.candidateFresh[world], /^[0-9a-f]{64}$/);
  assert.deepEqual(report.shots, [], 'dev report must contain zero screenshots');
  assert.equal(report.frameBoard, null, 'dev report must not contain a frame board');
  validateDevSkipReport(report.skips);
}

function assertReleaseMode(report){
  assert.equal(report.mode, 'release', 'release worker report mode');
  assert.equal(report.releaseEligible, false, 'release worker cannot declare release eligibility');
}

async function validateWorkerReport({ options, outputDirectory, reportPath }){
  const reportMetadata = await regularFileMetadata(reportPath, 'Phase 4 worker report');
  let report;
  try { report = JSON.parse(reportMetadata.contents.toString('utf8')); }
  catch(error){ throw new Error(`Phase 4 worker report is not valid JSON: ${error.message}`, { cause: error }); }
  assert.ok(report && typeof report === 'object' && !Array.isArray(report), 'Phase 4 worker report must be an object');

  if(options.workerMode === 'dev'){
    assertDevReport(report);
    assert.deepEqual(await recursivePngFiles(outputDirectory), [], 'dev worker wrote PNG artifacts');
    return {
      report,
      reportMetadata: { path: reportPath, bytes: reportMetadata.bytes, sha256: reportMetadata.sha256 },
      shots: [],
      frameBoard: null,
    };
  }

  assertReleaseMode(report);
  const worlds = {};
  for(const world of ['runner', 'golf']){
    const file = path.resolve(outputDirectory, 'builds', world, 'index.html');
    assert.equal(inside(outputDirectory, file), true, `${world} fresh build escaped output root`);
    const metadata = await regularFileMetadata(file, `${world} independent fresh build`);
    worlds[world] = { path: file, bytes: metadata.bytes, sha256: metadata.sha256 };
  }
  validateCandidateHashChain(report.candidateFresh, {
    runner: worlds.runner.sha256,
    golf: worlds.golf.sha256,
  }, options.gameplayTestedHashes);
  validateBaselineOldReport(report.baselineOld);
  assert.equal(Array.isArray(report.shots), true, 'release worker report shots must be an array');
  assert.equal(report.shots.length, 12, 'release worker report must contain exactly 12 screenshot paths');
  const expected = SHOT_VIEWPORTS.flatMap(viewport => SHOT_NAMES.map(name => (
    path.resolve(outputDirectory, 'phase4-shots', viewport, `${name}.png`)
  ))).sort();
  const reported = report.shots.map((value, index) => artifactPath(
    outputDirectory,
    value,
    `release screenshot ${index + 1}`,
  )).sort();
  assert.deepEqual(reported, expected, 'release report screenshot set must be exactly 2 viewports x 6 named frames');
  assert.equal(new Set(reported).size, 12, 'release screenshot paths must be unique');

  const frameBoardPath = artifactPath(outputDirectory, report.frameBoard, 'release frame board');
  const expectedBoard = path.resolve(outputDirectory, 'gridlock-run-v1-frames.png');
  assert.equal(frameBoardPath, expectedBoard, 'release frame board path');
  const pngFiles = await recursivePngFiles(outputDirectory);
  assert.deepEqual(pngFiles, [...expected, expectedBoard].sort(), 'release output must contain exactly 12 shots and one board');
  const shots = [];
  for(const file of expected){
    const relativePath = path.relative(outputDirectory, file);
    const viewport = relativePath.split(path.sep)[1];
    const metadata = await pngMetadata(file, PHASE4_SHOT_VIEWPORTS[viewport], `release screenshot ${relativePath}`);
    shots.push({ ...metadata, relativePath });
  }
  const frameBoard = await pngMetadata(expectedBoard, PHASE4_BOARD_SIZE, 'release frame board');
  assert.equal(new Set(shots.map(row => row.sha256)).size, shots.length,
    'release screenshots must have 12 distinct hashes');
  assert.equal(shots.some(row => row.sha256 === frameBoard.sha256), false,
    'release frame board must not duplicate a screenshot');
  frameBoard.relativePath = path.relative(outputDirectory, expectedBoard);
  return {
    report,
    reportMetadata: { path: reportPath, bytes: reportMetadata.bytes, sha256: reportMetadata.sha256 },
    shots,
    frameBoard,
    worlds,
  };
}

function boundedOutputAppend(current, chunk){
  return `${current}${chunk}`.slice(-2 * 1024 * 1024);
}

function expectedFixtureReadyText(fixture, marker){
  return `runner-phase4-${fixture}:${marker}`;
}

async function runSupervisor(options){
  await new Promise(resolve => setImmediate(resolve));
  const parentFrozenSources = await verifyFrozenPhase4Sources(ROOT);
  const parentBuildInputs = await buildPhase4InputManifest(ROOT);
  const marker = options.marker;
  if(options.fixture === 'unexpected-success-control'){
    return {
      exitCode: 0,
      success: { verdict: 'runner.phase4: PASS', summary: { releaseEligible: true } },
    };
  }
  if(options.fixture === 'supervisor-leak'){
    const leakTemp = await mkdtemp(path.join(tmpdir(), `${TEMP_PREFIX}${marker}-leak-`));
    const leakedOwned = spawnCapturedGatedNode({
      title: scopedGatedTitle(`${marker}:supervisor-leak`),
      args: [WAIT_FIXTURE, `${marker}:supervisor-leak-target`],
      stdio: 'ignore',
    });
    await releaseCapturedGatedNode(leakedOwned);
    const leaked = leakedOwned.child;
    leaked.unref();
    process.stderr.write(`runner-phase4-supervisor-leak:${marker}:${leakTemp}\n`);
    return 1;
  }
  const handleScope = createIdentityHandleScope({
    ignoredHandles: [process.stdin, process.stdout, process.stderr],
  });
  const outerTimeoutMs = options.outerTimeoutMs || (options.workerMode === 'dev' ? 240_000 : 720_000);
  const fixtureReadyTimeoutMs = options.fixtureReadyTimeoutMs || 120_000;
  const tempDirectory = await timebox(
    mkdtemp(path.join(tmpdir(), `${TEMP_PREFIX}${marker}-`)),
    5_000,
    'create parent-owned Phase 4 temp directory',
  );
  const outputDirectory = path.join(tempDirectory, 'artifacts');
  const reportPath = path.join(tempDirectory, 'runner-phase4-report.json');
  await mkdir(outputDirectory, { recursive: true });

  let child = null;
  let childIdentity = null;
  let exitPromise = null;
  let exitCode = 1;
  let timedOut = false;
  let workerStdout = '';
  let workerStderr = '';
  let validated = null;
  let transaction = null;
  let parentBaselineOld = null;
  let installedNetworkParity = null;
  let teardownResources = null;
  const rememberedWorkerProcesses = new Map();
  const cleanupErrors = [];
  try {
    const workerTitle = scopedGatedTitle(`${marker}:phase4-worker`);
    const spawnGate = createPhaseSpawnGate(workerTitle);
    child = spawn(process.execPath, gatedNodeCommandArguments(workerTitle, [
      WORKER,
      `--phase4-worker-marker=${marker}`,
    ]), {
      cwd: ROOT,
      detached: process.platform !== 'win32',
      env: gatedChildEnvironment(
        sanitizedWorkerEnvironment({ marker, tempDirectory, outputDirectory, reportPath, options }),
        spawnGate,
      ),
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    exitPromise = new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if(settled) return;
        settled = true;
        resolve(value);
      };
      child.once('error', error => finish({ error }));
      child.once('close', (code, signal) => finish({ code, signal }));
    });
    let resolveFixtureReady;
    const fixtureReady = new Promise(resolve => { resolveFixtureReady = resolve; });
    const fixtureReadyText = options.fixture ? expectedFixtureReadyText(options.fixture, marker) : null;
    const inspectFixtureOutput = () => {
      if(fixtureReadyText && `${workerStdout}\n${workerStderr}`.includes(fixtureReadyText)) resolveFixtureReady();
    };
    child.stdout.on('data', chunk => {
      workerStdout = boundedOutputAppend(workerStdout, chunk);
      inspectFixtureOutput();
    });
    child.stderr.on('data', chunk => {
      workerStderr = boundedOutputAppend(workerStderr, chunk);
      inspectFixtureOutput();
    });
    try {
      childIdentity = captureGatedProcessIdentitySync(child.pid, {
        expectedCommandMarker: marker,
        expectedCommand: workerTitle,
        requireOwnProcessGroup: process.platform !== 'win32',
      });
    } catch(error){
      abortPhaseSpawnGate(child, spawnGate);
      await terminateUncapturedWorkerHandle(child, exitPromise);
      throw error;
    }
    rememberExact(childIdentity, rememberedWorkerProcesses);
    await releasePhaseSpawnGate(child, spawnGate);

    const raceWithOuterWatchdog = async () => {
      let timer;
      try {
        return await Promise.race([
          exitPromise,
          new Promise(resolve => {
            timer = setTimeout(() => resolve({ timeout: true }), outerTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    let outcome;
    if(options.armAfterFixture){
      const readiness = await Promise.race([
        exitPromise.then(value => ({ exited: true, value })),
        timebox(fixtureReady, fixtureReadyTimeoutMs, 'wait for Phase 4 fixture readiness').then(() => ({ ready: true })),
      ]);
      outcome = readiness.exited ? readiness.value : await raceWithOuterWatchdog();
    } else {
      outcome = await raceWithOuterWatchdog();
    }

    if(outcome.timeout){
      timedOut = true;
      process.stderr.write(`runner.phase4 exceeded outer watchdog ${outerTimeoutMs}ms\n`);
      const survivors = await terminateOwnedProcessTrees(child, childIdentity, marker, rememberedWorkerProcesses);
      if(survivors.error) cleanupErrors.push(survivors.error);
      if(survivors.markerSurvivors.length || survivors.pidSurvivors.length || survivors.groupSurvivors.length){
        cleanupErrors.push(new Error(`Phase 4 watchdog survivors: ${JSON.stringify(survivors)}`));
      }
      try { await timebox(exitPromise, 3_000, 'wait for timed-out Phase 4 worker exit'); }
      catch(error){ cleanupErrors.push(error); }
      exitCode = 124;
    } else {
      if(outcome.error){
        throw new Error(`Phase 4 worker failed to spawn: ${outcome.error.message}`, { cause: outcome.error });
      }
      exitCode = Number.isInteger(outcome.code) ? outcome.code : 1;
      if(outcome.signal && exitCode === 0) exitCode = 1;
      if(exitCode === 0){
        assert.doesNotMatch(`${workerStdout}\n${workerStderr}`, /(?:runner\.phase4:\s*PASS|DEV PASS)/i,
          'Phase 4 worker attempted to print the parent-only verdict');
        validated = await validateWorkerReport({ options, outputDirectory, reportPath });
        if(options.promotionAuthorized){
          assertCandidateAuthorizationLive(options.candidateAuthorization);
          await assertPhase4ReleaseClaim(options.releaseClaim);
          await assertPhase4InputManifestUnchanged(ROOT, parentBuildInputs, 'pre-stage Phase 4 build inputs');
          parentBaselineOld = await validateParentOldBaseline(marker);
          assert.deepEqual(parentBaselineOld, validated.report.baselineOld,
            'worker old baseline report differs from authoritative parent baseline');
          // Every staging and backup path is registered before the first copy.
          transaction = createPromotionTransaction({
            marker, runnerRoot: RUNNER, golfRoot: GOLF, outputDirectory, validated,
          });
          await stagePromotionTransaction(transaction);
        }
      }
    }
  } catch(error){
    cleanupErrors.push(error);
    if(!timedOut) exitCode = 1;
  } finally {
    try {
      const survivors = childIdentity
        ? await terminateOwnedProcessTrees(child, childIdentity, marker, rememberedWorkerProcesses)
        : (await terminateUncapturedWorkerHandle(child, exitPromise), {
          markerSurvivors: processSnapshotMarkerMatches(captureProcessTableSnapshotSync(), marker)
            .filter(record => record.pid !== process.pid && !record.state.startsWith('Z')),
          pidSurvivors: [],
          groupSurvivors: [],
          error: null,
        });
      if(survivors.error) cleanupErrors.push(survivors.error);
      if(survivors.markerSurvivors.length || survivors.pidSurvivors.length || survivors.groupSurvivors.length){
        cleanupErrors.push(new Error(`Phase 4 cleanup survivors: ${JSON.stringify(survivors)}`));
      }
    } catch(error){
      cleanupErrors.push(error);
    }
    releaseChildProcessHandles(child);
    try {
      await timebox(rm(tempDirectory, { recursive: true, force: true }), 5_000, 'remove parent-owned Phase 4 temp directory');
    } catch(error){
      cleanupErrors.push(error);
    }
    try {
      teardownResources = await assertNoIntroducedResources(handleScope);
    } catch(error){
      cleanupErrors.push(error);
    }
  }

  if(exitCode === 0 && cleanupErrors.length === 0 && options.promotionAuthorized){
    try {
      assertCandidateAuthorizationLive(options.candidateAuthorization);
      await assertPhase4ReleaseClaim(options.releaseClaim);
      await assertPhase4InputManifestUnchanged(ROOT, parentBuildInputs, 'pre-install Phase 4 build inputs');
      await installPromotionTransaction(transaction);
      await validateInstalledTransaction(transaction);
      installedNetworkParity = await validateFinalPromotedParity(validated, marker);
      assert.deepEqual(
        processSnapshotMarkerMatches(captureProcessTableSnapshotSync(), marker)
          .filter(record => record.pid !== process.pid && !record.state.startsWith('Z')),
        [],
        'Phase 4 installed validation found surviving marker processes',
      );
      try {
        await lstat(tempDirectory);
        throw new Error(`Phase 4 parent temp still exists after cleanup: ${tempDirectory}`);
      } catch(error){
        if(error?.code !== 'ENOENT') throw error;
      }
      teardownResources = await assertNoIntroducedResources(handleScope, 'Phase 4 post-promotion supervisor');
      await verifyFrozenPhase4Sources(ROOT);
      assertCandidateAuthorizationLive(options.candidateAuthorization);
      await assertPhase4ReleaseClaim(options.releaseClaim);
      await preparePromotionForCommitGate(transaction);
      assert.equal(transaction.state, 'awaiting-grant',
        'Phase 4 did not retain provisional READY state');
      const supervisorReport = {
        version: 1,
        transactionId: marker,
        decisionNonce: options.candidateAuthorization.nonce,
        state: 'READY',
        candidateFresh: { ...validated.report.candidateFresh },
        parentBuildInputs,
        baselineOld: parentBaselineOld,
        validatedArtifacts: {
          shots: validated.shots.map(({ relativePath, bytes, sha256: hash }) => ({
            relativePath, bytes, sha256: hash,
          })),
          frameBoard: {
            relativePath: validated.frameBoard.relativePath,
            bytes: validated.frameBoard.bytes,
            sha256: validated.frameBoard.sha256,
          },
          worlds: {
            runner: validated.worlds.runner.sha256,
            golf: validated.worlds.golf.sha256,
          },
        },
        installedNetworkParity,
      };
      writePhase4SupervisorReportSync({
        reportPath: options.supervisorReportPath,
        tempRoot: process.env.TMPDIR || tmpdir(),
        report: supervisorReport,
      });
      publishCommitReadySync(options.candidateAuthorization, process.env.TMPDIR || tmpdir());
      const grantDeadline = Date.now() + 45_000;
      while(true){
        const coordination = readCommitCoordinationStateSync(
          options.candidateAuthorization,
          process.env.TMPDIR || tmpdir(),
        );
        if(coordination.decision === 'REVOKED'){
          throw new Error('outer release REVOKED provisional Phase 4 before final commit ACK');
        }
        if(coordination.decision === 'COMMIT_GRANTED') break;
        if(Date.now() >= grantDeadline) throw new Error('outer COMMIT_GRANTED exceeded 45s bound');
        await sleep(20);
      }
      // From the grant observation through the durable commit-intent journal and
      // atomic backup-root rename there is no event-loop yield. These are the
      // last authority/input checks and all precede the durable FINAL_COMMIT_ACK.
      finalizeGrantedPromotionJournalSync({
        projectRoot: ROOT,
        transactionId: marker,
        transaction,
        finalCommitGuard: () => {
          const coordination = readCommitCoordinationStateSync(
            options.candidateAuthorization,
            process.env.TMPDIR || tmpdir(),
          );
          assert.equal(coordination.decision, 'COMMIT_GRANTED',
            'final commit ACK requires outer COMMIT_GRANTED');
          assertCandidateAuthorizationLive(options.candidateAuthorization);
          assertPhase4ReleaseClaimSync(options.releaseClaim);
          assertPhase4InputManifestUnchangedSync(
            ROOT, parentBuildInputs, 'final Phase 4 build inputs',
          );
        },
      });
      transaction.committed = true;
      transaction.state = 'committed';
      writePhase4SupervisorReportSync({
        reportPath: options.supervisorReportPath,
        tempRoot: process.env.TMPDIR || tmpdir(),
        report: { ...supervisorReport, state: 'ACKED_NEW' },
      });
      assert.deepEqual((await transactionResidues(transaction)).map(entry => entry.kind).sort(),
        ['committed-backup-root', 'journal'],
        'FINAL_COMMIT_ACK must retain only its terminal classification receipt');
    } catch(error){
      const errors = [error];
      if(transaction && !transaction.committed){
        try { await cleanupUninstalledTransaction(transaction); }
        catch(rollbackError){ errors.push(rollbackError); }
      }
      cleanupErrors.push(new AggregateError(errors, 'Phase 4 promotion transaction failed'));
      exitCode = 1;
    }
  }
  if(transaction && !transaction.committed
    && !['rolled-back', 'stage-failed', 'awaiting-grant'].includes(transaction.state)){
    try { await cleanupUninstalledTransaction(transaction); }
    catch(error){ cleanupErrors.push(error); }
  }

  if(cleanupErrors.length){
    if(workerStdout.trim()) process.stderr.write(`runner.phase4 worker stdout:\n${workerStdout.trim()}\n`);
    if(workerStderr.trim()) process.stderr.write(`runner.phase4 worker stderr:\n${workerStderr.trim()}\n`);
    for(const error of cleanupErrors){
      process.stderr.write(`runner.phase4 supervisor: ${error?.stack || error}\n`);
    }
    if(!timedOut) exitCode = 1;
  } else if(exitCode !== 0){
    if(workerStdout.trim()) process.stderr.write(`${workerStdout.trim()}\n`);
    if(workerStderr.trim()) process.stderr.write(`${workerStderr.trim()}\n`);
  }

  let success = null;
  if(exitCode === 0){
    const validatedArtifacts = {
      report: validated.reportMetadata,
      shots: validated.shots.map(({ relativePath, bytes, sha256: hash }) => ({ relativePath, bytes, sha256: hash })),
      frameBoard: validated.frameBoard ? {
        relativePath: validated.frameBoard.relativePath,
        bytes: validated.frameBoard.bytes,
        sha256: validated.frameBoard.sha256,
      } : null,
    };
    const summary = {
      mode: options.workerMode,
      releaseEligible: false,
      outerAckRequired: options.promotionAuthorized,
      commitGranted: transaction?.state === 'committed',
      finalCommitAckCompleted: transaction?.state === 'committed',
      candidateFresh: validated.report.candidateFresh,
      baselineOld: parentBaselineOld || validated.report.baselineOld,
      parity: installedNetworkParity,
      parentFrozenSources,
      parentBuildInputs,
      installedNetworkParity,
      validatedArtifacts,
      teardownActiveResources: teardownResources,
    };
    success = {
      verdict: options.promotionAuthorized
        ? 'runner.phase4: FINAL COMMIT ACK COMPLETE'
        : 'DEV PASS — NOT RELEASE ELIGIBLE',
      summary,
    };
  }
  return { exitCode, success };
}

async function main(){
  // These checks intentionally happen before handle capture, mkdtemp, or spawn.
  const options = parseArguments(process.argv.slice(2));
  assertCleanInheritedEnvironment();
  const normalRelease = options.mode === 'release'
    && !options.fixture && !options.lockOnlyMs && !options.recoverOnly;
  if(!normalRelease && process.env.PLAYFORGE_CANDIDATE_HANDOFF_PATH !== undefined){
    throw new Error('candidate handoff is valid only for a normal non-fixture Phase 4 release');
  }
  if(!normalRelease && process.env.PLAYFORGE_PHASE4_SUPERVISOR_REPORT_PATH !== undefined){
    throw new Error('supervisor report path is valid only for a normal non-fixture Phase 4 release');
  }
  let candidateAuthorization = null;
  if(normalRelease){
    candidateAuthorization = await consumeCandidateHandoff({
      handoffPath: process.env.PLAYFORGE_CANDIDATE_HANDOFF_PATH,
      tempRoot: process.env.TMPDIR || tmpdir(),
      expectedOuterMarker: process.env.PLAYFORGE_RELEASE_RUN_MARKER,
    });
    assert.equal(typeof process.env.PLAYFORGE_PHASE4_SUPERVISOR_REPORT_PATH, 'string',
      'normal Phase 4 release requires an outer-owned supervisor report path');
  }
  options.candidateAuthorization = candidateAuthorization;
  options.supervisorReportPath = normalRelease
    ? path.resolve(process.env.PLAYFORGE_PHASE4_SUPERVISOR_REPORT_PATH) : null;
  options.gameplayTestedHashes = candidateAuthorization?.candidateFresh || null;
  options.promotionAuthorized = Boolean(normalRelease && candidateAuthorization);
  options.workerMode = options.fixture ? 'dev' : options.mode;
  options.marker = options.testMarker || candidateAuthorization?.outerMarker
    || `playforge-phase4-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let releaseLock = null;
  let result;
  let recovery = null;
  let primaryError = null;
  try {
    if(options.mode === 'release' && !options.fixture){
      if(options.promotionAuthorized) assertCandidateAuthorizationLive(options.candidateAuthorization);
      releaseLock = await acquirePhase4ReleaseLock({
        claimDirectory: RELEASE_CLAIM_DIRECTORY,
        marker: options.marker,
      });
      await assertPhase4ReleaseClaim(releaseLock);
      options.releaseClaim = releaseLock;
      recovery = await recoverPromotionJournal({ projectRoot: options.testRecoveryRoot || ROOT });
    }
    if(options.recoverOnly){
      console.log(JSON.stringify(recovery, null, 2));
      return 0;
    }
    if(options.lockOnlyMs){
      process.stderr.write(`runner-phase4-lock-held:${options.marker}\n`);
      await timebox(sleep(options.lockOnlyMs), options.lockOnlyMs + 1_000, 'Phase 4 lock-only fixture');
      return 0;
    }
    result = await runSupervisor(options);
    if(options.fixture){
      if(result.exitCode === 0){
        throw new Error(`negative fixture ${options.fixture} unexpectedly succeeded; fixtures are structurally nonpromoting`);
      }
      result.success = null;
    }
  } catch(error){
    primaryError = error;
  } finally {
    if(releaseLock){
      try { await releasePhase4ReleaseLock(releaseLock); }
      catch(error){
        if(primaryError) throw new AggregateError([primaryError, error], 'Phase 4 supervisor and lock release failed');
        throw error;
      }
    }
  }
  if(primaryError) throw primaryError;
  // The parent-only verdict is emitted only after the release lock has been
  // successfully relinquished. A lock-release failure can therefore never
  // leave a false PASS in the transcript.
  if(result?.success){
    console.log(result.success.verdict);
    console.log(JSON.stringify(result.success.summary, null, 2));
  }
  return result?.exitCode ?? 1;
}

try {
  process.exitCode = await main();
} catch(error){
  process.stderr.write(`runner.phase4 supervisor preflight failed: ${error?.stack || error}\n`);
  process.exitCode = 1;
}
