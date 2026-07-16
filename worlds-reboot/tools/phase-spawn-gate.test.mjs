import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RECOVERY_ANCESTOR_MARKER_ENV,
  acknowledgeCapturedGatedSentinelIfAlone,
  capturedGatedTargetResult,
  createCapturedSentinelProtocol,
  scopedGatedTitle,
} from './phase-isolated-node.mjs';
import {
  abortPhaseSpawnGate,
  captureGatedProcessIdentitySync,
  createPhaseSpawnGate,
  gatedChildEnvironment,
  gatedNodeArguments,
  releasePhaseSpawnGate,
} from './phase-spawn-gate-parent.mjs';
import {
  advanceArgsUnavailableGrace,
  exactDirectChildIdentityState,
  inspectCapturedProcessGroup,
  signalCapturedProcessGroup,
  signalExactIdentitySet,
} from './phase-process-cleanup.mjs';
import {
  bindProcessSnapshotIdentity,
  captureProcessTableSnapshotSync,
  exactProcessSnapshotIdentityState,
  processSnapshotMarkerMatches,
  signalExactProcessSnapshotIdentity,
} from './runner.phase4.lock.mjs';
import {
  encodePhaseNodeCommand,
  PHASE_NODE_COMMAND_PATH,
} from './phase-node-command-spec.mjs';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const GATE_MODULE_URL = new URL('./phase-spawn-gate.mjs', import.meta.url).href;
const DESCENDANT_MODULE_URL = new URL('./phase-descendant-marker.mjs', import.meta.url).href;
const GUARD_FIXTURE = fileURLToPath(new URL('./phase-child-process-guard.fixture.mjs', import.meta.url));
const dispatchedArguments = args => ['--', PHASE_NODE_COMMAND_PATH, encodePhaseNodeCommand(args)];

function manualGatedEnvironment(gate, environment = process.env){
  const recoveryAncestor = environment[RECOVERY_ANCESTOR_MARKER_ENV]
    || process.env[RECOVERY_ANCESTOR_MARKER_ENV]
    || gate.descendantMarker;
  return gatedChildEnvironment({
    ...environment,
    [RECOVERY_ANCESTOR_MARKER_ENV]: recoveryAncestor,
  }, gate);
}

function capturedManualLaunch(child, identity, gate, protocol){
  return Object.freeze({ child, identity, gate, protocol });
}

async function waitForOutput(read, label, timeoutMs = 1_000){
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while(!value.trim() && Date.now() < deadline){
    await sleep(10);
    value = read();
  }
  assert.ok(value.trim(), `${label} emitted no output`);
  return value;
}

async function exists(candidate){
  try { await access(candidate); return true; }
  catch(error){
    if(error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function waitForExit(child, timeoutMs = 3_000){
  if(child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve, reject) => {
      child.once('close', resolve);
      child.once('error', reject);
    }),
    sleep(timeoutMs).then(() => { throw new Error(`child ${child.pid} did not exit in ${timeoutMs}ms`); }),
  ]);
}

async function waitForIdentityDeath(identity, timeoutMs = 3_000){
  const deadline = Date.now() + timeoutMs;
  let state;
  do {
    state = exactProcessSnapshotIdentityState(identity, {
      snapshot: captureProcessTableSnapshotSync(),
    });
    if(state.state === 'PROVEN_DEAD') return state;
    await sleep(25);
  } while(Date.now() < deadline);
  throw new Error(`PID ${identity.pid} remained ${state?.state || 'UNKNOWN'}: ${state?.reason || 'unknown'}`);
}

async function runGuardFixture(mode, { timeoutMs = 15_000, afterClose = null } = {}){
  const marker = `phase4-guard-${mode}-${process.pid}-${Date.now()}`;
  const title = scopedGatedTitle(`${marker}:leader`);
  const gate = createPhaseSpawnGate(title);
  const targetArgs = [
    GUARD_FIXTURE,
    mode,
  ];
  const child = spawn(process.execPath, gatedNodeArguments(title, dispatchedArguments(targetArgs)), {
    detached: process.platform !== 'win32',
    env: manualGatedEnvironment(gate),
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ipc'],
  });
  const protocol = createCapturedSentinelProtocol(child, targetArgs);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let identity = null;
  let owned = null;
  const priorExactMemberIdentities = [];
  try {
    identity = captureGatedProcessIdentitySync(child.pid, {
      expectedCommand: title,
      requireOwnProcessGroup: process.platform !== 'win32',
    });
    owned = capturedManualLaunch(child, identity, gate, protocol);
    await releasePhaseSpawnGate(child, gate);
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${mode} guard fixture timed out`)), timeoutMs);
    });
    let result;
    try { result = await Promise.race([capturedGatedTargetResult(owned), timeoutPromise]); }
    finally { clearTimeout(timeout); }
    assert.equal(result.code, 0, stderr);
    assert.equal(result.signal, null, stderr);
    const completeOutput = await waitForOutput(() => stdout, `${mode} guard fixture`);
    const lines = completeOutput.trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 0, `${mode} guard fixture emitted no report`);
    const report = JSON.parse(lines.at(-1));
    if(afterClose){
      const suppliedAuthorities = await afterClose({ child, identity, marker, report, stderr, stdout });
      if(suppliedAuthorities !== undefined){
        assert.ok(Array.isArray(suppliedAuthorities),
          `${mode} afterClose exact-member authorities must be an array`);
        priorExactMemberIdentities.push(...suppliedAuthorities);
      }
    }
    const acknowledgement = await acknowledgeCapturedGatedSentinelIfAlone(owned);
    if(priorExactMemberIdentities.length){
      assert.equal(acknowledgement.acknowledged, false,
        `${mode} sentinel ACK ignored known same-group members`);
    } else {
      assert.equal(acknowledgement.acknowledged, true,
        `${mode} sentinel-only group was not acknowledged`);
      assert.equal(acknowledgement.final.state, 'PROVEN_DEAD',
        `${mode} dispatcher group was not final-proven after ACK`);
      assert.equal(acknowledgement.closed.code, result.code, stderr);
      assert.equal(acknowledgement.closed.signal, null, stderr);
    }
    return report;
  } finally {
    for(const line of stdout.trim().split('\n').filter(Boolean)){
      let emergency;
      try { emergency = JSON.parse(line); }
      catch { continue; }
      if(!Number.isSafeInteger(emergency?.emergencyPid) || emergency.emergencyPid <= 0) continue;
      const snapshot = captureProcessTableSnapshotSync();
      const record = snapshot.find(candidate => candidate.pid === emergency.emergencyPid);
      if(!record || record.state.startsWith('Z')) continue;
      try {
        const emergencyIdentity = bindProcessSnapshotIdentity(snapshot, record);
        signalExactProcessSnapshotIdentity(emergencyIdentity, 'SIGKILL');
      } catch {}
    }
    abortPhaseSpawnGate(child, gate);
    if(identity && process.platform !== 'win32') signalCapturedProcessGroup(identity, 'SIGKILL', {
      priorExactMemberIdentities,
    });
    if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await protocol.closed.catch(() => {});
    await protocol.result.catch(() => {});
  }
}

test('an UNKNOWN identity cannot skip a later exact LIVE cleanup target', async () => {
  const marker = `phase4-cleanup-${process.pid}-${Date.now()}`;
  const title = scopedGatedTitle(`${marker}:live`);
  const gate = createPhaseSpawnGate(title);
  const targetArgs = [
    GUARD_FIXTURE,
    'idle',
  ];
  const child = spawn(process.execPath, gatedNodeArguments(title, dispatchedArguments(targetArgs)), {
    detached: process.platform !== 'win32',
    env: manualGatedEnvironment(gate),
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'ipc'],
  });
  const protocol = createCapturedSentinelProtocol(child, targetArgs);
  protocol.result.catch(() => {});
  let liveIdentity = null;
  try {
    liveIdentity = captureGatedProcessIdentitySync(child.pid, {
      expectedCommand: title,
      requireOwnProcessGroup: process.platform !== 'win32',
    });
    await releasePhaseSpawnGate(child, gate);
    const liveSnapshot = captureProcessTableSnapshotSync();
    const fallbackSnapshot = Object.freeze(liveSnapshot.map(record => Object.freeze(
      record.pid === liveIdentity.pid ? { ...record, state: 'Rs', command: `(${record.ucomm})` } : record,
    )));
    assert.equal(exactDirectChildIdentityState(liveIdentity, child, {
      snapshot: fallbackSnapshot,
    }).reason, 'args-unavailable', 'a running direct child treated argv fallback as death');
    assert.deepEqual(exactDirectChildIdentityState(liveIdentity, {
      pid: liveIdentity.pid,
      exitCode: 0,
      signalCode: null,
    }, { snapshot: fallbackSnapshot }), {
      state: 'PROVEN_DEAD',
      processStart: null,
      reason: 'captured-child-handle-exited',
    }, 'the exact bound direct-child exit did not override only its stale fallback row');
    const fallbackSignals = [];
    assert.deepEqual(signalExactProcessSnapshotIdentity(liveIdentity, 'SIGKILL', {
      snapshotProbe: () => fallbackSnapshot,
      signalProcess: (...args) => fallbackSignals.push(args),
    }), { signalled: false, state: 'UNKNOWN', reason: 'args-unavailable' });
    assert.deepEqual(fallbackSignals, [], 'argv fallback authorized a numeric signal');
    const fakeUnknown = Object.freeze({ pid: Number.MAX_SAFE_INTEGER });
    const remembered = new Map([
      [fakeUnknown.pid, fakeUnknown],
      [liveIdentity.pid, liveIdentity],
    ]);
    const attempted = [];
    const result = signalExactIdentitySet(remembered, 'SIGTERM', {
      signalIdentity: (identity, signal) => {
        attempted.push(identity.pid);
        if(identity === fakeUnknown){
          return { signalled: false, state: 'UNKNOWN', reason: 'injected-first-identity' };
        }
        return signalExactProcessSnapshotIdentity(identity, signal);
      },
    });

    assert.deepEqual(attempted, [fakeUnknown.pid, liveIdentity.pid],
      'cleanup stopped before the later exact identity');
    assert.equal(result.ok, false, 'UNKNOWN must make the overall cleanup fail-safe');
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /injected-first-identity/);
    await waitForExit(child);
  } finally {
    abortPhaseSpawnGate(child, gate);
    if(liveIdentity && process.platform !== 'win32') signalCapturedProcessGroup(liveIdentity, 'SIGKILL');
    if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForExit(child).catch(() => {});
    await protocol.result.catch(() => {});
  }
});

test('empty and reused captured process groups never signal an unrelated PGID', () => {
  const identity = Object.freeze({
    pid: 700_001,
    pgid: 700_001,
    processStart: 'posix-lstart-utc:Tue Jul 14 20:01:01 2026',
    ucomm: 'node',
    command: 'phase4-original-group',
  });
  const signals = [];
  const options = snapshot => ({
    snapshotProbe: () => snapshot,
    signalGroup: (...args) => signals.push(args),
  });

  assert.deepEqual(signalCapturedProcessGroup(identity, 'SIGKILL', options([])), {
    signalled: false,
    state: 'PROVEN_DEAD',
    reason: 'process-group-empty',
  });
  assert.deepEqual(signalCapturedProcessGroup(identity, 'SIGKILL', options([{
    ...identity,
    ppid: 1,
    processStart: 'posix-lstart-utc:Tue Jul 14 20:02:01 2026',
    command: 'unrelated-reused-group',
    state: 'S',
  }])), {
    signalled: false,
    state: 'PROVEN_DEAD',
    reason: 'process-group-reused',
  });
  assert.deepEqual(signals, [], 'an empty or reused PGID received a negative-group signal');
});

test('leaderless reused process-group members are UNKNOWN and never receive a negative signal', () => {
  const identity = Object.freeze({
    pid: 700_101,
    pgid: 700_101,
    ppid: 1,
    processStart: 'posix-lstart-utc:Tue Jul 14 20:01:01 2026',
    state: 'S',
    ucomm: 'node',
    command: 'phase4-original-group',
  });
  const unrelatedMember = Object.freeze({
    pid: 700_102,
    pgid: identity.pgid,
    ppid: 1,
    processStart: 'posix-lstart-utc:Tue Jul 14 20:04:01 2026',
    state: 'S',
    ucomm: 'sleep',
    command: 'unrelated-leaderless-member',
  });
  const signals = [];
  assert.deepEqual(signalCapturedProcessGroup(identity, 'SIGKILL', {
    snapshotProbe: () => [unrelatedMember],
    signalGroup: (...args) => signals.push(args),
  }), {
    signalled: false,
    state: 'UNKNOWN',
    reason: 'leader-absent-without-exact-member-authority',
    memberPids: [unrelatedMember.pid],
  });
  assert.deepEqual(signals, [], 'leaderless numerical PGID reuse received a negative signal');
});

test('persistent argv-unavailable state expires only by bounded elapsed grace', () => {
  let grace = advanceArgsUnavailableGrace(null, true, { now: 1_000, graceMs: 250 });
  assert.deepEqual(grace, { startedAt: 1_000, expired: false });
  grace = advanceArgsUnavailableGrace(grace.startedAt, true, { now: 1_249, graceMs: 250 });
  assert.deepEqual(grace, { startedAt: 1_000, expired: false });
  grace = advanceArgsUnavailableGrace(grace.startedAt, true, { now: 1_250, graceMs: 250 });
  assert.deepEqual(grace, { startedAt: 1_000, expired: true },
    'persistent live fallback did not expire fail-closed');
  grace = advanceArgsUnavailableGrace(grace.startedAt, false, { now: 1_251, graceMs: 250 });
  assert.deepEqual(grace, { startedAt: null, expired: false },
    'exact command recovery did not reset pending fallback grace');
});

test('captured PGID cleanup survives target exit and kills an immediate unmarked child', async () => {
  if(process.platform === 'win32') return;
  const marker = `phase4-group-${process.pid}-${Date.now()}`;
  const title = scopedGatedTitle(`${marker}:leader`);
  const gate = createPhaseSpawnGate(title);
  const targetArgs = [
    GUARD_FIXTURE,
    'spawn-external-report',
  ];
  const child = spawn(process.execPath, gatedNodeArguments(title, dispatchedArguments(targetArgs)), {
    detached: true,
    env: manualGatedEnvironment(gate),
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ipc'],
  });
  const protocol = createCapturedSentinelProtocol(child, targetArgs);
  let stdout = '';
  let stderr = '';
  let sleeperIdentity = null;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let identity = null;
  let owned = null;
  try {
    identity = captureGatedProcessIdentitySync(child.pid, {
      expectedCommand: title,
      requireOwnProcessGroup: true,
    });
    owned = capturedManualLaunch(child, identity, gate, protocol);
    await releasePhaseSpawnGate(child, gate);
    const result = await capturedGatedTargetResult(owned);
    assert.equal(result.code, 0, stderr);
    assert.equal(result.signal, null, stderr);
    const completeOutput = await waitForOutput(() => stdout, 'external-report target');
    const sleeperPid = JSON.parse(completeOutput.trim().split('\n').at(-1)).sleeperPid;
    assert.ok(Number.isSafeInteger(sleeperPid) && sleeperPid > 0, `missing sleeper PID: ${stdout}`);
    assert.equal(child.exitCode, null, 'dispatcher sentinel exited before group proof');

    const snapshot = captureProcessTableSnapshotSync();
    const sleeperRecord = snapshot.find(record => record.pid === sleeperPid);
    assert.ok(sleeperRecord, `unmarked sleeper ${sleeperPid} was absent before cleanup`);
    assert.ok(!sleeperRecord.command.includes(marker), 'external sleeper unexpectedly carried the Node marker');
    sleeperIdentity = bindProcessSnapshotIdentity(snapshot, sleeperRecord);
    const before = inspectCapturedProcessGroup(identity, {
      snapshotProbe: () => snapshot,
      priorExactMemberIdentities: [sleeperIdentity],
    });
    assert.equal(before.state, 'LIVE');
    assert.ok(before.memberPids.includes(sleeperPid),
      `unmarked sleeper ${sleeperPid} was not retained by captured PGID ${identity.pgid}`);
    assert.ok(before.memberPids.includes(identity.pid), 'dispatcher sentinel did not retain the captured group');
    const acknowledgement = await acknowledgeCapturedGatedSentinelIfAlone(owned);
    assert.equal(acknowledgement.acknowledged, false,
      'dispatcher sentinel acknowledged while an unmarked member remained');

    const signalled = signalCapturedProcessGroup(identity, 'SIGKILL', {
      priorExactMemberIdentities: [sleeperIdentity],
    });
    assert.equal(signalled.signalled, true);
    assert.ok(signalled.memberPids.includes(sleeperPid));
    const closed = await protocol.closed;
    assert.ok(closed.signal === 'SIGKILL' || closed.code !== 0,
      `group SIGKILL unexpectedly closed cleanly: ${JSON.stringify(closed)}`);
    const deadline = Date.now() + 3_000;
    let after = inspectCapturedProcessGroup(identity, {
      priorExactMemberIdentities: [sleeperIdentity],
    });
    while(after.state === 'LIVE' && Date.now() < deadline){
      await sleep(25);
      after = inspectCapturedProcessGroup(identity, {
        priorExactMemberIdentities: [sleeperIdentity],
      });
    }
    assert.equal(after.state, 'PROVEN_DEAD',
      `captured group survived leader-independent SIGKILL: ${JSON.stringify(after)}`);
  } finally {
    if(identity) signalCapturedProcessGroup(identity, 'SIGKILL', {
      priorExactMemberIdentities: sleeperIdentity ? [sleeperIdentity] : [],
    });
    if(sleeperIdentity) signalExactProcessSnapshotIdentity(sleeperIdentity, 'SIGKILL');
    if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await protocol.closed.catch(() => {});
    await protocol.result.catch(() => {});
  }
});

test('hostile inherited NODE_OPTIONS is rejected before preload, target, or child side effects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'playforge-hostile-node-options-'));
  const preloadEffect = path.join(root, 'hostile-preload-ran');
  const targetEffect = path.join(root, 'target-ran');
  const childEffect = path.join(root, 'child-ran');
  const hostileModule = path.join(root, 'hostile-preload.mjs');
  await writeFile(hostileModule, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(preloadEffect)}, 'loaded');`,
  ].join('\n'));

  let spawnAttempted = false;
  try {
    const gate = createPhaseSpawnGate(`phase4-hostile-${process.pid}-${Date.now()}`);
    const hostileEnvironment = {
      ...process.env,
      NODE_OPTIONS: `--import=${pathToFileURL(hostileModule).href}`,
    };
    assert.throws(() => {
      const environment = gatedChildEnvironment(hostileEnvironment, gate);
      spawnAttempted = true;
      spawn(process.execPath, gatedNodeArguments(gate.descendantMarker, dispatchedArguments([
        GUARD_FIXTURE,
        'write-effects',
        targetEffect,
        childEffect,
      ])), { env: environment, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    }, /refuses inherited NODE_OPTIONS executable authority/);

    assert.equal(spawnAttempted, false, 'a child spawn was reached after hostile preload rejection');
    assert.equal(await exists(preloadEffect), false, 'hostile preload executed');
    assert.equal(await exists(targetEffect), false, 'gated target executed');
    assert.equal(await exists(childEffect), false, 'target spawned a child');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pre-GO EOF executes zero target JavaScript and leaves no owned process', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'playforge-spawn-gate-eof-'));
  const targetEffect = path.join(root, 'target-ran');
  const marker = `phase4-prego-${process.pid}-${Date.now()}`;
  const title = scopedGatedTitle(`${marker}:leader`);
  const gate = createPhaseSpawnGate(title);
  const targetArgs = [
    GUARD_FIXTURE,
    'write-effect',
    targetEffect,
  ];
  const child = spawn(process.execPath, gatedNodeArguments(title, dispatchedArguments(targetArgs)), {
    detached: process.platform !== 'win32',
    env: manualGatedEnvironment(gate),
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'ipc'],
  });
  const protocol = createCapturedSentinelProtocol(child, targetArgs);
  protocol.result.catch(() => {});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  let identity = null;
  try {
    identity = captureGatedProcessIdentitySync(child.pid, {
      expectedCommand: title,
      requireOwnProcessGroup: process.platform !== 'win32',
    });
    abortPhaseSpawnGate(child, gate);
    const result = await protocol.closed;
    assert.notEqual(result.code, 0, `pre-GO EOF unexpectedly succeeded: ${stderr}`);
    assert.equal(await exists(targetEffect), false, 'target JavaScript executed before GO');
    if(process.platform !== 'win32') await waitForIdentityDeath(identity);
    const residue = processSnapshotMarkerMatches(captureProcessTableSnapshotSync(), marker)
      .filter(record => record.pid !== process.pid && !record.state.startsWith('Z'));
    assert.deepEqual(residue, [], `pre-GO EOF left marker processes: ${JSON.stringify(residue)}`);
  } finally {
    abortPhaseSpawnGate(child, gate);
    if(identity && process.platform !== 'win32') signalCapturedProcessGroup(identity, 'SIGKILL');
    if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await protocol.closed.catch(() => {});
    await protocol.result.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('post-GO plain Node and node:test inherit marker authority without re-gating', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'playforge-spawn-gate-nested-'));
  const marker = `phase4-postgo-${process.pid}-${Date.now()}`;
  const title = scopedGatedTitle(`${marker}:leader`);
  const gate = createPhaseSpawnGate(title);
  const trustedOption = `--import=${DESCENDANT_MODULE_URL}`;
  const nestedTestPath = path.join(root, 'nested.test.mjs');
  await writeFile(nestedTestPath, [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "test('nested environment is marker-only', () => {",
    "  assert.equal(process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_FD, undefined);",
    "  assert.equal(process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE, undefined);",
    `  assert.equal(process.env.NODE_OPTIONS, ${JSON.stringify(trustedOption)});`,
    "  assert.ok(!process.env.NODE_OPTIONS.includes('phase-spawn-gate'));",
    '});',
  ].join('\n'));
  const targetArgs = [
    GUARD_FIXTURE,
    'nested-env',
    nestedTestPath,
  ];
  const child = spawn(process.execPath, gatedNodeArguments(title, dispatchedArguments(targetArgs)), {
    detached: process.platform !== 'win32',
    env: manualGatedEnvironment(gate, { ...process.env, NODE_OPTIONS: trustedOption }),
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ipc'],
  });
  const protocol = createCapturedSentinelProtocol(child, targetArgs);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let identity = null;
  let owned = null;
  try {
    identity = captureGatedProcessIdentitySync(child.pid, {
      expectedCommand: title,
      requireOwnProcessGroup: process.platform !== 'win32',
    });
    owned = capturedManualLaunch(child, identity, gate, protocol);
    await releasePhaseSpawnGate(child, gate);
    const result = await capturedGatedTargetResult(owned);
    assert.equal(result.code, 0, stderr);
    assert.equal(result.signal, null, stderr);
    const completeOutput = await waitForOutput(() => stdout, 'nested environment target');
    assert.equal(JSON.parse(completeOutput.trim().split('\n').at(-1)).nested, true);
    const acknowledgement = await acknowledgeCapturedGatedSentinelIfAlone(owned);
    assert.equal(acknowledgement.acknowledged, true);
    assert.equal(acknowledgement.closed.code, 0, stderr);
    assert.equal(acknowledgement.closed.signal, null, stderr);
    assert.equal(acknowledgement.final.state, 'PROVEN_DEAD');
    if(process.platform !== 'win32') await waitForIdentityDeath(identity);
  } finally {
    abortPhaseSpawnGate(child, gate);
    if(identity && process.platform !== 'win32') signalCapturedProcessGroup(identity, 'SIGKILL');
    if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await protocol.closed.catch(() => {});
    await protocol.result.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary detached Node is normalized into the captured PGID and remains marker-discoverable', async () => {
  if(process.platform === 'win32') return;
  const marker = `phase4-detached-${process.pid}-${Date.now()}`;
  const title = scopedGatedTitle(`${marker}:leader`);
  const gate = createPhaseSpawnGate(title);
  const targetArgs = [
    GUARD_FIXTURE,
    'ordinary-descendant-report',
  ];
  const child = spawn(process.execPath, gatedNodeArguments(title, dispatchedArguments(targetArgs)), {
    detached: true,
    env: manualGatedEnvironment(gate),
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ipc'],
  });
  const protocol = createCapturedSentinelProtocol(child, targetArgs);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let leaderIdentity = null;
  let descendantIdentity = null;
  let owned = null;
  try {
    leaderIdentity = captureGatedProcessIdentitySync(child.pid, {
      expectedCommand: title,
      requireOwnProcessGroup: true,
    });
    owned = capturedManualLaunch(child, leaderIdentity, gate, protocol);
    await releasePhaseSpawnGate(child, gate);
    const result = await capturedGatedTargetResult(owned);
    assert.equal(result.code, 0, stderr);
    assert.equal(result.signal, null, stderr);
    const completeOutput = await waitForOutput(() => stdout, 'ordinary descendant target');
    const descendantPid = JSON.parse(completeOutput.trim().split('\n').at(-1)).descendantPid;
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, `missing detached PID: ${stdout}`);

    const snapshot = captureProcessTableSnapshotSync();
    const markerRecords = processSnapshotMarkerMatches(snapshot, marker)
      .filter(record => !record.state.startsWith('Z'));
    const descendantRecord = markerRecords.find(record => record.pid === descendantPid);
    assert.ok(descendantRecord, `detached descendant ${descendantPid} was not marker-discoverable`);
    assert.equal(descendantRecord.command, `${marker}:owned-descendant`);
    descendantIdentity = bindProcessSnapshotIdentity(snapshot, descendantRecord, {
      expectedCommandMarker: marker,
      expectedCommand: `${marker}:owned-descendant`,
      requireOwnProcessGroup: false,
    });
    assert.equal(descendantIdentity.pgid, leaderIdentity.pgid,
      'ordinary detached Node escaped the captured phase PGID');
    assert.notEqual(descendantIdentity.pgid, descendantIdentity.pid,
      'ordinary detached Node retained its requested process group');
    const acknowledgement = await acknowledgeCapturedGatedSentinelIfAlone(owned);
    assert.equal(acknowledgement.acknowledged, false,
      'dispatcher sentinel acknowledged while a descendant remained');
    const signalled = signalCapturedProcessGroup(leaderIdentity, 'SIGKILL', {
      priorExactMemberIdentities: [descendantIdentity],
    });
    assert.equal(signalled.signalled, true);
    await waitForIdentityDeath(descendantIdentity);
    const residue = processSnapshotMarkerMatches(captureProcessTableSnapshotSync(), marker)
      .filter(record => record.pid !== process.pid && !record.state.startsWith('Z'));
    assert.deepEqual(residue, []);
  } finally {
    if(leaderIdentity) signalCapturedProcessGroup(leaderIdentity, 'SIGKILL', {
      priorExactMemberIdentities: descendantIdentity ? [descendantIdentity] : [],
    });
    if(descendantIdentity) signalExactProcessSnapshotIdentity(descendantIdentity, 'SIGKILL');
    abortPhaseSpawnGate(child, gate);
    if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await protocol.closed.catch(() => {});
    await protocol.result.catch(() => {});
  }
});

test('guard forces spawn, exec, and execFile external detach requests into the phase PGID', async () => {
  if(process.platform === 'win32') return;
  const report = await runGuardFixture('external');
  assert.ok(report.expected > 0);
});

test('guard forces an ordinary detached Node request into the phase PGID', async () => {
  if(process.platform === 'win32') return;
  const report = await runGuardFixture('ordinary-node');
  assert.ok(report.expected > 0);
});

test('guard always treats a shell launch as attached external work', async () => {
  if(process.platform === 'win32') return;
  const report = await runGuardFixture('shell');
  assert.ok(report.expected > 0);
});

test('guard forces ordinary and custom-execPath fork launches into the phase PGID', async () => {
  if(process.platform === 'win32') return;
  const report = await runGuardFixture('fork');
  assert.ok(report.expected > 0);
});

test('guard covers ESM named spawnSync, execSync, and execFileSync surfaces', async () => {
  if(process.platform === 'win32') return;
  const report = await runGuardFixture('sync');
  assert.ok(report.expected > 0);
});

test('ChildProcess.prototype.spawn is a forced-attached frozen backstop', async () => {
  if(process.platform === 'win32') return;
  const report = await runGuardFixture('direct');
  assert.ok(report.expected > 0);
});

test('guard synchronizes and freezes CJS/ESM exports without losing promisify.custom', async () => {
  const report = await runGuardFixture('exports');
  assert.equal(report.frozen, true);
});

test('guard rejects stripped, custom, combined, execFile, and fork gated-detach attempts', async () => {
  const report = await runGuardFixture('invalid-gate');
  assert.equal(report.rejected, 8);
});

test('flipping detached getters cannot bypass sync, async, or prototype containment', async () => {
  if(process.platform === 'win32') return;
  const report = await runGuardFixture('toctou');
  assert.equal(report.contained, 5);
});

test('only a fresh gated Node spawn can detach and GO requires capture first', async () => {
  if(process.platform === 'win32') return;
  const nested = await runGuardFixture('nested-gate');
  assert.equal(nested.capturedBeforeGo, true);
  const uncaptured = await runGuardFixture('capture-required');
  assert.equal(uncaptured.rejectedBeforeCapture, true);
});

test('ordinary Node to external transitive detach requests remain in the outer captured PGID', async () => {
  if(process.platform === 'win32') return;
  let sleeperIdentity = null;
  await runGuardFixture('transitive', {
    afterClose: async ({ identity, report }) => {
      const snapshot = captureProcessTableSnapshotSync();
      const sleeperRecord = snapshot.find(record => record.pid === report.sleeperPid);
      assert.ok(sleeperRecord, `transitive sleeper ${report.sleeperPid} exited before group proof`);
      assert.equal(sleeperRecord.pgid, identity.pgid,
        'transitive external child escaped the outer captured phase PGID');
      sleeperIdentity = bindProcessSnapshotIdentity(snapshot, sleeperRecord);
      const group = inspectCapturedProcessGroup(identity, {
        snapshotProbe: () => snapshot,
        priorExactMemberIdentities: [sleeperIdentity],
      });
      assert.equal(group.state, 'LIVE');
      assert.ok(group.memberPids.includes(report.sleeperPid));
      return [sleeperIdentity];
    },
  });
  if(sleeperIdentity) await waitForIdentityDeath(sleeperIdentity);
});

test('stripped spawn and fork environments regain recursive guard authority before transitive work', async () => {
  if(process.platform === 'win32') return;
  const sleeperIdentities = [];
  const result = await runGuardFixture('stripped-transitive', {
    afterClose: async ({ identity, report }) => {
      assert.equal(report.conflictsRejected, 2);
      assert.equal(report.sleeperPids.length, 2);
      const snapshot = captureProcessTableSnapshotSync();
      for(const sleeperPid of report.sleeperPids){
        const record = snapshot.find(candidate => candidate.pid === sleeperPid);
        assert.ok(record, `stripped-env sleeper ${sleeperPid} exited before proof`);
        assert.equal(record.pgid, identity.pgid,
          `stripped-env sleeper ${sleeperPid} escaped the outer captured PGID`);
        sleeperIdentities.push(bindProcessSnapshotIdentity(snapshot, record));
      }
      return [...sleeperIdentities];
    },
  });
  assert.equal(result.sleeperPids.length, 2);
  for(const identity of sleeperIdentities) await waitForIdentityDeath(identity);
});

test('explicit null and undefined argv slots preserve third options across child-process overloads', async () => {
  if(process.platform === 'win32') return;
  const report = await runGuardFixture('null-overloads');
  assert.equal(report.overloads, 10);
});

test('Puppeteer Chrome launch is forced into the phase PGID and closes cleanly', {
  timeout: 45_000,
}, async () => {
  if(process.platform === 'win32') return;
  const report = await runGuardFixture('puppeteer', { timeoutMs: 40_000 });
  assert.ok(report.browserPid > 0);
  assert.ok(report.expected > 0);
});

test('gate preload is a no-op with no capability and fails closed on partial or malformed capability', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'playforge-spawn-gate-shape-'));
  const cleanEnvironment = { ...process.env };
  for(const name of [
    'NODE_OPTIONS',
    'PLAYFORGE_INTERNAL_DESCENDANT_MARKER',
    'PLAYFORGE_INTERNAL_SPAWN_GATE_FD',
    'PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE',
  ]) delete cleanEnvironment[name];
  try {
    const noCapabilityEffect = path.join(root, 'no-capability-ran');
    const noCapability = spawnSync(process.execPath, [
      '--import',
      GATE_MODULE_URL,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(noCapabilityEffect)}, 'ran');`,
    ], { env: cleanEnvironment, encoding: 'utf8' });
    assert.equal(noCapability.status, 0, noCapability.stderr);
    assert.equal(await exists(noCapabilityEffect), true, 'both-absent gate preload did not no-op');

    const malformedCases = [
      { PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE: 'a'.repeat(48) },
      { PLAYFORGE_INTERNAL_SPAWN_GATE_FD: '3' },
      {
        PLAYFORGE_INTERNAL_SPAWN_GATE_FD: '4',
        PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE: 'a'.repeat(48),
      },
      {
        PLAYFORGE_INTERNAL_SPAWN_GATE_FD: '3',
        PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE: 'not-a-valid-nonce',
      },
    ];
    for(const [index, injected] of malformedCases.entries()){
      const effect = path.join(root, `malformed-${index}-ran`);
      const result = spawnSync(process.execPath, [
        '--import',
        GATE_MODULE_URL,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'ran');`,
      ], {
        env: { ...cleanEnvironment, ...injected },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe', 'ignore'],
      });
      assert.notEqual(result.status, 0, `malformed gate case ${index} executed successfully`);
      assert.equal(await exists(effect), false, `malformed gate case ${index} executed target JavaScript`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
