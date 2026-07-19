/* PAPER WINGS - dependency-injected, failure-contained campaign persistence. */
import { CAMPAIGN_STATE_VERSION, createCampaignState, mergeCampaignStates, restoreCampaignState } from './campaign.js';
import { WING_MISSIONS } from './missions.js';

export const PROGRESS_STORE_VERSION = 1;
export const WINGS_PROGRESS_KEY = `playforge:wings:campaign:v${PROGRESS_STORE_VERSION}`;

function errorInfo(error){
  let name = 'Error';
  let message = 'storage operation failed';
  try { if(typeof error?.name === 'string' && error.name) name = error.name; }
  catch {}
  try { if(typeof error?.message === 'string' && error.message) message = error.message; else if(error !== undefined) message = String(error); }
  catch {}
  return { name, message };
}

function callStorage(storage, method, args){
  try {
    const operation = storage?.[method];
    if(typeof operation !== 'function') return { ok: false, code: 'unavailable', error: null };
    return { ok: true, value: operation.apply(storage, args), error: null };
  } catch(error){
    return { ok: false, code: `${method}-failed`, error: errorInfo(error) };
  }
}

function safeCampaign(value, catalog, fallback = null){
  try { return restoreCampaignState(value, catalog); }
  catch { return fallback || createCampaignState(catalog); }
}

function decodeProgress(raw, catalog){
  if(typeof raw !== 'string') return { ok: false, code: 'malformed', error: null };
  let payload;
  try { payload = JSON.parse(raw); }
  catch(error){ return { ok: false, code: 'malformed', error: errorInfo(error) }; }
  if(!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, code: 'malformed', error: null };

  let campaignPayload;
  let migrated = false;
  if(Object.hasOwn(payload, 'storeVersion')){
    if(!Number.isInteger(payload.storeVersion) || payload.storeVersion !== PROGRESS_STORE_VERSION){
      return { ok: false, code: 'unsupported-version', error: null };
    }
    if(!payload.campaign || typeof payload.campaign !== 'object') return { ok: false, code: 'malformed', error: null };
    campaignPayload = payload.campaign;
  } else if(Number.isInteger(payload.version)){
    campaignPayload = payload;
    migrated = true;
  } else {
    return { ok: false, code: 'malformed', error: null };
  }

  try {
    const state = restoreCampaignState(campaignPayload, catalog);
    return { ok: true, code: migrated ? 'legacy-loaded' : 'loaded', state, error: null };
  } catch(error){
    return {
      ok: false,
      code: campaignPayload.version > CAMPAIGN_STATE_VERSION ? 'unsupported-campaign-version' : 'malformed',
      error: errorInfo(error),
    };
  }
}

function quotaCode(error){
  return error?.name === 'QuotaExceededError' || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    ? 'quota-exceeded'
    : 'write-failed';
}

function immutableResult(result){
  return Object.freeze({
    ...result,
    error: result.error ? Object.freeze({ ...result.error }) : null,
  });
}

export function createCampaignProgressStore({
  storage = null,
  key = WINGS_PROGRESS_KEY,
  catalog = WING_MISSIONS,
  initialState = null,
} = {}){
  if(typeof key !== 'string' || key.length === 0) throw new TypeError('progress key must be a non-empty string');
  let memory = safeCampaign(initialState, catalog);

  function readStored(){
    const read = callStorage(storage, 'getItem', [key]);
    if(!read.ok){
      return {
        ok: false,
        code: read.code === 'unavailable' ? 'unavailable' : 'read-failed',
        error: read.error,
      };
    }
    if(read.value === null || read.value === undefined) return { ok: true, code: 'empty', state: null, error: null };
    return decodeProgress(read.value, catalog);
  }

  function load(fallback = memory){
    const base = mergeCampaignStates(memory, safeCampaign(fallback, catalog, memory), catalog);
    const stored = readStored();
    if(stored.ok && stored.state) memory = mergeCampaignStates(base, stored.state, catalog);
    else memory = base;
    return immutableResult({
      ok: stored.ok,
      code: stored.code,
      state: snapshot(),
      error: stored.error,
    });
  }

  function save(candidate){
    let normalized;
    try { normalized = restoreCampaignState(candidate, catalog); }
    catch(error){
      return immutableResult({ ok: false, code: 'invalid-campaign', state: snapshot(), error: errorInfo(error) });
    }
    memory = mergeCampaignStates(memory, normalized, catalog);
    const stored = readStored();
    if(stored.ok && stored.state) memory = mergeCampaignStates(memory, stored.state, catalog);
    if(!stored.ok && ['unavailable', 'read-failed', 'unsupported-version', 'unsupported-campaign-version'].includes(stored.code)){
      return immutableResult({ ok: false, code: stored.code, state: snapshot(), error: stored.error });
    }

    const envelope = JSON.stringify({
      storeVersion: PROGRESS_STORE_VERSION,
      campaignVersion: CAMPAIGN_STATE_VERSION,
      campaign: memory,
    });
    const write = callStorage(storage, 'setItem', [key, envelope]);
    if(!write.ok){
      const code = write.code === 'unavailable' ? 'unavailable' : quotaCode(write.error);
      return immutableResult({ ok: false, code, state: snapshot(), error: write.error });
    }
    return immutableResult({
      ok: true,
      code: 'saved',
      state: snapshot(),
      recoveredFrom: stored.ok ? null : stored.code,
      error: null,
    });
  }

  function clear(){
    const removed = callStorage(storage, 'removeItem', [key]);
    if(!removed.ok){
      return immutableResult({
        ok: false,
        code: removed.code === 'unavailable' ? 'unavailable' : 'remove-failed',
        state: snapshot(),
        error: removed.error,
      });
    }
    memory = createCampaignState(catalog);
    return immutableResult({ ok: true, code: 'cleared', state: snapshot(), error: null });
  }

  function snapshot(){
    return restoreCampaignState(memory, catalog);
  }

  return Object.freeze({
    key,
    load,
    restore: load,
    save,
    clear,
    remove: clear,
    snapshot,
  });
}
