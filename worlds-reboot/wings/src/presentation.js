/* PAPER WINGS - immutable view-model normalization and accessible DOM rendering. */
import { getMissionDressing, MISSION_IDS } from './mission-dressing.js';

export const PRESENTATION_MODES = Object.freeze([
  'title', 'campaign', 'briefing', 'countdown',
  'flight', 'recovery', 'finish', 'fail', 'results',
]);

export const PRESENTATION_SCREEN_IDS = Object.freeze(['title', 'campaign', 'briefing', 'countdown', 'results']);

const HUD_MODES = new Set(['flight', 'recovery', 'finish', 'fail']);
const TERMINAL_MODES = new Set(['finish', 'fail']);
const MODE_ALIASES = Object.freeze({ 'mission-select': 'campaign', flying: 'flight', failed: 'fail', finished: 'finish' });

function deepFreeze(value){
  if(value && typeof value === 'object' && !Object.isFrozen(value)){
    for(const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const text = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback;
const integer = (value, fallback = 0) => Math.floor(finite(value, fallback));

export function normalizePresentationMode(value){
  const candidate = MODE_ALIASES[value] || value;
  return PRESENTATION_MODES.includes(candidate) ? candidate : 'title';
}

const SCREEN_STATE_BY_MODE = Object.freeze(Object.fromEntries(PRESENTATION_MODES.map(mode => [mode, deepFreeze({
  mode,
  activeScreen: PRESENTATION_SCREEN_IDS.includes(mode) ? mode : null,
  hud: HUD_MODES.has(mode),
  terminal: TERMINAL_MODES.has(mode),
})])));

export function presentationScreenState(mode){
  return SCREEN_STATE_BY_MODE[normalizePresentationMode(mode)];
}

export function formatPresentationTime(seconds){
  const safe = Math.max(0, finite(seconds));
  const minutes = Math.floor(safe / 60);
  const wholeSeconds = Math.floor(safe - minutes * 60);
  return `${minutes}:${String(wholeSeconds).padStart(2, '0')}`;
}

export function formatPresentationScore(value){
  const digits = String(Math.max(0, integer(value)));
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function normalizedMissionId(value){
  return MISSION_IDS.includes(value) ? value : MISSION_IDS[0];
}

function normalizedIds(value, fallback){
  const wanted = new Set(Array.isArray(value) ? value : fallback);
  return Object.freeze(MISSION_IDS.filter(id => wanted.has(id)));
}

function normalizedMissionStars(value){
  const source = value && typeof value === 'object' ? value : {};
  const stars = {};
  for(const id of MISSION_IDS) stars[id] = clamp(integer(source[id]), 0, 3);
  return deepFreeze(stars);
}

function normalizedChallenges(value, labels){
  const source = Array.isArray(value) ? value : [];
  return Object.freeze(labels.map((label, index) => {
    const candidate = source[index];
    if(typeof candidate === 'boolean') return Object.freeze({ label, complete: candidate });
    return Object.freeze({ label: text(candidate?.label, label), complete: candidate?.complete === true });
  }));
}

function energySegments(energy){
  const segments = [];
  for(let index = 0; index < 5; index += 1){
    const amount = clamp(energy - index * 20, 0, 20);
    segments.push(Object.freeze({ index, fill: amount / 20, state: amount >= 20 ? 'full' : amount > 0 ? 'partial' : 'empty' }));
  }
  return Object.freeze(segments);
}

export function createPresentationViewModel(input = {}){
  const mode = normalizePresentationMode(input.mode);
  const missionId = normalizedMissionId(input.missionId || input.mission?.id);
  const missionDressing = getMissionDressing(missionId);
  const objectiveTotal = Math.max(0, finite(input.objective?.total, 1));
  const objectiveCurrent = clamp(finite(input.objective?.current), 0, objectiveTotal || 0);
  const bossTotal = Math.max(0, finite(input.metric?.bossTotal));
  const bossCurrent = clamp(finite(input.metric?.bossCurrent), 0, bossTotal || 0);
  const energy = clamp(finite(input.energy, 100), 0, 100);
  const shield = clamp(integer(input.shield, 3), 0, 3);
  const combo = Math.max(1, finite(input.combo, 1));
  const unlockedMissionIds = normalizedIds(input.campaign?.unlockedMissionIds, [MISSION_IDS[0]]);
  const completedMissionIds = normalizedIds(input.campaign?.completedMissionIds, []);
  const selectedMissionId = normalizedMissionId(input.campaign?.selectedMissionId || missionId);
  const results = input.results || {};

  return deepFreeze({
    mode,
    screen: presentationScreenState(mode),
    mission: {
      id: missionId,
      name: text(input.mission?.name, missionDressing.name),
      shortName: text(input.mission?.shortName, missionDressing.shortName),
      kicker: text(input.mission?.kicker, missionDressing.briefing.kicker),
      headline: text(input.mission?.headline, missionDressing.briefing.headline),
      briefing: text(input.mission?.briefing, missionDressing.briefing.objective),
      controlTip: text(input.mission?.controlTip, missionDressing.briefing.controlTip),
      order: missionDressing.order,
    },
    objective: {
      label: text(input.objective?.label, missionDressing.briefing.objective),
      detail: text(input.objective?.detail, 'Stay on the wind line'),
      current: objectiveCurrent,
      total: objectiveTotal,
      progress: objectiveTotal > 0 ? objectiveCurrent / objectiveTotal : 0,
    },
    metric: {
      label: text(input.metric?.label, 'TIME'),
      value: text(input.metric?.value, formatPresentationTime(input.time)),
      bossLabel: text(input.metric?.bossLabel, 'SKYBREAKER'),
      bossCurrent,
      bossTotal,
      bossProgress: bossTotal > 0 ? bossCurrent / bossTotal : 0,
    },
    score: Math.max(0, integer(input.score)),
    combo,
    energy,
    energySegments: energySegments(energy),
    shield,
    shieldPips: Object.freeze([0, 1, 2].map(index => index < shield)),
    speed: Math.max(0, integer(input.speed)),
    position: text(input.position, '1 / 1'),
    nextGate: text(input.nextGate, 'THE NEEDLES'),
    action: {
      label: text(input.action?.label, 'BOOST'),
      hint: text(input.action?.hint, 'HOLD'),
      state: text(input.action?.state, 'ready'),
      enabled: input.action?.enabled !== false,
    },
    threat: {
      visible: input.threat?.visible === true,
      label: text(input.threat?.label, 'LIGHTNING INBOUND'),
      tone: ['warning', 'danger', 'safe'].includes(input.threat?.tone) ? input.threat.tone : 'warning',
    },
    stunt: {
      visible: input.stunt?.visible === true,
      label: text(input.stunt?.label, 'BARREL ROLL'),
      points: Math.max(0, integer(input.stunt?.points)),
    },
    status: {
      visible: input.status?.visible === true,
      label: text(input.status?.label, 'GATE CLEAR'),
    },
    countdown: {
      value: text(String(input.countdown?.value ?? '3'), '3'),
      label: text(input.countdown?.label, 'HOLD THE LINE'),
    },
    campaign: {
      selectedMissionId,
      unlockedMissionIds,
      completedMissionIds,
      totalStars: Math.max(0, integer(input.campaign?.totalStars)),
      missionStars: normalizedMissionStars(input.campaign?.missionStars),
    },
    results: {
      success: results.success !== false,
      kicker: text(results.kicker, 'MISSION COMPLETE'),
      headline: text(results.headline, 'Clean air.'),
      sub: text(results.sub, 'The ridge has another story to tell.'),
      rank: text(results.rank, 'A'),
      score: Math.max(0, integer(results.score, integer(input.score))),
      time: text(results.time, formatPresentationTime(input.time)),
      gates: text(results.gates, '0 / 0'),
      misses: Math.max(0, integer(results.misses)),
      challenges: normalizedChallenges(results.challenges, missionDressing.challenges),
      nextMissionId: MISSION_IDS.includes(results.nextMissionId) ? results.nextMissionId : null,
    },
  });
}

function setText(element, value){
  if(element && element.textContent !== String(value)) element.textContent = String(value);
}

function setHidden(element, hidden){
  if(!element) return;
  const next = Boolean(hidden);
  element.hidden = next;
  element.setAttribute('aria-hidden', String(next));
}

function setScreenActive(element, active){
  if(!element) return;
  const next = Boolean(active);
  if(!next && element.contains?.(element.ownerDocument?.activeElement)) element.ownerDocument.activeElement?.blur?.();
  element.hidden = !next;
  element.inert = !next;
  element.setAttribute('aria-hidden', String(!next));
  element.dataset.screenActive = String(next);
}

function setProgress(element, progress, current, total){
  if(!element) return;
  const percentage = `${Math.round(clamp(progress, 0, 1) * 100)}%`;
  element.style.setProperty('--progress', percentage);
  element.setAttribute('aria-valuemin', '0');
  element.setAttribute('aria-valuemax', String(total));
  element.setAttribute('aria-valuenow', String(current));
}

function missionStars(view, id){
  return clamp(integer(view.campaign.missionStars[id]), 0, 3);
}

function rootDocument(root){
  if(root?.getElementById) return root;
  if(root?.ownerDocument?.getElementById) return root.ownerDocument;
  throw new TypeError('createWingsPresentation requires a Document or document-owned root');
}

export function createWingsPresentation({ root = globalThis.document } = {}){
  const doc = rootDocument(root);
  const body = doc.body;
  if(!body) throw new TypeError('Paper Wings presentation requires a document body');
  const byId = id => doc.getElementById(id);
  const screens = Object.fromEntries(PRESENTATION_SCREEN_IDS.map(id => [id, byId(id)]));
  const refs = {
    hud: byId('hud'),
    terminal: byId('terminalFlag'),
    missionName: byId('missionName'),
    objectiveText: byId('objectiveText'),
    objectiveDetail: byId('objectiveDetail'),
    objectiveProgress: byId('objectiveProgress'),
    metricLabel: byId('missionMetricLabel'),
    metricValue: byId('missionMetricValue'),
    bossPanel: byId('bossPanel'),
    bossLabel: byId('bossLabel'),
    bossProgress: byId('bossProgress'),
    score: byId('scoreValue'),
    combo: byId('comboValue'),
    energyProgress: byId('energyProgress'),
    energyValue: byId('energyValue'),
    shieldValue: byId('shieldValue'),
    action: byId('actionButton'),
    actionLabel: byId('actionLabel'),
    actionHint: byId('actionHint'),
    threat: byId('threatCue'),
    threatLabel: byId('threatLabel'),
    stunt: byId('stuntCue'),
    stuntLabel: byId('stuntLabel'),
    stuntPoints: byId('stuntPoints'),
    status: byId('flightStatus'),
    countdownValue: byId('countValue'),
    countdownLabel: byId('countLabel'),
  };
  const energy = [...doc.querySelectorAll('[data-energy-segment]')];
  const shields = [...doc.querySelectorAll('[data-shield-pip]')];
  const missionButtons = [...doc.querySelectorAll('[data-mission-id]')];
  const challengeRows = [...doc.querySelectorAll('[data-result-challenge]')];
  let current = createPresentationViewModel();

  function renderCampaign(view){
    setText(byId('campaignStars'), view.campaign.totalStars);
    const selected = getMissionDressing(view.campaign.selectedMissionId);
    setText(byId('selectedMissionKicker'), selected.briefing.kicker);
    setText(byId('selectedMissionName'), selected.name);
    setText(byId('selectedMissionBrief'), selected.briefing.objective);
    for(const button of missionButtons){
      const id = button.dataset.missionId;
      const locked = !view.campaign.unlockedMissionIds.includes(id);
      const completed = view.campaign.completedMissionIds.includes(id);
      const chosen = id === view.campaign.selectedMissionId;
      button.disabled = locked;
      button.dataset.state = locked ? 'locked' : completed ? 'complete' : 'open';
      button.dataset.selected = String(chosen);
      button.setAttribute('aria-disabled', String(locked));
      button.setAttribute('aria-pressed', String(chosen));
      const stars = button.querySelector('[data-mission-stars]');
      setText(stars, locked ? 'LOCKED' : `${missionStars(view, id)} / 3`);
    }
  }

  function renderBriefing(view){
    setText(byId('briefKicker'), view.mission.kicker);
    setText(byId('briefTitle'), view.mission.headline);
    setText(byId('briefObjective'), view.mission.briefing);
    setText(byId('assistLine'), view.mission.controlTip);
  }

  function renderHud(view){
    setText(refs.missionName, view.mission.name);
    setText(byId('routeLabel'), view.mission.shortName);
    setText(refs.objectiveText, view.objective.label);
    setText(refs.objectiveDetail, view.objective.detail);
    setProgress(refs.objectiveProgress, view.objective.progress, view.objective.current, view.objective.total);
    setText(refs.metricLabel, view.metric.label);
    setText(refs.metricValue, view.metric.value);
    setText(refs.bossLabel, view.metric.bossLabel);
    setProgress(refs.bossProgress, view.metric.bossProgress, view.metric.bossCurrent, view.metric.bossTotal);
    setHidden(refs.bossPanel, view.metric.bossTotal <= 0);
    setText(refs.score, formatPresentationScore(view.score));
    setText(refs.combo, `x${view.combo.toFixed(view.combo % 1 ? 1 : 0)}`);
    refs.combo?.toggleAttribute('data-hot', view.combo >= 3);
    setText(byId('gateName'), view.nextGate);
    setText(byId('positionValue'), view.position);
    setText(byId('speedValue'), view.speed);

    const roundedEnergy = Math.round(view.energy);
    setText(refs.energyValue, `${roundedEnergy}%`);
    setProgress(refs.energyProgress, view.energy / 100, view.energy, 100);
    refs.energyProgress?.setAttribute('aria-valuetext', `${roundedEnergy} percent wind energy remaining`);
    setText(refs.shieldValue, `${view.shield} / 3`);
    for(let index = 0; index < energy.length; index += 1){
      const segment = view.energySegments[index];
      if(!segment) continue;
      energy[index].dataset.state = segment.state;
      energy[index].style.setProperty('--segment-fill', `${Math.round(segment.fill * 100)}%`);
    }
    for(let index = 0; index < shields.length; index += 1){
      const active = view.shieldPips[index] === true;
      shields[index].dataset.state = active ? 'ready' : 'spent';
      shields[index].setAttribute('aria-label', `Shield ${index + 1}: ${active ? 'ready' : 'spent'}`);
    }
    refs.action.disabled = !view.action.enabled;
    refs.action.dataset.state = view.action.state;
    refs.action.setAttribute('aria-label', `${view.action.label}. ${view.action.hint}`);
    setText(refs.actionLabel, view.action.label);
    setText(refs.actionHint, view.action.hint);
    refs.threat.dataset.tone = view.threat.tone;
    setText(refs.threatLabel, view.threat.label);
    setHidden(refs.threat, !view.threat.visible);
    setText(refs.stuntLabel, view.stunt.label);
    setText(refs.stuntPoints, `+${formatPresentationScore(view.stunt.points)}`);
    setHidden(refs.stunt, !view.stunt.visible);
    setText(refs.status, view.status.label);
    refs.status.classList.toggle('show', view.status.visible);
  }

  function renderResults(view){
    setText(byId('resultKicker'), view.results.kicker);
    setText(byId('resultHeadline'), view.results.headline);
    setText(byId('resultSub'), view.results.sub);
    setText(byId('resultRank'), view.results.rank);
    setText(byId('resultScore'), formatPresentationScore(view.results.score));
    setText(byId('resultTime'), view.results.time);
    setText(byId('resultGates'), view.results.gates);
    setText(byId('resultMisses'), view.results.misses);
    challengeRows.forEach((row, index) => {
      const challenge = view.results.challenges[index];
      if(!challenge) return;
      row.dataset.complete = String(challenge.complete);
      setText(row.querySelector('[data-challenge-label]'), challenge.label);
      setText(row.querySelector('[data-challenge-state]'), challenge.complete ? 'STAMPED' : 'OPEN');
    });
    const next = byId('nextMissionButton');
    if(next){
      next.disabled = !view.results.nextMissionId;
      next.dataset.missionId = view.results.nextMissionId || '';
      setHidden(next, !view.results.nextMissionId);
    }
  }

  function render(input){
    const view = createPresentationViewModel(input);
    current = view;
    body.dataset.mode = view.mode;
    for(const id of PRESENTATION_SCREEN_IDS) setScreenActive(screens[id], view.screen.activeScreen === id);
    setHidden(refs.hud, !view.screen.hud);
    setHidden(refs.terminal, !view.screen.terminal);
    setText(byId('terminalText'), view.mode === 'fail' ? 'WIND OUT' : 'ROUTE CLEAR');
    setText(refs.countdownValue, view.countdown.value);
    setText(refs.countdownLabel, view.countdown.label);
    renderCampaign(view);
    renderBriefing(view);
    renderHud(view);
    renderResults(view);
    return view;
  }

  function setMode(mode){
    return render({ ...current, mode });
  }

  function diagnostics(){
    return Object.freeze({
      mode: current.mode,
      activeScreen: current.screen.activeScreen,
      hudVisible: current.screen.hud,
      missionId: current.mission.id,
      energySegments: energy.length,
      shieldPips: shields.length,
      missionButtons: missionButtons.length,
    });
  }

  return Object.freeze({ render, setMode, diagnostics, get snapshot(){ return current; } });
}

export const createPresentationRenderer = createWingsPresentation;
