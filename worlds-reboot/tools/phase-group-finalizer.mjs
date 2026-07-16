import assert from 'node:assert/strict';
import { inspectCapturedProcessGroup } from './phase-process-cleanup.mjs';
import { signalCapturedGatedNodeGroup } from './phase-isolated-node.mjs';

const STATES = new Set(['LIVE', 'PROVEN_DEAD', 'UNKNOWN']);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function validateResult(result, label){
  assert.ok(result && STATES.has(result.state), `${label} returned an invalid process-group state`);
  return result;
}

/**
 * Finalize one already-captured gated process group without ever signalling an
 * UNKNOWN numerical PGID. Observation/signal failures are retained while later
 * fresh LIVE observations still receive cleanup. The first PROVEN_DEAD result
 * is copied and permanently latched, so numerical PGID reuse can never revive
 * signalling authority.
 */
export async function finalizeCapturedGatedProcessGroup(owned, {
  label = 'captured process group',
  inspectGroup = null,
  signalGroup = null,
  priorExactMemberIdentities = [],
  wait = delay,
  now = Date.now,
  platform = process.platform,
  pollMs = 25,
  termGraceMs = 750,
  killGraceMs = 2_000,
} = {}){
  assert.ok(owned?.identity, `${label} identity`);
  assert.notEqual(platform, 'win32',
    `${label} finalization requires POSIX process-group isolation; win32 is unsupported`);
  assert.ok(Array.isArray(priorExactMemberIdentities),
    `${label} prior exact member identities`);
  if(inspectGroup === null){
    inspectGroup = identity => inspectCapturedProcessGroup(identity, {
      priorExactMemberIdentities,
    });
  }
  if(signalGroup === null){
    signalGroup = (capture, signal) => signalCapturedGatedNodeGroup(capture, signal, {
      priorExactMemberIdentities,
    });
  }
  assert.equal(typeof inspectGroup, 'function', `${label} inspector`);
  assert.equal(typeof signalGroup, 'function', `${label} signaler`);
  assert.equal(typeof wait, 'function', `${label} waiter`);
  assert.equal(typeof now, 'function', `${label} clock`);
  for(const [name, value] of Object.entries({ pollMs, termGraceMs, killGraceMs })){
    assert.ok(Number.isFinite(value) && value >= (name === 'pollMs' ? 1 : 0),
      `${label} ${name}`);
  }

  const observations = [];
  const signals = [];
  const errors = [];
  const unknowns = new Set();
  let provenDead = null;
  const latchProvenDead = result => {
    if(result?.state === 'PROVEN_DEAD' && provenDead === null){
      provenDead = Object.freeze({ ...result });
    }
    return provenDead || result;
  };
  const rememberError = error => errors.push(error instanceof Error ? error : new Error(String(error)));
  const rememberUnknown = (stage, result) => {
    const key = `${stage}:${result?.reason || 'unknown'}`;
    if(unknowns.has(key)) return;
    unknowns.add(key);
    rememberError(new Error(`${label} ${stage} was UNKNOWN: ${result?.reason || 'unknown'}`));
  };
  const inspect = stage => {
    if(provenDead){
      observations.push(Object.freeze({ stage, result: provenDead, latched: true }));
      return provenDead;
    }
    let result;
    try { result = validateResult(inspectGroup(owned.identity), `${label} ${stage}`); }
    catch(error){
      result = { state: 'UNKNOWN', reason: 'inspection-threw', error };
      rememberError(new Error(`${label} ${stage} inspection failed: ${error?.message || error}`, { cause: error }));
    }
    result = latchProvenDead(result);
    observations.push(Object.freeze({ stage, result }));
    if(result.state === 'UNKNOWN') rememberUnknown(stage, result);
    return result;
  };
  const signal = (requestedSignal, stage) => {
    if(provenDead) return provenDead;
    let result;
    try { result = validateResult(signalGroup(owned, requestedSignal), `${label} ${stage}`); }
    catch(error){
      result = { state: 'UNKNOWN', signalled: false, reason: 'signal-threw', error };
      rememberError(new Error(`${label} ${stage} failed: ${error?.message || error}`, { cause: error }));
    }
    result = latchProvenDead(result);
    signals.push(Object.freeze({ signal: requestedSignal, stage, result }));
    if(result.state === 'UNKNOWN') rememberUnknown(stage, result);
    return result;
  };
  const pollUntil = async (deadline, stage) => {
    let current = inspect(`${stage}:initial`);
    while(current.state !== 'PROVEN_DEAD' && now() < deadline){
      await wait(Math.min(pollMs, Math.max(0, deadline - now())));
      current = inspect(`${stage}:poll`);
    }
    return current;
  };

  let current = inspect('initial-proof');
  if(current.state === 'LIVE') signal('SIGTERM', 'SIGTERM');
  current = await pollUntil(now() + termGraceMs, 'after-SIGTERM');

  // A prior UNKNOWN never authorizes a signal. A fresh LIVE observation does.
  if(current.state === 'LIVE') signal('SIGKILL', 'SIGKILL');
  current = await pollUntil(now() + killGraceMs, 'after-SIGKILL');
  const final = inspect('final-proof');
  if(final.state !== 'PROVEN_DEAD'){
    rememberError(new Error(`${label} final proof ended ${final.state}: ${final.reason || 'live members remain'}`));
  }

  const report = Object.freeze({
    ok: errors.length === 0 && final.state === 'PROVEN_DEAD',
    state: final.state,
    initial: observations[0]?.result || null,
    final,
    observations: Object.freeze(observations),
    signals: Object.freeze(signals),
    errors: Object.freeze(errors),
  });
  if(!report.ok){
    const error = new AggregateError(errors, `${label} cleanup was incomplete`);
    error.report = report;
    throw error;
  }
  return report;
}
