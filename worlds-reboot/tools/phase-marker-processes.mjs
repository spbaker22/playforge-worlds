import assert from 'node:assert/strict';
import {
  bindProcessSnapshotIdentity,
  captureProcessTableSnapshotSync,
  processSnapshotCommandUnavailable,
  processSnapshotMarkerMatches,
  signalExactProcessSnapshotIdentity,
} from './runner.phase4.lock.mjs';

export function exactMarkerProcessRecords(marker, {
  excludePids = new Set([process.pid]),
  includeZombies = false,
  snapshotProbe = captureProcessTableSnapshotSync,
} = {}){
  assert.ok(typeof marker === 'string' && marker.length > 0, 'exact marker process marker');
  assert.equal(typeof includeZombies, 'boolean', 'exact marker process zombie option');
  const snapshot = snapshotProbe();
  const records = processSnapshotMarkerMatches(snapshot, marker)
    .filter(record => (includeZombies || !record.state.startsWith('Z')) && !excludePids.has(record.pid));
  return { snapshot, records };
}

export function signalExactMarkerProcesses(marker, signal, options = {}){
  const { snapshot, records } = exactMarkerProcessRecords(marker, options);
  const signalIdentity = options.signalIdentity || signalExactProcessSnapshotIdentity;
  const errors = [];
  const identities = [];
  const results = [];
  for(const record of records){
    if(processSnapshotCommandUnavailable(record)){
      errors.push(new Error(`marker PID ${record.pid} has argv unavailable; ${signal} is not authorized`));
      continue;
    }
    try { identities.push(bindProcessSnapshotIdentity(snapshot, record)); }
    catch(error){ errors.push(error); }
  }
  for(const identity of identities){
    try {
      const result = signalIdentity(identity, signal);
      results.push({ pid: identity.pid, ...result });
      if(result.state === 'UNKNOWN'){
        errors.push(new Error(`marker PID ${identity.pid} exact ${signal} was indeterminate: ${result.reason}`));
      }
    } catch(error){
      errors.push(error);
    }
  }
  return { ok: errors.length === 0, errors, identities, records, results };
}
