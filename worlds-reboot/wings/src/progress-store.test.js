import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMPAIGN_STATE_VERSION, applyMissionResult, createCampaignState } from './campaign.js';
import { PROGRESS_STORE_VERSION, WINGS_PROGRESS_KEY, createCampaignProgressStore } from './progress-store.js';

function createMemoryStorage(){
  const values = new Map();
  return {
    values,
    getItem(key){ return values.has(key) ? values.get(key) : null; },
    setItem(key, value){ values.set(key, String(value)); },
    removeItem(key){ values.delete(key); },
  };
}

function completedFlightSchool({ score = 3000, stars = 3, timeMs = 65000, combo = 8 } = {}){
  return applyMissionResult(createCampaignState(), {
    missionId: 'flight-school',
    completed: true,
    score,
    stars,
    timeMs,
    combo,
  });
}

test('versioned adapter saves and restores through injected storage only', () => {
  const storage = createMemoryStorage();
  const writer = createCampaignProgressStore({ storage });
  const progress = completedFlightSchool();
  const saved = writer.save(progress);
  assert.equal(saved.ok, true);
  assert.equal(saved.code, 'saved');
  assert.equal(writer.key, WINGS_PROGRESS_KEY);

  const envelope = JSON.parse(storage.values.get(WINGS_PROGRESS_KEY));
  assert.equal(envelope.storeVersion, PROGRESS_STORE_VERSION);
  assert.equal(envelope.campaignVersion, CAMPAIGN_STATE_VERSION);
  assert.deepEqual(envelope.campaign.completedMissionIds, ['flight-school']);

  const reader = createCampaignProgressStore({ storage });
  const loaded = reader.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.code, 'loaded');
  assert.equal(loaded.state.missions['flight-school'].bestScore, 3000);
  assert.ok(loaded.state.unlockedMissionIds.includes('ridge-race'));
});

test('restore and save merge weaker payloads monotonically', () => {
  const storage = createMemoryStorage();
  const store = createCampaignProgressStore({ storage });
  const strong = completedFlightSchool({ score: 4200, stars: 3, timeMs: 58000, combo: 12 });
  const weak = completedFlightSchool({ score: 800, stars: 1, timeMs: 99000, combo: 2 });
  store.save(strong);
  const saved = store.save(weak);
  const record = saved.state.missions['flight-school'];
  assert.deepEqual(
    { score: record.bestScore, stars: record.bestStars, time: record.bestTimeMs, combo: record.bestCombo, completed: record.completed },
    { score: 4200, stars: 3, time: 58000, combo: 12, completed: true },
  );
  const disk = JSON.parse(storage.values.get(WINGS_PROGRESS_KEY)).campaign;
  assert.equal(disk.missions['flight-school'].bestScore, 4200);

  saved.state.missions['flight-school'].bestScore = 0;
  assert.equal(store.snapshot().missions['flight-school'].bestScore, 4200, 'returned state must not alias adapter memory');
});

test('malformed, hostile, and unsupported payloads fail closed to fallback progress', () => {
  const fallback = completedFlightSchool({ score: 2500 });
  for(const [raw, code] of [
    ['{broken', 'malformed'],
    ['null', 'malformed'],
    [JSON.stringify({ storeVersion: PROGRESS_STORE_VERSION + 1, campaign: fallback }), 'unsupported-version'],
    [JSON.stringify({ storeVersion: PROGRESS_STORE_VERSION, campaign: { version: CAMPAIGN_STATE_VERSION + 1 } }), 'unsupported-campaign-version'],
  ]){
    const storage = createMemoryStorage();
    storage.values.set(WINGS_PROGRESS_KEY, raw);
    const loaded = createCampaignProgressStore({ storage }).load(fallback);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.code, code);
    assert.equal(loaded.state.missions['flight-school'].bestScore, 2500);
  }

  const hostile = new Proxy({}, { get(){ throw new Error('blocked getter'); } });
  const read = createCampaignProgressStore({ storage: hostile, initialState: fallback }).load();
  assert.equal(read.ok, false);
  assert.equal(read.code, 'read-failed');
  assert.equal(read.error.message, 'blocked getter');
  assert.equal(read.state.missions['flight-school'].bestScore, 2500);
});

test('quota and unavailable storage retain monotonic in-memory progress', () => {
  const quotaError = new Error('full');
  quotaError.name = 'QuotaExceededError';
  const quotaStorage = {
    getItem(){ return null; },
    setItem(){ throw quotaError; },
    removeItem(){ throw new Error('remove blocked'); },
  };
  const store = createCampaignProgressStore({ storage: quotaStorage });
  const failed = store.save(completedFlightSchool({ score: 3600 }));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'quota-exceeded');
  assert.equal(failed.error.name, 'QuotaExceededError');
  assert.equal(store.snapshot().missions['flight-school'].bestScore, 3600);
  const remove = store.clear();
  assert.equal(remove.ok, false);
  assert.equal(remove.code, 'remove-failed');
  assert.equal(remove.state.missions['flight-school'].bestScore, 3600);

  const unavailable = createCampaignProgressStore();
  assert.equal(unavailable.load().code, 'unavailable');
  const unsaved = unavailable.save(completedFlightSchool({ score: 1900 }));
  assert.equal(unsaved.code, 'unavailable');
  assert.equal(unavailable.snapshot().missions['flight-school'].bestScore, 1900);
});

test('save refuses to overwrite progress it cannot safely read or understand', () => {
  let writes = 0;
  const unreadable = {
    getItem(){ throw new Error('read denied'); },
    setItem(){ writes += 1; },
    removeItem(){},
  };
  const readFailed = createCampaignProgressStore({ storage: unreadable }).save(completedFlightSchool());
  assert.equal(readFailed.code, 'read-failed');
  assert.equal(writes, 0);

  const future = createMemoryStorage();
  future.values.set(WINGS_PROGRESS_KEY, JSON.stringify({ storeVersion: PROGRESS_STORE_VERSION + 1, campaign: completedFlightSchool() }));
  const before = future.values.get(WINGS_PROGRESS_KEY);
  const unsupported = createCampaignProgressStore({ storage: future }).save(completedFlightSchool({ score: 5000 }));
  assert.equal(unsupported.code, 'unsupported-version');
  assert.equal(future.values.get(WINGS_PROGRESS_KEY), before);
});

test('clear resets progress only after injected remove succeeds', () => {
  const storage = createMemoryStorage();
  const store = createCampaignProgressStore({ storage });
  store.save(completedFlightSchool());
  const cleared = store.clear();
  assert.equal(cleared.ok, true);
  assert.equal(cleared.code, 'cleared');
  assert.equal(storage.values.has(WINGS_PROGRESS_KEY), false);
  assert.deepEqual(cleared.state.completedMissionIds, []);
  assert.deepEqual(cleared.state.unlockedMissionIds, ['flight-school']);
});

test('legacy raw campaign JSON is accepted and normalized', () => {
  const storage = createMemoryStorage();
  storage.values.set(WINGS_PROGRESS_KEY, JSON.stringify(completedFlightSchool({ score: 2800 })));
  const loaded = createCampaignProgressStore({ storage }).load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.code, 'legacy-loaded');
  assert.equal(loaded.state.missions['flight-school'].bestScore, 2800);
});
