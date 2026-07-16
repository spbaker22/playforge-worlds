import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acknowledgeCapturedGatedSentinelIfAlone,
  abortCapturedGatedNode,
  capturedGatedTargetResult,
  releaseCapturedGatedNode,
  spawnCapturedGatedNode,
} from './phase-isolated-node.mjs';
import { finalizeCapturedGatedProcessGroup } from './phase-group-finalizer.mjs';
import {
  bindProcessSnapshotIdentity,
  captureProcessTableSnapshotSync,
  processSnapshotCommandUnavailable,
  processSnapshotMarkerMatches,
} from './runner.phase4.lock.mjs';
import {
  exactMarkerProcessRecords,
  signalExactMarkerProcesses,
} from './phase-marker-processes.mjs';

const POST_WATCHDOG = fileURLToPath(new URL('./post.browser.watchdog.test.mjs', import.meta.url));
const RUNNER_WATCHDOG = fileURLToPath(new URL('./runner.hard-gate.watchdog.test.mjs', import.meta.url));
const NESTED_LEAK_FIXTURE = fileURLToPath(new URL('./phase-nested-leak.fixture.mjs', import.meta.url));

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function cleanupOuterGateTree(owned, marker){
  if(process.platform === 'win32'){
    const report = await finalizeCapturedGatedProcessGroup(owned, {
      label: 'outer-gated Windows integration tree',
    });
    return { nestedGroups: 0, provenGroups: report.final.state === 'PROVEN_DEAD' ? 1 : 0 };
  }
  const errors = [];
  const identities = [];
  try {
    const snapshot = captureProcessTableSnapshotSync();
    const markerRecords = processSnapshotMarkerMatches(snapshot, marker)
      .filter(record => !record.state.startsWith('Z'));
    for(const record of markerRecords){
      if(processSnapshotCommandUnavailable(record)){
        errors.push(new Error(`outer-gate marker PID ${record.pid} has argv unavailable`));
        continue;
      }
      try { identities.push(bindProcessSnapshotIdentity(snapshot, record)); }
      catch(error){ errors.push(error); }
    }
  } catch(error){ errors.push(error); }
  const nestedGroups = new Map();
  for(const identity of identities){
    if(identity.pgid === identity.pid && identity.pgid !== owned.identity.pgid){
      nestedGroups.set(identity.pgid, identity);
    }
  }
  let provenGroups = 0;
  for(const identity of nestedGroups.values()){
    try {
      const report = await finalizeCapturedGatedProcessGroup({ identity, child: null }, {
        label: `outer-gate nested group ${identity.pgid}`,
      });
      if(report.final.state === 'PROVEN_DEAD') provenGroups += 1;
    } catch(error){ errors.push(error); }
  }
  const exact = signalExactMarkerProcesses(marker, 'SIGKILL');
  errors.push(...exact.errors);
  try {
    const report = await finalizeCapturedGatedProcessGroup(owned, {
      label: 'outer-gated integration group',
    });
    if(report.final.state === 'PROVEN_DEAD') provenGroups += 1;
  } catch(error){ errors.push(error); }
  let markerSurvivors = [];
  try {
    for(let attempt = 0; attempt < 40; attempt += 1){
      markerSurvivors = exactMarkerProcessRecords(marker).records;
      if(markerSurvivors.length === 0) break;
      await sleep(25);
    }
    if(markerSurvivors.length){
      errors.push(new Error(`outer-gated marker survivors: ${markerSurvivors.map(record => record.pid).join(', ')}`));
    }
  } catch(error){ errors.push(error); }
  if(errors.length) throw new AggregateError(errors, 'outer-gated integration cleanup failed');
  return { nestedGroups: nestedGroups.size, provenGroups };
}

async function runInsideOuterGate(label, args, timeoutMs){
  const title = `outer-gated-${label}-${process.pid}-${Date.now()}`;
  const owned = spawnCapturedGatedNode({
    title,
    args,
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PLAYFORGE_OUTER_GATE_TEST_MARKER: title },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { child } = owned;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = owned.protocol.closed;
  let timer;
  let result;
  let cleanupReport = { nestedGroups: 0 };
  try {
    await releaseCapturedGatedNode(owned);
    result = await Promise.race([
      capturedGatedTargetResult(owned),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} outer-gated integration timed out`)), timeoutMs);
      }),
    ]);
    assert.equal(result.code, 0, `${stdout}\n${stderr}`);
    assert.equal(result.signal, null, `${stdout}\n${stderr}`);
    await acknowledgeCapturedGatedSentinelIfAlone(owned);
  } finally {
    clearTimeout(timer);
    let cleanupError = null;
    try { cleanupReport = await cleanupOuterGateTree(owned, title); }
    catch(error){ cleanupError = error; }
    abortCapturedGatedNode(owned);
    await closed;
    if(cleanupError) throw cleanupError;
  }
  return { stdout, stderr, result, cleanupReport };
}

test('post-browser watchdog retains isolated harness and worker groups under a real outer gate', {
  timeout: 30_000,
}, async () => {
  const output = await runInsideOuterGate('post-watchdog', [
    '--test',
    '--test-timeout=30000',
    '--test-name-pattern=outer watchdog preempts',
    POST_WATCHDOG,
  ], 25_000);
  assert.match(output.stdout, /pass 1/);
  assert.doesNotMatch(output.stderr, /cleanup survivors|captured child process group aliases/);
});

test('Runner hard-gate watchdog retains nested phase isolation under a real outer gate', {
  timeout: 20_000,
}, async () => {
  const output = await runInsideOuterGate('runner-watchdog', [
    '--test',
    '--test-timeout=30000',
    RUNNER_WATCHDOG,
  ], 15_000);
  assert.match(output.stdout, /pass 2/);
  assert.doesNotMatch(output.stderr, /cleanup failed|captured child process group aliases/);
});

test('outer-gate cleanup captures and terminates an intentionally leaked nested gated group', {
  timeout: 10_000,
}, async () => {
  const output = await runInsideOuterGate('nested-leak', [
    NESTED_LEAK_FIXTURE,
    `outer-gated-nested-leak-${process.pid}`,
  ], 5_000);
  assert.match(output.stdout, /nested-leak-created/);
  assert.ok(output.cleanupReport.nestedGroups >= 1,
    'integration cleanup did not bind the leaked nested process group');
  assert.ok(output.cleanupReport.provenGroups >= output.cleanupReport.nestedGroups + 1,
    'integration cleanup did not final-prove every nested group plus the outer group');
});
