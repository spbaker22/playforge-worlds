import {
  PREVIEW_DEFAULTS,
  normalizePreviewOptions,
  previewGameHref,
  readPreviewOptions,
  setPreviewOption,
  writePreviewOptions,
} from './options.js';

let state = readPreviewOptions();
const status = document.getElementById('savedStatus');

function valueAt(path){
  const [group, key] = path.split('.');
  return key ? state[group][key] : state[group];
}

function render(){
  for(const group of document.querySelectorAll('[data-option]')){
    const selected = String(valueAt(group.dataset.option));
    for(const button of group.querySelectorAll('button[data-value]')){
      const active = button.dataset.value === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }
  document.getElementById('practiceHole').classList.toggle('disabled', state.golf.format !== 'practice');
  document.getElementById('playGolf').href = previewGameHref('golf', state);
  document.getElementById('playRunner').href = previewGameHref('runner', state);
  document.getElementById('playAshfall').href = previewGameHref('ashfall', state);
  document.getElementById('playWings').href = previewGameHref('wings', state);
  document.getElementById('playTide').href = previewGameHref('tide', state);
}

function save(next){
  state = writePreviewOptions(next);
  render();
  status.textContent = 'SAVED';
  window.setTimeout(() => { status.textContent = 'OPTIONS SAVE ON THIS IPAD'; }, 900);
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-option] button[data-value]');
  if(!button) return;
  event.preventDefault();
  const path = button.closest('[data-option]').dataset.option;
  save(setPreviewOption(state, path, button.dataset.value));
});

document.getElementById('resetOptions').addEventListener('click', () => save(normalizePreviewOptions(PREVIEW_DEFAULTS)));
render();

window.__previewLauncher = {
  get options(){ return normalizePreviewOptions(state); },
  set(path, value){ save(setPreviewOption(state, path, value)); return normalizePreviewOptions(state); },
};
