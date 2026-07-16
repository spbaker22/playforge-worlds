import assert from 'node:assert/strict';
import childProcess, {
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  execSync,
  fork,
  spawn,
  spawnSync,
} from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  RECOVERY_ANCESTOR_MARKER_ENV,
  acknowledgeCapturedGatedSentinelIfAlone,
  capturedGatedTargetResult,
  createCapturedSentinelProtocol,
  scopedGatedTitle,
} from './phase-isolated-node.mjs';
import {
  TRUSTED_DESCENDANT_NODE_OPTION,
  TRUSTED_GATE_MODULE_URL,
} from './phase-spawn-capability.mjs';
import {
  abortPhaseSpawnGate,
  captureGatedProcessIdentitySync,
  createPhaseSpawnGate,
  gatedChildEnvironment,
  gatedNodeArguments,
  releasePhaseSpawnGate,
} from './phase-spawn-gate-parent.mjs';
import { signalCapturedProcessGroup } from './phase-process-cleanup.mjs';
import { resolveChromeExecutable } from './chrome-path.mjs';
import {
  bindProcessSnapshotIdentity,
  captureProcessTableSnapshotSync,
  signalExactProcessSnapshotIdentity,
} from './runner.phase4.lock.mjs';
import {
  encodePhaseNodeCommand,
  PHASE_NODE_COMMAND_PATH,
} from './phase-node-command-spec.mjs';

const mode = process.argv[2];

function processGroup(pid = process.pid){
  const result = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const pgid = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(pgid) && pgid > 0, `invalid PGID for ${pid}: ${result.stdout}`);
  return pgid;
}

function closed(child){
  if(child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
}

async function stop(child){
  if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await closed(child).catch(() => {});
}

function report(value){
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

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

async function waitForOutput(read, label, timeoutMs = 1_000){
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while(!value && Date.now() < deadline){
    await new Promise(resolve => setTimeout(resolve, 10));
    value = read();
  }
  assert.ok(value, `${label} emitted no output`);
  return value;
}

if(mode === 'fork-wait'){
  setInterval(() => {}, 1_000);
} else if(mode === 'idle'){
  setInterval(() => {}, 1_000);
} else if(mode === 'noop'){
  report({ noop: true });
} else if(mode === 'emit'){
  process.stdout.write(process.argv[3] || '');
} else if(mode === 'write-effect'){
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.argv[3], 'target');
} else if(mode === 'write-effects'){
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.argv[3], 'target');
  const child = spawnSync(process.execPath, [
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(process.argv[4])}, 'child')`,
  ]);
  assert.equal(child.status, 0, child.stderr?.toString());
} else if(mode === 'nested-env'){
  const nestedTestPath = process.argv[3];
  const marker = process.env.PLAYFORGE_INTERNAL_DESCENDANT_MARKER;
  assert.equal(process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_FD, undefined);
  assert.equal(process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE, undefined);
  assert.equal(process.env.NODE_OPTIONS, TRUSTED_DESCENDANT_NODE_OPTION);
  const plainSource = [
    "const assert = require('node:assert/strict');",
    "assert.equal(process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_FD, undefined);",
    "assert.equal(process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE, undefined);",
    `assert.equal(process.env.NODE_OPTIONS, ${JSON.stringify(TRUSTED_DESCENDANT_NODE_OPTION)});`,
    `assert.equal(process.title, ${JSON.stringify(`${marker}:owned-descendant`)});`,
    "process.stdout.write('plain-ok');",
  ].join('\n');
  const plain = spawnSync(process.execPath, ['-e', plainSource], { encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, 'plain-ok');
  const nested = spawnSync(process.execPath, ['--test', nestedTestPath], { encoding: 'utf8' });
  assert.equal(nested.status, 0, `${nested.stdout}\n${nested.stderr}`);
  report({ nested: true });
} else if(mode === 'ordinary-descendant-report'){
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  report({ descendantPid: child.pid });
} else if(mode === 'spawn-external-report'){
  assert.equal(process.env.NODE_OPTIONS, TRUSTED_DESCENDANT_NODE_OPTION,
    'stripped Node child lacked recursive marker preload');
  assert.match(process.env.PLAYFORGE_INTERNAL_DESCENDANT_MARKER || '',
    /^[A-Za-z0-9:_-]{8,220}$/, 'stripped Node child lacked descendant marker');
  const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  child.unref();
  report({
    sleeperPid: child.pid,
    marker: process.env.PLAYFORGE_INTERNAL_DESCENDANT_MARKER,
    nodeOptions: process.env.NODE_OPTIONS,
  });
} else if(mode === 'external'){
  const expected = processGroup();
  let spawned = null;
  let execed = null;
  let filed = null;
  try {
    spawned = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
    assert.equal(processGroup(spawned.pid), expected, 'spawn external escaped phase PGID');
    execed = exec('exec /bin/sleep 30', { detached: true });
    assert.equal(processGroup(execed.pid), expected, 'exec shell escaped phase PGID');
    filed = execFile('/bin/sleep', ['30'], { detached: true });
    assert.equal(processGroup(filed.pid), expected, 'execFile external escaped phase PGID');
  } finally {
    if(spawned) await stop(spawned);
    if(execed) await stop(execed);
    if(filed) await stop(filed);
  }
  report({ expected });
} else if(mode === 'ordinary-node'){
  const expected = processGroup();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  try {
    assert.equal(processGroup(child.pid), expected, 'ordinary Node escaped phase PGID');
  } finally {
    await stop(child);
  }
  report({ expected });
} else if(mode === 'shell'){
  const expected = processGroup();
  const child = spawn('exec /bin/sleep 30', [], { detached: true, shell: true, stdio: 'ignore' });
  try {
    assert.equal(processGroup(child.pid), expected, 'shell spawn escaped phase PGID');
  } finally {
    await stop(child);
  }
  report({ expected });
} else if(mode === 'fork'){
  const expected = processGroup();
  const root = await mkdtemp(path.join(tmpdir(), 'playforge-guard-fork-'));
  const script = path.join(root, 'wait.sh');
  await writeFile(script, '#!/bin/sh\nexec /bin/sleep 30\n');
  await chmod(script, 0o700);
  let ordinary = null;
  let custom = null;
  try {
    ordinary = fork(new URL(import.meta.url).pathname, ['fork-wait'], {
      detached: true,
      silent: true,
    });
    assert.equal(processGroup(ordinary.pid), expected, 'ordinary fork escaped phase PGID');
    custom = fork(script, [], {
      detached: true,
      execPath: '/bin/sh',
      silent: true,
    });
    assert.equal(processGroup(custom.pid), expected, 'custom-execPath fork escaped phase PGID');
  } finally {
    if(ordinary) await stop(ordinary);
    if(custom) await stop(custom);
    await rm(root, { recursive: true, force: true });
  }
  report({ expected });
} else if(mode === 'sync'){
  const expected = processGroup();
  const command = '/bin/ps -o pgid= -p $$';
  const spawned = spawnSync('/bin/sh', ['-c', command], { detached: true, encoding: 'utf8' });
  assert.equal(spawned.status, 0, spawned.stderr);
  assert.equal(Number(spawned.stdout.trim()), expected, 'ESM named spawnSync escaped phase PGID');
  assert.equal(Number(execSync(command, { detached: true, encoding: 'utf8', shell: '/bin/sh' }).trim()),
    expected, 'ESM named execSync escaped phase PGID');
  assert.equal(Number(execFileSync('/bin/sh', ['-c', command], {
    detached: true,
    encoding: 'utf8',
  }).trim()), expected, 'ESM named execFileSync escaped phase PGID');
  report({ expected });
} else if(mode === 'direct'){
  const expected = processGroup();
  const direct = new ChildProcess();
  direct.spawn({
    file: '/bin/sleep',
    args: ['/bin/sleep', '30'],
    cwd: undefined,
    detached: true,
    envPairs: [],
    stdio: 'ignore',
  });
  try {
    assert.equal(processGroup(direct.pid), expected, 'direct ChildProcess.prototype.spawn escaped phase PGID');
  } finally {
    await stop(direct);
  }
  report({ expected });
} else if(mode === 'toctou'){
  const expected = processGroup();
  const flippingOptions = (falseReads, extras = {}) => {
    let detachedReads = 0;
    const target = { ...extras };
    return new Proxy(target, {
      get(object, property, receiver){
        if(property === 'detached') return ++detachedReads > falseReads;
        return Reflect.get(object, property, receiver);
      },
      ownKeys(object){ return [...Reflect.ownKeys(object), 'detached']; },
      getOwnPropertyDescriptor(object, property){
        if(property === 'detached') return { enumerable: true, configurable: true };
        return Reflect.getOwnPropertyDescriptor(object, property);
      },
    });
  };
  const command = '/bin/ps -o pgid= -p $$';
  const spawnedSync = spawnSync('/bin/sh', ['-c', command], flippingOptions(2, { encoding: 'utf8' }));
  assert.equal(spawnedSync.status, 0, spawnedSync.stderr);
  assert.equal(Number(spawnedSync.stdout.trim()), expected, 'spawnSync flipping getter escaped phase PGID');
  assert.equal(Number(execSync(command, flippingOptions(1, { encoding: 'utf8', shell: '/bin/sh' })).trim()),
    expected, 'execSync flipping getter escaped phase PGID');
  assert.equal(Number(execFileSync('/bin/sh', ['-c', command], flippingOptions(2, {
    encoding: 'utf8',
  })).trim()), expected, 'execFileSync flipping getter escaped phase PGID');

  const asynchronous = spawn('/bin/sleep', ['30'], flippingOptions(1, { stdio: 'ignore' }));
  try {
    assert.equal(processGroup(asynchronous.pid), expected, 'async spawn flipping getter escaped phase PGID');
  } finally {
    await stop(asynchronous);
  }

  const direct = new ChildProcess();
  direct.spawn(flippingOptions(1, {
    file: '/bin/sleep',
    args: ['/bin/sleep', '30'],
    cwd: undefined,
    envPairs: [],
    stdio: 'ignore',
  }));
  try {
    assert.equal(processGroup(direct.pid), expected, 'prototype flipping getter escaped phase PGID');
  } finally {
    await stop(direct);
  }
  report({ contained: 5 });
} else if(mode === 'exports'){
  const require = createRequire(import.meta.url);
  const cjs = require('node:child_process');
  assert.equal(cjs.spawnSync, spawnSync, 'ESM named spawnSync was not synchronized');
  assert.equal(cjs.execSync, execSync, 'ESM named execSync was not synchronized');
  assert.equal(cjs.execFileSync, execFileSync, 'ESM named execFileSync was not synchronized');
  for(const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']){
    const descriptor = Object.getOwnPropertyDescriptor(cjs, name);
    assert.equal(descriptor.writable, false, `${name} wrapper remained writable`);
    assert.equal(descriptor.configurable, false, `${name} wrapper remained configurable`);
  }
  const prototypeDescriptor = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
  assert.equal(prototypeDescriptor.writable, false);
  assert.equal(prototypeDescriptor.configurable, false);
  assert.throws(() => { cjs.spawn = () => {}; }, TypeError);
  assert.equal(typeof exec[promisify.custom], 'function', 'exec promisify.custom was lost');
  assert.equal(typeof execFile[promisify.custom], 'function', 'execFile promisify.custom was lost');
  const promised = await promisify(execFile)('/bin/echo', ['promisify-ok']);
  assert.equal(promised.stdout.trim(), 'promisify-ok');
  const expected = processGroup();
  const promisedExec = promisify(exec)('/bin/ps -o pgid= -p $$', { detached: true });
  assert.ok(promisedExec.child?.pid > 0, 'promisified exec lost .child');
  assert.equal(Number((await promisedExec).stdout.trim()), expected,
    'promisified exec bypassed detached normalization');
  const promisedExecFile = promisify(execFile)('/bin/sh', ['-c', '/bin/ps -o pgid= -p $$'], {
    detached: true,
  });
  assert.ok(promisedExecFile.child?.pid > 0, 'promisified execFile lost .child');
  assert.equal(Number((await promisedExecFile).stdout.trim()), expected,
    'promisified execFile bypassed detached normalization');
  await new Promise((resolve, reject) => exec('printf callback-exec', (error, stdout, stderr) => {
    if(error) reject(error);
    else {
      assert.equal(stdout, 'callback-exec');
      assert.equal(stderr, '');
      resolve();
    }
  }));
  await new Promise((resolve, reject) => execFile('/bin/echo', ['callback-file'], (error, stdout) => {
    if(error) reject(error);
    else {
      assert.equal(stdout.trim(), 'callback-file');
      resolve();
    }
  }));
  await assert.rejects(
    promisify(execFile)('/bin/sh', ['-c', 'printf out; printf err >&2; exit 7']),
    error => error.code === 7 && error.stdout === 'out' && error.stderr === 'err',
  );
  assert.equal(childProcess.spawnSync, spawnSync);
  report({ frozen: true });
} else if(mode === 'invalid-gate'){
  const attempt = async (label, mutate, launch, { emergencyPidPath = null } = {}) => {
    const marker = `phase4-invalid-${label}-${process.pid}-${Date.now()}`;
    const gate = createPhaseSpawnGate(marker);
    const args = gatedNodeArguments(marker, dispatchedArguments([
      new URL(import.meta.url).pathname,
      'noop',
    ]));
    const environment = gatedChildEnvironment(process.env, gate);
    let launched = null;
    try {
      assert.throws(() => {
        launched = launch({ gate, args, environment: mutate(environment) });
        return launched;
      }, /gated Node|malformed gated|fresh registered|exact process\.execPath|command payload/);
    } finally {
      let launchedIdentity = null;
      if(Number.isSafeInteger(launched?.pid) && launched.pid > 0
        && launched.exitCode === null && launched.signalCode === null){
        const snapshot = captureProcessTableSnapshotSync();
        const record = snapshot.find(candidate => candidate.pid === launched.pid);
        if(record && !record.state.startsWith('Z')){
          try { launchedIdentity = bindProcessSnapshotIdentity(snapshot, record); }
          catch {}
        }
      }
      abortPhaseSpawnGate(launched, gate);
      if(Number.isSafeInteger(launched?.pid) && launched.pid > 0){
        if(launchedIdentity) signalExactProcessSnapshotIdentity(launchedIdentity, 'SIGKILL');
        await stop(launched);
      }
      if(emergencyPidPath){
        let emergencyPid = null;
        try { emergencyPid = Number(await readFile(emergencyPidPath, 'utf8')); }
        catch {}
        if(Number.isSafeInteger(emergencyPid) && emergencyPid > 0){
          const snapshot = captureProcessTableSnapshotSync();
          const record = snapshot.find(candidate => candidate.pid === emergencyPid);
          if(record && !record.state.startsWith('Z')){
            try {
              const identity = bindProcessSnapshotIdentity(snapshot, record, {
                expectedCommand: '/bin/sleep 30',
              });
              signalExactProcessSnapshotIdentity(identity, 'SIGKILL');
            } catch {}
          }
        }
      }
    }
  };
  await attempt('env-strip', environment => {
    const stripped = { ...environment };
    delete stripped.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE;
    return stripped;
  }, ({ args, environment }) => spawn(process.execPath, args, {
    detached: true,
    env: environment,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  }));
  await attempt('execpath', environment => environment, ({ args, environment }) => spawn('/bin/echo', args, {
    detached: true,
    env: environment,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  }));
  await attempt('execfile', environment => environment, ({ args, environment }) => execFile(process.execPath, args, {
    detached: true,
    env: environment,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  }));
  await attempt('fork', environment => environment, ({ environment }) => fork(new URL(import.meta.url).pathname, ['fork-wait'], {
    detached: true,
    env: environment,
    silent: true,
  }));
  await attempt('combined', environment => environment, ({ gate, environment }) => spawn(process.execPath, [
    `--title=${gate.descendantMarker}`,
    `--import=${TRUSTED_GATE_MODULE_URL}`,
    '-e',
    '',
  ], {
    detached: true,
    env: environment,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  }));
  await attempt('payload-flip', environment => environment, ({ args, environment }) => {
    let reads = 0;
    const changedPayload = encodePhaseNodeCommand([
      new URL(import.meta.url).pathname,
      'emit',
      'changed-payload',
    ]);
    const flippingArgs = new Proxy(args, {
      get(target, property, receiver){
        if(property === '5' && ++reads > 1) return changedPayload;
        return Reflect.get(target, property, receiver);
      },
    });
    return spawn(process.execPath, flippingArgs, {
      detached: true,
      env: environment,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
  });
  const authorityRoot = await mkdtemp(path.join(tmpdir(), 'playforge-pre-go-authority-'));
  const authorityEffect = path.join(authorityRoot, 'preload-ran');
  const authorityPid = path.join(authorityRoot, 'preload-child-pid');
  const authorityModule = path.join(authorityRoot, 'hostile.cjs');
  await writeFile(authorityModule, [
    "const { writeFileSync } = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `writeFileSync(${JSON.stringify(authorityEffect)}, 'ran');`,
    "const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(authorityPid)}, String(child.pid));`,
    'child.unref();',
  ].join('\n'));
  try {
    await attempt('pre-go-authority', environment => environment, ({ gate, environment }) => spawn(
      process.execPath,
      [
        `--title=${gate.descendantMarker}`,
        '--import',
        TRUSTED_GATE_MODULE_URL,
        '--require',
        authorityModule,
        ...dispatchedArguments([new URL(import.meta.url).pathname, 'noop']),
      ],
      {
        detached: true,
        env: environment,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      },
    ), { emergencyPidPath: authorityPid });
    assert.equal(await readFile(authorityEffect, 'utf8').catch(() => null), null,
      'pre-GO executable authority ran before rejection');
  } finally {
    await rm(authorityRoot, { recursive: true, force: true });
  }
  const shapeGate = createPhaseSpawnGate(`phase4-shape-${process.pid}-${Date.now()}`);
  try {
    assert.throws(() => gatedNodeArguments(shapeGate.descendantMarker, [
      ...dispatchedArguments([new URL(import.meta.url).pathname, 'noop']),
      'extra-authority',
    ]), /dispatcher argv length/);
  } finally {
    abortPhaseSpawnGate(null, shapeGate);
  }
  report({ rejected: 8 });
} else if(mode === 'nested-gate'){
  const marker = `phase4-nested-gate-${process.pid}-${Date.now()}`;
  const gate = createPhaseSpawnGate(marker);
  const child = spawn(process.execPath, gatedNodeArguments(marker, [
    ...dispatchedArguments([new URL(import.meta.url).pathname, 'emit', 'nested-ok']),
  ]), {
    detached: true,
    env: gatedChildEnvironment(process.env, gate),
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let identity = null;
  try {
    identity = captureGatedProcessIdentitySync(child.pid, {
      expectedCommand: marker,
      expectedCommandMarker: marker,
      requireOwnProcessGroup: true,
    });
    assert.equal(identity.pgid, identity.pid, 'validated nested gate lost detached process group');
    assert.notEqual(identity.pgid, processGroup(), 'validated nested gate stayed in parent process group');
    await releasePhaseSpawnGate(child, gate);
    await closed(child);
    assert.equal(child.exitCode, 0, stderr);
    assert.equal(stdout, 'nested-ok');
  } finally {
    abortPhaseSpawnGate(child, gate);
    if(identity) signalCapturedProcessGroup(identity, 'SIGKILL');
    await stop(child);
  }
  report({ capturedBeforeGo: true });
} else if(mode === 'capture-required'){
  const marker = `phase4-capture-required-${process.pid}-${Date.now()}`;
  const gate = createPhaseSpawnGate(marker);
  const child = spawn(process.execPath, gatedNodeArguments(marker, dispatchedArguments([
    new URL(import.meta.url).pathname,
    'noop',
  ])), {
    detached: true,
    env: gatedChildEnvironment(process.env, gate),
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  let identity = null;
  try {
    await assert.rejects(releasePhaseSpawnGate(child, gate), /identity capture before release/);
    identity = captureGatedProcessIdentitySync(child.pid, {
      expectedCommand: marker,
      requireOwnProcessGroup: true,
    });
  } finally {
    abortPhaseSpawnGate(child, gate);
    if(identity) signalCapturedProcessGroup(identity, 'SIGKILL');
    await stop(child);
  }
  report({ rejectedBeforeCapture: true });
} else if(mode === 'transitive'){
  const source = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });",
    'child.unref();',
    'process.stdout.write(String(child.pid));',
  ].join('\n');
  const intermediate = spawnSync(process.execPath, ['-e', source], {
    detached: true,
    encoding: 'utf8',
  });
  assert.equal(intermediate.status, 0, intermediate.stderr);
  const sleeperPid = Number(intermediate.stdout);
  assert.ok(Number.isSafeInteger(sleeperPid) && sleeperPid > 0, `invalid transitive PID: ${intermediate.stdout}`);
  report({ emergencyPid: sleeperPid });
  assert.equal(processGroup(sleeperPid), processGroup(), 'transitive external child escaped phase PGID');
  report({ sleeperPid });
} else if(mode === 'stripped-transitive'){
  assert.throws(() => spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'noop'], {
    env: { NODE_OPTIONS: '--require=/definitely/not/playforge-trusted.cjs' },
    encoding: 'utf8',
  }), /conflicting NODE_OPTIONS/);
  assert.throws(() => spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'noop'], {
    env: { PLAYFORGE_INTERNAL_DESCENDANT_MARKER: 'different-marker' },
    encoding: 'utf8',
  }), /conflicting descendant marker/);
  const reports = [];
  const direct = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'spawn-external-report'], {
    env: {},
    encoding: 'utf8',
  });
  assert.equal(direct.status, 0, direct.stderr);
  reports.push(JSON.parse(direct.stdout.trim().split('\n').at(-1)));

  const forked = fork(new URL(import.meta.url).pathname, ['spawn-external-report'], {
    env: {},
    silent: true,
  });
  let forkStdout = '';
  let forkStderr = '';
  forked.stdout.on('data', chunk => { forkStdout += chunk; });
  forked.stderr.on('data', chunk => { forkStderr += chunk; });
  await closed(forked);
  assert.equal(forked.exitCode, 0, forkStderr);
  reports.push(JSON.parse(forkStdout.trim().split('\n').at(-1)));

  for(const observed of reports){
    report({ emergencyPid: observed.sleeperPid });
    assert.equal(observed.marker, process.env.PLAYFORGE_INTERNAL_DESCENDANT_MARKER,
      'stripped child changed recursive marker');
    assert.equal(observed.nodeOptions, TRUSTED_DESCENDANT_NODE_OPTION,
      'stripped child changed recursive preload');
    assert.equal(processGroup(observed.sleeperPid), processGroup(),
      'stripped-env transitive external child escaped phase PGID');
  }
  report({ sleeperPids: reports.map(observed => observed.sleeperPid), conflictsRejected: 2 });
} else if(mode === 'null-overloads'){
  const root = await mkdtemp(path.join(tmpdir(), 'playforge-guard-overloads-'));
  const canonicalRoot = await realpath(root);
  const script = path.join(root, 'probe.sh');
  const forkModule = path.join(root, 'fork-probe.cjs');
  await writeFile(script, [
    '#!/bin/sh',
    'printf "%s|%s|" "$PWD" "$PROBE"',
    '/bin/ps -o pgid= -p $$ | /usr/bin/tr -d " "',
  ].join('\n'));
  await chmod(script, 0o700);
  await writeFile(forkModule, [
    "const { spawnSync } = require('node:child_process');",
    "const pgid = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim();",
    "process.stdout.write(`${process.cwd()}|${process.env.PROBE}|${pgid}`);",
  ].join('\n'));
  const expectedGroup = processGroup();
  const expected = second => `${canonicalRoot}|${second}|${expectedGroup}`;
  const options = second => ({
    cwd: root,
    env: { PROBE: second },
    detached: true,
    encoding: 'utf8',
  });
  const asyncSpawn = second => new Promise((resolve, reject) => {
    const child = spawn(script, second === 'null' ? null : undefined, {
      ...options(second),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  });
  const asyncExecFile = second => new Promise((resolve, reject) => {
    execFile(script, second === 'null' ? null : undefined, options(second), (error, stdout, stderr) => {
      if(error) reject(new Error(`${error.message}\n${stderr}`));
      else resolve(stdout.trim());
    });
  });
  const asyncFork = second => new Promise((resolve, reject) => {
    const child = fork(forkModule, second === 'null' ? null : undefined, {
      ...options(second),
      silent: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  });
  try {
    for(const second of ['null', 'undefined']){
      assert.equal(await asyncSpawn(second), expected(second), `spawn ${second} overload lost options`);
      assert.equal(spawnSync(script, second === 'null' ? null : undefined, options(second)).stdout.trim(),
        expected(second), `spawnSync ${second} overload lost options`);
      assert.equal(await asyncExecFile(second), expected(second), `execFile ${second} overload lost options`);
      assert.equal(execFileSync(script, second === 'null' ? null : undefined, options(second)).trim(),
        expected(second), `execFileSync ${second} overload lost options`);
      assert.equal(await asyncFork(second), expected(second), `fork ${second} overload lost options`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  report({ overloads: 10 });
} else if(mode === 'puppeteer'){
  const { default: puppeteer } = await import('puppeteer');
  const profileRoot = await mkdtemp(path.join(tmpdir(), 'playforge-guard-chrome-'));
  let browser = null;
  let browserProcess = null;
  let browserPid = null;
  let expected = null;
  let closedNormally = false;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: resolveChromeExecutable(),
      userDataDir: path.join(profileRoot, 'profile'),
      timeout: 30_000,
      protocolTimeout: 30_000,
      args: ['--no-sandbox', '--mute-audio'],
    });
    browserProcess = browser.process();
    assert.ok(browserProcess?.pid > 0, 'Puppeteer browser PID');
    browserPid = browserProcess.pid;
    expected = processGroup();
    assert.equal(processGroup(browserProcess.pid), expected, 'Puppeteer Chrome escaped phase PGID');
    await browser.close();
    closedNormally = true;
  } finally {
    if(!closedNormally && browserProcess
      && browserProcess.exitCode === null && browserProcess.signalCode === null){
      try { await browser.close(); }
      catch(closeError){
        try { process.kill(-browserProcess.pid, 'SIGKILL'); }
        catch(killError){ browserProcess.kill('SIGKILL'); }
      }
    }
    await rm(profileRoot, { recursive: true, force: true });
  }
  report({ browserPid, expected });
} else {
  throw new Error(`unknown phase child-process guard fixture mode: ${mode}`);
}
