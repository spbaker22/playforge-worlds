import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createIdentityHandleScope } from './active-handle-scope.mjs';
import {
  abortCapturedGatedNode,
  releaseCapturedGatedNode,
  scopedGatedTitle,
  signalCapturedGatedNodeGroup,
  spawnCapturedGatedNode,
} from './phase-isolated-node.mjs';
import {
  exactMarkerProcessRecords,
  signalExactMarkerProcesses,
} from './phase-marker-processes.mjs';
import { inspectCapturedProcessGroup } from './phase-process-cleanup.mjs';
import {
  acquirePhase4ReleaseLock,
  assertPhase4ReleaseClaim,
  assertPhase4ReleaseClaimSync,
  captureExactProcessIdentitySync,
  exactProcessIdentityState,
  probeProcessIdentity,
  releasePhase4ReleaseLock,
  removeExactDeadPhase4Claims,
  signalExactProcessIdentity,
} from './runner.phase4.lock.mjs';
import {
  assertCandidateAuthorizationLive,
  consumeCandidateHandoff,
  createCandidateHandoff,
  prepareCommitGateCandidatesSync,
  publishCommitGrantSync,
  publishCommitRevokeSync,
} from './runner.phase4.handoff.mjs';
import {
  assertPhase4InputManifestUnchanged,
  assertPhase4InputManifestUnchangedSync,
  buildPhase4InputManifest,
} from './runner.phase4.frozen.mjs';
import {
  PHASE4_SHOT_NAMES,
  PHASE4_SHOT_VIEWPORTS,
  cleanupUninstalledTransaction,
  commitPromotionTransaction,
  createPromotionTransaction,
  decodeAndValidatePng,
  installPromotionTransaction,
  finalizeGrantedPromotionJournalSync,
  preparePromotionForCommitGate,
  recoverPromotionJournal,
  rollbackPromotionTransaction,
  stagePromotionTransaction,
  transactionResidues,
  validateInstalledTransaction,
  validateBaselineOldReport,
  validateCandidateHashChain,
  validateDevSkipReport,
  validateStrictParityReport,
} from './runner.phase4.promotion.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNNER = join(ROOT, 'runner');
const GOLF = join(ROOT, 'golf');
const HARNESS = join(ROOT, 'tools', 'shipcheck-phase4.mjs');
const TRANSACTION_CRASH_FIXTURE = join(ROOT, 'tools', 'runner.phase4.transaction-crash.fixture.mjs');
const TRUSTED_PS = '/bin/ps';
const TRUSTED_XATTR = '/usr/bin/xattr';
const TRUSTED_CHMOD = '/bin/chmod';
const TRUSTED_LS = '/bin/ls';
const TRUSTED_ID = '/usr/bin/id';
const TEMP_PREFIX = 'playforge-runner-phase4-supervisor-';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function officialArtifactHashes(){
  const paths = [
    join(RUNNER, 'dist', 'index.html'),
    join(RUNNER, 'gridlock-run-v1.html'),
    join(RUNNER, 'gridlock-run-v1-frames.png'),
    join(GOLF, 'dist', 'index.html'),
    join(GOLF, 'stackyard-golf-v1.html'),
    ...Object.keys(PHASE4_SHOT_VIEWPORTS).flatMap(viewport => PHASE4_SHOT_NAMES.map(name => (
      join(RUNNER, 'phase4-shots', viewport, `${name}.png`)
    ))),
  ];
  assert.equal(paths.length, 17, 'official Phase 4 artifact inventory');
  return Object.fromEntries(await Promise.all(paths.sort().map(async file => [
    file, fileHash(await readFile(file)),
  ])));
}

async function phase4TempDirectories(marker = null){
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory()
      && entry.name.startsWith(marker ? `${TEMP_PREFIX}${marker}-` : TEMP_PREFIX))
    .map(entry => entry.name)
    .sort();
}

async function markerPromotionResidues(marker){
  const residues = [];
  for(const root of [RUNNER, GOLF]){
    const entries = await readdir(root, { withFileTypes: true });
    for(const entry of entries){
      if(entry.name.includes(marker) && /(?:stage|backup)/.test(entry.name)) residues.push(join(root, entry.name));
    }
  }
  return residues.sort();
}

function markerProcesses(marker){
  if(process.platform === 'win32') return [];
  return exactMarkerProcessRecords(marker).records;
}

function emergencyCleanup(owned, marker){
  const child = owned?.child;
  if(process.platform === 'win32'){
    if(child?.pid){
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', timeout: 5_000,
      });
    }
    return;
  }
  const errors = [];
  if(owned?.identity){
    try {
      const group = signalCapturedGatedNodeGroup(owned, 'SIGKILL');
      if(group.state === 'UNKNOWN') errors.push(new Error(`captured group cleanup was indeterminate: ${group.reason}`));
    }
    catch(error){ errors.push(error); }
  }
  const exact = signalExactMarkerProcesses(marker, 'SIGKILL');
  errors.push(...exact.errors);
  if(child?.exitCode === null && child?.signalCode === null){
    try { child.kill('SIGKILL'); } catch(error){ errors.push(error); }
  }
  if(errors.length) throw new AggregateError(errors, 'Phase 4 watchdog exact emergency cleanup failed');
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

function describeResource(resource){
  return {
    type: resource?.constructor?.name || typeof resource,
    fd: Number.isInteger(resource?.fd) ? resource.fd
      : Number.isInteger(resource?._handle?.fd) ? resource._handle.fd : null,
    pid: Number.isInteger(resource?.pid) ? resource.pid : null,
    hasRef: typeof resource?.hasRef === 'function' ? resource.hasRef()
      : typeof resource?._handle?.hasRef === 'function' ? resource._handle.hasRef() : null,
  };
}

async function assertNoOwnedResources(scope){
  const deadline = Date.now() + 3_000;
  let ownership;
  do {
    ownership = scope.classify();
    if(ownership.handles.length === 0 && ownership.requests.length === 0) return;
    await sleep(25);
  } while(Date.now() < deadline);
  assert.fail(`Phase 4 negative test leaked resources: ${JSON.stringify({
    handles: ownership.handles.map(describeResource),
    requests: ownership.requests.map(describeResource),
  })}`);
}

async function runNegative({
  marker, args, env = {}, emergencyMilliseconds = 20_000,
  expectPreCleanupResidue = false,
}){
  const beforeTemps = await phase4TempDirectories(marker);
  await new Promise(resolve => setImmediate(resolve));
  const scope = createIdentityHandleScope({
    ignoredHandles: [process.stdin, process.stdout, process.stderr],
  });
  const stdout = [];
  const stderr = [];
  const started = Date.now();
  let emergencyTriggered = false;
  const owned = spawnCapturedGatedNode({
    title: scopedGatedTitle(`${marker}:harness`),
    args: [HARNESS, ...args],
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { child } = owned;
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  await releaseCapturedGatedNode(owned);
  const emergencyTimer = setTimeout(() => {
    emergencyTriggered = true;
    emergencyCleanup(owned, marker);
  }, emergencyMilliseconds);

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(emergencyTimer);
  }

  // Snapshot and assert the supervisor's natural teardown before any test-side
  // kill, rm, stream destroy, or unref can hide residue.
  await sleep(50);
  const afterTemps = await phase4TempDirectories(marker);
  const newTemps = afterTemps.filter(name => !beforeTemps.includes(name));
  const survivors = markerProcesses(marker);
  const promotionResidues = await markerPromotionResidues(marker);
  const capturedGroup = process.platform === 'win32'
    ? { state: 'PROVEN_DEAD', reason: 'windows-child-handle' }
    : inspectCapturedProcessGroup(owned.identity);
  await new Promise(resolve => setImmediate(resolve));
  let ownership = scope.classify();
  const ownershipDeadline = Date.now() + 500;
  while((ownership.handles.length || ownership.requests.length) && Date.now() < ownershipDeadline){
    await sleep(25);
    ownership = scope.classify();
  }
  const preCleanup = {
    survivors,
    newTemps,
    promotionResidues,
    capturedGroup,
    handles: ownership.handles.map(describeResource),
    requests: ownership.requests.map(describeResource),
  };
  let preCleanupAssertion = null;
  try {
    if(expectPreCleanupResidue){
      assert.ok(survivors.length || newTemps.length || promotionResidues.length
        || ownership.handles.length || ownership.requests.length,
      'injected supervisor leak was not detected before hygiene cleanup');
    } else {
      assert.deepEqual(preCleanup, {
        survivors: [], newTemps: [], promotionResidues: [],
        capturedGroup: { state: 'PROVEN_DEAD', reason: 'process-group-empty' },
        handles: [], requests: [],
      }, 'Phase 4 supervisor left pre-cleanup ownership residue');
    }
  } catch(error){
    preCleanupAssertion = error;
  }

  // Hygiene occurs only after the evidence above is immutable. A real residue
  // still fails the test after cleanup; the one proof fixture opts into
  // asserting that detection itself.
  emergencyCleanup(owned, marker);
  await Promise.all(newTemps.map(name => rm(join(tmpdir(), name), { recursive: true, force: true })));
  await Promise.all(promotionResidues.map(file => rm(file, { recursive: true, force: true })));
  abortCapturedGatedNode(owned);
  releaseChild(child);
  await assertNoOwnedResources(scope);
  if(process.platform !== 'win32'){
    const finalGroup = inspectCapturedProcessGroup(owned.identity);
    assert.equal(finalGroup.state, 'PROVEN_DEAD',
      `test hygiene left captured group ${finalGroup.state}: ${finalGroup.reason}`);
  }
  assert.deepEqual(markerProcesses(marker), [], 'test hygiene left marker processes');
  assert.deepEqual(await phase4TempDirectories(marker), beforeTemps, 'test hygiene left Phase 4 temp directories');
  assert.deepEqual(await markerPromotionResidues(marker), [], 'test hygiene left promotion residue');
  if(preCleanupAssertion) throw preCleanupAssertion;
  return {
    result,
    output: Buffer.concat([...stdout, ...stderr]).toString('utf8'),
    elapsedMs: Date.now() - started,
    emergencyTriggered,
    preCleanup,
  };
}

test('release preflight rejects malicious inherited Phase 4 controls before spawn or temp creation', {
  timeout: 10_000,
}, async () => {
  const marker = `phase4-env-negative-${process.pid}-${Date.now()}`;
  const result = await runNegative({
    marker,
    args: [],
    env: {
      RUNNER_PHASE4_WRITE_SHOTS: '1',
      RUNNER_PHASE4_SKIP_PARITY: '1',
      RUNNER_PHASE4_INTERNAL_WORKER: '1',
      RUNNER_PHASE4_MODE: 'release',
      RUNNER_PHASE4_OUTPUT_DIR: '/tmp/not-parent-owned',
      RUNNER_PHASE4_FIXTURE: 'post-boot-sync-hang',
    },
    emergencyMilliseconds: 5_000,
  });
  assert.equal(result.emergencyTriggered, false, 'preflight needed emergency cleanup');
  assert.equal(result.result.code, 1, `malicious environment must exit 1, received ${result.result.code}/${result.result.signal}`);
  assert.ok(result.elapsedMs < 3_000, `malicious environment was not rejected at preflight (${result.elapsedMs}ms)`);
  assert.match(result.output, /refusing inherited Phase 4 control environment/);
  assert.match(result.output, /RUNNER_PHASE4_WRITE_SHOTS/);
  assert.match(result.output, /RUNNER_PHASE4_SKIP_PARITY/);
  assert.doesNotMatch(result.output, /PASS/);
});

test('candidate handoff is one-use, exact, fresh, mode-bound, and requires its live outer identity', {
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), `phase4-handoff-${process.pid}-`));
  const marker = `playforge-release-handoff-${process.pid}-${Date.now()}-${'a'.repeat(24)}`;
  const hashes = { runner: '1'.repeat(64), golf: '2'.repeat(64) };
  try {
    const validPath = join(root, 'valid.json');
    await createCandidateHandoff({
      handoffPath: validPath, tempRoot: root, outerMarker: marker, candidateFresh: hashes,
    });
    const consumed = await consumeCandidateHandoff({
      handoffPath: validPath, tempRoot: root, expectedOuterMarker: marker,
    });
    assert.deepEqual(consumed.candidateFresh, hashes);
    assert.equal((await readdir(root)).includes('valid.json'), false, 'handoff was not consumed');
    await assert.rejects(consumeCandidateHandoff({
      handoffPath: validPath, tempRoot: root, expectedOuterMarker: marker,
    }), /unavailable/);

    const cases = [
      {
        name: 'one-hash',
        mutate: payload => { payload.candidateFresh = { runner: hashes.runner }; },
        pattern: /missing or extra keys/,
      },
      {
        name: 'tampered-hash',
        mutate: payload => { payload.candidateFresh.runner = 'not-a-hash'; },
        pattern: /Runner SHA-256/,
      },
      {
        name: 'stale',
        mutate: payload => { payload.createdAt = 1; },
        pattern: /stale/,
      },
      {
        name: 'dead-outer',
        mutate: payload => {
          payload.outerPid = 2_000_000_000;
          payload.outerProcessStart = 'posix-lstart-utc:Mon Jan 1 00:00:00 1990';
        },
        pattern: /not provably live/,
      },
    ];
    for(const fixture of cases){
      const handoffPath = join(root, `${fixture.name}.json`);
      await createCandidateHandoff({
        handoffPath, tempRoot: root, outerMarker: marker, candidateFresh: hashes,
      });
      const payload = JSON.parse(await readFile(handoffPath, 'utf8'));
      fixture.mutate(payload);
      await writeFile(handoffPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      await assert.rejects(consumeCandidateHandoff({
        handoffPath, tempRoot: root, expectedOuterMarker: marker,
      }), fixture.pattern, fixture.name);
      assert.equal((await readdir(root)).includes(`${fixture.name}.json`), true,
        `${fixture.name} invalid proof was consumed`);
      await rm(handoffPath, { force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('complete Phase 4 build-input manifest rejects source change, addition, and removal', {
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), `phase4-build-inputs-${process.pid}-`));
  const contents = new Map([
    ['engine/core.js', 'engine-v1'],
    ['runner/src/main.js', 'runner-v1'],
    ['golf/src/main.js', 'golf-v1'],
    ['runner/index.html', 'runner-index'],
    ['runner/vite.config.js', 'runner-config'],
    ['golf/index.html', 'golf-index'],
    ['golf/vite.config.js', 'golf-config'],
    ['package.json', '{}'],
    ['package-lock.json', '{}'],
  ]);
  try {
    for(const relativePath of contents.keys()) await mkdir(join(root, dirname(relativePath)), { recursive: true });
    for(const [relativePath, bytes] of contents) await writeFile(join(root, relativePath), bytes);
    const expected = await buildPhase4InputManifest(root);
    assert.equal(expected.files.length, contents.size);

    await writeFile(join(root, 'engine/core.js'), 'engine-v2');
    await assert.rejects(assertPhase4InputManifestUnchanged(root, expected, 'changed-source'),
      /changed after candidate build/);
    await writeFile(join(root, 'engine/core.js'), contents.get('engine/core.js'));

    await writeFile(join(root, 'runner/src/added.js'), 'added');
    await assert.rejects(assertPhase4InputManifestUnchanged(root, expected, 'added-source'),
      /changed after candidate build/);
    await rm(join(root, 'runner/src/added.js'));

    await rm(join(root, 'golf/src/main.js'));
    await assert.rejects(assertPhase4InputManifestUnchanged(root, expected, 'removed-source'),
      /changed after candidate build/);
    await writeFile(join(root, 'golf/src/main.js'), contents.get('golf/src/main.js'));
    assert.deepEqual(await assertPhase4InputManifestUnchanged(root, expected), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dead outer authorization blocks both pre-install and final commit and restores exact OLD', {
  timeout: 25_000,
}, async () => {
  const newAuthorizer = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    const identity = probeProcessIdentity(child.pid);
    assert.equal(identity.state, 'LIVE');
    return {
      child,
      exited: new Promise(resolve => child.once('close', resolve)),
      authorization: {
        outerMarker: `playforge-release-authority-${child.pid}-${Date.now()}-${'c'.repeat(24)}`,
        outerPid: child.pid,
        outerProcessStart: identity.processStart,
        nonce: 'd'.repeat(48),
        createdAt: Date.now(),
        candidateFresh: { runner: '1'.repeat(64), golf: '2'.repeat(64) },
      },
    };
  };
  const killAuthorizer = async owner => {
    owner.child.kill('SIGKILL');
    await owner.exited;
    assert.throws(() => assertCandidateAuthorizationLive(owner.authorization), /not provably live/);
  };

  const beforeInstall = await createTransactionSandbox(`outer-before-install-${process.pid}-${Date.now()}`);
  let owner = newAuthorizer();
  try {
    await stagePromotionTransaction(beforeInstall.transaction);
    await killAuthorizer(owner);
    await cleanupUninstalledTransaction(beforeInstall.transaction);
    await assertOldTransactionDestinations(beforeInstall);
    assert.deepEqual(await transactionResidues(beforeInstall.transaction), []);
  } finally {
    if(owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill('SIGKILL');
    await owner.exited;
    await rm(beforeInstall.root, { recursive: true, force: true });
  }

  const beforeCommit = await createTransactionSandbox(`outer-before-commit-${process.pid}-${Date.now()}`);
  owner = newAuthorizer();
  try {
    await stagePromotionTransaction(beforeCommit.transaction);
    await installPromotionTransaction(beforeCommit.transaction);
    await validateInstalledTransaction(beforeCommit.transaction);
    await killAuthorizer(owner);
    await assert.rejects(commitPromotionTransaction(beforeCommit.transaction, {
      finalCommitGuard: () => assertCandidateAuthorizationLive(owner.authorization),
    }), /not provably live/);
    assert.equal(beforeCommit.transaction.committed, false);
    await cleanupUninstalledTransaction(beforeCommit.transaction);
    await assertOldTransactionDestinations(beforeCommit);
    assert.deepEqual(await transactionResidues(beforeCommit.transaction), []);
  } finally {
    if(owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill('SIGKILL');
    await owner.exited;
    await rm(beforeCommit.root, { recursive: true, force: true });
  }
});

test('atomic COMMIT_GRANTED versus REVOKED gate yields one exact terminal generation with no mixed residue', {
  timeout: 30_000,
}, async () => {
  for(let index = 0; index < 8; index += 1){
    const sandbox = await createTransactionSandbox(`decision-race-${index}-${process.pid}-${Date.now()}`);
    const decisionRoot = join(sandbox.root, 'decision');
    await mkdir(decisionRoot);
    const handoffPath = join(decisionRoot, 'handoff.json');
    const nonce = createHash('sha256').update(`${index}-${Date.now()}`).digest('hex').slice(0, 48);
    const gate = {
      nonce,
      handoffPath,
      tempRoot: decisionRoot,
    };
    const paths = prepareCommitGateCandidatesSync(gate);
    Object.assign(gate, paths);
    try {
      await stagePromotionTransaction(sandbox.transaction);
      await installPromotionTransaction(sandbox.transaction);
      await validateInstalledTransaction(sandbox.transaction);
      await preparePromotionForCommitGate(sandbox.transaction);
      assert.equal(sandbox.transaction.state, 'awaiting-grant');
      let outcome;
      if(index % 2 === 0){
        outcome = publishCommitGrantSync(gate);
        assert.equal(publishCommitRevokeSync(gate).decision, 'COMMIT_GRANTED');
      } else {
        outcome = publishCommitRevokeSync(gate);
        assert.equal(publishCommitGrantSync(gate).decision, 'REVOKED');
      }
      if(outcome.decision === 'COMMIT_GRANTED'){
        finalizeGrantedPromotionJournalSync({
          projectRoot: sandbox.root,
          transactionId: sandbox.transaction.marker,
          transaction: sandbox.transaction,
          finalCommitGuard: () => assert.equal(outcome.decision, 'COMMIT_GRANTED'),
        });
        sandbox.transaction.committed = true;
        sandbox.transaction.state = 'committed';
        await assertNewTransactionDestinations(sandbox);
        assert.deepEqual(await recoverPromotionJournal({ projectRoot: sandbox.root }), {
          recovered: true,
          action: 'finished-commit',
          transactionId: sandbox.transaction.marker,
        });
      } else {
        await cleanupUninstalledTransaction(sandbox.transaction);
        await assertOldTransactionDestinations(sandbox);
      }
      assert.deepEqual(await transactionResidues(sandbox.transaction), []);
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }
});

test('late build-input mutation after READY blocks durable final ACK and restores exact OLD', {
  timeout: 20_000,
}, async () => {
  const buildRoot = await mkdtemp(join(tmpdir(), `phase4-late-input-${process.pid}-`));
  const sandbox = await createTransactionSandbox(`late-input-${process.pid}-${Date.now()}`);
  const contents = new Map([
    ['engine/core.js', 'engine-v1'],
    ['runner/src/main.js', 'runner-v1'],
    ['golf/src/main.js', 'golf-v1'],
    ['runner/index.html', 'runner-index'],
    ['runner/vite.config.js', 'runner-config'],
    ['golf/index.html', 'golf-index'],
    ['golf/vite.config.js', 'golf-config'],
    ['package.json', '{}'],
    ['package-lock.json', '{}'],
  ]);
  try {
    for(const relativePath of contents.keys()) await mkdir(join(buildRoot, dirname(relativePath)), { recursive: true });
    for(const [relativePath, bytes] of contents) await writeFile(join(buildRoot, relativePath), bytes);
    const expectedInputs = await buildPhase4InputManifest(buildRoot);
    await stagePromotionTransaction(sandbox.transaction);
    await installPromotionTransaction(sandbox.transaction);
    await validateInstalledTransaction(sandbox.transaction);
    await preparePromotionForCommitGate(sandbox.transaction);
    await writeFile(join(buildRoot, 'runner/src/main.js'), 'runner-mutated-after-ready');
    assert.throws(() => finalizeGrantedPromotionJournalSync({
      projectRoot: sandbox.root,
      transactionId: sandbox.transaction.marker,
      transaction: sandbox.transaction,
      finalCommitGuard: () => assertPhase4InputManifestUnchangedSync(
        buildRoot, expectedInputs, 'late final source guard',
      ),
    }), /changed after candidate build/);
    assert.equal(JSON.parse(await readFile(sandbox.transaction.journalPath, 'utf8')).state,
      'awaiting-grant', 'failed final source guard wrote a durable final ACK');
    await cleanupUninstalledTransaction(sandbox.transaction);
    await assertOldTransactionDestinations(sandbox);
    assert.deepEqual(await transactionResidues(sandbox.transaction), []);
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
    await rm(sandbox.root, { recursive: true, force: true });
  }
});

test('durable FINAL_COMMIT_ACK before root rename recovers exact NEW', {
  timeout: 20_000,
}, async () => {
  const sandbox = await createTransactionSandbox(`final-ack-recovery-${process.pid}-${Date.now()}`);
  try {
    await stagePromotionTransaction(sandbox.transaction);
    await installPromotionTransaction(sandbox.transaction);
    await validateInstalledTransaction(sandbox.transaction);
    await preparePromotionForCommitGate(sandbox.transaction);
    const journal = JSON.parse(await readFile(sandbox.transaction.journalPath, 'utf8'));
    journal.state = 'commit-intent';
    journal.progress = { installed: journal.items.map(item => item.id), finalCommitAck: true };
    journal.updatedAt = Date.now();
    await writeFile(sandbox.transaction.journalPath, `${JSON.stringify(journal)}\n`);
    assert.deepEqual(await recoverPromotionJournal({ projectRoot: sandbox.root }), {
      recovered: true,
      action: 'finished-commit',
      transactionId: sandbox.transaction.marker,
    });
    await assertNewTransactionDestinations(sandbox);
    assert.deepEqual(await transactionResidues(sandbox.transaction), []);
  } finally {
    await rm(sandbox.root, { recursive: true, force: true });
  }
});

test('every post-ACK failure cut is monotonic and recovery finishes exact NEW', {
  timeout: 30_000,
}, async () => {
  for(const hookName of ['afterDurableFinalCommitAck', 'afterCommitPoint', 'afterCommittedJournal']){
    const sandbox = await createTransactionSandbox(`post-ack-${hookName}-${process.pid}-${Date.now()}`);
    try {
      await stagePromotionTransaction(sandbox.transaction);
      await installPromotionTransaction(sandbox.transaction);
      await validateInstalledTransaction(sandbox.transaction);
      await preparePromotionForCommitGate(sandbox.transaction);
      assert.throws(() => finalizeGrantedPromotionJournalSync({
        projectRoot: sandbox.root,
        transactionId: sandbox.transaction.marker,
        transaction: sandbox.transaction,
        finalCommitGuard: () => {},
        [hookName]: () => { throw new Error(`injected ${hookName}`); },
      }), new RegExp(`injected ${hookName}`));
      assert.equal(sandbox.transaction.committed, true,
        `${hookName} lost monotonic committed state`);
      await assert.rejects(rollbackPromotionTransaction(sandbox.transaction),
        /cannot rollback a committed promotion|durable FINAL_COMMIT_ACK/);
      assert.deepEqual(await recoverPromotionJournal({ projectRoot: sandbox.root }), {
        recovered: true,
        action: 'finished-commit',
        transactionId: sandbox.transaction.marker,
      });
      await assertNewTransactionDestinations(sandbox);
      assert.deepEqual(await transactionResidues(sandbox.transaction), []);
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }
});

test('release claim excludes a contender from READY through COMMIT_GRANTED and final ACK', {
  timeout: 20_000,
}, async () => {
  const sandbox = await createTransactionSandbox(`claim-through-ack-${process.pid}-${Date.now()}`);
  const claimDirectory = join(sandbox.root, 'claims');
  const ownerMarker = `phase4-claim-owner-${process.pid}-${Date.now()}`;
  let owner = null;
  let successor = null;
  try {
    owner = await acquirePhase4ReleaseLock({ claimDirectory, marker: ownerMarker });
    await assertPhase4ReleaseClaim(owner);
    await stagePromotionTransaction(sandbox.transaction);
    await installPromotionTransaction(sandbox.transaction);
    await validateInstalledTransaction(sandbox.transaction);
    await preparePromotionForCommitGate(sandbox.transaction);
    await assert.rejects(acquirePhase4ReleaseLock({
      claimDirectory,
      marker: `phase4-claim-contender-${process.pid}-${Date.now()}`,
    }), /already held|held by|lost election|incumbent/i);
    finalizeGrantedPromotionJournalSync({
      projectRoot: sandbox.root,
      transactionId: sandbox.transaction.marker,
      transaction: sandbox.transaction,
      finalCommitGuard: () => assertPhase4ReleaseClaimSync(owner),
    });
    await assertPhase4ReleaseClaim(owner);
    await releasePhase4ReleaseLock(owner);
    owner = null;
    assert.deepEqual(await recoverPromotionJournal({ projectRoot: sandbox.root }), {
      recovered: true,
      action: 'finished-commit',
      transactionId: sandbox.transaction.marker,
    });
    successor = await acquirePhase4ReleaseLock({
      claimDirectory,
      marker: `phase4-claim-successor-${process.pid}-${Date.now()}`,
    });
    await assertPhase4ReleaseClaim(successor);
  } finally {
    if(successor) await releasePhase4ReleaseLock(successor).catch(() => {});
    if(owner) await releasePhase4ReleaseLock(owner).catch(() => {});
    await rm(sandbox.root, { recursive: true, force: true });
  }
});

test('direct release without a live candidate handoff fails before claim, temp, or official writes', {
  timeout: 10_000,
}, async () => {
  const marker = `phase4-direct-proof-${process.pid}-${Date.now()}`;
  const before = await officialArtifactHashes();
  const claimDirectory = join(RUNNER, '.phase4-release-claims');
  const claimsBefore = await readdir(claimDirectory).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  const result = await runNegative({ marker, args: ['--release'], emergencyMilliseconds: 5_000 });
  assert.equal(result.result.code, 1, result.output);
  assert.match(result.output, /candidate handoff.*required|candidate handoff is unavailable/);
  assert.doesNotMatch(result.output, /PASS/);
  assert.deepEqual(await officialArtifactHashes(), before);
  const claimsAfter = await readdir(claimDirectory).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(claimsAfter, claimsBefore, 'direct Phase 4 touched release claims before proof');
});

test('an unexpectedly successful fixture is structurally nonpromoting and cannot print PASS', {
  timeout: 10_000,
}, async () => {
  const marker = `phase4-fixture-control-${process.pid}-${Date.now()}`;
  const before = await officialArtifactHashes();
  const result = await runNegative({
    marker,
    args: ['--release', '--fixture=unexpected-success-control', `--test-marker=${marker}`],
    emergencyMilliseconds: 5_000,
  });
  assert.equal(result.result.code, 1, result.output);
  assert.match(result.output, /unexpectedly succeeded.*structurally nonpromoting/);
  assert.doesNotMatch(result.output, /PASS/);
  assert.deepEqual(await officialArtifactHashes(), before, 'fixture control changed an official artifact');
});

test('negative harness observes an injected supervisor leak before hygiene cleanup', {
  timeout: 10_000,
}, async () => {
  const marker = `phase4-supervisor-leak-${process.pid}-${Date.now()}`;
  const result = await runNegative({
    marker,
    args: ['--dev', '--fixture=supervisor-leak', `--test-marker=${marker}`],
    expectPreCleanupResidue: true,
    emergencyMilliseconds: 5_000,
  });
  assert.equal(result.emergencyTriggered, false);
  assert.equal(result.result.code, 1);
  assert.match(result.output, new RegExp(`runner-phase4-supervisor-leak:${marker}`));
  assert.ok(result.preCleanup.survivors.length > 0, 'proof fixture process leak was not recorded');
  assert.ok(result.preCleanup.newTemps.length > 0, 'proof fixture temp leak was not recorded');
});

test('concurrent release supervisor fails on the exclusive lock before artifact writes', {
  timeout: 15_000,
}, async () => {
  const holderMarker = `phase4-lock-holder-${process.pid}-${Date.now()}`;
  const contenderMarker = `phase4-lock-contender-${process.pid}-${Date.now()}`;
  const artifactPaths = [
    join(RUNNER, 'gridlock-run-v1-frames.png'),
    join(RUNNER, 'gridlock-run-v1.html'),
    join(RUNNER, 'dist', 'index.html'),
    join(GOLF, 'stackyard-golf-v1.html'),
    join(GOLF, 'dist', 'index.html'),
  ];
  const before = Object.fromEntries(await Promise.all(artifactPaths.map(async file => [file, fileHash(await readFile(file))])));
  const holderOwned = spawnCapturedGatedNode({
    title: scopedGatedTitle(`${holderMarker}:holder`),
    args: [HARNESS, '--release', '--lock-only-ms=1800', `--test-marker=${holderMarker}`],
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const holder = holderOwned.child;
  let output = '';
  holder.stdout.on('data', chunk => { output += chunk; });
  holder.stderr.on('data', chunk => { output += chunk; });
  const holderExit = new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.once('close', (code, signal) => resolve({ code, signal }));
  });
  await releaseCapturedGatedNode(holderOwned);
  try {
    const deadline = Date.now() + 5_000;
    while(!output.includes(`runner-phase4-lock-held:${holderMarker}`)){
      if(Date.now() >= deadline) assert.fail(`lock holder did not become ready: ${output}`);
      await sleep(20);
    }
    const contender = await runNegative({
      marker: contenderMarker,
      args: ['--release', '--lock-only-ms=200', `--test-marker=${contenderMarker}`],
      emergencyMilliseconds: 5_000,
    });
    assert.equal(contender.result.code, 1, `concurrent contender result: ${contender.output}`);
    assert.match(contender.output, /release lock is held/);
    const holderResult = await holderExit;
    assert.equal(holderResult.code, 0, `lock holder failed ${holderResult.code}/${holderResult.signal}: ${output}`);
  } finally {
    emergencyCleanup(holderOwned, holderMarker);
    abortCapturedGatedNode(holderOwned);
    releaseChild(holder);
    await sleep(50);
    await removeExactDeadPhase4Claims({
      claimDirectory: join(RUNNER, '.phase4-release-claims'),
      ownedPids: new Set([holder.pid]),
    });
  }
  const after = Object.fromEntries(await Promise.all(artifactPaths.map(async file => [file, fileHash(await readFile(file))])));
  assert.deepEqual(after, before, 'concurrent lock attempt changed official artifacts');
});

test('claim-set arbitration elects one writer, ignores dead claims, and cannot displace an incumbent', {
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), `phase4-lock-recovery-${process.pid}-`));
  const claimDirectory = join(root, '.phase4-release-claims');
  const deadPid = 2_000_000_000;
  try {
    await mkdir(join(claimDirectory, `claim-${deadPid}-${'0'.repeat(16)}-${'a'.repeat(24)}`), { recursive: true });
    const attempts = Array.from({ length: 8 }, (_, index) => acquirePhase4ReleaseLock({
      claimDirectory,
      marker: `claim-race-${process.pid}-${Date.now()}-${index}`,
      settleMs: 150,
    }));
    const settled = await Promise.allSettled(attempts);
    const winners = settled.filter(result => result.status === 'fulfilled').map(result => result.value);
    assert.equal(winners.length, 1, `claim race elected ${winners.length} writers`);
    const [winner] = winners;
    await assertPhase4ReleaseClaim(winner);

    await assert.rejects(acquirePhase4ReleaseLock({
      claimDirectory,
      marker: `late-claim-${process.pid}-${Date.now()}`,
      settleMs: 75,
    }), /held by another live claimant/);
    await assertPhase4ReleaseClaim(winner);

    const removed = await removeExactDeadPhase4Claims({ claimDirectory, ownedPids: new Set([deadPid]) });
    assert.equal(removed.length, 0, 'startup should already prune the proven-dead published claim');
    await assertPhase4ReleaseClaim(winner);
    await releasePhase4ReleaseLock(winner);

    let releaseDelayed;
    let markDelayedReady;
    const delayedReady = new Promise(resolve => { markDelayedReady = resolve; });
    const delayedGate = new Promise(resolve => { releaseDelayed = resolve; });
    const delayed = acquirePhase4ReleaseLock({
      claimDirectory,
      marker: `delayed-claim-${process.pid}-${Date.now()}`,
      settleMs: 150,
      beforePublish: async () => {
        markDelayedReady();
        await delayedGate;
      },
    });
    await delayedReady;
    const incumbent = await acquirePhase4ReleaseLock({
      claimDirectory,
      marker: `published-incumbent-${process.pid}-${Date.now()}`,
      settleMs: 75,
    });
    releaseDelayed();
    await assert.rejects(delayed, /held by another live claimant/);
    await assertPhase4ReleaseClaim(incumbent);
    await releasePhase4ReleaseLock(incumbent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('process identity is canonical across caller TZ/locale and cross-TZ claimants elect one writer', {
  timeout: 15_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), `phase4-cross-tz-${process.pid}-`));
  const claimDirectory = join(root, '.phase4-release-claims');
  const hostileBin = join(root, 'hostile-bin');
  await mkdir(hostileBin);
  await writeFile(join(hostileBin, 'ps'), '#!/bin/sh\nprintf "Mon Jan 1 00:00:00 1990\\n"\n');
  await chmod(join(hostileBin, 'ps'), 0o755);
  const lockModule = join(ROOT, 'tools', 'runner.phase4.lock.mjs');
  const probeSource = [
    `import { probeProcessIdentity } from ${JSON.stringify(lockModule)};`,
    'console.log(JSON.stringify(probeProcessIdentity(Number(process.argv[1]))));',
  ].join('\n');
  const probeUnder = environment => spawnSync(
    process.execPath,
    ['--input-type=module', '-e', probeSource, String(process.pid)],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...environment } },
  );
  const utc = probeUnder({ TZ: 'UTC', LANG: 'C', LC_ALL: 'C' });
  const phoenix = probeUnder({
    TZ: 'America/Phoenix', LANG: 'POSIX', LC_ALL: 'POSIX', PATH: hostileBin,
  });
  assert.equal(utc.status, 0, utc.stderr);
  assert.equal(phoenix.status, 0, phoenix.stderr);
  assert.deepEqual(JSON.parse(utc.stdout), JSON.parse(phoenix.stdout),
    'the same PID produced caller-environment-dependent process identities');

  // A fast exit/UNKNOWN capture is never inserted into ownership state, and a
  // later unrelated process reusing the PID is never signalled.
  const syntheticPid = 424_242;
  const rememberedSynthetic = new Map();
  assert.throws(() => {
    const identity = captureExactProcessIdentitySync(syntheticPid, {
      expectedCommandMarker: 'playforge-synthetic-child',
      processProbe: () => ({ state: 'PROVEN_DEAD', processStart: null }),
      rowProbe: () => { throw new Error('row probe must not run for a dead child'); },
    });
    rememberedSynthetic.set(identity.pid, identity);
  }, /PROVEN_DEAD before ownership capture/);
  assert.equal(rememberedSynthetic.size, 0, 'fast-exit PID was remembered');
  const capturedSynthetic = captureExactProcessIdentitySync(syntheticPid, {
    expectedCommandMarker: 'playforge-synthetic-child',
    requireOwnProcessGroup: true,
    processProbe: () => ({ state: 'LIVE', processStart: 'synthetic-start-A' }),
    rowProbe: () => ({
      pid: syntheticPid,
      pgid: syntheticPid,
      status: 'S',
      command: 'node --title=playforge-synthetic-child fixture.mjs',
    }),
  });
  assert.equal(exactProcessIdentityState(capturedSynthetic, {
    processProbe: () => ({ state: 'LIVE', processStart: 'synthetic-start-B' }),
    rowProbe: () => ({
      pid: syntheticPid, pgid: syntheticPid, status: 'S', command: 'unrelated replacement',
    }),
  }).reason, 'pid-reused');
  const signals = [];
  const signalResult = signalExactProcessIdentity(capturedSynthetic, 'SIGKILL', {
    processProbe: () => ({ state: 'LIVE', processStart: 'synthetic-start-B' }),
    rowProbe: () => ({
      pid: syntheticPid, pgid: syntheticPid, status: 'S', command: 'unrelated replacement',
    }),
    signalProcess: (...args) => signals.push(args),
  });
  assert.equal(signalResult.signalled, false);
  assert.deepEqual(signals, [], 'PID-reused unrelated process was signalled');
  const exactSignals = [];
  const exactSignalResult = signalExactProcessIdentity(capturedSynthetic, 'SIGTERM', {
    processProbe: () => ({ state: 'LIVE', processStart: 'synthetic-start-A' }),
    rowProbe: () => ({
      pid: syntheticPid,
      pgid: syntheticPid,
      status: 'S',
      command: 'node --title=playforge-synthetic-child fixture.mjs',
    }),
    signalProcess: (...args) => exactSignals.push(args),
  });
  assert.equal(exactSignalResult.signalled, true);
  assert.deepEqual(exactSignals, [[-syntheticPid, 'SIGTERM']],
    'an exact process-group identity must be signalled once, without a later bare-PID race');

  const contenderSource = [
    `import { acquirePhase4ReleaseLock, releasePhase4ReleaseLock } from ${JSON.stringify(lockModule)};`,
    'const [claimDirectory, marker] = process.argv.slice(1);',
    'try {',
    '  const lock = await acquirePhase4ReleaseLock({ claimDirectory, marker, settleMs: 250 });',
    '  console.log(`winner:${marker}`);',
    '  await new Promise(resolve => setTimeout(resolve, 650));',
    '  await releasePhase4ReleaseLock(lock);',
    '} catch (error) {',
    '  console.error(`loser:${marker}:${error.message}`);',
    '  process.exitCode = 2;',
    '}',
  ].join('\n');
  const spawnContender = (marker, environment) => {
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', contenderSource, claimDirectory, marker,
    ], {
      cwd: ROOT,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, output }));
    });
  };
  try {
    const markerBase = `cross-tz-${process.pid}-${Date.now()}`;
    const results = await Promise.all([
      spawnContender(`${markerBase}-utc`, { TZ: 'UTC', LANG: 'C', LC_ALL: 'C' }),
      spawnContender(`${markerBase}-phoenix`, {
        TZ: 'America/Phoenix', LANG: 'POSIX', LC_ALL: 'POSIX', PATH: hostileBin,
      }),
    ]);
    assert.equal(results.filter(result => result.code === 0).length, 1, JSON.stringify(results));
    assert.equal(results.filter(result => result.code === 2).length, 1, JSON.stringify(results));
    assert.match(results.find(result => result.code === 0).output, /winner:/);
    assert.match(results.find(result => result.code === 2).output, /loser:.*held by another live claimant/);
    assert.deepEqual(await readdir(claimDirectory), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UNKNOWN incumbent liveness blocks untouched and proven-dead published claims are pruned on restart', {
  timeout: 15_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), `phase4-unknown-claim-${process.pid}-`));
  const claimDirectory = join(root, '.phase4-release-claims');
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const sleeperExit = new Promise(resolve => sleeper.once('close', resolve));
  try {
    await mkdir(claimDirectory, { recursive: true });
    const probed = probeProcessIdentity(sleeper.pid);
    assert.equal(probed.state, 'LIVE');
    const identityHash = createHash('sha256').update(probed.processStart).digest('hex').slice(0, 16);
    const nonce = 'b'.repeat(24);
    const claimPath = join(claimDirectory, `claim-${sleeper.pid}-${identityHash}-${nonce}`);
    await mkdir(claimPath);
    await writeFile(join(claimPath, 'payload.json'), `${JSON.stringify({
      version: 1,
      token: 'unknown-incumbent-token',
      marker: 'unknown-incumbent-marker',
      pid: sleeper.pid,
      processStart: probed.processStart,
      nonce,
      createdAt: Date.now(),
    })}\n`);
    const unknowableProbe = pid => pid === sleeper.pid
      ? { state: 'UNKNOWN', processStart: null }
      : probeProcessIdentity(pid);
    await assert.rejects(acquirePhase4ReleaseLock({
      claimDirectory,
      marker: `unknown-contender-${process.pid}-${Date.now()}`,
      settleMs: 10,
      processProbe: unknowableProbe,
    }), /liveness is unknown/);
    assert.equal((await readdir(claimDirectory)).includes(claimPath.split('/').at(-1)), true,
      'UNKNOWN incumbent was removed');

    sleeper.kill('SIGKILL');
    await sleeperExit;
    const winner = await acquirePhase4ReleaseLock({
      claimDirectory,
      marker: `dead-prune-winner-${process.pid}-${Date.now()}`,
      settleMs: 10,
    });
    assert.equal((await readdir(claimDirectory)).filter(name => name.startsWith('claim-')).length, 1,
      'restart did not prune the proven-dead published claim');
    await releasePhase4ReleaseLock(winner);
    assert.deepEqual(await readdir(claimDirectory), []);
  } finally {
    if(sleeper.exitCode === null && sleeper.signalCode === null) sleeper.kill('SIGKILL');
    await sleeperExit;
    await rm(root, { recursive: true, force: true });
  }
});

test('killed pre-publication claims are cleaned only by exact dead identity', {
  timeout: 15_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), `phase4-pending-claim-${process.pid}-`));
  const claimDirectory = join(root, '.phase4-release-claims');
  const lockModule = join(ROOT, 'tools', 'runner.phase4.lock.mjs');
  const fixtureSource = [
    `import { acquirePhase4ReleaseLock } from ${JSON.stringify(lockModule)};`,
    'const [claimDirectory, marker] = process.argv.slice(1);',
    'await acquirePhase4ReleaseLock({ claimDirectory, marker, beforePublish: async () => {',
    '  await new Promise(resolve => process.stdout.write(`pending-claim-ready:${marker}\\n`, resolve));',
    "  process.kill(process.pid, 'SIGKILL');",
    '} });',
  ].join('\n');
  async function killPendingPublisher(marker){
    let output = '';
    const child = spawn(process.execPath, ['--input-type=module', '-e', fixtureSource, claimDirectory, marker], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    releaseChild(child);
    assert.equal(result.signal, 'SIGKILL', `pending claim fixture did not self-kill: ${JSON.stringify(result)} ${output}`);
    assert.match(output, new RegExp(`pending-claim-ready:${marker}`));
    return child.pid;
  }
  try {
    const firstMarker = `pending-startup-${process.pid}-${Date.now()}`;
    await killPendingPublisher(firstMarker);
    assert.equal((await readdir(claimDirectory)).filter(name => name.startsWith('.pending-')).length, 1);
    const winner = await acquirePhase4ReleaseLock({
      claimDirectory,
      marker: `pending-winner-${process.pid}-${Date.now()}`,
    });
    assert.equal((await readdir(claimDirectory)).filter(name => name.startsWith('.pending-')).length, 0,
      'next acquisition did not remove the proven-dead pending identity');

    const secondMarker = `pending-outer-${process.pid}-${Date.now()}`;
    const secondPid = await killPendingPublisher(secondMarker);
    const removed = await removeExactDeadPhase4Claims({ claimDirectory, ownedPids: new Set([secondPid]) });
    assert.equal(removed.length, 1);
    assert.equal(removed[0].kind, 'pending');
    assert.equal(removed[0].pid, secondPid);
    await assertPhase4ReleaseClaim(winner);
    await releasePhase4ReleaseLock(winner);
    assert.deepEqual(await readdir(claimDirectory), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pending-only journal metadata is safely discarded before staging can begin', {
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), `phase4-pending-journal-${process.pid}-`));
  try {
    await writeFile(join(root, '.phase4-promotion-journal.pending.json'), '{partial');
    assert.deepEqual(await recoverPromotionJournal({ projectRoot: root }), {
      recovered: true,
      action: 'discarded-pending-metadata',
    });
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('outer watchdog preempts a post-boot synchronous worker hang with exit 124', {
  timeout: 30_000,
}, async () => {
  const marker = `phase4-sync-negative-${process.pid}-${Date.now()}`;
  const hostileRoot = await mkdtemp(join(tmpdir(), 'phase4-hostile-path-'));
  const hostileBin = join(hostileRoot, 'bin');
  await mkdir(hostileBin);
  for(const command of ['ps', 'pgrep']){
    await writeFile(join(hostileBin, command), '#!/bin/sh\nexit 0\n');
    await chmod(join(hostileBin, command), 0o755);
  }
  let result;
  try {
    result = await runNegative({
      marker,
      args: [
        '--dev',
        '--fixture=post-boot-sync-hang',
        `--test-marker=${marker}`,
        '--arm-watchdog-after-fixture',
        '--outer-timeout-ms=750',
        '--fixture-ready-timeout-ms=12000',
      ],
      env: { PATH: `${hostileBin}:${process.env.PATH || ''}` },
      emergencyMilliseconds: 25_000,
    });
  } finally {
    await rm(hostileRoot, { recursive: true, force: true });
  }
  assert.equal(result.emergencyTriggered, false, 'sync-hang test emergency fired before the supervisor watchdog');
  assert.equal(result.result.code, 124,
    `post-boot synchronous hang must exit 124, received ${result.result.code}/${result.result.signal}\n${result.output}`);
  assert.ok(result.elapsedMs >= 500 && result.elapsedMs < 15_000,
    `post-boot synchronous watchdog did not terminate promptly (${result.elapsedMs}ms)`);
  assert.match(result.output, new RegExp(`runner-phase4-post-boot-sync-hang:${marker}`));
  assert.match(result.output, /exceeded outer watchdog 750ms/);
  assert.doesNotMatch(result.output, /PASS/);
});

test('never-resolving page evaluation exits 1 and leaves no ownership residue', {
  timeout: 30_000,
}, async () => {
  const marker = `phase4-page-negative-${process.pid}-${Date.now()}`;
  const result = await runNegative({
    marker,
    args: [
      '--dev',
      '--fixture=page-evaluate-hang',
      `--test-marker=${marker}`,
      '--inject-timeout-ms=250',
      '--outer-timeout-ms=20000',
    ],
  });
  assert.equal(result.emergencyTriggered, false, 'page-timeout test needed emergency cleanup');
  assert.equal(result.result.code, 1,
    `never-resolving evaluate must exit 1, received ${result.result.code}/${result.result.signal}\n${result.output}`);
  assert.ok(result.elapsedMs >= 200 && result.elapsedMs < 15_000,
    `page evaluation did not reject and clean promptly (${result.elapsedMs}ms)`);
  assert.match(result.output, new RegExp(`runner-phase4-page-evaluate-hang:${marker}`));
  assert.match(result.output, /injected never-resolving evaluate exceeded 250ms/);
  assert.doesNotMatch(result.output, /PASS/);
});

test('browser-close failure exits 1 and supervisor removes the marker fallback process', {
  timeout: 30_000,
}, async () => {
  const marker = `phase4-close-negative-${process.pid}-${Date.now()}`;
  const result = await runNegative({
    marker,
    args: [
      '--dev',
      '--fixture=close-failure',
      `--test-marker=${marker}`,
      '--inject-timeout-ms=250',
      '--outer-timeout-ms=20000',
    ],
  });
  assert.equal(result.emergencyTriggered, false, 'close-failure test needed emergency cleanup');
  assert.equal(result.result.code, 1,
    `browser-close failure must exit 1, received ${result.result.code}/${result.result.signal}\n${result.output}`);
  assert.ok(result.elapsedMs >= 200 && result.elapsedMs < 15_000,
    `browser-close failure did not reject and clean promptly (${result.elapsedMs}ms)`);
  assert.match(result.output, new RegExp(`runner-phase4-close-failure:${marker}`));
  assert.match(result.output, /injected browser close failure/);
  assert.match(result.output, /injected browser close hang exceeded 250ms/);
  assert.doesNotMatch(result.output, /PASS/);
});

function parityFixture(runnerHash = 'a'.repeat(64), golfHash = 'b'.repeat(64)){
  const row = hash => ({ fresh: hash, dist: hash, standalone: hash, localhost: hash, lan: hash });
  return { skipped: false, runner: row(runnerHash), golf: row(golfHash) };
}

test('strict parent parity rejects missing keys, unequal surfaces, and stale internally-equal copies', () => {
  const trusted = { runner: 'a'.repeat(64), golf: 'b'.repeat(64) };
  const missing = parityFixture();
  delete missing.runner.lan;
  assert.throws(() => validateStrictParityReport(missing, trusted), /missing or extra keys/);

  const unequal = parityFixture();
  unequal.golf.localhost = 'c'.repeat(64);
  assert.throws(() => validateStrictParityReport(unequal, trusted), /does not equal fresh/);

  const stale = parityFixture('d'.repeat(64), 'e'.repeat(64));
  assert.throws(() => validateStrictParityReport(stale, trusted), /stale or untrusted/);

  const validSkips = Object.fromEntries(
    ['parity', 'screenshots', 'frameBoard', 'replay', 'promotion']
      .map(name => [name, { skipped: true, reason: `${name} intentionally skipped` }]),
  );
  validateDevSkipReport(validSkips);
  const falseSkip = structuredClone(validSkips);
  falseSkip.replay.skipped = false;
  assert.throws(() => validateDevSkipReport(falseSkip), /replay must be skipped/);
});

test('old baseline may differ from fresh while candidate chain and each old surface remain exact', () => {
  const oldRunner = '3'.repeat(64);
  const oldGolf = '4'.repeat(64);
  const fresh = { runner: '5'.repeat(64), golf: '6'.repeat(64) };
  const baseline = {
    skipped: false,
    runner: { dist: oldRunner, standalone: oldRunner, localhost: oldRunner, lan: oldRunner },
    golf: { dist: oldGolf, standalone: oldGolf, localhost: oldGolf, lan: oldGolf },
  };
  assert.deepEqual(validateBaselineOldReport(baseline), baseline);
  assert.deepEqual(validateCandidateHashChain(fresh, fresh, fresh), fresh);
  assert.notEqual(baseline.runner.dist, fresh.runner);
  assert.notEqual(baseline.golf.dist, fresh.golf);

  const inconsistent = structuredClone(baseline);
  inconsistent.runner.lan = '7'.repeat(64);
  assert.throws(() => validateBaselineOldReport(inconsistent), /old baseline lan does not match old dist/);
  assert.throws(() => validateCandidateHashChain(fresh, fresh, {
    runner: '8'.repeat(64), golf: fresh.golf,
  }), /was not the gameplay-tested candidate/);
});

const TEST_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for(let value = 0; value < 256; value += 1){
    let crc = value;
    for(let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    table[value] = crc >>> 0;
  }
  return table;
})();

function testCrc32(parts){
  let crc = 0xffffffff;
  for(const part of parts){
    for(const value of part) crc = TEST_CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data){
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(testCrc32([typeBytes, data]), 8 + data.length);
  return chunk;
}

function makeRgbPng(width, height, seed = 0){
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rowBytes = width * 3;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for(let row = 0; row < height; row += 1) raw[row * (rowBytes + 1)] = 0;
  raw[1] = seed & 0xff;
  raw[2] = (seed >>> 8) & 0xff;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

test('real PNG decoder rejects truncation, CRC corruption, and wrong dimensions', () => {
  const png = makeRgbPng(32, 24);
  assert.deepEqual(
    { ...decodeAndValidatePng(png, { width: 32, height: 24 }, 'valid test PNG') },
    { width: 32, height: 24, bitDepth: 8, colorType: 2, compression: 0, filter: 0, interlace: 0, rowBytes: 96, decodedBytes: 2328 },
  );
  assert.throws(() => decodeAndValidatePng(png.subarray(0, -7), { width: 32, height: 24 }, 'truncated'), /truncated|missing IEND/);
  const corrupt = Buffer.from(png);
  const idatTypeOffset = corrupt.indexOf(Buffer.from('IDAT'));
  corrupt[idatTypeOffset + 4] ^= 0xff;
  assert.throws(() => decodeAndValidatePng(corrupt, { width: 32, height: 24 }, 'corrupt'), /CRC mismatch/);
  assert.throws(() => decodeAndValidatePng(png, { width: 33, height: 24 }, 'wrong-size'), /width/);
});

const fileHash = bytes => createHash('sha256').update(bytes).digest('hex');

async function createTransactionSandbox(marker){
  const root = await mkdtemp(join(tmpdir(), `phase4-transaction-${marker}-`));
  const runnerRoot = join(root, 'runner');
  const golfRoot = join(root, 'golf');
  const outputDirectory = join(root, 'output');
  await Promise.all([
    mkdir(join(runnerRoot, 'dist'), { recursive: true }),
    mkdir(join(golfRoot, 'dist'), { recursive: true }),
    mkdir(join(runnerRoot, 'phase4-shots', 'old'), { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
  ]);
  const old = {
    board: Buffer.from('old-board'), runner: Buffer.from('old-runner'), golf: Buffer.from('old-golf'), shots: Buffer.from('old-shots'),
  };
  await Promise.all([
    writeFile(join(runnerRoot, 'gridlock-run-v1-frames.png'), old.board),
    writeFile(join(runnerRoot, 'dist', 'index.html'), old.runner),
    writeFile(join(runnerRoot, 'gridlock-run-v1.html'), old.runner),
    writeFile(join(golfRoot, 'dist', 'index.html'), old.golf),
    writeFile(join(golfRoot, 'stackyard-golf-v1.html'), old.golf),
    writeFile(join(runnerRoot, 'phase4-shots', 'old', 'sentinel.txt'), old.shots),
  ]);

  const boardPng = makeRgbPng(1440, 900);
  const sources = join(outputDirectory, 'sources');
  await mkdir(sources, { recursive: true });
  const boardPath = join(sources, 'board.png');
  await writeFile(boardPath, boardPng);
  const freshRunner = Buffer.from(`fresh-runner-${marker}`);
  const freshGolf = Buffer.from(`fresh-golf-${marker}`);
  const runnerPath = join(sources, 'runner.html');
  const golfPath = join(sources, 'golf.html');
  await writeFile(runnerPath, freshRunner);
  await writeFile(golfPath, freshGolf);
  const names = ['opening', 'hero-s14', 'gameplay-s60', 'slide-s90-92', 'genuine-recovery', 'finish'];
  const shots = [];
  let seed = 1;
  for(const [viewport, size] of Object.entries({
    '1366x1024': { width: 1366, height: 1024 },
    '1024x768': { width: 1024, height: 768 },
  })){
    for(const name of names){
      const bytes = makeRgbPng(size.width, size.height, seed);
      seed += 1;
      const sourcePath = join(sources, `${viewport}-${name}.png`);
      await writeFile(sourcePath, bytes);
      shots.push({
        path: sourcePath,
        relativePath: join('phase4-shots', viewport, `${name}.png`),
        sha256: fileHash(bytes),
      });
    }
  }
  const validated = {
    shots,
    frameBoard: { path: boardPath, relativePath: 'gridlock-run-v1-frames.png', sha256: fileHash(boardPng) },
    worlds: {
      runner: { path: runnerPath, sha256: fileHash(freshRunner) },
      golf: { path: golfPath, sha256: fileHash(freshGolf) },
    },
  };
  const transaction = createPromotionTransaction({ marker, runnerRoot, golfRoot, outputDirectory, validated });
  return { root, runnerRoot, golfRoot, old, validated, transaction };
}

async function assertOldTransactionDestinations(sandbox){
  assert.deepEqual(await readFile(join(sandbox.runnerRoot, 'gridlock-run-v1-frames.png')), sandbox.old.board);
  assert.deepEqual(await readFile(join(sandbox.runnerRoot, 'dist', 'index.html')), sandbox.old.runner);
  assert.deepEqual(await readFile(join(sandbox.runnerRoot, 'gridlock-run-v1.html')), sandbox.old.runner);
  assert.deepEqual(await readFile(join(sandbox.golfRoot, 'dist', 'index.html')), sandbox.old.golf);
  assert.deepEqual(await readFile(join(sandbox.golfRoot, 'stackyard-golf-v1.html')), sandbox.old.golf);
  assert.deepEqual(await readFile(join(sandbox.runnerRoot, 'phase4-shots', 'old', 'sentinel.txt')), sandbox.old.shots);
}

async function assertNewTransactionDestinations(sandbox){
  assert.equal(fileHash(await readFile(join(sandbox.runnerRoot, 'gridlock-run-v1-frames.png'))),
    sandbox.validated.frameBoard.sha256);
  assert.equal(fileHash(await readFile(join(sandbox.runnerRoot, 'dist', 'index.html'))),
    sandbox.validated.worlds.runner.sha256);
  assert.equal(fileHash(await readFile(join(sandbox.runnerRoot, 'gridlock-run-v1.html'))),
    sandbox.validated.worlds.runner.sha256);
  assert.equal(fileHash(await readFile(join(sandbox.golfRoot, 'dist', 'index.html'))),
    sandbox.validated.worlds.golf.sha256);
  assert.equal(fileHash(await readFile(join(sandbox.golfRoot, 'stackyard-golf-v1.html'))),
    sandbox.validated.worlds.golf.sha256);
  for(const shot of sandbox.validated.shots){
    const relative = shot.relativePath.replace(/^phase4-shots[\\/]/, '');
    assert.equal(fileHash(await readFile(join(sandbox.runnerRoot, 'phase4-shots', relative))), shot.sha256);
  }
}

async function snapshotSandboxFiles(root){
  const files = [];
  async function visit(current){
    const entries = await readdir(current, { withFileTypes: true });
    for(const entry of entries.sort((a, b) => a.name.localeCompare(b.name))){
      const absolute = join(current, entry.name);
      if(entry.isDirectory()) await visit(absolute);
      else if(entry.isFile()){
        const bytes = await readFile(absolute);
        files.push({ path: absolute.slice(root.length + 1), bytes: bytes.length, sha256: fileHash(bytes) });
      }
    }
  }
  await visit(root);
  return files;
}

async function runCrashRecoveryFixture(point){
  const marker = `crash-${point}-${process.pid}-${Date.now()}`;
  const sandbox = await createTransactionSandbox(marker);
  const configPath = join(sandbox.root, `crash-${point}.json`);
  await writeFile(configPath, `${JSON.stringify({
    marker,
    runnerRoot: sandbox.runnerRoot,
    golfRoot: sandbox.golfRoot,
    outputDirectory: join(sandbox.root, 'output'),
    validated: sandbox.validated,
    point,
  })}\n`);
  let child = null;
  try {
    let output = '';
    child = spawn(process.execPath, [TRANSACTION_CRASH_FIXTURE, configPath], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const closePromise = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const readyText = `transaction-crash-ready:${marker}:${point}`;
    const deadline = Date.now() + 10_000;
    while(!output.includes(readyText)){
      if(Date.now() >= deadline) assert.fail(`transaction crash fixture did not become ready: ${output}`);
      const closed = await Promise.race([closePromise.then(result => ({ result })), sleep(20).then(() => null)]);
      if(closed && !output.includes(readyText)){
        assert.fail(`transaction crash fixture exited before readiness ${JSON.stringify(closed.result)}: ${output}`);
      }
    }
    if(point === 'post-install' && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const result = await closePromise;
    assert.equal(result.signal, 'SIGKILL', `crash fixture must die by SIGKILL: ${JSON.stringify(result)}\n${output}`);

    const beforeRecovery = await transactionResidues(sandbox.transaction);
    assert.ok(beforeRecovery.some(entry => entry.kind === 'journal'), 'SIGKILL must leave a durable recovery journal');
    if([
      'mid-directory-backup', 'mid-file-backup', 'directory-displaced', 'mid-install', 'post-install',
      'recovery-directory-new-displaced', 'recovery-directory-old-restored', 'recovery-file-old-restored',
      'recovery-rollback-complete', 'recovery-partial-cleanup', 'commit-intent',
    ].includes(point)){
      assert.ok(beforeRecovery.some(entry => entry.kind === 'backup-root'), 'install crash must retain the old backup root');
    }
    if(point === 'mid-file-backup'){
      assert.ok(beforeRecovery.some(entry => entry.kind === 'backupPending'),
        'file-backup crash must retain the unpublished exact hard link');
    }
    if(point === 'directory-displaced'){
      assert.ok(beforeRecovery.some(entry => entry.id === 'shots' && entry.kind === 'backup'),
        'directory install gap must retain the atomically renamed original directory');
    }
    if(point === 'recovery-partial-cleanup'){
      const shots = sandbox.transaction.items.find(item => item.id === 'shots');
      await assert.rejects(stat(shots.stage), error => error?.code === 'ENOENT',
        'partial-cleanup crash did not remove the real owned shots stage');
      assert.ok(beforeRecovery.some(entry => entry.kind === 'backup-root'),
        'partial-cleanup crash must retain later cleanup residue');
      assert.ok(beforeRecovery.some(entry => entry.kind === 'journal'),
        'partial-cleanup crash must retain its rollback-complete journal');
    }
    if(['commit-point', 'post-commit', 'mid-committed-cleanup'].includes(point)){
      assert.ok(beforeRecovery.some(entry => entry.kind === 'committed-backup-root'),
        'committed crash must retain the atomically moved old generation');
    }
    const recovery = await recoverPromotionJournal({ projectRoot: sandbox.root });
    const committed = ['commit-point', 'post-commit', 'mid-committed-cleanup'].includes(point);
    assert.deepEqual(recovery, {
      recovered: true,
      action: committed ? 'finished-commit' : 'rolled-back',
      transactionId: marker,
    });
    assert.deepEqual(await transactionResidues(sandbox.transaction), []);
    if(committed) await assertNewTransactionDestinations(sandbox);
    else await assertOldTransactionDestinations(sandbox);
  } finally {
    if(child){
      child.kill('SIGKILL');
      releaseChild(child);
    }
    await rm(sandbox.root, { recursive: true, force: true });
  }
}

test('mid-copy staging failure removes all owned paths and changes no official destination', {
  timeout: 15_000,
}, async () => {
  const marker = `copy-failure-${process.pid}-${Date.now()}`;
  const sandbox = await createTransactionSandbox(marker);
  try {
    await assert.rejects(stagePromotionTransaction(sandbox.transaction, { injectCopyFailureAt: 4 }), /injected stage copy failure/);
    assert.deepEqual(await transactionResidues(sandbox.transaction), []);
    await assertOldTransactionDestinations(sandbox);
  } finally {
    await cleanupUninstalledTransaction(sandbox.transaction).catch(() => {});
    await rm(sandbox.root, { recursive: true, force: true });
  }
});

test('wrong-size screenshot fails staged decode and leaves no owned or official residue', {
  timeout: 15_000,
}, async () => {
  const marker = `wrong-size-${process.pid}-${Date.now()}`;
  const sandbox = await createTransactionSandbox(marker);
  try {
    const wrong = makeRgbPng(10, 10);
    await writeFile(sandbox.validated.shots[0].path, wrong);
    sandbox.validated.shots[0].sha256 = fileHash(wrong);
    await assert.rejects(stagePromotionTransaction(sandbox.transaction), /width/);
    assert.deepEqual(await transactionResidues(sandbox.transaction), []);
    await assertOldTransactionDestinations(sandbox);
  } finally {
    await cleanupUninstalledTransaction(sandbox.transaction).catch(() => {});
    await rm(sandbox.root, { recursive: true, force: true });
  }
});

test('duplicate screenshot hashes fail staging and leave no owned or official residue', {
  timeout: 15_000,
}, async () => {
  const marker = `duplicate-shot-${process.pid}-${Date.now()}`;
  const sandbox = await createTransactionSandbox(marker);
  try {
    await copyFile(sandbox.validated.shots[0].path, sandbox.validated.shots[1].path);
    sandbox.validated.shots[1].sha256 = sandbox.validated.shots[0].sha256;
    await assert.rejects(stagePromotionTransaction(sandbox.transaction), /12 distinct hashes/);
    assert.deepEqual(await transactionResidues(sandbox.transaction), []);
    await assertOldTransactionDestinations(sandbox);
  } finally {
    await cleanupUninstalledTransaction(sandbox.transaction).catch(() => {});
    await rm(sandbox.root, { recursive: true, force: true });
  }
});

for(const point of [
  'mid-stage', 'mid-directory-backup', 'mid-file-backup', 'directory-displaced', 'mid-install',
  'post-install', 'recovery-directory-new-displaced', 'recovery-directory-old-restored',
  'recovery-file-old-restored', 'recovery-rollback-complete', 'recovery-partial-cleanup',
  'commit-intent', 'commit-point', 'post-commit', 'mid-committed-cleanup',
]){
  test(`SIGKILL ${point} leaves a durable journal and recovery resolves exact artifacts`, {
    timeout: 15_000,
  }, async () => {
    await runCrashRecoveryFixture(point);
  });
}

for(const target of ['file', 'shots-directory']){
  test(`recovery rejects divergent ${target} and preserves all current bytes and evidence`, {
    timeout: 15_000,
  }, async () => {
    const marker = `divergent-${target}-${process.pid}-${Date.now()}`;
    const sandbox = await createTransactionSandbox(marker);
    try {
      await stagePromotionTransaction(sandbox.transaction);
      await installPromotionTransaction(sandbox.transaction);
      const divergentPath = target === 'file'
        ? join(sandbox.runnerRoot, 'dist', 'index.html')
        : join(sandbox.runnerRoot, 'phase4-shots', '1366x1024', 'opening.png');
      await writeFile(divergentPath, Buffer.from(`unrecognized-${target}-${marker}`));
      const before = await snapshotSandboxFiles(sandbox.root);
      const residuesBefore = await transactionResidues(sandbox.transaction);
      assert.ok(residuesBefore.some(entry => entry.kind === 'journal'));
      assert.ok(residuesBefore.some(entry => entry.kind === 'backup-root'));
      await assert.rejects(recoverPromotionJournal({ projectRoot: sandbox.root }), /divergent current/);
      assert.deepEqual(await snapshotSandboxFiles(sandbox.root), before,
        'failed recovery mutated divergent current data or retained evidence');
      assert.deepEqual(await transactionResidues(sandbox.transaction), residuesBefore,
        'failed recovery changed journal/stage/backup evidence');
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  });
}

test('post-install failure rolls back shots, board, and both games with backups retained until rollback', {
  timeout: 15_000,
}, async () => {
  const marker = `rollback-${process.pid}-${Date.now()}`;
  const sandbox = await createTransactionSandbox(marker);
  try {
    await stagePromotionTransaction(sandbox.transaction);
    await installPromotionTransaction(sandbox.transaction);
    await validateInstalledTransaction(sandbox.transaction);
    assert.ok((await transactionResidues(sandbox.transaction)).some(entry => entry.kind === 'backup'),
      'old artifacts were deleted before final commit');
    await rollbackPromotionTransaction(sandbox.transaction);
    assert.deepEqual(await transactionResidues(sandbox.transaction), []);
    await assertOldTransactionDestinations(sandbox);
  } finally {
    await cleanupUninstalledTransaction(sandbox.transaction).catch(() => {});
    await rm(sandbox.root, { recursive: true, force: true });
  }
});

test('rollback restores OLD modes and commit preserves candidate modes', {
  timeout: 20_000,
}, async () => {
  const mode = async target => (await stat(target)).mode & 0o7777;
  const rollbackSandbox = await createTransactionSandbox(`mode-rollback-${process.pid}-${Date.now()}`);
  try {
    const oldFile = join(rollbackSandbox.runnerRoot, 'dist', 'index.html');
    const oldShots = join(rollbackSandbox.runnerRoot, 'phase4-shots');
    const oldNested = join(oldShots, 'old');
    const oldSentinel = join(oldNested, 'sentinel.txt');
    const oldEmpty = join(oldShots, 'empty-mode-dir');
    await mkdir(oldEmpty);
    await chmod(oldFile, 0o640);
    await chmod(oldShots, 0o750);
    await chmod(oldNested, 0o710);
    await chmod(oldSentinel, 0o600);
    await chmod(oldEmpty, 0o711);
    await stagePromotionTransaction(rollbackSandbox.transaction);
    await installPromotionTransaction(rollbackSandbox.transaction);
    await recoverPromotionJournal({ projectRoot: rollbackSandbox.root });
    assert.equal(await mode(oldFile), 0o640);
    assert.equal(await mode(oldShots), 0o750);
    assert.equal(await mode(oldNested), 0o710);
    assert.equal(await mode(oldSentinel), 0o600);
    assert.equal(await mode(oldEmpty), 0o711);
  } finally {
    await rm(rollbackSandbox.root, { recursive: true, force: true });
  }

  const commitSandbox = await createTransactionSandbox(`mode-commit-${process.pid}-${Date.now()}`);
  try {
    await chmod(commitSandbox.validated.worlds.runner.path, 0o750);
    await chmod(commitSandbox.validated.worlds.golf.path, 0o740);
    await chmod(commitSandbox.validated.frameBoard.path, 0o640);
    await chmod(commitSandbox.validated.shots[0].path, 0o600);
    await stagePromotionTransaction(commitSandbox.transaction);
    await installPromotionTransaction(commitSandbox.transaction);
    await validateInstalledTransaction(commitSandbox.transaction);
    await commitPromotionTransaction(commitSandbox.transaction);
    assert.equal(await mode(join(commitSandbox.runnerRoot, 'dist', 'index.html')), 0o750);
    assert.equal(await mode(join(commitSandbox.runnerRoot, 'gridlock-run-v1.html')), 0o750);
    assert.equal(await mode(join(commitSandbox.golfRoot, 'dist', 'index.html')), 0o740);
    assert.equal(await mode(join(commitSandbox.runnerRoot, 'gridlock-run-v1-frames.png')), 0o640);
    const firstShot = commitSandbox.validated.shots[0].relativePath.replace(/^phase4-shots[\\/]/, '');
    assert.equal(await mode(join(commitSandbox.runnerRoot, 'phase4-shots', firstShot)), 0o600);
  } finally {
    await rm(commitSandbox.root, { recursive: true, force: true });
  }
});

test('whole-set install preflight rejects late OLD or staged NEW divergence before any official mutation', {
  timeout: 20_000,
}, async () => {
  const oldDivergence = await createTransactionSandbox(`old-preflight-${process.pid}-${Date.now()}`);
  try {
    await stagePromotionTransaction(oldDivergence.transaction);
    const target = join(oldDivergence.golfRoot, 'stackyard-golf-v1.html');
    const external = Buffer.from('external-late-old-divergence');
    await writeFile(target, external);
    await assert.rejects(installPromotionTransaction(oldDivergence.transaction), /pre-install OLD golf-standalone/);
    assert.deepEqual(await readFile(target), external, 'failed preflight overwrote the externally divergent destination');
    assert.deepEqual(await readFile(join(oldDivergence.runnerRoot, 'dist', 'index.html')), oldDivergence.old.runner);
    assert.deepEqual(await readFile(join(oldDivergence.golfRoot, 'dist', 'index.html')), oldDivergence.old.golf);
    assert.equal(oldDivergence.transaction.committed, false);
    assert.ok((await transactionResidues(oldDivergence.transaction)).some(entry => entry.kind === 'journal'),
      'divergent OLD preflight must preserve journal/stage evidence');
  } finally {
    await rm(oldDivergence.root, { recursive: true, force: true });
  }

  const stagedDivergence = await createTransactionSandbox(`stage-preflight-${process.pid}-${Date.now()}`);
  try {
    await stagePromotionTransaction(stagedDivergence.transaction);
    const lastStage = stagedDivergence.transaction.items.find(item => item.id === 'golf-standalone').stage;
    await writeFile(lastStage, Buffer.from('tampered-last-stage'));
    await assert.rejects(installPromotionTransaction(stagedDivergence.transaction), /pre-install NEW golf-standalone/);
    await assertOldTransactionDestinations(stagedDivergence);
    assert.deepEqual(await transactionResidues(stagedDivergence.transaction), [],
      'staged NEW preflight failure did not clean its owned journal/stages');
  } finally {
    await rm(stagedDivergence.root, { recursive: true, force: true });
  }
});

test('post-hook per-item stage recheck rolls back earlier installs after hook mutation', {
  timeout: 20_000,
}, async () => {
  const sandbox = await createTransactionSandbox(`stage-hook-${process.pid}-${Date.now()}`);
  try {
    await stagePromotionTransaction(sandbox.transaction);
    await assert.rejects(installPromotionTransaction(sandbox.transaction, {
      afterBackupChunk: async ({ item }) => {
        if(item.id === 'golf-standalone') await writeFile(item.stage, Buffer.from('hook-mutated-stage'));
      },
    }), /post-hook NEW golf-standalone/);
    await assertOldTransactionDestinations(sandbox);
    assert.deepEqual(await transactionResidues(sandbox.transaction), []);
  } finally {
    await rm(sandbox.root, { recursive: true, force: true });
  }
});

test('directory post-displacement stage damage still restores exact OLD', {
  timeout: 20_000,
}, async () => {
  const sandbox = await createTransactionSandbox(`displace-stage-${process.pid}-${Date.now()}`);
  try {
    await stagePromotionTransaction(sandbox.transaction);
    await assert.rejects(installPromotionTransaction(sandbox.transaction, {
      afterDisplaceItem: async ({ item }) => {
        if(item.id === 'shots') await writeFile(join(item.stage, '1366x1024', 'opening.png'), Buffer.from('damaged-owned-stage'));
      },
    }), /immediate pre-install NEW shots/);
    await assertOldTransactionDestinations(sandbox);
    assert.deepEqual(await transactionResidues(sandbox.transaction), []);
  } finally {
    await rm(sandbox.root, { recursive: true, force: true });
  }
});

test('per-item OLD recheck never overwrites a hook-replaced live destination', {
  timeout: 20_000,
}, async () => {
  const sandbox = await createTransactionSandbox(`old-hook-${process.pid}-${Date.now()}`);
  const external = Buffer.from('external-live-replacement');
  try {
    await stagePromotionTransaction(sandbox.transaction);
    const targetItem = sandbox.transaction.items.find(item => item.id === 'board');
    await assert.rejects(installPromotionTransaction(sandbox.transaction, {
      beforeBackupItem: async ({ item }) => {
        if(item.id === targetItem.id) await writeFile(item.destination, external);
      },
    }), /immediate pre-backup OLD board/);
    assert.deepEqual(await readFile(targetItem.destination), external,
      'late divergent live destination was overwritten by staged NEW');
    assert.equal(sandbox.transaction.committed, false);
    assert.ok((await transactionResidues(sandbox.transaction)).some(entry => entry.kind === 'journal'));
  } finally {
    await rm(sandbox.root, { recursive: true, force: true });
  }
});

test('commit revalidates complete NEW officials and exact retained OLD inodes', {
  timeout: 20_000,
}, async () => {
  for(const target of ['destination', 'backup']){
    const sandbox = await createTransactionSandbox(`commit-${target}-${process.pid}-${Date.now()}`);
    try {
      await stagePromotionTransaction(sandbox.transaction);
      await installPromotionTransaction(sandbox.transaction);
      await validateInstalledTransaction(sandbox.transaction);
      if(target === 'destination'){
        await writeFile(join(sandbox.golfRoot, 'stackyard-golf-v1.html'), Buffer.from('late-installed-divergence'));
      } else {
        const backup = sandbox.transaction.items.find(item => item.id === 'golf-standalone').backup;
        await writeFile(backup, Buffer.from('corrupt-retained-old'));
      }
      await assert.rejects(commitPromotionTransaction(sandbox.transaction),
        target === 'destination' ? /pre-commit NEW golf-standalone/ : /pre-commit retained OLD golf-standalone/);
      assert.equal(sandbox.transaction.committed, false);
      assert.equal((await transactionResidues(sandbox.transaction)).some(entry => entry.kind === 'committed-backup-root'), false,
        'failed commit preflight crossed the atomic commit point');
      assert.ok((await transactionResidues(sandbox.transaction)).some(entry => entry.kind === 'journal'));
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }
});

test('commit-point recheck rejects hook mutations after durable intent', {
  timeout: 20_000,
}, async () => {
  for(const target of ['destination', 'backup']){
    const sandbox = await createTransactionSandbox(`commit-hook-${target}-${process.pid}-${Date.now()}`);
    try {
      await stagePromotionTransaction(sandbox.transaction);
      await installPromotionTransaction(sandbox.transaction);
      await validateInstalledTransaction(sandbox.transaction);
      await assert.rejects(commitPromotionTransaction(sandbox.transaction, {
        afterCommitIntent: async () => {
          const item = sandbox.transaction.items.find(candidate => candidate.id === 'golf-standalone');
          await writeFile(target === 'destination' ? item.destination : item.backup,
            Buffer.from(`hook-mutated-${target}`));
        },
      }), target === 'destination'
        ? /commit-point NEW golf-standalone/
        : /commit-point retained OLD golf-standalone/);
      assert.equal(sandbox.transaction.committed, false);
      assert.equal((await transactionResidues(sandbox.transaction)).some(entry => entry.kind === 'committed-backup-root'), false);
      assert.ok((await transactionResidues(sandbox.transaction)).some(entry => entry.kind === 'journal'));
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }
});

test('final commit manifests run after the asynchronous authority callback', {
  timeout: 20_000,
}, async () => {
  for(const target of ['destination', 'backup']){
    const sandbox = await createTransactionSandbox(`commit-authority-${target}-${process.pid}-${Date.now()}`);
    try {
      await stagePromotionTransaction(sandbox.transaction);
      await installPromotionTransaction(sandbox.transaction);
      await validateInstalledTransaction(sandbox.transaction);
      await assert.rejects(commitPromotionTransaction(sandbox.transaction, {
        beforeCommitPoint: async () => {
          const item = sandbox.transaction.items.find(candidate => candidate.id === 'golf-standalone');
          await writeFile(target === 'destination' ? item.destination : item.backup,
            Buffer.from(`authority-window-${target}`));
        },
      }), target === 'destination'
        ? /commit-point NEW golf-standalone/
        : /commit-point retained OLD golf-standalone/);
      assert.equal(sandbox.transaction.committed, false);
      assert.equal((await transactionResidues(sandbox.transaction)).some(entry => entry.kind === 'committed-backup-root'), false);
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }
});

test('retained OLD xattr-value and ACL mutations block final ACK and preserve evidence', {
  timeout: 30_000,
  skip: process.platform !== 'darwin',
}, async () => {
  const userResult = spawnSync(TRUSTED_ID, ['-un', String(process.getuid())], { encoding: 'utf8' });
  assert.equal(userResult.status, 0, userResult.stderr);
  const user = userResult.stdout.trim();
  assert.match(user, /^[A-Za-z0-9_.-]+$/);
  for(const mutation of ['xattr-value', 'acl']){
    const sandbox = await createTransactionSandbox(`metadata-guard-${mutation}-${process.pid}-${Date.now()}`);
    const original = join(sandbox.golfRoot, 'stackyard-golf-v1.html');
    const xattrName = 'com.playforge.phase4-guard-test';
    try {
      if(mutation === 'xattr-value'){
        const initial = spawnSync(TRUSTED_XATTR, ['-wx', xattrName, '00010203FF', original], { encoding: 'utf8' });
        assert.equal(initial.status, 0, initial.stderr);
      } else {
        const initial = spawnSync(TRUSTED_CHMOD, ['+a', `user:${user} allow read`, original], { encoding: 'utf8' });
        assert.equal(initial.status, 0, initial.stderr);
      }
      await stagePromotionTransaction(sandbox.transaction);
      await installPromotionTransaction(sandbox.transaction);
      await validateInstalledTransaction(sandbox.transaction);
      await preparePromotionForCommitGate(sandbox.transaction);
      const retainedOld = sandbox.transaction.items.find(item => item.id === 'golf-standalone').backup;
      if(mutation === 'xattr-value'){
        const changed = spawnSync(TRUSTED_XATTR, ['-wx', xattrName, '00010203FE', retainedOld], { encoding: 'utf8' });
        assert.equal(changed.status, 0, changed.stderr);
      } else {
        const changed = spawnSync(TRUSTED_CHMOD, ['+a', `user:${user} allow write`, retainedOld], { encoding: 'utf8' });
        assert.equal(changed.status, 0, changed.stderr);
      }
      assert.throws(() => finalizeGrantedPromotionJournalSync({
        projectRoot: sandbox.root,
        transactionId: sandbox.transaction.marker,
        transaction: sandbox.transaction,
        finalCommitGuard: () => {},
      }), /final-ack retained OLD golf-standalone manifest changed/);
      assert.equal(sandbox.transaction.committed, false);
      await assert.rejects(rollbackPromotionTransaction(sandbox.transaction),
        /promotion rollback incomplete/,
        'metadata-divergent retained OLD must not be reported as an exact rollback');
      assert.equal(sandbox.transaction.state, 'rollback-incomplete');
      const residues = await transactionResidues(sandbox.transaction);
      assert.ok(residues.some(entry => entry.kind === 'journal'), 'metadata failure lost its journal evidence');
      assert.ok(residues.some(entry => entry.kind === 'backup-root'), 'metadata failure lost retained OLD evidence');
      assert.equal(residues.some(entry => entry.kind === 'committed-backup-root'), false,
        'metadata-divergent OLD crossed the commit point');
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }
});

test('rollback restores original inode, mtime, mode, macOS xattrs, and ACLs', {
  timeout: 20_000,
  skip: process.platform !== 'darwin',
}, async () => {
  const sandbox = await createTransactionSandbox(`metadata-${process.pid}-${Date.now()}`);
  const file = join(sandbox.runnerRoot, 'dist', 'index.html');
  const shots = join(sandbox.runnerRoot, 'phase4-shots');
  const xattrName = 'com.playforge.phase4-test';
  const fixed = new Date('2024-01-02T03:04:05.000Z');
  const setXattr = (target, value) => {
    const result = spawnSync(TRUSTED_XATTR, ['-w', xattrName, value, target], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const readXattr = target => {
    const result = spawnSync(TRUSTED_XATTR, ['-p', xattrName, target], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const userResult = spawnSync(TRUSTED_ID, ['-un', String(process.getuid())], { encoding: 'utf8' });
  assert.equal(userResult.status, 0, userResult.stderr);
  const aclEntry = `user:${userResult.stdout.trim()} allow read`;
  const readAcl = target => {
    const result = spawnSync(TRUSTED_LS, ['-lde', target], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split('\n').slice(1).join('\n');
  };
  try {
    await chmod(file, 0o640);
    await utimes(file, fixed, fixed);
    setXattr(file, 'file-original');
    setXattr(shots, 'directory-original');
    const aclResult = spawnSync(TRUSTED_CHMOD, ['+a', aclEntry, file], { encoding: 'utf8' });
    assert.equal(aclResult.status, 0, aclResult.stderr);
    const beforeAcl = readAcl(file);
    const beforeFile = await stat(file, { bigint: true });
    const beforeShots = await stat(shots, { bigint: true });
    await stagePromotionTransaction(sandbox.transaction);
    await installPromotionTransaction(sandbox.transaction);
    await rollbackPromotionTransaction(sandbox.transaction);
    const afterFile = await stat(file, { bigint: true });
    const afterShots = await stat(shots, { bigint: true });
    assert.equal(afterFile.ino, beforeFile.ino);
    assert.equal(afterFile.dev, beforeFile.dev);
    assert.equal(afterFile.mtimeNs, beforeFile.mtimeNs);
    assert.equal(afterFile.mode & 0o7777n, beforeFile.mode & 0o7777n);
    assert.equal(afterShots.ino, beforeShots.ino);
    assert.equal(afterShots.dev, beforeShots.dev);
    assert.equal(readXattr(file), 'file-original');
    assert.equal(readXattr(shots), 'directory-original');
    assert.equal(readAcl(file), beforeAcl);
  } finally {
    await rm(sandbox.root, { recursive: true, force: true });
  }
});
