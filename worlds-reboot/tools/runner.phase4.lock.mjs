import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { link, mkdir, open, readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const startHash = identity => createHash('sha256').update(identity).digest('hex').slice(0, 16);
const LIVE = 'LIVE';
const PROVEN_DEAD = 'PROVEN_DEAD';
const UNKNOWN = 'UNKNOWN';
const TRUSTED_PS = '/bin/ps';
const CANONICAL_LSTART = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12][0-9]|3[01]) (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-6][0-9] [0-9]{4}$/;
const PROCESS_SNAPSHOT_ARGS = Object.freeze([
  '-axww',
  '-o',
  'pid=,ppid=,pgid=,stat=,lstart=,ucomm=,command=',
]);
// Darwin's ucomm column is MAXCOMLEN (16) bytes and is emitted left-aligned.
// Keeping it beside argv lets callers distinguish a KERN_PROCARGS2 fallback
// such as `(node)` from a genuine full-command mutation in the same snapshot.
const PROCESS_SNAPSHOT_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(?:[1-9]|[12][0-9]|3[01])\s+(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-6][0-9]\s+[0-9]{4})\s+(.{16})\s(.*)$/;
const PROCESS_SNAPSHOT_FIELDS = Object.freeze([
  'pid',
  'ppid',
  'pgid',
  'processStart',
  'state',
  'ucomm',
  'command',
]);
const CAPTURE_PAUSE = new Int32Array(new SharedArrayBuffer(4));
const pauseCapture = milliseconds => Atomics.wait(CAPTURE_PAUSE, 0, 0, milliseconds);

function validateProcessSnapshotRecord(record, label = 'process snapshot record'){
  assert.ok(record && typeof record === 'object', `${label} must be an object`);
  for(const field of ['pid', 'ppid', 'pgid']){
    assert.ok(Number.isSafeInteger(record[field]) && record[field] >= (field === 'ppid' ? 0 : 1),
      `${label} has invalid ${field}`);
  }
  assert.ok(typeof record.processStart === 'string'
    && record.processStart.startsWith('posix-lstart-utc:'), `${label} has invalid processStart`);
  assert.ok(CANONICAL_LSTART.test(record.processStart.slice('posix-lstart-utc:'.length)),
    `${label} has non-canonical processStart`);
  assert.ok(typeof record.state === 'string' && record.state.length > 0,
    `${label} has invalid state`);
  assert.ok(typeof record.ucomm === 'string' && record.ucomm.length > 0 && record.ucomm.length <= 16,
    `${label} has invalid ucomm`);
  assert.ok(typeof record.command === 'string' && record.command.length > 0,
    `${label} has invalid command`);
  return record;
}

function validateProcessSnapshot(snapshot){
  assert.ok(Array.isArray(snapshot), 'process snapshot must be an array');
  const seen = new Set();
  for(const [index, record] of snapshot.entries()){
    validateProcessSnapshotRecord(record, `process snapshot record ${index}`);
    assert.ok(!seen.has(record.pid), `process snapshot contains duplicate PID ${record.pid}`);
    seen.add(record.pid);
  }
  return snapshot;
}

/** Validate an injected/cached snapshot with the same schema as pinned /bin/ps. */
export function assertProcessTableSnapshot(snapshot){
  return validateProcessSnapshot(snapshot);
}

function sameProcessSnapshotRecord(left, right){
  return PROCESS_SNAPSHOT_FIELDS.every(field => left?.[field] === right?.[field]);
}

/**
 * Capture one process-table view with one pinned /bin/ps invocation. Each row
 * and the returned array are frozen; callers can therefore derive ownership
 * and lineage from one view without performing a second bare-PID discovery.
 */
export function captureProcessTableSnapshotSync({
  psRunner = spawnSync,
  requiredPid = process.pid,
} = {}){
  assert.equal(typeof psRunner, 'function', 'process snapshot psRunner');
  assert.ok(Number.isSafeInteger(requiredPid) && requiredPid > 0, 'process snapshot requiredPid');
  const result = psRunner(TRUSTED_PS, [...PROCESS_SNAPSHOT_ARGS], {
    encoding: 'utf8',
    timeout: 1_000,
    killSignal: 'SIGKILL',
    env: {
      LC_ALL: 'C',
      LANG: 'C',
      TZ: 'UTC',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    },
  });
  if(result?.error){
    throw new Error(`atomic process snapshot failed: ${result.error.message}`, { cause: result.error });
  }
  if(result?.status !== 0){
    throw new Error(`atomic process snapshot exited ${result?.status}: ${String(result?.stderr || '')}`);
  }
  assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0,
    'atomic process snapshot did not report its scanner PID');
  assert.notEqual(result.pid, requiredPid,
    'atomic process snapshot scanner PID unexpectedly equals the required supervisor PID');

  const records = [];
  const seen = new Set();
  for(const [index, originalLine] of String(result.stdout || '').split('\n').entries()){
    const line = originalLine.endsWith('\r') ? originalLine.slice(0, -1) : originalLine;
    if(!line.trim()) continue;
    const match = line.match(PROCESS_SNAPSHOT_ROW);
    assert.ok(match, `atomic process snapshot returned malformed row ${index + 1}: ${line}`);
    const lstart = match[5].replace(/\s+/g, ' ');
    assert.ok(CANONICAL_LSTART.test(lstart),
      `atomic process snapshot returned non-canonical lstart on row ${index + 1}`);
    const record = Object.freeze({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      processStart: `posix-lstart-utc:${lstart}`,
      state: match[4],
      ucomm: match[6].trimEnd(),
      // Preserve internal/full spelling, trimming only ps column padding at
      // the end of the final command field.
      command: match[7].trimEnd(),
    });
    if(record.pid === result.pid){
      continue; // Never let the short-lived scanner become owned lineage.
    }
    validateProcessSnapshotRecord(record, `process snapshot row ${index + 1}`);
    assert.ok(!seen.has(record.pid), `atomic process snapshot returned duplicate PID ${record.pid}`);
    seen.add(record.pid);
    records.push(record);
  }
  assert.ok(records.length > 0, 'atomic process snapshot returned no rows');
  assert.ok(records.some(record => record.pid === requiredPid),
    `atomic process snapshot omitted required supervisor PID ${requiredPid}`);
  return Object.freeze(records);
}

/** Literal command-marker matches derived only from the supplied snapshot. */
export function processSnapshotMarkerMatches(snapshot, marker){
  validateProcessSnapshot(snapshot);
  assert.equal(typeof marker, 'string', 'process command marker');
  assert.ok(marker.length > 0, 'process command marker must not be empty');
  return Object.freeze(snapshot.filter(record => record.command.includes(marker)));
}

/**
 * Return a complete PPID closure from exact root records in the same snapshot.
 * Numeric PIDs are deliberately rejected as roots. Roots are included unless
 * includeRoots is false.
 */
export function processSnapshotDescendantClosure(snapshot, rootRecords, { includeRoots = true } = {}){
  validateProcessSnapshot(snapshot);
  const requestedRoots = Array.isArray(rootRecords) ? rootRecords : [rootRecords];
  assert.ok(requestedRoots.length > 0, 'at least one exact process root record is required');
  const roots = requestedRoots.map((root, index) => {
    validateProcessSnapshotRecord(root, `process root record ${index}`);
    const exact = snapshot.find(record => sameProcessSnapshotRecord(record, root));
    assert.ok(exact, `process root record ${index} is not an exact member of this snapshot`);
    return exact;
  });

  const childrenByParent = new Map();
  for(const record of snapshot){
    const children = childrenByParent.get(record.ppid) || [];
    children.push(record);
    childrenByParent.set(record.ppid, children);
  }
  const rootPids = new Set(roots.map(record => record.pid));
  const visited = new Set(rootPids);
  const queue = [...roots];
  const closure = includeRoots ? [...roots] : [];
  for(let cursor = 0; cursor < queue.length; cursor += 1){
    const parent = queue[cursor];
    for(const child of childrenByParent.get(parent.pid) || []){
      if(visited.has(child.pid)) continue;
      visited.add(child.pid);
      queue.push(child);
      closure.push(child);
    }
  }
  if(!includeRoots){
    assert.ok(closure.every(record => !rootPids.has(record.pid)),
      'descendant-only closure included a root');
  }
  return Object.freeze(closure);
}

/** Bind an exact discovered row before it can enter an owned-process set. */
export function bindProcessSnapshotIdentity(snapshot, record, {
  expectedCommandMarker = null,
  expectedCommand = null,
  requireOwnProcessGroup = false,
} = {}){
  validateProcessSnapshot(snapshot);
  validateProcessSnapshotRecord(record);
  const exact = snapshot.find(candidate => sameProcessSnapshotRecord(candidate, record));
  if(!exact) throw captureFailure(`PID ${record.pid} is not an exact member of the supplied process snapshot`, UNKNOWN);
  if(exact.state.startsWith('Z')){
    throw captureFailure(`PID ${record.pid} is a zombie in the supplied process snapshot`, PROVEN_DEAD);
  }
  if(expectedCommandMarker !== null){
    assert.equal(typeof expectedCommandMarker, 'string', 'expected command marker');
    assert.ok(expectedCommandMarker.length > 0, 'expected command marker must not be empty');
    if(!exact.command.includes(expectedCommandMarker)){
      throw captureFailure(`PID ${record.pid} command marker mismatch`, UNKNOWN);
    }
  }
  if(expectedCommand !== null){
    assert.equal(typeof expectedCommand, 'string', 'expected exact command');
    assert.ok(expectedCommand.length > 0, 'expected exact command must not be empty');
    if(exact.command !== expectedCommand){
      throw captureFailure(`PID ${record.pid} exact command mismatch`, UNKNOWN);
    }
  }
  if(requireOwnProcessGroup && process.platform !== 'win32' && exact.pgid !== exact.pid){
    throw captureFailure(`PID ${record.pid} does not own its process group`, UNKNOWN);
  }
  return Object.freeze(Object.fromEntries(PROCESS_SNAPSHOT_FIELDS.map(field => [field, exact[field]])));
}

/**
 * Darwin ps renders argv as `(<ucomm>)` when KERN_PROCARGS2 is temporarily
 * unavailable. This is degraded observability, never proof of life/death or
 * authority to signal. PPID is deliberately required here even though normal
 * bound children may later reparent.
 */
export function processSnapshotCommandUnavailable(record, {
  platform = process.platform,
} = {}){
  try { validateProcessSnapshotRecord(record, 'argv-unavailable process record'); }
  catch { return false; }
  return platform === 'darwin' && record.command === `(${record.ucomm})`;
}

export function processSnapshotArgsUnavailable(identity, current, {
  platform = process.platform,
} = {}){
  try {
    validateProcessSnapshotRecord(identity, 'captured argv identity');
    validateProcessSnapshotRecord(current, 'current argv identity');
  } catch { return false; }
  return processSnapshotCommandUnavailable(current, { platform })
    && current.pid === identity.pid
    && current.ppid === identity.ppid
    && current.pgid === identity.pgid
    && current.processStart === identity.processStart
    && current.ucomm === identity.ucomm
    && current.command !== identity.command;
}

/**
 * Revalidate the stable bound fields against one new process-table snapshot.
 * PPID and ps state are bound at discovery to prove initial lineage, but are
 * not stable thereafter: an owned child may be reparented and a healthy
 * process routinely moves between runnable/sleeping states. PID/start reuse is
 * proof that the captured identity died; PGID/command changes fail closed.
 */
export function exactProcessSnapshotIdentityState(identity, {
  snapshot = null,
  snapshotProbe = captureProcessTableSnapshotSync,
  pidExistenceProbe = existenceProbe,
} = {}){
  try { validateProcessSnapshotRecord(identity, 'bound process snapshot identity'); }
  catch(error){ return { state: UNKNOWN, reason: 'invalid-captured-identity', error }; }

  let currentSnapshot;
  try {
    currentSnapshot = snapshot === null ? snapshotProbe() : snapshot;
    validateProcessSnapshot(currentSnapshot);
  } catch(error){
    return { state: UNKNOWN, reason: 'process-table-snapshot-failed', error };
  }
  const current = currentSnapshot.find(record => record.pid === identity.pid);
  if(!current){
    let existence = UNKNOWN;
    try { existence = pidExistenceProbe(identity.pid); }
    catch { /* a failed kill(0) probe is unknowable, never proof of death */ }
    if(existence === PROVEN_DEAD){
      return { state: PROVEN_DEAD, processStart: null, reason: 'pid-absent-and-esrch' };
    }
    return {
      state: UNKNOWN,
      processStart: identity.processStart,
      reason: existence === LIVE ? 'snapshot-omitted-live-pid' : 'snapshot-omitted-unproven-pid',
    };
  }
  if(current.processStart !== identity.processStart){
    return { state: PROVEN_DEAD, processStart: null, reason: 'pid-reused' };
  }
  if(current.state.startsWith('Z')){
    return { state: PROVEN_DEAD, processStart: null, reason: 'zombie' };
  }
  if(current.pgid !== identity.pgid){
    return { state: UNKNOWN, processStart: current.processStart, reason: 'process-group-changed', record: current };
  }
  if(current.ucomm !== identity.ucomm){
    return { state: UNKNOWN, processStart: current.processStart, reason: 'ucomm-changed', record: current };
  }
  if(current.command !== identity.command){
    if(processSnapshotArgsUnavailable(identity, current)){
      return { state: UNKNOWN, processStart: current.processStart, reason: 'args-unavailable', record: current };
    }
    return { state: UNKNOWN, processStart: current.processStart, reason: 'command-changed', record: current };
  }
  return { state: LIVE, processStart: current.processStart, record: current };
}

/** Signal only one PID whose complete snapshot identity was just revalidated. */
export function signalExactProcessSnapshotIdentity(identity, signal, {
  snapshotProbe = captureProcessTableSnapshotSync,
  pidExistenceProbe = existenceProbe,
  signalProcess = process.kill,
} = {}){
  const current = exactProcessSnapshotIdentityState(identity, { snapshotProbe, pidExistenceProbe });
  if(current.state !== LIVE){
    return { signalled: false, state: current.state, reason: current.reason };
  }
  try {
    signalProcess(identity.pid, signal);
    return { signalled: true, state: LIVE };
  } catch(error){
    if(error?.code === 'ESRCH'){
      return { signalled: false, state: PROVEN_DEAD, reason: 'pid-disappeared-before-signal' };
    }
    if(error?.code === 'EPERM'){
      return { signalled: false, state: UNKNOWN, reason: 'signal-not-permitted' };
    }
    throw error;
  }
}

function existenceProbe(pid){
  try {
    process.kill(pid, 0);
    return LIVE;
  } catch(error){
    if(error?.code === 'EPERM') return LIVE;
    if(error?.code === 'ESRCH') return PROVEN_DEAD;
    return UNKNOWN;
  }
}

/**
 * Returns a fail-closed, environment-independent process identity result.
 * UNKNOWN is never interchangeable with death: callers must leave the claim
 * untouched and block acquisition/recovery until liveness is knowable.
 */
export function probeProcessIdentity(pid){
  if(!Number.isSafeInteger(pid) || pid <= 0) return { state: UNKNOWN, processStart: null };
  const exists = existenceProbe(pid);
  if(exists === PROVEN_DEAD) return { state: PROVEN_DEAD, processStart: null };
  if(exists === UNKNOWN) return { state: UNKNOWN, processStart: null };
  if(process.platform === 'win32') return { state: LIVE, processStart: `win32-pid:${pid}` };
  const result = spawnSync(TRUSTED_PS, ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 1_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
  });
  const raw = String(result.stdout || '').trim().replace(/\s+/g, ' ');
  if(!result.error && result.status === 0 && CANONICAL_LSTART.test(raw)){
    return { state: LIVE, processStart: `posix-lstart-utc:${raw}` };
  }
  const rechecked = existenceProbe(pid);
  if(rechecked === PROVEN_DEAD) return { state: PROVEN_DEAD, processStart: null };
  return { state: UNKNOWN, processStart: null };
}

function processRowSync(pid){
  const result = spawnSync(TRUSTED_PS, ['-o', 'pid=,pgid=,stat=,command=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 1_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
  });
  if(result.error) throw new Error(`exact process row probe failed: ${result.error.message}`, { cause: result.error });
  if(result.status !== 0) throw new Error(`exact process row probe exited ${result.status}: ${result.stderr || ''}`);
  const rows = String(result.stdout || '').split('\n').filter(line => line.trim());
  assert.equal(rows.length, 1, `exact process row probe returned ${rows.length} rows`);
  const match = rows[0].match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
  assert.ok(match, `exact process row probe returned malformed row: ${rows[0]}`);
  return {
    pid: Number(match[1]),
    pgid: Number(match[2]),
    status: match[3],
    command: match[4].trimEnd(),
  };
}

function captureFailure(message, state, cause = undefined){
  const error = new Error(message, cause ? { cause } : undefined);
  error.identityState = state;
  return error;
}

/** Capture a spawned/discovered process before it can become owned state. */
export function captureExactProcessIdentitySync(pid, {
  expectedCommandMarker = null,
  expectedCommand = null,
  requireOwnProcessGroup = false,
  processProbe = probeProcessIdentity,
  rowProbe = processRowSync,
} = {}){
  if(!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid){
    throw captureFailure(`invalid spawned PID ${pid}`, UNKNOWN);
  }
  if(expectedCommandMarker !== null){
    assert.equal(typeof expectedCommandMarker, 'string', 'expected command marker');
    assert.ok(expectedCommandMarker, 'expected command marker must not be empty');
  }
  if(expectedCommand !== null){
    assert.equal(typeof expectedCommand, 'string', 'expected exact command');
    assert.ok(expectedCommand, 'expected exact command must not be empty');
  }
  const first = runProcessProbe(processProbe, pid);
  if(first.state !== LIVE){
    throw captureFailure(`spawned PID ${pid} is ${first.state} before ownership capture`, first.state);
  }
  const deadline = Date.now() + 500;
  let lastReason = 'process row did not stabilize';
  let lastError = null;
  while(Date.now() <= deadline){
    let firstRow;
    let secondRow;
    try {
      firstRow = rowProbe(pid);
      const middle = runProcessProbe(processProbe, pid);
      if(middle.state !== LIVE || middle.processStart !== first.processStart){
        throw captureFailure(`spawned PID ${pid} identity changed during ownership capture`,
          middle.state === PROVEN_DEAD ? PROVEN_DEAD : UNKNOWN);
      }
      secondRow = rowProbe(pid);
      const last = runProcessProbe(processProbe, pid);
      if(last.state !== LIVE || last.processStart !== first.processStart){
        throw captureFailure(`spawned PID ${pid} identity changed during ownership capture`,
          last.state === PROVEN_DEAD ? PROVEN_DEAD : UNKNOWN);
      }
    } catch(error){
      if(error?.identityState) throw error;
      const afterFailure = runProcessProbe(processProbe, pid);
      if(afterFailure.state === PROVEN_DEAD){
        throw captureFailure(`spawned PID ${pid} died before its process row stabilized`, PROVEN_DEAD, error);
      }
      lastReason = `process row is not provable: ${error.message}`;
      lastError = error;
      pauseCapture(5);
      continue;
    }
    for(const row of [firstRow, secondRow]){
      if(row.pid !== pid || !Number.isSafeInteger(row.pgid) || row.pgid <= 0){
        throw captureFailure(`spawned PID ${pid} returned an invalid exact process row`, UNKNOWN);
      }
      if(row.status.startsWith('Z')){
        throw captureFailure(`spawned PID ${pid} became a zombie before ownership capture`, PROVEN_DEAD);
      }
    }
    const stable = firstRow.pgid === secondRow.pgid
      && firstRow.command === secondRow.command;
    const markerMatches = expectedCommand !== null
      ? secondRow.command === expectedCommand
      : expectedCommandMarker === null || secondRow.command.includes(expectedCommandMarker);
    const groupMatches = !requireOwnProcessGroup || process.platform === 'win32'
      || secondRow.pgid === pid;
    if(stable && markerMatches && groupMatches){
      return Object.freeze({
        pid,
        processStart: first.processStart,
        pgid: secondRow.pgid,
        command: secondRow.command,
        commandMarker: expectedCommandMarker || expectedCommand,
      });
    }
    lastReason = !stable
      ? 'process row changed between exact probes'
      : !markerMatches
        ? `command marker mismatch (observed ${JSON.stringify(secondRow.command)})`
        : 'process group did not stabilize';
    pauseCapture(5);
  }
  throw captureFailure(`spawned PID ${pid} ${lastReason}`, UNKNOWN, lastError);
}

export function exactProcessIdentityState(identity, {
  processProbe = probeProcessIdentity,
  rowProbe = processRowSync,
} = {}){
  if(!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0){
    return { state: UNKNOWN, reason: 'invalid-captured-identity' };
  }
  const current = runProcessProbe(processProbe, identity.pid);
  if(current.state !== LIVE) return { ...current, reason: 'liveness' };
  if(current.processStart !== identity.processStart){
    return { state: PROVEN_DEAD, processStart: null, reason: 'pid-reused' };
  }
  let row;
  try { row = rowProbe(identity.pid); }
  catch(error){ return { state: UNKNOWN, processStart: current.processStart, reason: error.message }; }
  if(row.pid !== identity.pid || row.status.startsWith('Z')){
    return { state: PROVEN_DEAD, processStart: null, reason: 'row-dead-or-mismatched' };
  }
  if(row.pgid !== identity.pgid || row.command !== identity.command){
    return { state: UNKNOWN, processStart: current.processStart, reason: 'command-or-pgid-changed' };
  }
  return { state: LIVE, processStart: current.processStart, pgid: row.pgid, command: row.command };
}

/** Signal only an identity that is still exact at the instant of signalling. */
export function signalExactProcessIdentity(identity, signal, {
  processProbe = probeProcessIdentity,
  rowProbe = processRowSync,
  signalProcess = process.kill,
} = {}){
  const current = exactProcessIdentityState(identity, { processProbe, rowProbe });
  if(current.state !== LIVE) return { signalled: false, state: current.state, reason: current.reason };
  const target = process.platform !== 'win32' && identity.pgid === identity.pid
    ? -identity.pgid : identity.pid;
  try { signalProcess(target, signal); }
  catch(error){
    if(!['ESRCH', 'EPERM'].includes(error?.code)) throw error;
  }
  return { signalled: true, state: LIVE };
}

function runProcessProbe(processProbe, pid){
  try {
    const result = processProbe(pid);
    if(result?.state === LIVE && typeof result.processStart === 'string' && result.processStart){
      return result;
    }
    if(result?.state === PROVEN_DEAD) return { state: PROVEN_DEAD, processStart: null };
    if(result?.state === UNKNOWN) return { state: UNKNOWN, processStart: null };
  } catch { /* a probe failure is unknowable, never proof of death */ }
  return { state: UNKNOWN, processStart: null };
}

function deadForIdentity(probe, identityHash){
  return probe.state === PROVEN_DEAD
    || (probe.state === LIVE && startHash(probe.processStart) !== identityHash);
}

function claimProcessIsLive(claim, processProbe){
  const current = runProcessProbe(processProbe, claim?.pid);
  return current.state === LIVE && current.processStart === claim?.processStart;
}

async function fsyncDirectory(directory){
  const handle = await open(directory, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function publishClaim(claimDirectory, payload, beforePublish){
  const nonce = randomBytes(12).toString('hex');
  const identityHash = startHash(payload.processStart);
  const publishedPayload = { ...payload, nonce };
  const pending = path.join(claimDirectory, `.pending-${payload.pid}-${identityHash}-${nonce}.json`);
  const claimPath = path.join(claimDirectory, `claim-${payload.pid}-${identityHash}-${nonce}`);
  let handle = null;
  let published = false;
  try {
    handle = await open(pending, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(publishedPayload)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    if(beforePublish) await beforePublish();

    // mkdir is the publication operation. Its directory birth time therefore
    // orders contenders at publication, never at prewrite/pending creation.
    await mkdir(claimPath);
    published = true;
    await link(pending, path.join(claimPath, 'payload.json'));
    await fsyncDirectory(claimPath);
    await fsyncDirectory(claimDirectory);
    await unlink(pending);
    return { claimPath, publishedPayload };
  } catch(error){
    if(handle) await handle.close().catch(() => {});
    if(published) await rm(claimPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(pending, { force: true }).catch(() => {});
  }
}

function claimNameIdentity(name){
  const match = name.match(/^claim-(\d+)-([0-9a-f]{16})-([0-9a-f]{24})$/);
  if(!match) return null;
  return { pid: Number(match[1]), processStartHash: match[2], nonce: match[3] };
}

function pendingNameIdentity(name){
  const match = name.match(/^\.pending-(\d+)-([0-9a-f]{16})-([0-9a-f]{24})\.json$/);
  if(!match) return null;
  return { pid: Number(match[1]), processStartHash: match[2], nonce: match[3] };
}

async function removeProvenDeadPendingClaims({
  claimDirectory,
  ownedPids = null,
  processProbe = probeProcessIdentity,
}){
  let entries;
  try { entries = await readdir(claimDirectory, { withFileTypes: true }); }
  catch(error){ if(error?.code === 'ENOENT') return []; throw error; }
  const removed = [];
  for(const entry of entries){
    if(!entry.isFile()) continue;
    const identity = pendingNameIdentity(entry.name);
    if(!identity || (ownedPids && !ownedPids.has(identity.pid))) continue;
    const probe = runProcessProbe(processProbe, identity.pid);
    if(!deadForIdentity(probe, identity.processStartHash)) continue;
    const pendingPath = path.join(claimDirectory, entry.name);
    let payload = null;
    try {
      const candidate = JSON.parse(await readFile(pendingPath, 'utf8'));
      if(candidate.pid === identity.pid
        && startHash(candidate.processStart) === identity.processStartHash
        && candidate.nonce === identity.nonce
        && typeof candidate.marker === 'string') payload = candidate;
    } catch { /* a killed pre-publication write is still bound by its exact filename identity */ }
    await unlink(pendingPath);
    removed.push({ path: pendingPath, payload, pid: identity.pid, kind: 'pending' });
  }
  if(removed.length) await fsyncDirectory(claimDirectory);
  return removed;
}

async function removeProvenDeadPublishedClaims({
  claimDirectory,
  ownedPids = null,
  processProbe = probeProcessIdentity,
}){
  let entries;
  try { entries = await readdir(claimDirectory, { withFileTypes: true }); }
  catch(error){ if(error?.code === 'ENOENT') return []; throw error; }
  const removed = [];
  for(const entry of entries){
    if(!entry.isDirectory()) continue;
    const identity = claimNameIdentity(entry.name);
    if(!identity || (ownedPids && !ownedPids.has(identity.pid))) continue;
    const probe = runProcessProbe(processProbe, identity.pid);
    if(!deadForIdentity(probe, identity.processStartHash)) continue;
    const claimPath = path.join(claimDirectory, entry.name);
    let payload = null;
    try { payload = JSON.parse(await readFile(path.join(claimPath, 'payload.json'), 'utf8')); }
    catch { /* an interrupted publisher is still bound by its exact directory identity */ }
    await rm(claimPath, { recursive: true, force: true });
    removed.push({ path: claimPath, payload, pid: identity.pid, kind: 'published' });
  }
  if(removed.length) await fsyncDirectory(claimDirectory);
  return removed;
}

async function readClaims(claimDirectory, processProbe){
  const entries = await readdir(claimDirectory, { withFileTypes: true });
  const claims = [];
  for(const entry of entries){
    if(!entry.isDirectory()) continue;
    const nameIdentity = claimNameIdentity(entry.name);
    if(!nameIdentity) continue;
    const probe = runProcessProbe(processProbe, nameIdentity.pid);
    if(deadForIdentity(probe, nameIdentity.processStartHash)) continue;
    const claimPath = path.join(claimDirectory, entry.name);
    let metadata;
    try { metadata = await stat(claimPath, { bigint: true }); }
    catch(error){ if(error?.code === 'ENOENT') continue; throw error; }
    let payload = null;
    try {
      const candidate = JSON.parse(await readFile(path.join(claimPath, 'payload.json'), 'utf8'));
      if(candidate.pid === nameIdentity.pid
        && startHash(candidate.processStart) === nameIdentity.processStartHash
        && (probe.state !== LIVE || candidate.processStart === probe.processStart)
        && candidate.nonce === nameIdentity.nonce) payload = candidate;
    } catch {
      // A published but not-yet-linked live claim remains a blocking entry.
    }
    claims.push({
      path: claimPath,
      payload,
      probeState: probe.state,
      nameIdentity,
      order: metadata.birthtimeNs || metadata.ctimeNs || metadata.mtimeNs,
    });
  }
  return claims.sort((left, right) => {
    if(left.order < right.order) return -1;
    if(left.order > right.order) return 1;
    return left.path.localeCompare(right.path);
  });
}

async function assertNoUnknownPendingClaims(claimDirectory, processProbe){
  const entries = await readdir(claimDirectory, { withFileTypes: true });
  for(const entry of entries){
    if(!entry.isFile()) continue;
    const identity = pendingNameIdentity(entry.name);
    if(!identity) continue;
    const probe = runProcessProbe(processProbe, identity.pid);
    assert.notEqual(probe.state, UNKNOWN,
      `Phase 4 pending release claimant liveness is unknown for ${path.join(claimDirectory, entry.name)}`);
  }
}

function assertNoUnknownPendingClaimsSync(claimDirectory, processProbe){
  for(const entry of readdirSync(claimDirectory, { withFileTypes: true })){
    if(!entry.isFile()) continue;
    const identity = pendingNameIdentity(entry.name);
    if(!identity) continue;
    const probe = runProcessProbe(processProbe, identity.pid);
    assert.notEqual(probe.state, UNKNOWN,
      `Phase 4 pending release claimant liveness is unknown for ${path.join(claimDirectory, entry.name)}`);
  }
}

function readClaimsSync(claimDirectory, processProbe){
  const claims = [];
  for(const entry of readdirSync(claimDirectory, { withFileTypes: true })){
    if(!entry.isDirectory()) continue;
    const nameIdentity = claimNameIdentity(entry.name);
    if(!nameIdentity) continue;
    const probe = runProcessProbe(processProbe, nameIdentity.pid);
    if(deadForIdentity(probe, nameIdentity.processStartHash)) continue;
    const claimPath = path.join(claimDirectory, entry.name);
    const metadata = statSync(claimPath, { bigint: true });
    let payload = null;
    try {
      const candidate = JSON.parse(readFileSync(path.join(claimPath, 'payload.json'), 'utf8'));
      if(candidate.pid === nameIdentity.pid
        && startHash(candidate.processStart) === nameIdentity.processStartHash
        && (probe.state !== LIVE || candidate.processStart === probe.processStart)
        && candidate.nonce === nameIdentity.nonce) payload = candidate;
    } catch { /* a live/unknown incomplete publication remains blocking */ }
    claims.push({
      path: claimPath,
      payload,
      probeState: probe.state,
      order: metadata.birthtimeNs || metadata.ctimeNs || metadata.mtimeNs,
    });
  }
  return claims.sort((left, right) => {
    if(left.order < right.order) return -1;
    if(left.order > right.order) return 1;
    return left.path.localeCompare(right.path);
  });
}

/** Synchronous final-boundary ownership check used immediately before commit. */
export function assertPhase4ReleaseClaimSync(lock){
  assert.ok(lock?.path && lock?.token && lock?.claimDirectory, 'release claim is required');
  const processProbe = lock.processProbe || probeProcessIdentity;
  const current = JSON.parse(readFileSync(path.join(lock.path, 'payload.json'), 'utf8'));
  assert.equal(current.token, lock.token, 'owned Phase 4 release claim token changed');
  assert.equal(claimProcessIsLive(current, processProbe), true,
    'owned Phase 4 release claim process identity is not provably live');
  assertNoUnknownPendingClaimsSync(lock.claimDirectory, processProbe);
  const live = readClaimsSync(lock.claimDirectory, processProbe);
  assert.ok(live.length > 0, 'no live Phase 4 release claims');
  const unknowable = live.find(claim => claim.probeState === UNKNOWN);
  assert.equal(unknowable, undefined,
    `Phase 4 release claim liveness is unknown for ${unknowable?.path || 'an incumbent'}`);
  assert.ok(live[0].payload, `earlier live Phase 4 claim ${live[0].path} is still publishing`);
  assert.equal(live[0].payload.token, lock.token,
    `Phase 4 release claim lost arbitration to pid ${live[0].payload.pid}`);
  return lock;
}

export async function assertPhase4ReleaseClaim(lock){
  assert.ok(lock?.path && lock?.token && lock?.claimDirectory, 'release claim is required');
  const processProbe = lock.processProbe || probeProcessIdentity;
  const current = JSON.parse(await readFile(path.join(lock.path, 'payload.json'), 'utf8'));
  assert.equal(current.token, lock.token, 'owned Phase 4 release claim token changed');
  assert.equal(claimProcessIsLive(current, processProbe), true,
    'owned Phase 4 release claim process identity is not provably live');
  await assertNoUnknownPendingClaims(lock.claimDirectory, processProbe);
  const live = await readClaims(lock.claimDirectory, processProbe);
  assert.ok(live.length > 0, 'no live Phase 4 release claims');
  const unknowable = live.find(claim => claim.probeState === UNKNOWN);
  assert.equal(unknowable, undefined,
    `Phase 4 release claim liveness is unknown for ${unknowable?.path || 'an incumbent'}`);
  assert.ok(live[0].payload, `earlier live Phase 4 claim ${live[0].path} is still publishing`);
  assert.equal(live[0].payload.token, lock.token,
    `Phase 4 release claim lost arbitration to pid ${live[0].payload.pid}`);
  return lock;
}

export async function acquirePhase4ReleaseLock({
  claimDirectory,
  marker,
  settleMs = 75,
  beforePublish = null,
  processProbe = probeProcessIdentity,
}){
  assert.match(marker, /^[A-Za-z0-9_-]{8,160}$/, 'release claim marker');
  assert.ok(Number.isSafeInteger(settleMs) && settleMs >= 0 && settleMs <= 5_000, 'release claim settleMs');
  if(beforePublish !== null) assert.equal(typeof beforePublish, 'function', 'beforePublish hook');
  assert.equal(typeof processProbe, 'function', 'processProbe');
  await mkdir(claimDirectory, { recursive: true });
  // Startup prunes only identities proven dead. UNKNOWN claims and pending
  // publishers are retained and block acquisition fail-closed.
  await removeProvenDeadPendingClaims({ claimDirectory, processProbe });
  await removeProvenDeadPublishedClaims({ claimDirectory, processProbe });
  await assertNoUnknownPendingClaims(claimDirectory, processProbe);
  const self = runProcessProbe(processProbe, process.pid);
  assert.equal(self.state, LIVE, 'cannot prove release claimant process is live');
  const processStart = self.processStart;
  assert.equal(typeof processStart, 'string', 'cannot establish release claimant process start identity');
  const token = `${marker}-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
  const payload = { version: 1, token, marker, pid: process.pid, processStart, createdAt: Date.now() };
  const { claimPath, publishedPayload } = await publishClaim(claimDirectory, payload, beforePublish);
  const lock = { path: claimPath, claimDirectory, token, payload: publishedPayload, processProbe };
  try {
    if(settleMs) await sleep(settleMs);
    await assertPhase4ReleaseClaim(lock);
    return lock;
  } catch(error){
    // A losing contender removes only its own immutable claim directory.
    await releasePhase4ReleaseLock(lock).catch(() => {});
    throw new Error(`Phase 4 release lock is held by another live claimant: ${error.message}`, { cause: error });
  }
}

export async function releasePhase4ReleaseLock(lock){
  if(!lock) return;
  let current;
  try { current = JSON.parse(await readFile(path.join(lock.path, 'payload.json'), 'utf8')); }
  catch(error){
    if(error?.code === 'ENOENT') throw new Error('owned Phase 4 release claim disappeared before release');
    throw error;
  }
  if(current.token !== lock.token) throw new Error('refusing to release another Phase 4 claim');
  await rm(lock.path, { recursive: true, force: false });
  await fsyncDirectory(lock.claimDirectory);
}

/** Outer watchdog cleanup: remove only unique dead claims with sampled PIDs. */
export async function removeExactDeadPhase4Claims({
  claimDirectory,
  ownedPids,
  processProbe = probeProcessIdentity,
}){
  const removed = await removeProvenDeadPublishedClaims({ claimDirectory, ownedPids, processProbe });
  removed.push(...await removeProvenDeadPendingClaims({ claimDirectory, ownedPids, processProbe }));
  if(removed.length) await fsyncDirectory(claimDirectory);
  return removed;
}
