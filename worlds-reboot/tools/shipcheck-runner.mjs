/* Authoritative Gridlock Run hard gate.
   Unit/orientation tests and the fresh-browser gate run as child processes so
   this parent watchdog can preempt even a synchronous child event-loop hang. */
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acknowledgeCapturedGatedSentinelIfAlone,
  abortCapturedGatedNode,
  capturedGatedTargetResult,
  releaseCapturedGatedNode,
  scopedGatedTitle,
  spawnCapturedGatedNode,
} from './phase-isolated-node.mjs';
import { finalizeCapturedGatedProcessGroup } from './phase-group-finalizer.mjs';

if(process.platform === 'win32'){
  throw new Error('Gridlock Run verification requires POSIX process-group isolation; win32 is unsupported');
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const candidateMode = process.argv.includes('--candidate');
const browserOnly = process.argv.includes('--browser-only');
if(candidateMode && browserOnly){
  throw new Error('Runner hard gate candidate and browser-only modes are mutually exclusive');
}
const expectedArguments = candidateMode ? ['--candidate'] : browserOnly ? ['--browser-only'] : [];
if(JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expectedArguments)){
  throw new Error('unknown Runner hard-gate arguments');
}
const rawTimeout = process.env.RUNNER_SHIPCHECK_TIMEOUT_MS;
const timeoutMs = rawTimeout === undefined || rawTimeout === '' ? 240_000 : Number(rawTimeout);
if(!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0){
  throw new RangeError('RUNNER_SHIPCHECK_TIMEOUT_MS must be a positive integer');
}

const unitFiles = [
  fileURLToPath(new URL('./runner.sim.unit.test.mjs', import.meta.url)),
  fileURLToPath(new URL('./runner.geometry.unit.test.mjs', import.meta.url)),
  fileURLToPath(new URL('./runner.handle-scope.unit.test.mjs', import.meta.url)),
];
const browserGate = fileURLToPath(new URL('./runner.phase3.mjs', import.meta.url));
const artifactTempPrefix = `playforge-runner-phase3-gate-${process.pid}-${Date.now().toString(36)}-`;
const injectedHang = process.env.RUNNER_SHIPCHECK_INJECT_UNIT_HANG;
if(injectedHang !== undefined && !/^[A-Za-z0-9:_-]{8,120}$/.test(injectedHang)){
  throw new RangeError('RUNNER_SHIPCHECK_INJECT_UNIT_HANG must be an ownership marker');
}
const hangMarker = `playforge-runner-unit-sync-hang:${String(injectedHang || process.pid).slice(0, 120)}`;
const hangFixture = fileURLToPath(new URL('./runner.unit-sync-hang.fixture.mjs', import.meta.url));
const injectedFastExit = process.env.RUNNER_SHIPCHECK_INJECT_FAST_EXIT_LEAK;
if(injectedFastExit !== undefined && !/^[A-Za-z0-9:_-]{8,120}$/.test(injectedFastExit)){
  throw new RangeError('RUNNER_SHIPCHECK_INJECT_FAST_EXIT_LEAK must be an ownership marker');
}
if(injectedHang && injectedFastExit){
  throw new Error('Runner hard-gate injections are mutually exclusive');
}
const fastExitFixture = fileURLToPath(new URL('./runner.fast-exit-leak.fixture.mjs', import.meta.url));

const browserPhase = Object.freeze({
  name: 'runner-browser',
  args: [browserGate],
  containmentEnvironment: 'RUNNER_PHASE3_CONTAINMENT_MARKER',
  env: {
    RUNNER_PHASE3_TEMP_PREFIX: artifactTempPrefix,
    RUNNER_PHASE3_ALLOW_CALLER_HANDLES: '0',
    RUNNER_PHASE3_CANDIDATE_MODE: candidateMode ? '1' : '0',
  },
});

const phases = injectedHang
  ? [{ name: 'runner-unit-sync-hang-fixture', args: [hangFixture, `${hangMarker}:parent`] }]
  : injectedFastExit
    ? [{ name: 'runner-fast-exit-leak-fixture', args: [fastExitFixture, injectedFastExit] }]
  : browserOnly ? [browserPhase] : [
      {
        name: 'runner-unit-and-geometry',
        args: ['--test', '--test-timeout=30000', ...unitFiles],
      },
      browserPhase,
    ];

async function ownedArtifactTemps(){
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(artifactTempPrefix))
    .map(entry => join(tmpdir(), entry.name));
}

async function cleanupOwnedArtifactTemps(){
  const cleanup = (async () => {
    const paths = await ownedArtifactTemps();
    await Promise.all(paths.map(path => rm(path, { recursive: true, force: true })));
    return paths;
  })();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('owned Runner temp cleanup exceeded 5000ms')), 5_000);
  });
  try { return await Promise.race([cleanup, timeout]); }
  finally { clearTimeout(timer); }
}

let activeOwned = null;
let activePhase = null;
let timedOut = false;
let terminationError = null;
let watchdogTermination = Promise.resolve();

const watchdog = setTimeout(() => {
  timedOut = true;
  console.error(JSON.stringify({
    ok: false,
    phase: activePhase,
    error: `Runner hard gate exceeded outer watchdog (${timeoutMs}ms)`,
  }, null, 2));
  const timedOutOwned = activeOwned;
  watchdogTermination = timedOutOwned
    ? finalizeCapturedGatedProcessGroup(timedOutOwned, {
        label: 'Runner watchdog captured phase group',
      }).catch(error => {
        terminationError = error;
      })
    : Promise.resolve();
}, timeoutMs);

async function runPhase(phase){
  if(timedOut) return { code: 124, signal: null };
  activePhase = phase.name;
  const phaseTitlePrefix = injectedHang || `runner-phase-${process.pid}-${Date.now()}`;
  const phaseTitle = scopedGatedTitle(`${phaseTitlePrefix}:${phase.name}`);
  const phaseEnvironment = { ...process.env, ...(phase.env || {}) };
  if(phase.containmentEnvironment) phaseEnvironment[phase.containmentEnvironment] = phaseTitle;
  const owned = spawnCapturedGatedNode({
    title: phaseTitle,
    args: phase.args,
    cwd: ROOT,
    env: phaseEnvironment,
    stdio: 'inherit',
  });
  activeOwned = owned;
  let result = null;
  let primaryError = null;
  let finalizationReport = null;
  let acknowledgementReport = null;
  try {
    await releaseCapturedGatedNode(owned);
    result = await capturedGatedTargetResult(owned);
    acknowledgementReport = await acknowledgeCapturedGatedSentinelIfAlone(owned);
  } catch(error){
    primaryError = error;
  } finally {
    const cleanupErrors = [];
    if(timedOut && activeOwned === owned) await watchdogTermination;
    if(acknowledgementReport?.acknowledged
      && acknowledgementReport.final?.state === 'PROVEN_DEAD'){
      finalizationReport = acknowledgementReport;
    } else {
      try {
        finalizationReport = await finalizeCapturedGatedProcessGroup(owned, {
          label: `Runner ${phase.name} captured phase group`,
        });
      } catch(error){
        finalizationReport = error?.report || null;
        cleanupErrors.push(error);
      }
    }
    const initialMembers = acknowledgementReport?.initial?.memberPids || [];
    if(result?.code === 0 && initialMembers.some(pid => pid !== owned.identity.pid)){
      cleanupErrors.push(new Error(`Runner phase ${phase.name} exited successfully with live process-group members`));
    }
    abortCapturedGatedNode(owned);
    if(finalizationReport?.final?.state === 'PROVEN_DEAD' && activeOwned === owned) activeOwned = null;
    if(cleanupErrors.length){
      primaryError = primaryError
        ? new AggregateError([primaryError, ...cleanupErrors], 'Runner phase failed and cleanup was incomplete')
        : new AggregateError(cleanupErrors, 'Runner phase cleanup was incomplete');
    }
  }
  if(primaryError) throw primaryError;
  return result;
}

let failedPhase = null;
let failedResult = null;
let residueError = null;
let executionError = null;
let retainedCleanupError = null;
try {
  for(const phase of phases){
    if(timedOut) break;
    const result = await runPhase(phase);
    if(timedOut) break;
    if(result.code !== 0){
      failedPhase = phase;
      failedResult = result;
      break;
    }
  }
} catch(error){
  executionError = error;
} finally {
  clearTimeout(watchdog);
  if(timedOut) await watchdogTermination;
  if(activeOwned){
    let report = null;
    try {
      report = await finalizeCapturedGatedProcessGroup(activeOwned, {
        label: 'Runner retained captured phase group',
      });
    } catch(error){
      report = error?.report || null;
      retainedCleanupError = error;
    }
    if(report?.final?.state === 'PROVEN_DEAD') activeOwned = null;
  }
  try {
    const residues = await cleanupOwnedArtifactTemps();
    if(!timedOut && !failedResult && residues.length){
      residueError = new Error(`Runner browser gate left temporary artifacts: ${residues.join(', ')}`);
    }
  } catch(error){
    residueError = error;
  }
}

if(timedOut){
  if(terminationError) console.error(`Runner watchdog cleanup failed: ${terminationError.message}`);
  if(executionError) console.error(`Runner timed-out phase failed: ${executionError.message}`);
  if(retainedCleanupError) console.error(`Runner retained-group cleanup failed: ${retainedCleanupError.message}`);
  if(residueError) console.error(`Runner temporary-artifact cleanup failed: ${residueError.message}`);
  process.exitCode = 124;
} else if(executionError || retainedCleanupError || residueError){
  const errors = [executionError, retainedCleanupError, residueError].filter(Boolean);
  const terminalError = errors.length === 1
    ? errors[0]
    : new AggregateError(errors, 'Runner hard gate and cleanup failed');
  console.error(terminalError.stack || terminalError.message);
  process.exitCode = 1;
} else if(failedResult){
  process.exitCode = Number.isInteger(failedResult.code) ? failedResult.code : 1;
  console.error(`Runner hard gate phase ${failedPhase.name} failed${failedResult.signal ? ` by ${failedResult.signal}` : ''}`);
}
