import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARNESS = join(ROOT, 'tools/post.browser.mjs');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function postTempDirectories(){
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith('playforge-post-browser-'))
    .map(entry => entry.name)
    .sort();
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
        stdio: 'ignore',
        timeout: 5_000,
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
  if(errors.length) throw new AggregateError(errors, 'post watchdog exact emergency cleanup failed');
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
    fd: Number.isInteger(resource?.fd) ? resource.fd : Number.isInteger(resource?._handle?.fd) ? resource._handle.fd : null,
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
  assert.fail(`negative test leaked resources: ${JSON.stringify({
    handles: ownership.handles.map(describeResource),
    requests: ownership.requests.map(describeResource),
  })}`);
}

async function runNegative({ marker, env, emergencyMilliseconds = 8_000 }){
  await new Promise(resolve => setImmediate(resolve));
  const scope = createIdentityHandleScope({
    ignoredHandles: [process.stdin, process.stdout, process.stderr],
  });
  const beforeTemps = await postTempDirectories();
  const stdout = [];
  const stderr = [];
  const started = Date.now();
  let emergencyTriggered = false;
  const owned = spawnCapturedGatedNode({
    title: scopedGatedTitle(`${marker}:harness`),
    args: [HARNESS],
    cwd: ROOT,
    env: {
      ...process.env,
      POST_BROWSER_RUN_MARKER: marker,
      ...env,
    },
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
    emergencyCleanup(owned, marker);
    abortCapturedGatedNode(owned);
    releaseChild(child);
  }

  let survivors = markerProcesses(marker);
  for(let attempt = 0; survivors.length && attempt < 40; attempt += 1){
    await sleep(50);
    survivors = markerProcesses(marker);
  }
  assert.deepEqual(survivors, [],
    `negative left owned processes alive: ${survivors.map(item => item.command).join(' | ')}`);
  assert.deepEqual(await postTempDirectories(), beforeTemps,
    'negative must remove its Chrome/Vite temp root');
  await assertNoOwnedResources(scope);
  return {
    result,
    output: Buffer.concat([...stdout, ...stderr]).toString('utf8'),
    elapsedMs: Date.now() - started,
    emergencyTriggered,
  };
}

test('outer watchdog preempts a synchronous worker hang and removes its process tree', {
  timeout: 15_000,
}, async () => {
  const marker = `post-sync-negative-${process.pid}-${Date.now()}`;
  const result = await runNegative({
    marker,
    env: {
      POST_BROWSER_INJECT_SYNC_HANG: '1',
      POST_BROWSER_ARM_WATCHDOG_AFTER_FIXTURE: '1',
      POST_BROWSER_OUTER_TIMEOUT_MS: '750',
    },
  });
  assert.equal(result.emergencyTriggered, false, 'test emergency cleanup fired before the harness watchdog');
  assert.equal(result.result.code, 124,
    `synchronous hang must exit 124, received ${result.result.code}/${result.result.signal}\n${result.output}`);
  assert.ok(result.elapsedMs >= 500 && result.elapsedMs < 5_000,
    `synchronous watchdog must terminate promptly (${result.elapsedMs}ms)`);
  assert.match(result.output, new RegExp(`post-browser-sync-hang-fixture:${marker}`));
  assert.match(result.output, /exceeded outer watchdog 750ms/);
});

test('page-operation timeout rejects a never-resolving evaluation and cleans all ownership', {
  timeout: 15_000,
}, async () => {
  const marker = `post-page-negative-${process.pid}-${Date.now()}`;
  const result = await runNegative({
    marker,
    env: {
      POST_BROWSER_INJECT_PAGE_HANG: '1',
      POST_BROWSER_INJECT_TIMEOUT_MS: '250',
      POST_BROWSER_OUTER_TIMEOUT_MS: '10000',
    },
  });
  assert.equal(result.emergencyTriggered, false, 'test emergency cleanup fired during page timeout cleanup');
  assert.equal(result.result.code, 1,
    `page timeout must exit 1, received ${result.result.code}/${result.result.signal}`);
  assert.ok(result.elapsedMs >= 200 && result.elapsedMs < 5_000,
    `page timeout must reject and clean promptly (${result.elapsedMs}ms)`);
  assert.match(result.output, new RegExp(`post-browser-page-hang-fixture:${marker}`));
  assert.match(result.output, /injected page evaluate exceeded 250ms/);
  assert.match(result.output, /post\.browser failed/);
});
