import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { exactMarkerProcessRecords } from './phase-marker-processes.mjs';
import {
  assertContainedPhaseTarget,
  proveContainedPhaseTargetTopology,
} from './phase-target-bootstrap.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNNER = join(ROOT, 'tools', 'runner.phase3.mjs');
const POST = join(ROOT, 'tools', 'post.browser.mjs');
const PHASE4 = join(ROOT, 'tools', 'runner.phase4.mjs');
const FOUNDATION = join(ROOT, 'tools', 'foundation.browser.mjs');
const GOLF = join(ROOT, 'tools', 'golf.phase2.mjs');
const TOPOLOGY_MARKER = 'playforge-topology-test-marker';

const processRow = ({ pid, ppid, pgid, command, state = 'S', ucomm = 'node' }) => Object.freeze({
  pid,
  ppid,
  pgid,
  processStart: `posix-lstart-utc:Tue Jul 14 20:00:${String(pid % 60).padStart(2, '0')} 2026`,
  state,
  ucomm,
  command,
});

const topologySnapshot = () => Object.freeze([
  processRow({ pid: 900, ppid: 1, pgid: 900, command: 'playforge-test-supervisor' }),
  processRow({
    pid: 901,
    ppid: 900,
    pgid: 901,
    command: `${TOPOLOGY_MARKER}:dispatcher`,
  }),
  processRow({ pid: 902, ppid: 901, pgid: 901, command: `${TOPOLOGY_MARKER}:ordinary-parent` }),
  processRow({ pid: 903, ppid: 902, pgid: 901, command: `${TOPOLOGY_MARKER}:test-worker` }),
]);

function replaceRow(snapshot, pid, changes){
  return Object.freeze(snapshot.map(record => record.pid === pid
    ? Object.freeze({ ...record, ...changes })
    : record));
}

function uncontainedEnvironment(){
  const environment = { ...process.env };
  for(const name of [
    'NODE_OPTIONS',
    'PLAYFORGE_INTERNAL_DESCENDANT_MARKER',
    'PLAYFORGE_INTERNAL_SPAWN_GATE_FD',
    'PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE',
    'PLAYFORGE_INTERNAL_TARGET_BOOTSTRAP_NONCE',
    'PLAYFORGE_INTERNAL_TARGET_DISPATCHER_MARKER',
    'RUNNER_PHASE3_CONTAINMENT_MARKER',
    'POST_BROWSER_CONTAINMENT_MARKER',
  ]) delete environment[name];
  return environment;
}

test('ordinary and node:test descendants require one exact same-group dispatcher ancestry proof', () => {
  const snapshot = topologySnapshot();
  const proof = proveContainedPhaseTargetTopology(snapshot, {
    currentPid: 903,
    descendantMarker: TOPOLOGY_MARKER,
    platform: 'darwin',
    label: 'synthetic descendant',
  });
  assert.deepEqual(proof, {
    proof: 'atomic-exact-topology',
    targetPid: 903,
    dispatcherPid: 901,
    dispatcherStart: snapshot[1].processStart,
    dispatcherPgid: 901,
    supervisorPid: 900,
    marker: TOPOLOGY_MARKER,
    ancestryPids: [903, 902, 901],
  });

  let snapshots = 0;
  const asserted = assertContainedPhaseTarget('synthetic descendant', {
    currentPid: 903,
    descendantMarker: TOPOLOGY_MARKER,
    platform: 'darwin',
    snapshotProbe(){ snapshots += 1; return snapshot; },
  });
  assert.equal(snapshots, 1, 'containment topology used more than one atomic snapshot');
  assert.deepEqual(asserted, proof);
});

test('topology proof rejects broken lineage, fallback argv, zombies, and same-group supervisor', () => {
  const snapshot = topologySnapshot();
  const prove = candidate => proveContainedPhaseTargetTopology(candidate, {
    currentPid: 903,
    descendantMarker: TOPOLOGY_MARKER,
    platform: 'darwin',
    label: 'synthetic descendant',
  });
  assert.throws(() => prove(replaceRow(snapshot, 902, { ppid: 900 })),
    /ancestry left the dispatcher process group/);
  assert.throws(() => prove(replaceRow(snapshot, 901, { command: '(node)' })),
    /dispatcher argv is unavailable/);
  assert.throws(() => prove(replaceRow(snapshot, 901, { command: 'unrelated-dispatcher' })),
    /dispatcher command marker mismatch/);
  assert.throws(() => prove(replaceRow(snapshot, 901, { state: 'Z' })),
    /(?:dispatcher|ancestor).*zombie/);
  assert.throws(() => prove(replaceRow(snapshot, 900, { pgid: 901 })),
    /dispatcher group aliases its supervisor group/);
});

function tempEntries(prefix){
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
    .map(entry => entry.name)
    .sort();
}

test('direct Runner browser worker rejects before creating its artifact or Chrome', () => {
  const prefix = `playforge-runner-phase3-direct-reject-${process.pid}-${Date.now()}-`;
  const before = tempEntries(prefix);
  const result = spawnSync(process.execPath, [RUNNER], {
    cwd: ROOT,
    env: {
      ...uncontainedEnvironment(),
      RUNNER_PHASE3_TEMP_PREFIX: prefix,
    },
    encoding: 'utf8',
    timeout: 5_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /descendant marker|dispatcher containment/);
  assert.deepEqual(tempEntries(prefix), before);
});

test('post worker mode rejects before Chrome when its supervisor gate is absent', () => {
  const marker = `post-worker-direct-reject-${process.pid}-${Date.now()}`;
  const result = spawnSync(process.execPath, [POST, `--post-browser-worker-marker=${marker}`], {
    cwd: ROOT,
    env: {
      ...uncontainedEnvironment(),
      POST_BROWSER_WORKER: '1',
      POST_BROWSER_RUN_MARKER: marker,
    },
    encoding: 'utf8',
    timeout: 5_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /descendant marker|dispatcher containment/);
  if(process.platform !== 'win32'){
    assert.deepEqual(exactMarkerProcessRecords(marker).records, [],
      'uncontained post worker spawned a marker-bearing Chrome process');
  }
});

test('other browser workers reject uncontained direct execution before browser or Vite work', () => {
  for(const [label, entry, environment] of [
    ['Phase 4', PHASE4, { RUNNER_PHASE4_INTERNAL_WORKER: '1' }],
    ['foundation', FOUNDATION, {}],
    ['Golf', GOLF, {}],
  ]){
    const result = spawnSync(process.execPath, [entry], {
      cwd: ROOT,
      env: { ...uncontainedEnvironment(), ...environment },
      encoding: 'utf8',
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    assert.equal(result.error, undefined, `${label} rejection did not terminate`);
    assert.notEqual(result.status, 0, `${label} accepted uncontained execution`);
    assert.match(`${result.stdout}\n${result.stderr}`, /descendant marker|dispatcher containment/,
      `${label} did not fail at containment`);
  }
});

test('public Runner browser command routes through the captured supervisor', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['test:runner:browser'],
    'node tools/shipcheck-runner.mjs --browser-only');
});
