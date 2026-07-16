import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCandidateAuthorizationLive,
  consumeCandidateHandoff,
  publishCommitReadySync,
  readCommitCoordinationStateSync,
} from './runner.phase4.handoff.mjs';
import {
  acquirePhase4ReleaseLock,
  assertPhase4ReleaseClaimSync,
  releasePhase4ReleaseLock,
} from './runner.phase4.lock.mjs';
import {
  cleanupUninstalledTransaction,
  createPromotionTransaction,
  finalizeGrantedPromotionJournalSync,
  installPromotionTransaction,
  preparePromotionForCommitGate,
  stagePromotionTransaction,
  validateInstalledTransaction,
} from './runner.phase4.promotion.mjs';
import {
  assertPhase4InputManifestUnchangedSync,
  buildPhase4InputManifest,
} from './runner.phase4.frozen.mjs';
import { writePhase4SupervisorReportSync } from './runner.phase4.supervisor-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = process.argv[2];
if(![
  'sampled-unmarked-detached',
  'exit-zero-after-grant',
  'sandbox-hang-after-final-ack',
  'sandbox-hang-after-revoke',
  'sandbox-mutate-input-before-grant',
  'sandbox-sampler-scan-failure',
].includes(fixture)){
  throw new Error('unknown Phase 4 READY fixture');
}
const tempRoot = process.env.TMPDIR || tmpdir();
const authorization = await consumeCandidateHandoff({
  handoffPath: process.env.PLAYFORGE_CANDIDATE_HANDOFF_PATH,
  tempRoot,
  expectedOuterMarker: process.env.PLAYFORGE_RELEASE_RUN_MARKER,
});
let sandboxTransaction = null;
let sandboxClaim = null;
let sandboxBuildInputs = null;
let sandboxConfig = null;
if([
  'sandbox-hang-after-final-ack',
  'sandbox-hang-after-revoke',
  'sandbox-mutate-input-before-grant',
  'sandbox-sampler-scan-failure',
].includes(fixture)){
  sandboxConfig = JSON.parse(await readFile(process.env.PLAYFORGE_RELEASE_TRANSACTION_CONFIG, 'utf8'));
  const projectRoot = path.resolve(sandboxConfig.runnerRoot, '..');
  const inputFiles = new Map([
    ['engine/core.js', 'sandbox-engine'],
    ['runner/src/main.js', 'sandbox-runner'],
    ['golf/src/main.js', 'sandbox-golf'],
    ['runner/index.html', 'sandbox-runner-index'],
    ['runner/vite.config.js', 'export default {}'],
    ['golf/index.html', 'sandbox-golf-index'],
    ['golf/vite.config.js', 'export default {}'],
    ['package.json', '{}'],
    ['package-lock.json', '{}'],
  ]);
  for(const relativePath of inputFiles.keys()){
    await mkdir(path.dirname(path.join(projectRoot, relativePath)), { recursive: true });
  }
  for(const [relativePath, contents] of inputFiles){
    await writeFile(path.join(projectRoot, relativePath), contents);
  }
  sandboxBuildInputs = await buildPhase4InputManifest(projectRoot);
  sandboxClaim = await acquirePhase4ReleaseLock({
    claimDirectory: path.join(ROOT, 'runner', '.phase4-release-claims'),
    marker: authorization.outerMarker,
  });
  sandboxTransaction = createPromotionTransaction(sandboxConfig);
  await stagePromotionTransaction(sandboxTransaction);
  await installPromotionTransaction(sandboxTransaction);
  await validateInstalledTransaction(sandboxTransaction);
  await preparePromotionForCommitGate(sandboxTransaction);
}

// The intermediate remains a descendant long enough for the outer sampler to
// capture both it and its child. It then exits, reparenting an unmarked detached
// sleeper so the current descendant and marker scans are clean at READY.
if(fixture === 'sampled-unmarked-detached'){
  const intermediateSource = [
    `import { releaseCapturedGatedNode, spawnCapturedGatedNode } from ${JSON.stringify(new URL('./phase-isolated-node.mjs', import.meta.url).href)};`,
    `const waitFixture = ${JSON.stringify(fileURLToPath(new URL('./phase-wait.fixture.mjs', import.meta.url)))};`,
    "const title = `ready-isolated-${process.pid}-${Date.now()}`;",
    "const owned = spawnCapturedGatedNode({ title, args: [waitFixture, `${title}:target`], stdio: 'ignore' });",
    'await releaseCapturedGatedNode(owned);',
    'const sleeper = owned.child;',
    'sleeper.unref();',
    'process.stdout.write(String(sleeper.pid));',
    'setTimeout(() => process.exit(0), 600);',
  ].join('\n');
  const intermediate = spawn(process.execPath, ['--input-type=module', '-e', intermediateSource], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const sleeperPidChunks = [];
  intermediate.stdout.on('data', chunk => sleeperPidChunks.push(chunk));
  await new Promise((resolve, reject) => {
    intermediate.once('error', reject);
    intermediate.once('close', code => code === 0 ? resolve() : reject(new Error(`intermediate exited ${code}`)));
  });
  const sleeperPid = Number(Buffer.concat(sleeperPidChunks).toString('utf8'));
  if(!Number.isSafeInteger(sleeperPid) || sleeperPid <= 0) throw new Error('READY fixture sleeper PID missing');
  process.stderr.write(`ready-fixture-detached-pid:${sleeperPid}\n`);
}

const fakeShotRows = ['1366x1024', '1024x768'].flatMap(viewport => (
  ['opening', 'hero-s14', 'gameplay-s60', 'slide-s90-92', 'genuine-recovery', 'finish']
    .map((name, index) => ({
      relativePath: `phase4-shots/${viewport}/${name}.png`,
      bytes: index + 1,
      sha256: `${index}`.padStart(64, viewport === '1366x1024' ? 'a' : 'b').slice(-64),
    }))
));
const candidateFresh = authorization.candidateFresh;
const parityRow = hash => ({ fresh: hash, dist: hash, standalone: hash, localhost: hash, lan: hash });
const sandboxShotRows = sandboxConfig?.validated.shots.map(row => ({
  relativePath: row.relativePath.split(path.sep).join('/'),
  bytes: statSync(row.path).size,
  sha256: row.sha256,
}));
const supervisorReport = {
  version: 1,
  transactionId: authorization.outerMarker,
  decisionNonce: authorization.nonce,
  state: 'READY',
  candidateFresh,
  parentBuildInputs: sandboxBuildInputs || { version: 1, files: [] },
  baselineOld: {
    skipped: false,
    runner: { dist: candidateFresh.runner, standalone: candidateFresh.runner, localhost: candidateFresh.runner, lan: candidateFresh.runner },
    golf: { dist: candidateFresh.golf, standalone: candidateFresh.golf, localhost: candidateFresh.golf, lan: candidateFresh.golf },
  },
  validatedArtifacts: {
    shots: sandboxShotRows || fakeShotRows,
    frameBoard: sandboxConfig ? {
      relativePath: 'gridlock-run-v1-frames.png',
      bytes: statSync(sandboxConfig.validated.frameBoard.path).size,
      sha256: sandboxConfig.validated.frameBoard.sha256,
    } : { relativePath: 'gridlock-run-v1-frames.png', bytes: 1, sha256: 'c'.repeat(64) },
    worlds: candidateFresh,
  },
  installedNetworkParity: {
    skipped: false,
    runner: sandboxConfig ? parityRow(candidateFresh.runner) : {},
    golf: sandboxConfig ? parityRow(candidateFresh.golf) : {},
  },
};
writePhase4SupervisorReportSync({
  reportPath: process.env.PLAYFORGE_PHASE4_SUPERVISOR_REPORT_PATH,
  tempRoot,
  report: supervisorReport,
});
publishCommitReadySync(authorization, tempRoot);
if(fixture === 'sandbox-mutate-input-before-grant'){
  await writeFile(path.join(path.resolve(sandboxConfig.runnerRoot, '..'), 'runner/src/main.js'),
    'sandbox-runner-mutated-after-ready');
}

const deadline = Date.now() + 10_000;
while(Date.now() < deadline){
  const coordination = readCommitCoordinationStateSync(authorization, tempRoot);
  if(coordination.decision === 'REVOKED'){
    if(fixture === 'sandbox-hang-after-revoke'){
      process.stderr.write('ready-fixture-hanging-after-revoke\n');
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    }
    if(sandboxTransaction) await cleanupUninstalledTransaction(sandboxTransaction);
    if(sandboxClaim) await releasePhase4ReleaseLock(sandboxClaim);
    process.exit(1);
  }
  if(coordination.decision === 'COMMIT_GRANTED'){
    if(['sandbox-hang-after-final-ack', 'sandbox-mutate-input-before-grant'].includes(fixture)){
      finalizeGrantedPromotionJournalSync({
        projectRoot: path.resolve(sandboxConfig.runnerRoot, '..'),
        transactionId: sandboxTransaction.marker,
        transaction: sandboxTransaction,
        finalCommitGuard: () => {
          assertCandidateAuthorizationLive(authorization);
          assertPhase4ReleaseClaimSync(sandboxClaim);
          assertPhase4InputManifestUnchangedSync(
            path.resolve(sandboxConfig.runnerRoot, '..'),
            sandboxBuildInputs,
            'sandbox final build inputs',
          );
        },
      });
      writePhase4SupervisorReportSync({
        reportPath: process.env.PLAYFORGE_PHASE4_SUPERVISOR_REPORT_PATH,
        tempRoot,
        report: { ...supervisorReport, state: 'ACKED_NEW' },
      });
      if(fixture === 'sandbox-mutate-input-before-grant'){
        throw new Error('mutated sandbox input unexpectedly passed final commit guard');
      }
      process.stderr.write('ready-fixture-hanging-after-final-ack\n');
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    }
    process.exit(fixture === 'exit-zero-after-grant' ? 0 : 2);
  }
  await new Promise(resolve => setTimeout(resolve, 20));
}
throw new Error('READY fixture gate timed out');
