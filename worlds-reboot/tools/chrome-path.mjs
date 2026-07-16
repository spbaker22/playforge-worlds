import fs from 'node:fs';
import path from 'node:path';

function playwrightCandidates(){
  const root = '/opt/pw-browsers';
  try {
    return fs.readdirSync(root)
      .filter(name => name.startsWith('chromium-'))
      .flatMap(name => [
        path.join(root, name, 'chrome-linux', 'chrome'),
        path.join(root, name, 'chrome-linux64', 'chrome'),
        path.join(root, name, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(root, name, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ]);
  } catch { return []; }
}

/** Resolve Chrome/Chromium without assuming one OS or install channel. */
export function resolveChromeExecutable({ env = process.env, bundledPath = null, extraCandidates = [] } = {}){
  const candidates = [
    env.PUPPETEER_EXECUTABLE_PATH,
    env.CHROME_PATH,
    ...extraCandidates,
    bundledPath,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...playwrightCandidates(),
  ].filter(Boolean);

  const executable = candidates.find(candidate => {
    try {
      if(!fs.statSync(candidate).isFile()) return false;
      if(process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch { return false; }
  });
  if(executable) return executable;
  throw new Error('No Chrome/Chromium executable found. Set PUPPETEER_EXECUTABLE_PATH or CHROME_PATH.');
}
