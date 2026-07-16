# Playforge Worlds

Playforge is a browser-native collection of cinematic, touch-first games. The active project is [`worlds-reboot/`](worlds-reboot/), containing Stackyard Golf, Gridlock Run, Ashfall, Paper Wings, and Low Tide.

Repository: <https://github.com/spbaker22/playforge-worlds>

**New account or session:** start with [`NEW_ACCOUNT_HANDOFF.md`](NEW_ACCOUNT_HANDOFF.md). It is the authoritative product, architecture, safety, testing, iPad, and next-work handoff. The much older [`worlds-reboot/HANDOFF.md`](worlds-reboot/HANDOFF.md) is retained as historical context and contains obsolete executable-looking instructions.

## Current preview

The immutable family-test build is [`worlds-reboot/preview-dist/family-preview-20260715-7/`](worlds-reboot/preview-dist/family-preview-20260715-7/). Focused browser, gameplay, touch, routing, and shared-menu checks pass across all five games. Physical iPad play and approval are still pending, so this is a preview—not a promoted release.

Preview 6 and detailed screenshots/reports remain on the development Mac as local evidence. Generated evidence is intentionally not committed; the durable verification record is [`worlds-reboot/VERIFICATION.md`](worlds-reboot/VERIFICATION.md).

## Setup

Use Node 22.12 or newer. The locked Puppeteer dependency requires it for a supported fresh install.

```bash
git clone https://github.com/spbaker22/playforge-worlds.git
cd playforge-worlds/worlds-reboot
npm ci
```

## Build

Before any build, verify the canonical protected official/reference HTML hashes in [`NEW_ACCOUNT_HANDOFF.md`](NEW_ACCOUNT_HANDOFF.md#mandatory-integrity-preflight). The preview builder proves those files did not change during its run; it cannot detect an artifact that was already wrong beforehand.

Build all five games and the launcher into a new immutable preview ID:

```bash
PREVIEW_ID=
printf 'New unused preview ID: '
read -r PREVIEW_ID
node tools/build-preview.mjs --id="$PREVIEW_ID"
```

The builder refuses to overwrite an existing preview and verifies that the six protected official/reference HTML files do not change during the build. Never run a default per-game Vite build into Golf, Runner, Wings, or Tide: their default `dist/` paths contain protected artifacts. Use a development server, an explicitly disposable output directory, or the immutable preview builder.

## Test

Run the focused unit checks:

```bash
node --test golf/src/*.test.js ashfall/src/*.test.js wings/src/*.test.js tide/src/*.test.js preview/options.test.js
npm run test:runner:unit
npm run test:runner:cue
```

From the `worlds-reboot/` directory used above, serve the repository in one terminal:

```bash
python3 -m http.server 8091 --bind 0.0.0.0
```

Then open another terminal, change to the same `playforge-worlds/worlds-reboot` directory, and run the built five-game browser smoke:

```bash
node tools/preview-smoke.mjs --base=http://127.0.0.1:8091/preview-dist/family-preview-20260715-7/
```

For an iPad on the same Wi-Fi, replace `127.0.0.1` with the Mac address printed by:

```bash
ipconfig getifaddr en0
```

`npm run test:release` and `npm run test:runner:phase4` are authorization-bearing promotion gates. Do not use them for routine preview development or inspection.

The complete practical-check sequence, isolated touch/MENU tests, current game context, and physical iPad checklist are in [`NEW_ACCOUNT_HANDOFF.md`](NEW_ACCOUNT_HANDOFF.md).
