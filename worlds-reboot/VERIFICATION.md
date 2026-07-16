# Playforge Preview 7 verification

Date: 2026-07-15  
Candidate: `preview-dist/family-preview-20260715-7`  
Verdict: **PASS for computer/iPad family testing; physical iPad approval pending**

## Verified scope

- The launcher and all five built games returned HTTP 200 locally and over the Mac's LAN address.
- The full built five-game browser/gameplay smoke passed with no page, console, request, or HTTP errors.
- All launcher routes and version-local Back links passed.
- Genuine touch paths and the shared MENU pause/resume behavior passed independently for Golf, Runner, Ashfall, Wings, and Tide. Active gestures are cancelled safely, stale releases are ignored, and resuming does not catch up paused simulation time.
- Focused game checks covered Golf close putting, second-shot lie preservation, the Hole 2 uphill guide, and hole progression; Runner cue timing, recovery, and Training/Relay paths; Ashfall contact/scoring and perimeter-wave counterplay; Wings exact 42 px control and race completion; and Tide scoring modes, fishing zones, and last-fish overtime.
- Compared with Preview 6, only `wings/index.html` changed. The launcher, Golf, Runner, Ashfall, and Tide remained byte-identical. Preview 6 is preserved locally.
- Protected official/reference artifacts remained byte-identical before and after the preview build.

This verification is automated/browser evidence. It does not prove real-finger feel, audio by ear, thermals, or sustained frame pacing on a physical iPad. Those remain the final family-test gate; no release promotion is implied.

## Preview 7 manifest

| File | SHA-256 |
|---|---|
| `index.html` | `8a20f2abbe26b841c1249b2e1ae37c9fb5e69004302f02aecd2e46a4b2193d8f` |
| `golf/index.html` | `0c292706754a3d5ef3d5b1b9d56f955bc30ae2632194bdb58584d910282b8ed9` |
| `runner/index.html` | `6166050a439f3c2a52a3f4bcc6c52d69cbe054fcff9a8f6be9808d0f069a3f65` |
| `ashfall/index.html` | `b7d92fbfebdf8d9eed372d1dfa66fa25e9b81f5a5196d0d5bd6a509e138d136a` |
| `wings/index.html` | `8a93276446ac92a12a877bf35958a20636ef0d35aed4e4f12d5399347c9e100b` |
| `tide/index.html` | `cf1478c94f0f15f58a5e65bb484038d11f129273a44cb090eb85e91dfbc8b40d` |

The authoritative machine-readable manifest is `preview-dist/family-preview-20260715-7/preview.json`.

## Protected artifact invariants

| Artifact | Expected SHA-256 |
|---|---|
| Runner `dist/index.html` and `gridlock-run-v1.html` | `009bdb89c804db27a09107ef7b36e371aa858e78615d7f71491d48d934ed6ca0` |
| Golf `dist/index.html` and `stackyard-golf-v1.html` | `cb4a1d5ca25de2a1f0d719fb033bb4b8ba312b386d9ac0065229b054d47f2c28` |
| Wings reference `dist/index.html` | `a35d7ee12261af6eb84d4d9046f5e49dee01bde89b87d77cc2f2714e6020cc4d` |
| Tide reference `dist/index.html` | `14d04d90ffc6ae2bb708233796335a52777d2e277dbc097292750ae991a80d31` |

## Reproduce the practical checks

From `worlds-reboot/`, serve the tree:

```bash
python3 -m http.server 8091 --bind 0.0.0.0
```

In another terminal:

```bash
node --test golf/src/*.test.js ashfall/src/*.test.js wings/src/*.test.js tide/src/*.test.js preview/options.test.js
npm run test:runner:unit
npm run test:runner:cue
node tools/preview-smoke.mjs --base=http://127.0.0.1:8091/preview-dist/family-preview-20260715-7/
for game in golf runner ashfall wings tide; do node tools/preview-menu-pause.browser.mjs --base=http://127.0.0.1:8091/preview-dist/family-preview-20260715-7/ --game="$game"; done
```

Detailed screenshots and transient reports live under `preview-evidence/` on the development Mac. They are reproducible generated evidence and are intentionally ignored by Git.

