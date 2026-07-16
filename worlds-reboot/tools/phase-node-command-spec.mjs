import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PHASE_NODE_COMMAND_PATH = path.join(HERE, 'phase-node-command.mjs');

const SCRIPT_ENTRIES = Object.freeze({
  'foundation-browser': path.join(HERE, 'foundation.browser.mjs'),
  'golf-phase2': path.join(HERE, 'golf.phase2.mjs'),
  'phase-child-process-guard-fixture': path.join(HERE, 'phase-child-process-guard.fixture.mjs'),
  'phase-fast-recovery-fixture': path.join(HERE, 'phase-fast-recovery.fixture.mjs'),
  'phase-nested-leak-fixture': path.join(HERE, 'phase-nested-leak.fixture.mjs'),
  'phase-success-fixture': path.join(HERE, 'phase-success.fixture.mjs'),
  'phase-wait-fixture': path.join(HERE, 'phase-wait.fixture.mjs'),
  'post-browser': path.join(HERE, 'post.browser.mjs'),
  'release-detached-marker-fixture': path.join(HERE, 'release-detached-marker.fixture.mjs'),
  'runner-phase3': path.join(HERE, 'runner.phase3.mjs'),
  'runner-fast-exit-leak-fixture': path.join(HERE, 'runner.fast-exit-leak.fixture.mjs'),
  'runner-phase4-ready-fixture': path.join(HERE, 'runner.phase4.ready.fixture.mjs'),
  'runner-phase4-transaction-crash-fixture': path.join(HERE, 'runner.phase4.transaction-crash.fixture.mjs'),
  'runner-phase4-worker': path.join(HERE, 'runner.phase4.mjs'),
  'runner-unit-sync-hang-fixture': path.join(HERE, 'runner.unit-sync-hang.fixture.mjs'),
  'shipcheck-phase4': path.join(HERE, 'shipcheck-phase4.mjs'),
  'shipcheck-runner': path.join(HERE, 'shipcheck-runner.mjs'),
});

const TEST_ENTRIES = Object.freeze({
  'browser-containment': path.join(HERE, 'browser-containment.test.mjs'),
  'foundation-unit': path.join(HERE, 'foundation.unit.test.mjs'),
  'phase-isolated-node-integration': path.join(HERE, 'phase-isolated-node.integration.test.mjs'),
  'phase-group-finalizer': path.join(HERE, 'phase-group-finalizer.test.mjs'),
  'phase-marker-processes': path.join(HERE, 'phase-marker-processes.test.mjs'),
  'phase-spawn-gate': path.join(HERE, 'phase-spawn-gate.test.mjs'),
  'post-browser-watchdog': path.join(HERE, 'post.browser.watchdog.test.mjs'),
  'runner-hard-gate-watchdog': path.join(HERE, 'runner.hard-gate.watchdog.test.mjs'),
  'runner-geometry-unit': path.join(HERE, 'runner.geometry.unit.test.mjs'),
  'runner-handle-scope-unit': path.join(HERE, 'runner.handle-scope.unit.test.mjs'),
  'runner-phase4-process-snapshot': path.join(HERE, 'runner.phase4.process-snapshot.test.mjs'),
  'runner-phase4-watchdog': path.join(HERE, 'runner.phase4.watchdog.test.mjs'),
  'runner-sim-unit': path.join(HERE, 'runner.sim.unit.test.mjs'),
});

const scriptIdsByPath = new Map(Object.entries(SCRIPT_ENTRIES).map(([id, entry]) => [entry, id]));
const testIdsByPath = new Map(Object.entries(TEST_ENTRIES).map(([id, entry]) => [entry, id]));
const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{1,32768}$/;

function assertStringArray(values, label){
  assert.ok(Array.isArray(values), `${label} array`);
  assert.ok(values.every(value => typeof value === 'string' && !value.includes('\0')),
    `${label} strings`);
  assert.ok(values.reduce((total, value) => total + Buffer.byteLength(value), 0) <= 128 * 1024,
    `${label} byte budget`);
}

function normalizeTestArgs(args){
  const flags = [];
  const files = [];
  for(const argument of args.slice(1)){
    if(argument.startsWith('--')){
      assert.ok(/^--test-(?:timeout|concurrency)=\d{1,9}$/.test(argument)
        || (/^--test-name-pattern=.{1,500}$/.test(argument) && !argument.includes('\0')),
      `disallowed gated node:test flag ${argument}`);
      flags.push(argument);
      continue;
    }
    const absolute = path.resolve(argument);
    const id = testIdsByPath.get(absolute);
    assert.ok(id, `disallowed gated node:test file ${absolute}`);
    files.push(id);
  }
  assert.ok(files.length > 0, 'gated node:test requires an allowlisted file');
  return Object.freeze({ v: 2, kind: 'test', sentinel: true, flags, files });
}

export function phaseNodeCommandDescriptor(args){
  assertStringArray(args, 'gated Node command');
  assert.ok(args.length > 0, 'gated Node command cannot be empty');
  if(args[0] === '--test') return normalizeTestArgs(args);
  assert.ok(!args[0].startsWith('-'),
    `gated Node executable flags are forbidden: ${args[0]}`);
  const entryPath = path.resolve(args[0]);
  const entry = scriptIdsByPath.get(entryPath);
  assert.ok(entry, `disallowed gated Node script ${entryPath}`);
  return Object.freeze({ v: 2, kind: 'script', sentinel: true, entry, args: args.slice(1) });
}

function canonicalDescriptor(descriptor){
  assert.equal(descriptor?.v, 2, 'gated Node descriptor version');
  assert.equal(descriptor.sentinel, true, 'gated Node descriptor sentinel requirement');
  if(descriptor.kind === 'script'){
    assert.equal(typeof SCRIPT_ENTRIES[descriptor.entry], 'string',
      'gated Node descriptor script entry');
    assertStringArray(descriptor.args, 'gated Node script arguments');
    assert.deepEqual(Object.keys(descriptor), ['v', 'kind', 'sentinel', 'entry', 'args'],
      'gated Node script descriptor keys');
    return { v: 2, kind: 'script', sentinel: true, entry: descriptor.entry, args: [...descriptor.args] };
  }
  assert.equal(descriptor.kind, 'test', 'gated Node descriptor kind');
  assert.deepEqual(Object.keys(descriptor), ['v', 'kind', 'sentinel', 'flags', 'files'],
    'gated node:test descriptor keys');
  assertStringArray(descriptor.flags, 'gated node:test flags');
  assertStringArray(descriptor.files, 'gated node:test files');
  const argv = ['--test', ...descriptor.flags, ...descriptor.files.map(id => {
    assert.equal(typeof TEST_ENTRIES[id], 'string', `gated node:test entry ${id}`);
    return TEST_ENTRIES[id];
  })];
  return normalizeTestArgs(argv);
}

export function encodePhaseNodeCommand(args){
  const descriptor = phaseNodeCommandDescriptor(args);
  const payload = Buffer.from(JSON.stringify(descriptor)).toString('base64url');
  assert.match(payload, PAYLOAD_PATTERN, 'gated Node command payload');
  return payload;
}

export function decodePhaseNodeCommand(payload){
  return decodePhaseNodeCommandEnvelope(payload).args;
}

export function decodePhaseNodeCommandEnvelope(payload){
  assert.match(payload || '', PAYLOAD_PATTERN, 'gated Node command payload');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const descriptor = canonicalDescriptor(decoded);
  assert.equal(Buffer.from(JSON.stringify(descriptor)).toString('base64url'), payload,
    'gated Node command payload must be canonical');
  const args = descriptor.kind === 'script'
    ? [SCRIPT_ENTRIES[descriptor.entry], ...descriptor.args]
    : ['--test', ...descriptor.flags, ...descriptor.files.map(id => TEST_ENTRIES[id])];
  return Object.freeze({ args: Object.freeze(args), sentinel: descriptor.sentinel });
}
