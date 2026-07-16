import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentityHandleScope } from './active-handle-scope.mjs';
import { finalizeCapturedGatedProcessGroup } from './phase-group-finalizer.mjs';
import {
  exactMarkerProcessRecords,
  signalExactMarkerProcesses,
} from './phase-marker-processes.mjs';
import {
  inspectCapturedProcessGroup,
  signalCapturedProcessGroup,
} from './phase-process-cleanup.mjs';
import { createPhase4TransactionFixtureSandbox } from './runner.phase4.test-sandbox.mjs';
import {
  bindProcessSnapshotIdentity,
  captureProcessTableSnapshotSync,
  processSnapshotCommandUnavailable,
} from './runner.phase4.lock.mjs';
import { PHASE4_SHOT_NAMES, PHASE4_SHOT_VIEWPORTS } from './runner.phase4.promotion.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'tools/shipcheck-release.mjs');
const PHASE_WAIT_FIXTURE = path.join(ROOT, 'tools/phase-wait.fixture.mjs');
const CAPTURE_PAUSE = new Int32Array(new SharedArrayBuffer(4));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function officialArtifactHashes(){
  const runner = path.join(ROOT, 'runner');
  const golf = path.join(ROOT, 'golf');
  const files = [
    path.join(runner, 'dist', 'index.html'),
    path.join(runner, 'gridlock-run-v1.html'),
    path.join(runner, 'gridlock-run-v1-frames.png'),
    path.join(golf, 'dist', 'index.html'),
    path.join(golf, 'stackyard-golf-v1.html'),
    ...Object.keys(PHASE4_SHOT_VIEWPORTS).flatMap(viewport => PHASE4_SHOT_NAMES.map(name => (
      path.join(runner, 'phase4-shots', viewport, `${name}.png`)
    ))),
  ].sort();
  assert.equal(files.length, 17);
  return Object.fromEntries(await Promise.all(files.map(async file => [file, sha256(await readFile(file))])));
}
async function releaseTempDirectories(marker){
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(`${marker}-tmp-`))
    .map(entry => entry.name)
    .sort();
}

async function phase4ClaimEntries(){
  const directory = path.join(ROOT, 'runner', '.phase4-release-claims');
  return (await readdir(directory).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error))).sort();
}

async function sandboxPromotionResidues(sandbox){
  const rows = [];
  for(const [label, directory] of [
    ['root', sandbox.root],
    ['runner', sandbox.runnerRoot],
    ['golf', sandbox.golfRoot],
  ]){
    for(const entry of await readdir(directory, { withFileTypes: true })){
      if(entry.name.startsWith('.phase4-') || entry.name.includes('-stage-')
        || entry.name.startsWith('.gridlock-run-v1-frames-stage-')){
        rows.push(`${label}/${entry.name}`);
      }
    }
  }
  return rows.sort();
}

async function assertSandboxExactOld(sandbox){
  assert.deepEqual(await readFile(path.join(sandbox.runnerRoot, 'dist', 'index.html')), sandbox.old.runner);
  assert.deepEqual(await readFile(path.join(sandbox.runnerRoot, 'gridlock-run-v1.html')), sandbox.old.runner);
  assert.deepEqual(await readFile(path.join(sandbox.golfRoot, 'dist', 'index.html')), sandbox.old.golf);
  assert.deepEqual(await readFile(path.join(sandbox.golfRoot, 'stackyard-golf-v1.html')), sandbox.old.golf);
  assert.deepEqual(
    await readFile(path.join(sandbox.runnerRoot, 'phase4-shots', 'old', 'sentinel.txt')),
    sandbox.old.shots,
  );
}

async function startSandboxArtifactServer(sandbox){
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      const file = pathname === '/runner/gridlock-run-v1.html'
        ? path.join(sandbox.runnerRoot, 'gridlock-run-v1.html')
        : pathname === '/golf/stackyard-golf-v1.html'
          ? path.join(sandbox.golfRoot, 'stackyard-golf-v1.html') : null;
      if(!file){ response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(await readFile(file));
    } catch(error){
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function markerProcesses(marker, { includeZombies = false } = {}){
  if(process.platform === 'win32') return [];
  return exactMarkerProcessRecords(marker, { includeZombies }).records;
}

function captureSpawnedProcessGroup(child, commandMarker){
  assert.ok(Number.isSafeInteger(child?.pid) && child.pid > 0, 'release negative spawned PID');
  assert.ok(typeof commandMarker === 'string' && commandMarker.length > 0,
    'release negative spawned command marker');
  const deadline = Date.now() + 500;
  let lastError = null;
  do {
    try {
      const snapshot = captureProcessTableSnapshotSync();
      const record = snapshot.find(candidate => candidate.pid === child.pid);
      if(!record){
        lastError = new Error(`spawned release PID ${child.pid} was omitted from the atomic snapshot`);
      } else if(processSnapshotCommandUnavailable(record)){
        lastError = new Error(`spawned release PID ${child.pid} argv is temporarily unavailable`);
      } else {
        return bindProcessSnapshotIdentity(snapshot, record, {
          expectedCommandMarker: commandMarker,
          requireOwnProcessGroup: process.platform !== 'win32',
        });
      }
    } catch(error){ lastError = error; }
    Atomics.wait(CAPTURE_PAUSE, 0, 0, 5);
  } while(Date.now() <= deadline);
  const error = new Error(
    `spawned release PID ${child.pid} exact process-group identity did not stabilize: ${lastError?.message || 'unknown'}`,
    { cause: lastError || undefined },
  );
  error.identityState = 'UNKNOWN';
  throw error;
}

function spawnCapturedNodeGroup({ args, cwd = ROOT, env = process.env, stdio = ['ignore', 'pipe', 'pipe'], title }){
  assert.notEqual(process.platform, 'win32',
    'release watchdog exact process-group negatives require POSIX isolation');
  assert.match(title || '', /^[A-Za-z0-9:_-]{8,180}$/, 'release negative captured title');
  // Keep the ownership marker in immutable argv. Node's --title rewrites the
  // observable command after spawn and would make a correctly captured exact
  // identity become UNKNOWN before cleanup.
  const child = spawn(process.execPath, [...args, title], {
    cwd,
    detached: process.platform !== 'win32',
    env,
    stdio,
  });
  try {
    const identity = captureSpawnedProcessGroup(child, title);
    return Object.freeze({ child, identity });
  } catch(error){
    const cleanupErrors = [];
    try {
      const exact = signalExactMarkerProcesses(title, 'SIGKILL');
      cleanupErrors.push(...exact.errors);
    } catch(caught){ cleanupErrors.push(caught); }
    if(child.exitCode === null && child.signalCode === null){
      try { child.kill('SIGKILL'); } catch(caught){ cleanupErrors.push(caught); }
    }
    try { releaseChild(child); } catch(caught){ cleanupErrors.push(caught); }
    if(cleanupErrors.length){
      const failures = [error, ...cleanupErrors];
      throw new AggregateError(
        failures,
        `release watchdog capture and exact fallback cleanup failed: ${failures.map(cleanupErrorSummary).join(' | ')}`,
      );
    }
    throw error;
  }
}

function spawnCapturedReleaseHarness(marker, env){
  const title = `release-watchdog-harness-${process.pid}-${randomBytes(8).toString('hex')}`;
  return spawnCapturedNodeGroup({
    title,
    args: [HARNESS],
    env: {
      ...process.env,
      PLAYFORGE_RELEASE_RUN_MARKER: marker,
      ...env,
    },
  });
}

async function freshMarkerEmpty(marker){
  let records = [];
  for(let attempt = 0; attempt < 40; attempt += 1){
    records = markerProcesses(marker, { includeZombies: true });
    if(records.length === 0) return records;
    await sleep(25);
  }
  return records;
}

function cleanupErrorSummary(error){
  if(error instanceof AggregateError){
    return `${error.message}: ${error.errors.map(cleanupErrorSummary).join(' | ')}`;
  }
  return error?.message || String(error);
}

function capturedGroupSnapshotWithoutExactZombieLeader(identity){
  const snapshot = captureProcessTableSnapshotSync();
  const leader = snapshot.find(record => record.pid === identity.pid);
  if(!leader || !leader.state.startsWith('Z')) return snapshot;
  if(leader.processStart !== identity.processStart) return snapshot;
  if(leader.pgid !== identity.pgid || leader.ucomm !== identity.ucomm) return snapshot;
  return Object.freeze(snapshot.filter(record => record !== leader));
}

function inspectReleaseCapturedGroup(identity){
  if(process.platform === 'win32') return null;
  return inspectCapturedProcessGroup(identity, {
    snapshotProbe: () => capturedGroupSnapshotWithoutExactZombieLeader(identity),
  });
}

function signalReleaseCapturedGroup(owned, signal){
  if(process.platform === 'win32'){
    throw new Error('Windows release captured-group signaling must use the finalizer default');
  }
  return signalCapturedProcessGroup(owned.identity, signal, {
    snapshotProbe: () => capturedGroupSnapshotWithoutExactZombieLeader(owned.identity),
  });
}

async function emergencyCleanup(owned, marker){
  const errors = [];
  if(owned?.identity){
    try {
      await finalizeCapturedGatedProcessGroup(owned, {
        label: `release watchdog captured group ${owned.identity.pgid}`,
        ...(process.platform === 'win32' ? {} : {
          inspectGroup: inspectReleaseCapturedGroup,
          signalGroup: signalReleaseCapturedGroup,
        }),
      });
    } catch(error){ errors.push(error); }
  }
  try {
    const exact = signalExactMarkerProcesses(marker, 'SIGKILL');
    errors.push(...exact.errors);
  } catch(error){ errors.push(error); }
  const child = owned?.child;
  if(child?.exitCode === null && child?.signalCode === null){
    try { child.kill('SIGKILL'); } catch(error){ errors.push(error); }
  }
  if(process.platform !== 'win32' && owned?.identity){
    try {
      const finalGroup = inspectReleaseCapturedGroup(owned.identity);
      if(finalGroup.state !== 'PROVEN_DEAD'){
        errors.push(new Error(
          `release watchdog final captured-group proof was ${finalGroup.state}: ${finalGroup.reason || 'members remain'}`,
        ));
      }
    } catch(error){ errors.push(error); }
  }
  try {
    const survivors = await freshMarkerEmpty(marker);
    if(survivors.length){
      errors.push(new Error(
        `release watchdog final marker proof found survivors: ${survivors.map(record => record.pid).join(', ')}`,
      ));
    }
  } catch(error){ errors.push(error); }
  if(errors.length){
    throw new AggregateError(
      errors,
      `release watchdog exact emergency cleanup failed: ${errors.map(cleanupErrorSummary).join(' | ')}`,
    );
  }
}

function armEmergencyCleanup(owned, marker, timeoutMs){
  let triggered = false;
  let cleanupPromise = null;
  let cleanupError = null;
  const timer = setTimeout(() => {
    triggered = true;
    cleanupPromise = emergencyCleanup(owned, marker).catch(error => { cleanupError = error; });
  }, timeoutMs);
  return Object.freeze({
    get triggered(){ return triggered; },
    clear(){ clearTimeout(timer); },
    async finish(){
      clearTimeout(timer);
      if(cleanupPromise) await cleanupPromise;
      else {
        try { await emergencyCleanup(owned, marker); }
        catch(error){ cleanupError = error; }
      }
      if(cleanupError) throw cleanupError;
    },
  });
}

async function runCapturedReleaseHarness(marker, env, { timeoutMs = 15_000 } = {}){
  const owned = spawnCapturedReleaseHarness(marker, env);
  const { child } = owned;
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const emergency = armEmergencyCleanup(owned, marker, timeoutMs);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    await finishEmergencyHygiene(emergency, child);
  }
  return {
    status: result.code,
    signal: result.signal,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    emergencyTriggered: emergency.triggered,
  };
}

function releaseChild(child){
  for(const stream of child?.stdio || []){
    stream?.removeAllListeners?.();
    stream?.destroy?.();
    stream?.unref?.();
  }
  child?.removeAllListeners?.();
  child?.unref?.();
}

async function finishEmergencyHygiene(emergency, child, cleanups = []){
  assert.ok(emergency && typeof emergency.finish === 'function', 'release emergency cleanup controller');
  assert.ok(Array.isArray(cleanups) && cleanups.every(cleanup => typeof cleanup === 'function'),
    'release additional cleanup callbacks');
  const errors = [];
  try { await emergency.finish(); }
  catch(error){ errors.push(error); }
  try { releaseChild(child); }
  catch(error){ errors.push(error); }
  for(const cleanup of cleanups){
    try { await cleanup(); }
    catch(error){ errors.push(error); }
  }
  if(errors.length){
    throw new AggregateError(
      errors,
      `release watchdog test hygiene failed: ${errors.map(cleanupErrorSummary).join(' | ')}`,
    );
  }
}

function describeResource(resource){
  return {
    type: resource?.constructor?.name || typeof resource,
    fd: Number.isInteger(resource?.fd) ? resource.fd : Number.isInteger(resource?._handle?.fd) ? resource._handle.fd : null,
    pid: Number.isInteger(resource?.pid) ? resource.pid : null,
  };
}

async function naturalResourceSnapshot(scope){
  const deadline = Date.now() + 750;
  let ownership;
  do {
    ownership = scope.classify();
    if(!ownership.handles.length && !ownership.requests.length) return ownership;
    await sleep(25);
  } while(Date.now() < deadline);
  return ownership;
}

test('release watchdog owns and removes a detached marker process before exit', {
  timeout: 15_000,
}, async () => {
  await new Promise(resolve => setImmediate(resolve));
  const scope = createIdentityHandleScope({ ignoredHandles: [process.stdin, process.stdout, process.stderr] });
  const marker = `playforge-release-negative-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
  const hostileRoot = await mkdtemp(path.join(tmpdir(), 'playforge-hostile-path-'));
  const hostileBin = path.join(hostileRoot, 'bin');
  await mkdir(hostileBin);
  for(const command of ['ps', 'pgrep']){
    await writeFile(path.join(hostileBin, command), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(hostileBin, command), 0o755);
  }
  const beforeTemps = await releaseTempDirectories(marker);
  const stdout = [];
  const stderr = [];
  const started = Date.now();
  const owned = spawnCapturedReleaseHarness(marker, {
    PLAYFORGE_RELEASE_INJECT_DETACHED_MARKER: '1',
    PLAYFORGE_RELEASE_TIMEOUT_MS: '750',
    PATH: `${hostileBin}${path.delimiter}${process.env.PATH || ''}`,
  });
  const { child } = owned;
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const emergency = armEmergencyCleanup(owned, marker, 8_000);

  let result;
  let preCleanupFailure = null;
  let preCleanupSurvivors = [];
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });

    // These observations deliberately happen before emergency cleanup. They
    // prove the release supervisor, rather than this test, removed its tree.
    preCleanupSurvivors = markerProcesses(marker);
    const preCleanupTemps = await releaseTempDirectories(marker);
    const ownership = await naturalResourceSnapshot(scope);
    try {
      assert.deepEqual(preCleanupSurvivors, [],
        `release supervisor left marker processes: ${preCleanupSurvivors.map(item => item.command).join(' | ')}`);
      assert.deepEqual(preCleanupTemps, beforeTemps, 'release supervisor left fresh temporary directories');
      assert.deepEqual(ownership.handles.map(describeResource), [], 'release negative retained active handles');
      assert.deepEqual(ownership.requests.map(describeResource), [], 'release negative retained active requests');
    } catch(error){
      preCleanupFailure = error;
    }
  } finally {
    await finishEmergencyHygiene(emergency, child, [
      () => rm(hostileRoot, { recursive: true, force: true }),
    ]);
  }

  assert.equal(emergency.triggered, false, 'test emergency cleanup fired before the release watchdog');
  if(preCleanupFailure) throw preCleanupFailure;
  const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
  const elapsedMs = Date.now() - started;
  assert.equal(result.code, 124,
    `detached-marker watchdog must exit 124, received ${result.code}/${result.signal}\n${output}`);
  assert.ok(elapsedMs >= 500 && elapsedMs < 6_000,
    `release watchdog must terminate promptly (${elapsedMs}ms)`);
  assert.match(output, new RegExp(`release-detached-marker-fixture:${marker}`));
  assert.match(output, /Playforge release gate exceeded outer watchdog \(750ms\)/);
});

test('release pins direct Node tooling and rejects hostile PATH/npm_execpath shims before promotion', {
  timeout: 20_000,
}, async () => {
  await new Promise(resolve => setImmediate(resolve));
  const scope = createIdentityHandleScope({ ignoredHandles: [process.stdin, process.stdout, process.stderr] });
  const marker = `playforge-release-negative-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
  const hostileRoot = await mkdtemp(path.join(tmpdir(), 'playforge-hostile-toolchain-'));
  const hostileBin = path.join(hostileRoot, 'bin');
  const executionMarker = path.join(hostileRoot, 'shim-executed');
  await mkdir(hostileBin);
  const shim = [
    '#!/bin/sh',
    'printf shim-executed > "$PLAYFORGE_FAKE_TOOLCHAIN_MARKER"',
    'printf "release: PASS all gates\\n"',
    'exit 0',
    '',
  ].join('\n');
  for(const command of ['node', 'npm', 'npx']){
    await writeFile(path.join(hostileBin, command), shim);
    await chmod(path.join(hostileBin, command), 0o755);
  }
  const beforeOfficials = await officialArtifactHashes();
  const beforeTemps = await releaseTempDirectories(marker);
  try {
    const direct = await runCapturedReleaseHarness(marker, {
        PATH: `${hostileBin}${path.delimiter}${process.env.PATH || ''}`,
        PLAYFORGE_FAKE_TOOLCHAIN_MARKER: executionMarker,
        PLAYFORGE_RELEASE_INJECT_TOOLCHAIN_PROBE: '1',
        PLAYFORGE_RELEASE_TIMEOUT_MS: '10000',
    }, { timeoutMs: 15_000 });
    const directOutput = `${direct.stdout || ''}\n${direct.stderr || ''}`;
    assert.equal(direct.status, 1, directOutput);
    assert.match(directOutput, /foundation/i,
      'hostile-toolchain fixture did not run the real direct-Node foundation test');
    assert.match(directOutput, /fixtures are unconditionally ineligible/);
    assert.doesNotMatch(directOutput, /release: PASS all gates/);
    await assert.rejects(readFile(executionMarker), error => error?.code === 'ENOENT',
      'a hostile PATH toolchain shim executed');

    const rejectedMarker = `${marker}-npmexec`;
    const rejected = await runCapturedReleaseHarness(rejectedMarker, {
        PATH: `${hostileBin}${path.delimiter}${process.env.PATH || ''}`,
        npm_execpath: path.join(hostileBin, 'npm'),
        PLAYFORGE_FAKE_TOOLCHAIN_MARKER: executionMarker,
        PLAYFORGE_RELEASE_INJECT_TOOLCHAIN_PROBE: '1',
    }, { timeoutMs: 5_000 });
    const rejectedOutput = `${rejected.stdout || ''}\n${rejected.stderr || ''}`;
    assert.equal(rejected.status, 1, rejectedOutput);
    assert.match(rejectedOutput, /npm_execpath must resolve to the npm CLI shipped with process\.execPath/);
    assert.doesNotMatch(rejectedOutput, /release: START|release: PASS/);
    await assert.rejects(readFile(executionMarker), error => error?.code === 'ENOENT',
      'the rejected npm_execpath shim executed');
    assert.deepEqual(await releaseTempDirectories(marker), beforeTemps);
    assert.deepEqual(await releaseTempDirectories(rejectedMarker), []);
    assert.deepEqual(markerProcesses(marker), []);
    assert.deepEqual(markerProcesses(rejectedMarker), []);
    assert.deepEqual(await officialArtifactHashes(), beforeOfficials);
    const ownership = await naturalResourceSnapshot(scope);
    assert.deepEqual(ownership.handles.map(describeResource), []);
    assert.deepEqual(ownership.requests.map(describeResource), []);
  } finally {
    await rm(hostileRoot, { recursive: true, force: true });
  }
});

test('repeated fast recovery exits propagate 0/1 without retained PID, zombie, or unrelated signal', {
  timeout: 45_000,
}, async () => {
  await new Promise(resolve => setImmediate(resolve));
  const scope = createIdentityHandleScope({ ignoredHandles: [process.stdin, process.stdout, process.stderr] });
  const hostileRoot = await mkdtemp(path.join(tmpdir(), 'playforge-fast-recovery-hostile-'));
  const hostileBin = path.join(hostileRoot, 'bin');
  const executionMarker = path.join(hostileRoot, 'shim-executed');
  await mkdir(hostileBin);
  const shim = '#!/bin/sh\nprintf shim-executed > "$PLAYFORGE_FAKE_TOOLCHAIN_MARKER"\nexit 0\n';
  for(const command of ['node', 'npm', 'npx', 'ps', 'pgrep']){
    await writeFile(path.join(hostileBin, command), shim);
    await chmod(path.join(hostileBin, command), 0o755);
  }
  const unrelatedTitle = `playforge-unrelated-fast-recovery-${process.pid}-${Date.now()}`;
  const unrelatedOwned = spawnCapturedNodeGroup({
    title: unrelatedTitle,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    stdio: 'ignore',
  });
  const { child: unrelated } = unrelatedOwned;
  unrelated.unref();
  const beforeOfficials = await officialArtifactHashes();
  const beforeClaims = await phase4ClaimEntries();
  try {
    for(const recoveryExit of ['0', '1']){
      for(let iteration = 0; iteration < 3; iteration += 1){
        const marker = `playforge-release-negative-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
        const beforeTemps = await releaseTempDirectories(marker);
        const result = await runCapturedReleaseHarness(marker, {
          PATH: `${hostileBin}${path.delimiter}${process.env.PATH || ''}`,
          PLAYFORGE_FAKE_TOOLCHAIN_MARKER: executionMarker,
          PLAYFORGE_RELEASE_INJECT_TOOLCHAIN_PROBE: '1',
          PLAYFORGE_RELEASE_INJECT_RECOVERY_FAST_EXIT: recoveryExit,
          PLAYFORGE_RELEASE_TIMEOUT_MS: '10000',
        }, { timeoutMs: 15_000 });
        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        assert.equal(result.status, 1, output);
        assert.doesNotMatch(output, /became a zombie|before ownership capture|identity capture/i,
          'a proven-dead fast exit was misclassified as a potentially live ambiguous child');
        assert.doesNotMatch(output, /release: PASS all gates/);
        if(recoveryExit === '0'){
          assert.match(output, /release: RECOVERY Phase 4 transaction resolved/);
          assert.match(output, /release: START hostile-toolchain-foundation-fixture/,
            'exit-0 recovery did not propagate success to the next bounded phase');
        } else {
          assert.match(output, /Phase 4 recovery exited 1/,
            'exit-1 recovery did not propagate failure');
          assert.doesNotMatch(output, /release: START/,
            'a failed recovery allowed a release phase to start');
        }
        assert.deepEqual(markerProcesses(marker, { includeZombies: true }), [],
          'fast recovery left a live or zombie marker PID');
        assert.deepEqual(await releaseTempDirectories(marker), beforeTemps,
          'fast recovery left a release temp root');
        const unrelatedState = process.platform === 'win32'
          ? unrelated.exitCode === null && unrelated.signalCode === null ? 'LIVE' : 'PROVEN_DEAD'
          : inspectCapturedProcessGroup(unrelatedOwned.identity).state;
        assert.equal(unrelatedState, 'LIVE', 'fast-exit cleanup signalled an unrelated process');
      }
    }
    await assert.rejects(readFile(executionMarker), error => error?.code === 'ENOENT',
      'hostile PATH tooling executed during fast recovery probes');
    assert.deepEqual(await phase4ClaimEntries(), beforeClaims);
    assert.deepEqual(await officialArtifactHashes(), beforeOfficials);
    const ownership = await naturalResourceSnapshot(scope);
    const ownedHandles = ownership.handles.filter(handle => handle !== unrelated);
    assert.deepEqual(ownedHandles.map(describeResource), []);
    assert.deepEqual(ownership.requests.map(describeResource), []);
  } finally {
    await finishEmergencyHygiene({
      finish: () => emergencyCleanup(unrelatedOwned, unrelatedTitle),
    }, unrelated, [
      () => rm(hostileRoot, { recursive: true, force: true }),
    ]);
  }
});

test('pre-grant hygiene rejects and removes a sampled unmarked detached descendant', {
  timeout: 15_000,
}, async () => {
  const marker = `playforge-release-negative-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
  const before = await officialArtifactHashes();
  const beforeTemps = await releaseTempDirectories(marker);
  const stdout = [];
  const stderr = [];
  const owned = spawnCapturedReleaseHarness(marker, {
    PLAYFORGE_RELEASE_INJECT_READY_FIXTURE: 'sampled-unmarked-detached',
    PLAYFORGE_RELEASE_TIMEOUT_MS: '10000',
  });
  const { child } = owned;
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const emergency = armEmergencyCleanup(owned, marker, 12_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    assert.equal(result.code, 1, output);
    assert.match(output, /LIVE\/UNKNOWN previously sampled detached process/);
    assert.doesNotMatch(output, /release: PASS|runner\.phase4:\s*PASS/i);
    const sleeperMatch = output.match(/ready-fixture-detached-pid:(\d+)/);
    assert.ok(sleeperMatch, output);
    const sleeperPid = Number(sleeperMatch[1]);
    const sleeperRecord = captureProcessTableSnapshotSync().find(record => record.pid === sleeperPid);
    assert.ok(!sleeperRecord || !sleeperRecord.command.includes(PHASE_WAIT_FIXTURE),
      'outer pre-grant cleanup left the sampled unmarked process alive with its exact command');
    assert.deepEqual(await officialArtifactHashes(), before);
    assert.deepEqual(await releaseTempDirectories(marker), beforeTemps);
  } finally {
    await finishEmergencyHygiene(emergency, child);
  }
});

test('granted child exit 0 without durable final ACK is nonzero and preserves exact OLD', {
  timeout: 15_000,
}, async () => {
  const marker = `playforge-release-negative-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
  const before = await officialArtifactHashes();
  const beforeTemps = await releaseTempDirectories(marker);
  const stdout = [];
  const stderr = [];
  const owned = spawnCapturedReleaseHarness(marker, {
      PLAYFORGE_RELEASE_INJECT_READY_FIXTURE: 'exit-zero-after-grant',
      PLAYFORGE_RELEASE_TIMEOUT_MS: '10000',
  });
  const { child } = owned;
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const emergency = armEmergencyCleanup(owned, marker, 12_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    assert.equal(result.code, 1, output);
    assert.match(output, /COMMIT_GRANTED lacked a durable terminal recovery receipt/);
    assert.doesNotMatch(output, /release: PASS|runner\.phase4:\s*PASS/i);
    assert.deepEqual(await officialArtifactHashes(), before);
    assert.deepEqual(await releaseTempDirectories(marker), beforeTemps);
  } finally {
    await finishEmergencyHygiene(emergency, child);
  }
});

for(const point of ['mid-install', 'commit-intent']){
  test(`release failure immediately recovers a Phase 4 ${point} crash`, {
    timeout: 20_000,
  }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    const scope = createIdentityHandleScope({ ignoredHandles: [process.stdin, process.stdout, process.stderr] });
    const marker = `playforge-release-negative-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
    const sandbox = await createPhase4TransactionFixtureSandbox(marker, point);
    const beforeTemps = await releaseTempDirectories(marker);
    const stdout = [];
    const stderr = [];
    const owned = spawnCapturedReleaseHarness(marker, {
        PLAYFORGE_RELEASE_INJECT_TRANSACTION_CRASH: point,
        PLAYFORGE_RELEASE_TRANSACTION_CONFIG: sandbox.configPath,
        PLAYFORGE_RELEASE_TEST_RECOVERY_ROOT: sandbox.root,
        PLAYFORGE_RELEASE_TIMEOUT_MS: '12000',
    });
    const { child } = owned;
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const emergency = armEmergencyCleanup(owned, marker, 15_000);
    try {
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      emergency.clear();
      const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
      assert.equal(emergency.triggered, false, `outer ${point} recovery exceeded emergency bound`);
      assert.equal(result.code, 1, `outer ${point} fixture must fail closed: ${result.code}/${result.signal}\n${output}`);
      assert.match(output, /release: RECOVERY Phase 4 transaction resolved/);
      assert.match(output, new RegExp(`transaction-crash-ready:${marker}:${point}`));
      assert.deepEqual(markerProcesses(marker), [], 'outer transaction fixture left marker processes');
      assert.deepEqual(await releaseTempDirectories(marker), beforeTemps, 'outer transaction fixture left temp roots');
      assert.deepEqual(await readFile(path.join(sandbox.runnerRoot, 'dist', 'index.html')), sandbox.old.runner);
      assert.deepEqual(await readFile(path.join(sandbox.runnerRoot, 'gridlock-run-v1.html')), sandbox.old.runner);
      assert.deepEqual(await readFile(path.join(sandbox.golfRoot, 'dist', 'index.html')), sandbox.old.golf);
      assert.deepEqual(await readFile(path.join(sandbox.golfRoot, 'stackyard-golf-v1.html')), sandbox.old.golf);
      assert.deepEqual(
        await readFile(path.join(sandbox.runnerRoot, 'phase4-shots', 'old', 'sentinel.txt')),
        sandbox.old.shots,
      );
      const rootResidue = (await readdir(sandbox.root)).filter(name => name.startsWith('.phase4-'));
      const runnerResidue = (await readdir(sandbox.runnerRoot)).filter(name => name.includes('-stage-'));
      const golfResidue = (await readdir(sandbox.golfRoot)).filter(name => name.includes('-stage-'));
      assert.deepEqual({ rootResidue, runnerResidue, golfResidue }, {
        rootResidue: [], runnerResidue: [], golfResidue: [],
      });
      const ownership = await naturalResourceSnapshot(scope);
      assert.deepEqual(ownership.handles.map(describeResource), []);
      assert.deepEqual(ownership.requests.map(describeResource), []);
    } finally {
      await finishEmergencyHygiene(emergency, child, [
        () => rm(sandbox.root, { recursive: true, force: true }),
      ]);
    }
  });
}

test('outer recovery finishes exact NEW after killed durable FINAL_COMMIT_ACK', {
  timeout: 20_000,
}, async () => {
  const marker = `playforge-release-negative-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
  const sandbox = await createPhase4TransactionFixtureSandbox(marker, 'final-commit-ack');
  const beforeOfficials = await officialArtifactHashes();
  const stdout = [];
  const stderr = [];
  const owned = spawnCapturedReleaseHarness(marker, {
      PLAYFORGE_RELEASE_INJECT_TRANSACTION_CRASH: 'final-commit-ack',
      PLAYFORGE_RELEASE_TRANSACTION_CONFIG: sandbox.configPath,
      PLAYFORGE_RELEASE_TEST_RECOVERY_ROOT: sandbox.root,
      PLAYFORGE_RELEASE_TIMEOUT_MS: '12000',
  });
  const { child } = owned;
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const emergency = armEmergencyCleanup(owned, marker, 15_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    assert.equal(result.code, 1, output);
    assert.match(output, new RegExp(`transaction-crash-ready:${marker}:final-commit-ack`));
    assert.match(output, /release: RECOVERY Phase 4 transaction resolved/);
    assert.doesNotMatch(output, /release: PASS/);
    assert.deepEqual(await readFile(path.join(sandbox.runnerRoot, 'dist', 'index.html')),
      await readFile(sandbox.validated.worlds.runner.path));
    assert.deepEqual(await readFile(path.join(sandbox.runnerRoot, 'gridlock-run-v1.html')),
      await readFile(sandbox.validated.worlds.runner.path));
    assert.deepEqual(await readFile(path.join(sandbox.golfRoot, 'dist', 'index.html')),
      await readFile(sandbox.validated.worlds.golf.path));
    assert.deepEqual(await readFile(path.join(sandbox.golfRoot, 'stackyard-golf-v1.html')),
      await readFile(sandbox.validated.worlds.golf.path));
    assert.deepEqual(await officialArtifactHashes(), beforeOfficials,
      'sandbox final-ACK fixture changed real officials');
    const rootResidue = (await readdir(sandbox.root)).filter(name => name.startsWith('.phase4-'));
    assert.deepEqual(rootResidue, []);
  } finally {
    await finishEmergencyHygiene(emergency, child, [
      () => rm(sandbox.root, { recursive: true, force: true }),
    ]);
  }
});

test('post-grant completion timeout recovers ACKED_NEW and never reports timeout plus NEW', {
  timeout: 25_000,
}, async () => {
  const marker = `playforge-release-negative-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
  const sandbox = await createPhase4TransactionFixtureSandbox(marker, 'post-install');
  const artifactServer = await startSandboxArtifactServer(sandbox);
  await new Promise(resolve => setImmediate(resolve));
  const scope = createIdentityHandleScope({ ignoredHandles: [process.stdin, process.stdout, process.stderr] });
  const beforeOfficials = await officialArtifactHashes();
  const beforeTemps = await releaseTempDirectories(marker);
  const beforeClaims = await phase4ClaimEntries();
  const stdout = [];
  const stderr = [];
  const owned = spawnCapturedReleaseHarness(marker, {
      PLAYFORGE_RELEASE_INJECT_READY_FIXTURE: 'sandbox-hang-after-final-ack',
      PLAYFORGE_RELEASE_TRANSACTION_CONFIG: sandbox.configPath,
      PLAYFORGE_RELEASE_TEST_RECOVERY_ROOT: sandbox.root,
      PLAYFORGE_RELEASE_ACK_COMPLETION_TIMEOUT_MS: '750',
      PLAYFORGE_RELEASE_TIMEOUT_MS: '15000',
      PLAYFORGE_LOCALHOST_ORIGIN: artifactServer.origin,
      PLAYFORGE_LAN_ORIGIN: artifactServer.origin,
  });
  const { child } = owned;
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const emergency = armEmergencyCleanup(owned, marker, 20_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    assert.equal(result.code, 42, output);
    assert.match(output, /ready-fixture-hanging-after-final-ack/);
    assert.match(output, /release fixture: FIXTURE_OK ACKED_NEW terminal classification/);
    assert.doesNotMatch(output, /release: PASS|exit 124|exceeded outer watchdog/i);
    assert.deepEqual(await readFile(path.join(sandbox.runnerRoot, 'dist', 'index.html')),
      await readFile(sandbox.validated.worlds.runner.path));
    assert.deepEqual(await readFile(path.join(sandbox.golfRoot, 'dist', 'index.html')),
      await readFile(sandbox.validated.worlds.golf.path));
    assert.deepEqual(await officialArtifactHashes(), beforeOfficials);
    assert.deepEqual(await releaseTempDirectories(marker), beforeTemps);
    assert.deepEqual(markerProcesses(marker), []);
    assert.deepEqual(await phase4ClaimEntries(), beforeClaims);
    assert.deepEqual(await sandboxPromotionResidues(sandbox), []);
    const ownership = await naturalResourceSnapshot(scope);
    assert.deepEqual(ownership.handles.map(describeResource), []);
    assert.deepEqual(ownership.requests.map(describeResource), []);
  } finally {
    await finishEmergencyHygiene(emergency, child, [
      () => artifactServer.close(),
      () => rm(sandbox.root, { recursive: true, force: true }),
    ]);
  }
});

test('READY timeout revokes and recovers exact OLD before exiting 124', {
  timeout: 20_000,
}, async () => {
  await new Promise(resolve => setImmediate(resolve));
  const scope = createIdentityHandleScope({ ignoredHandles: [process.stdin, process.stdout, process.stderr] });
  const marker = `playforge-release-negative-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
  const sandbox = await createPhase4TransactionFixtureSandbox(marker, 'post-install');
  const beforeOfficials = await officialArtifactHashes();
  const beforeTemps = await releaseTempDirectories(marker);
  const beforeClaims = await phase4ClaimEntries();
  const stdout = [];
  const stderr = [];
  const owned = spawnCapturedReleaseHarness(marker, {
      PLAYFORGE_RELEASE_INJECT_READY_FIXTURE: 'sandbox-hang-after-revoke',
      PLAYFORGE_RELEASE_TRANSACTION_CONFIG: sandbox.configPath,
      PLAYFORGE_RELEASE_TEST_RECOVERY_ROOT: sandbox.root,
      PLAYFORGE_RELEASE_TIMEOUT_MS: '2000',
  });
  const { child } = owned;
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const emergency = armEmergencyCleanup(owned, marker, 15_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    assert.equal(result.code, 124, output);
    assert.match(output, /ready-fixture-hanging-after-revoke/);
    assert.match(output, /release: RECOVERY Phase 4 transaction resolved/);
    assert.doesNotMatch(output, /release: PASS|FIXTURE_OK/);
    assert.deepEqual(await readFile(path.join(sandbox.runnerRoot, 'dist', 'index.html')), sandbox.old.runner);
    assert.deepEqual(await readFile(path.join(sandbox.runnerRoot, 'gridlock-run-v1.html')), sandbox.old.runner);
    assert.deepEqual(await readFile(path.join(sandbox.golfRoot, 'dist', 'index.html')), sandbox.old.golf);
    assert.deepEqual(await readFile(path.join(sandbox.golfRoot, 'stackyard-golf-v1.html')), sandbox.old.golf);
    assert.deepEqual(await readFile(path.join(sandbox.runnerRoot, 'phase4-shots', 'old', 'sentinel.txt')),
      sandbox.old.shots);
    assert.deepEqual(markerProcesses(marker), []);
    assert.deepEqual(await phase4ClaimEntries(), beforeClaims);
    assert.deepEqual(await sandboxPromotionResidues(sandbox), []);
    assert.deepEqual(await releaseTempDirectories(marker), beforeTemps);
    assert.deepEqual(await officialArtifactHashes(), beforeOfficials);
    const ownership = await naturalResourceSnapshot(scope);
    assert.deepEqual(ownership.handles.map(describeResource), []);
    assert.deepEqual(ownership.requests.map(describeResource), []);
  } finally {
    await finishEmergencyHygiene(emergency, child, [
      () => rm(sandbox.root, { recursive: true, force: true }),
    ]);
  }
});

for(const scannerFailure of ['timeout', 'malformed']){
  test(`persistent ${scannerFailure} ownership scanner failure aborts, recovers exact OLD, and leaves zero residue`, {
    timeout: 25_000,
  }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    const scope = createIdentityHandleScope({ ignoredHandles: [process.stdin, process.stdout, process.stderr] });
    const marker = `playforge-release-negative-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
    const sandbox = await createPhase4TransactionFixtureSandbox(marker, 'post-install');
    const beforeOfficials = await officialArtifactHashes();
    const beforeTemps = await releaseTempDirectories(marker);
    const beforeClaims = await phase4ClaimEntries();
    const stdout = [];
    const stderr = [];
    const owned = spawnCapturedReleaseHarness(marker, {
        PLAYFORGE_RELEASE_INJECT_READY_FIXTURE: 'sandbox-sampler-scan-failure',
        PLAYFORGE_RELEASE_INJECT_SAMPLER_FAILURE: scannerFailure,
        PLAYFORGE_RELEASE_TRANSACTION_CONFIG: sandbox.configPath,
        PLAYFORGE_RELEASE_TEST_RECOVERY_ROOT: sandbox.root,
        PLAYFORGE_RELEASE_TIMEOUT_MS: '12000',
    });
    const { child } = owned;
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const emergency = armEmergencyCleanup(owned, marker, 20_000);
    try {
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      emergency.clear();
      const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
      assert.equal(emergency.triggered, false, `persistent ${scannerFailure} fixture exceeded emergency bound`);
      assert.equal(result.code, 1, output);
      assert.match(output, new RegExp(`injected persistent ${scannerFailure} scanner failure`));
      assert.match(output, /release: RECOVERY Phase 4 transaction resolved/);
      assert.doesNotMatch(output, /release: PASS|runner\.phase4:\s*PASS|FIXTURE_OK/i);
      await assertSandboxExactOld(sandbox);

      // These checks precede emergency cleanup and use this external test
      // process's real pinned scanners. They prove supervisor-owned teardown.
      assert.deepEqual(markerProcesses(marker), [], 'persistent scanner fixture left a marker process');
      assert.deepEqual(await releaseTempDirectories(marker), beforeTemps,
        'persistent scanner fixture left a release temp root');
      assert.deepEqual(await phase4ClaimEntries(), beforeClaims,
        'persistent scanner fixture left a Phase 4 claim');
      assert.deepEqual(await sandboxPromotionResidues(sandbox), [],
        'persistent scanner fixture left journal/backup/stage residue');
      assert.deepEqual(await officialArtifactHashes(), beforeOfficials,
        'persistent scanner fixture changed real officials');
      const ownership = await naturalResourceSnapshot(scope);
      assert.deepEqual(ownership.handles.map(describeResource), []);
      assert.deepEqual(ownership.requests.map(describeResource), []);
    } finally {
      await finishEmergencyHygiene(emergency, child, [
        () => rm(sandbox.root, { recursive: true, force: true }),
      ]);
    }
  });
}

test('recovery proof snapshot failure stays UNKNOWN and preserves transaction evidence', {
  timeout: 25_000,
}, async () => {
  await new Promise(resolve => setImmediate(resolve));
  const scope = createIdentityHandleScope({ ignoredHandles: [process.stdin, process.stdout, process.stderr] });
  const marker = `playforge-release-negative-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
  const sandbox = await createPhase4TransactionFixtureSandbox(marker, 'post-install');
  const beforeOfficials = await officialArtifactHashes();
  const beforeTemps = await releaseTempDirectories(marker);
  const beforeClaims = await phase4ClaimEntries();
  const stdout = [];
  const stderr = [];
  const owned = spawnCapturedReleaseHarness(marker, {
      PLAYFORGE_RELEASE_INJECT_READY_FIXTURE: 'sandbox-sampler-scan-failure',
      PLAYFORGE_RELEASE_INJECT_SAMPLER_FAILURE: 'timeout',
      PLAYFORGE_RELEASE_INJECT_RECOVERY_PROOF_FAILURE: '1',
      PLAYFORGE_RELEASE_TRANSACTION_CONFIG: sandbox.configPath,
      PLAYFORGE_RELEASE_TEST_RECOVERY_ROOT: sandbox.root,
      PLAYFORGE_RELEASE_TIMEOUT_MS: '12000',
  });
  const { child } = owned;
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const emergency = armEmergencyCleanup(owned, marker, 20_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    emergency.clear();
    const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    assert.equal(emergency.triggered, false, 'recovery-proof failure exceeded emergency bound');
    assert.equal(result.code, 1, output);
    assert.match(output, /injected persistent timeout scanner failure/);
    assert.match(output, /injected recovery proof snapshot failure/);
    assert.match(output, /promotion evidence was preserved|recovery proof snapshot failure/);
    assert.equal((output.match(/release: RECOVERY Phase 4 transaction resolved/g) || []).length, 1,
      'failed recovery proof printed a second resolved receipt');
    assert.doesNotMatch(output, /release: PASS|runner\.phase4:\s*PASS|FIXTURE_OK/i);

    // The only resolved receipt is the empty preflight. The failed terminal
    // recovery must neither clear nor classify the still-durable transaction.
    assert.notDeepEqual(await sandboxPromotionResidues(sandbox), [],
      'UNKNOWN recovery proof cleared the durable transaction evidence');
    assert.deepEqual(markerProcesses(marker), [], 'recovery-proof failure left a marker process');
    assert.deepEqual(await releaseTempDirectories(marker), beforeTemps,
      'recovery-proof failure left a release temp root');
    assert.deepEqual(await phase4ClaimEntries(), beforeClaims,
      'recovery-proof failure left a Phase 4 claim');
    assert.deepEqual(await officialArtifactHashes(), beforeOfficials,
      'recovery-proof failure changed real officials');
    const ownership = await naturalResourceSnapshot(scope);
    assert.deepEqual(ownership.handles.map(describeResource), []);
    assert.deepEqual(ownership.requests.map(describeResource), []);
  } finally {
    await finishEmergencyHygiene(emergency, child, [
      () => rm(sandbox.root, { recursive: true, force: true }),
    ]);
  }
});

test('late sandbox source mutation after READY blocks final ACK and recovers exact OLD', {
  timeout: 20_000,
}, async () => {
  const marker = `playforge-release-negative-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
  const sandbox = await createPhase4TransactionFixtureSandbox(marker, 'post-install');
  const beforeOfficials = await officialArtifactHashes();
  const beforeClaims = await phase4ClaimEntries();
  const stdout = [];
  const stderr = [];
  const owned = spawnCapturedReleaseHarness(marker, {
      PLAYFORGE_RELEASE_INJECT_READY_FIXTURE: 'sandbox-mutate-input-before-grant',
      PLAYFORGE_RELEASE_TRANSACTION_CONFIG: sandbox.configPath,
      PLAYFORGE_RELEASE_TEST_RECOVERY_ROOT: sandbox.root,
      PLAYFORGE_RELEASE_TIMEOUT_MS: '10000',
  });
  const { child } = owned;
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const emergency = armEmergencyCleanup(owned, marker, 15_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    assert.equal(result.code, 1, output);
    assert.match(output, /sandbox final build inputs changed after candidate build/);
    assert.doesNotMatch(output, /release: PASS|FINAL COMMIT ACK COMPLETE|FIXTURE_OK/);
    assert.deepEqual(await readFile(path.join(sandbox.runnerRoot, 'dist', 'index.html')), sandbox.old.runner);
    assert.deepEqual(await readFile(path.join(sandbox.golfRoot, 'dist', 'index.html')), sandbox.old.golf);
    assert.deepEqual(await readFile(path.join(sandbox.runnerRoot, 'phase4-shots', 'old', 'sentinel.txt')),
      sandbox.old.shots);
    assert.deepEqual(markerProcesses(marker), []);
    assert.deepEqual(await phase4ClaimEntries(), beforeClaims);
    assert.deepEqual(await sandboxPromotionResidues(sandbox), []);
    assert.deepEqual(await officialArtifactHashes(), beforeOfficials);
  } finally {
    await finishEmergencyHygiene(emergency, child, [
      () => rm(sandbox.root, { recursive: true, force: true }),
    ]);
  }
});

test('outer transaction fixture cannot print PASS or mutate officials when its child unexpectedly exits 0', {
  timeout: 15_000,
}, async () => {
  const marker = `playforge-release-negative-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
  const sandbox = await createPhase4TransactionFixtureSandbox(marker, 'mid-install');
  const before = await officialArtifactHashes();
  const stdout = [];
  const stderr = [];
  const owned = spawnCapturedReleaseHarness(marker, {
      PLAYFORGE_RELEASE_INJECT_TRANSACTION_CRASH: 'mid-install',
      PLAYFORGE_RELEASE_TRANSACTION_CONFIG: sandbox.configPath,
      PLAYFORGE_RELEASE_TEST_RECOVERY_ROOT: sandbox.root,
      PLAYFORGE_RELEASE_FIXTURE_FORCE_SUCCESS: '1',
      PLAYFORGE_RELEASE_TIMEOUT_MS: '10000',
  });
  const { child } = owned;
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const emergency = armEmergencyCleanup(owned, marker, 12_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    emergency.clear();
    const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    assert.equal(result.code, 1, output);
    assert.match(output, /unexpectedly exited 0; fixtures are unconditionally ineligible/);
    assert.doesNotMatch(output, /release: PASS/);
    assert.deepEqual(await officialArtifactHashes(), before, 'outer fixture changed an official artifact');
    assert.deepEqual(markerProcesses(marker), []);
  } finally {
    await finishEmergencyHygiene(emergency, child, [
      () => rm(sandbox.root, { recursive: true, force: true }),
    ]);
  }
});
