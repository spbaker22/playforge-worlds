import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const HARNESS = fileURLToPath(new URL('./shipcheck-runner.mjs', import.meta.url));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function runnerTempDirectories(){
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith('playforge-runner-phase3-'))
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
  if(errors.length) throw new AggregateError(errors, 'Runner hard-gate exact emergency cleanup failed');
}

test('outer hard-gate watchdog preempts a synchronous unit hang and kills its process tree', {
  timeout: 15_000,
}, async () => {
  const marker = `watchdog-negative-${process.pid}-${Date.now()}`;
  const beforeTemps = await runnerTempDirectories();
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
      RUNNER_SHIPCHECK_INJECT_UNIT_HANG: marker,
      RUNNER_SHIPCHECK_TIMEOUT_MS: '750',
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
  }, 8_000);

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(emergencyTimer);
    emergencyCleanup(owned, marker);
    abortCapturedGatedNode(owned);
  }

  const elapsedMs = Date.now() - started;
  const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
  assert.equal(emergencyTriggered, false, 'test emergency cleanup fired before the shipcheck watchdog');
  assert.equal(result.code, 124, `synchronous unit hang must exit 124, received ${result.code}/${result.signal}`);
  assert.ok(elapsedMs >= 500 && elapsedMs < 5_000,
    `synchronous unit hang watchdog must terminate promptly (${elapsedMs}ms)`);
  assert.match(output, /runner-unit-sync-hang-fixture/);
  assert.match(output, /exceeded outer watchdog/);

  let survivors = markerProcesses(marker);
  for(let attempt = 0; survivors.length && attempt < 20; attempt += 1){
    await sleep(50);
    survivors = markerProcesses(marker);
  }
  assert.deepEqual(survivors, [],
    `watchdog left injected unit processes alive: ${survivors.map(item => item.command).join(' | ')}`);
  assert.deepEqual(await runnerTempDirectories(), beforeTemps,
    'synchronous unit hang must not leave a fresh Runner artifact directory');
});

test('fast nonzero phase exit is observed pre-GO and its same-group helper is final-cleaned', {
  timeout: 15_000,
}, async () => {
  const marker = `runner-fast-exit-${process.pid}-${Date.now()}`;
  const beforeTemps = await runnerTempDirectories();
  const stdout = [];
  const stderr = [];
  const owned = spawnCapturedGatedNode({
    title: scopedGatedTitle(`${marker}:harness`),
    args: [HARNESS],
    cwd: ROOT,
    env: {
      ...process.env,
      RUNNER_SHIPCHECK_INJECT_FAST_EXIT_LEAK: marker,
      RUNNER_SHIPCHECK_TIMEOUT_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { child } = owned;
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  let timer;
  let result;
  try {
    await releaseCapturedGatedNode(owned);
    result = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('fast-exit Runner harness timed out')), 8_000);
      }),
    ]);
    const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    assert.deepEqual(result, { code: 23, signal: null }, output);
    assert.match(output, /runner-fast-exit-leak-ready/);
    assert.doesNotMatch(output, /exceeded outer watchdog/);

    let survivors = markerProcesses(marker);
    for(let attempt = 0; survivors.length && attempt < 20; attempt += 1){
      await sleep(25);
      survivors = markerProcesses(marker);
    }
    assert.deepEqual(survivors, [],
      `fast nonzero phase left helper processes alive: ${survivors.map(item => item.command).join(' | ')}`);
    assert.deepEqual(await runnerTempDirectories(), beforeTemps,
      'fast nonzero phase must not leave a fresh Runner artifact directory');
  } finally {
    clearTimeout(timer);
    emergencyCleanup(owned, marker);
    abortCapturedGatedNode(owned);
    await exited.catch(() => {});
  }
});
