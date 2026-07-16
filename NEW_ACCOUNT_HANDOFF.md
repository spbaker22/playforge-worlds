# Playforge Worlds — authoritative new-account handoff

Last reconciled: 2026-07-15 (America/Phoenix)

Repository: <https://github.com/spbaker22/playforge-worlds>

Default branch: `main`

Active project: `worlds-reboot/`

This is the first document a new account or session should read. It is the
operational authority for the current Playforge state. It deliberately replaces
the executable-looking setup, build, status, and release instructions in
[`worlds-reboot/HANDOFF.md`](worlds-reboot/HANDOFF.md). That older document is
retained only as a historical record of design work and release-safety work.

## Read this first

The current deliverable is an isolated, immutable five-game family-test build:

`worlds-reboot/preview-dist/family-preview-20260715-7/`

Preview 7 has passed focused unit tests and practical built-browser checks for
all five games. It has **not** yet been physically approved on an iPad. The next
product step is a real family playtest on the iPad, followed by narrowly scoped
tuning based on observed behavior. It is not a production release, and none of
the protected official/reference artifacts have been promoted to Preview 7.

Use this exact status language:

> Preview 7 is automated/browser-verified and ready for physical iPad family
> testing. Physical device approval and production promotion are still pending.

Do not describe it as shipped, iPad-approved, production-ready, or promoted.

## Executive state

| Area | Current truth |
|---|---|
| Product | Five touch-first browser games in one launcher |
| Candidate | `family-preview-20260715-7` |
| Games | Stackyard Golf, Gridlock Run, Ashfall, Paper Wings, Low Tide |
| Automated status | 101 focused unit checks pass; built five-game browser and isolated touch/MENU checks pass |
| Device status | Real iPad playtest still required |
| Source status | All five current game sources and shared runtime are committed |
| Official artifacts | Intentionally unchanged from the older protected generation |
| Release status | No Preview 7 production promotion was authorized or performed |
| Next decision | Accept/tune each game from physical iPad evidence, then decide whether to expand or promote |

## The user's goal and the operating decision

The project began with severe playability problems on a real iPad:

- Golf's finger aim wandered, spun, and drew circles; second shots could return
  to the first lie; post-hole holds and transitions were unreliable.
- Runner could loop its title/countdown, keep the title over gameplay, fall after
  roughly five seconds, and restart instead of providing a playable run.
- Golf's visual finish looked promising, while Runner's art, framing, and hero
  felt materially weaker.
- Later desktop feedback said Golf was smoother, but very short putts were still
  difficult and the Hole 2 uphill guide could clip or disappear into terrain.

An extended effort then went too far into hardening an old release harness
instead of getting a practical build back onto the iPad. The user explicitly
reset the strategy:

> Isolate the actual game changes, create a separate preview build, run only
> practical gameplay/browser checks, and put that preview on the iPad for real
> testing. Apply the same foundation to every game, with variety and options.

That decision governs the current work:

1. Keep official/release artifacts untouched.
2. Make gameplay changes in source.
3. Build a new immutable preview ID.
4. Run focused units and practical built-browser checks.
5. Test with real fingers on the iPad.
6. Tune from observed play, not from speculative harness work.
7. Revisit production promotion only with explicit authorization.

Do not resume release-harness hardening as the default next task.

### Product principles to preserve

- Touch behavior must be direct, stable, and understandable before visual polish
  is considered successful.
- Each game keeps a small, distinct control grammar; variety comes from real
  mode/options differences rather than five reskins of one controller.
- Failure should teach and recover locally where the genre allows it. Avoid
  surprise full restarts and screen loops.
- Results, scoring units, cues, and buttons must tell the truth about the state
  the simulation actually owns.
- The shared foundation should enforce timing, input ownership, pause, and
  presentation safety without flattening every genre into one generic class.
- Visuals should feel authored, cinematic, readable, and child-friendly. In
  particular, Runner's hero and course should not regress toward the generic,
  weak presentation that prompted the rebuild.
- Automated checks support the family playtest; they do not substitute for it.

## Authority hierarchy

Several generations coexist in the repository. Use this hierarchy to avoid
editing or testing the wrong thing.

### 1. Current editable source

These directories are the authority for future gameplay work:

```text
worlds-reboot/
  engine/          shared timing, input, rendering, camera, FX, audio, and UI primitives
  preview/         five-game launcher, typed options, and shared in-game MENU
  golf/            Stackyard Golf current source plus protected historical artifacts
  runner/          Gridlock Run current source plus protected historical artifacts/evidence
  ashfall/         Ashfall current source
  wings/           Paper Wings current source plus a protected reference build
  tide/            Low Tide current source plus a protected reference build
  tools/           active preview tools and dormant historical release tools
  plans/           historical foundation plan and approval mockups
```

Within a game directory, edit `src/`, the game `index.html`, and its Vite
configuration when necessary. Do not edit a generated candidate in
`preview-dist/`.

### 2. Current immutable family-test candidate

The committed candidate is:

```text
worlds-reboot/preview-dist/family-preview-20260715-7/
  index.html
  golf/index.html
  runner/index.html
  ashfall/index.html
  wings/index.html
  tide/index.html
  preview.json
```

“Immutable” is a workflow rule, not a filesystem permission. The files are
writable, but they must never be changed in place. Any change produces a new
preview ID.

### 3. Protected official/reference artifacts

The following are historical invariants and must not be overwritten during
routine preview work:

- `worlds-reboot/golf/dist/index.html`
- `worlds-reboot/golf/stackyard-golf-v1.html`
- `worlds-reboot/runner/dist/index.html`
- `worlds-reboot/runner/gridlock-run-v1.html`
- `worlds-reboot/runner/gridlock-run-v1-frames.png`
- the 12 committed Runner Phase 4 screenshots
- `worlds-reboot/wings/dist/index.html`
- `worlds-reboot/tide/dist/index.html`

Ashfall has no protected official/reference `dist` artifact in Git.

These old artifacts are not the gameplay authority for Preview 7. Their
preservation is a safety boundary: preview work may differ from them without
promoting over them.

### 4. Historical documents

- [`worlds-reboot/HANDOFF.md`](worlds-reboot/HANDOFF.md) is a layered historical
  record. Its lower sections contain obsolete statuses, IP addresses, commands,
  and build/release instructions.
- [`worlds-reboot/plans/foundation-rebuild-gameplan.md`](worlds-reboot/plans/foundation-rebuild-gameplan.md)
  records the approved design direction, but its approval/status language was
  not updated as implementation progressed.
- [`worlds-reboot/plans/foundation-rebuild-mockups.html`](worlds-reboot/plans/foundation-rebuild-mockups.html)
  is an approval artifact, not the current runtime. Its old 640 m Runner concept
  does not mean the current Runner is 640 m.

Use those files for rationale and archaeology only. This handoff and current
source control operational decisions.

## Repository and account setup

The repository is public, so a new account can clone it without credentials.
Pushing requires collaborator access to `spbaker22/playforge-worlds`, or a fork
and pull request from the new account.

### Requirements

- macOS is the currently exercised host environment.
- Node.js **22.12.0 or newer** is the safe requirement for a fresh install.
- npm is supplied with Node.
- Python 3 is used only for the simple local static server.
- Desktop Chrome is needed by the Puppeteer browser checks. The tools search
  standard macOS Chrome locations; they can also use `CHROME_BIN` or an explicit
  `--chrome=/absolute/path/to/Chrome` argument.
- GitHub CLI (`gh`) is useful for pull requests but is not required to run the
  games.

Why Node 22.12+: the lockfile currently resolves `puppeteer@25.3.0` and
`@puppeteer/browsers@3.0.6`, which declare Node `>=22.12.0`. Preview 7 itself was
built on the original Mac with Node 20.20.2; that is provenance, not a setup
recommendation. Do not rebuild Preview 7 just to rewrite its manifest.

### Fresh clone

```bash
git clone https://github.com/spbaker22/playforge-worlds.git
cd playforge-worlds
git switch main
git pull --ff-only
cd worlds-reboot
node --version
npm ci
```

Confirm that `node --version` is at least `v22.12.0` before `npm ci`. If the
machine has a Node version manager, select a current Node 22 release there.

For a new GitHub identity that will push changes:

```bash
gh auth status
git config user.name
git config user.email
```

Do not copy authentication tokens into documentation, commits, chat, or the
repository.

### Durable Git lineage

- Preview 7 source and committed candidate entered `main` through GitHub PR #1,
  merge commit `ad074bf9420c8891eae9cfc684a28d89c6bd2b5c`.
- Its content commit is `952e7e1` (`feat: publish verified five-game Preview 7`).
- The initial workstream-ledger release entered through PR #2, merge commit
  `8ba5eaba2fcb2b9762eb3f0f0553d6b0b4b9cc73`.

Use `git log --oneline --decorate` and `git rev-parse origin/main` for the newer
head after this handoff and subsequent work are merged. Commit hashes identify
repository publication; they do not imply iPad or production approval.

## Mandatory integrity preflight

Run this before any build, promotion experiment, or work involving generated
artifacts:

```bash
cd /path/to/playforge-worlds/worlds-reboot
shasum -a 256 \
  runner/dist/index.html \
  runner/gridlock-run-v1.html \
  golf/dist/index.html \
  golf/stackyard-golf-v1.html \
  wings/dist/index.html \
  tide/dist/index.html
```

Expected SHA-256 values:

| Artifact | Expected SHA-256 |
|---|---|
| Runner `dist/index.html` | `009bdb89c804db27a09107ef7b36e371aa858e78615d7f71491d48d934ed6ca0` |
| Runner `gridlock-run-v1.html` | `009bdb89c804db27a09107ef7b36e371aa858e78615d7f71491d48d934ed6ca0` |
| Golf `dist/index.html` | `cb4a1d5ca25de2a1f0d719fb033bb4b8ba312b386d9ac0065229b054d47f2c28` |
| Golf `stackyard-golf-v1.html` | `cb4a1d5ca25de2a1f0d719fb033bb4b8ba312b386d9ac0065229b054d47f2c28` |
| Wings reference `dist/index.html` | `a35d7ee12261af6eb84d4d9046f5e49dee01bde89b87d77cc2f2714e6020cc4d` |
| Tide reference `dist/index.html` | `14d04d90ffc6ae2bb708233796335a52777d2e277dbc097292750ae991a80d31` |

Stop and investigate if any value differs. Do not “fix” a mismatch by copying a
new build over the artifact.

This routine build preflight covers the six official/reference HTML outputs the
preview builder observes. The Runner frame board and 12 Phase 4 screenshots are
additional protected release evidence; their exact hashes remain in the
historical handoff and are relevant if an explicitly authorized release project
is opened. This six-HTML check is not the 17-artifact release preflight and does
not authorize promotion.

This preflight matters because `tools/build-preview.mjs` compares protected
files immediately before and after its own run. It proves that the builder did
not change its starting state; it cannot prove that a file was already
canonical before the builder started.

## Verify the committed Preview 7 bytes

From `worlds-reboot/`:

```bash
cd preview-dist/family-preview-20260715-7
shasum -a 256 \
  index.html \
  golf/index.html \
  runner/index.html \
  ashfall/index.html \
  wings/index.html \
  tide/index.html \
  preview.json
cd ../..
```

Expected values:

| File | SHA-256 |
|---|---|
| `index.html` | `8a20f2abbe26b841c1249b2e1ae37c9fb5e69004302f02aecd2e46a4b2193d8f` |
| `golf/index.html` | `0c292706754a3d5ef3d5b1b9d56f955bc30ae2632194bdb58584d910282b8ed9` |
| `runner/index.html` | `6166050a439f3c2a52a3f4bcc6c52d69cbe054fcff9a8f6be9808d0f069a3f65` |
| `ashfall/index.html` | `b7d92fbfebdf8d9eed372d1dfa66fa25e9b81f5a5196d0d5bd6a509e138d136a` |
| `wings/index.html` | `8a93276446ac92a12a877bf35958a20636ef0d35aed4e4f12d5399347c9e100b` |
| `tide/index.html` | `cf1478c94f0f15f58a5e65bb484038d11f129273a44cb090eb85e91dfbc8b40d` |
| `preview.json` | `738b2dd4ed0fb6757b7f5f2b182262993fffc1f25a8d271743f7a664db5f158b` |

The manifest contains absolute Node and Vite paths from the original build Mac.
That information is expected provenance and is not a credential. A fresh clone
will have different local paths; do not edit the immutable manifest.

## Run Preview 7 on a computer and iPad

### Start the server

Open Terminal 1 and keep it in the foreground:

```bash
cd /path/to/playforge-worlds/worlds-reboot
python3 -m http.server 8091 --bind 0.0.0.0
```

Computer URL:

```text
http://127.0.0.1:8091/preview-dist/family-preview-20260715-7/
```

Do not serve the repository root, a game's `dist/`, or an individual game
directory when testing the five-game candidate. Stop the server with `Control-C`
when finished. Keeping it foregrounded makes ownership and shutdown obvious.

### Find the Mac's current Wi-Fi address

In Terminal 2:

```bash
ipconfig getifaddr en0
```

If that prints nothing, identify the active Wi-Fi interface and query it. The
address is DHCP-derived and may change every session. The old `192.168.1.137`
address in historical documents is not authoritative.

On an iPad connected to the same trusted Wi-Fi, open:

```text
http://<CURRENT-MAC-IP>:8091/preview-dist/family-preview-20260715-7/
```

If the page does not open:

- confirm the Mac URL works locally;
- keep the Mac awake;
- confirm both devices are on the same non-guest Wi-Fi;
- allow Python through the macOS firewall;
- disable a VPN or client-isolated/guest network for the test;
- query the IP again rather than reusing an old value.

The static server is for a trusted local network. Do not expose it to the public
internet.

## Current system architecture

The games are browser-native ES modules bundled into self-contained HTML files.
The current dependency family is Three.js 0.185.1, Vite 8.1.4, and
`vite-plugin-singlefile` 2.3.3.

### Shared foundation

- `engine/fixed-step.js` separates deterministic simulation time from wall and
  cinematic time. Current gameplay simulations use a 120 Hz fixed step and do
  not catch up accumulated time after a pause.
- `engine/gesture.js` provides one-owner pointer capture, coalesced events,
  deadzones, hysteresis, axis locking, and cancellation cleanup.
- `engine/mode.js` provides guarded modes with owned timers/listeners and stale
  callback protection.
- `engine/screen.js` updates visibility, inertness, accessibility state, and
  focus as one screen transition.
- `engine/post.js`, `atmo.js`, `cam.js`, `fx.js`, `sfx.js`, and `base.css`
  provide the shared renderer/post pipeline, quality behavior, atmosphere,
  camera helpers, effects, audio, and base presentation.
- `preview/options.js` and the launcher provide typed URL/local-storage options,
  44 px-or-larger controls, version-local Back navigation, and the shared MENU.

All five games use the shared post pipeline, fixed-step runtime, preview MENU,
and SFX layer. They intentionally do **not** all use one giant generic game
controller:

- Golf and Runner compose `engine/mode.js` and `engine/gesture.js` through their
  controllers.
- Ashfall uses the shared gesture primitive with a genre-specific action and a
  local guarded flow.
- Tide uses the shared screen primitive with its own action/flow.
- Wings has its own guarded screen/action flow.

This genre-specific composition is deliberate. Preserve the shared safety
invariants without forcing unrelated game grammars into one abstraction.

All five games expose a test/diagnostic surface named `window.__gp`; Golf and
Runner also expose `window.__dbg`. Some Golf/Runner methods deliberately mutate
runtime state for controlled tests, and `__dbg` exposes mutable Three.js objects.
These helpers are not evidence of human playability and should not be used
casually during a family run. `engine/touch.js` is a legacy/frozen-harness input
path and is not used by current game source. Current Golf and Runner input is
built on `engine/gesture.js`; do not revive the old tap/hold grammar by wiring
new work to `engine/touch.js`.

### Shared MENU behavior

Every game has a version-local MENU that must:

1. freeze simulation exactly;
2. block gameplay input;
3. cancel an active gesture safely;
4. ignore the stale release from that gesture;
5. resume without a physics catch-up burst;
6. preserve Back, reset, sound, and quality behavior.

Any input or timing refactor must retain these properties in all five games.

## Launcher and option matrix

Global options:

- Sound: On / Off
- Quality: Auto / Fast

Game options and current defaults:

| Game | Options | Default |
|---|---|---|
| Golf | Front Six / Quick Three / Practice; starting hole 1–6; Standard/Family cup; Standard/Relaxed rivals | Front Six, Hole 1, Standard cup, Standard rivals |
| Runner | Training 150 m / Final Relay starting at 112 m; Standard/Calm pace; 5/3/1 shields; Standard/Easy swipe | Full Training, Standard pace, 3 shields, Standard swipe |
| Ashfall | Quick / Full; Calm / Standard / Inferno | Full, Standard |
| Wings | Quick / Full; Guided / Direct; Solo / Rivals | Full, Guided, Rivals |
| Tide | Quick / Full; Relaxed / Standard line; Haul / Trophy | Full, Standard, Haul |

Options are encoded through the launcher and consumed by each built game. Test
launcher selection, direct navigation, version-local Back, and replay whenever
option parsing changes.

## Game-by-game product and technical context

### Stackyard Golf

Current scope:

- Six authored dusk-garden holes: First Light, The Hedge, Twin Mounds, The
  Terrace, Moon Gate, and Fountain Turn.
- Front Six, Quick Three, and per-hole Practice modes.
- Standard or Family cup; Standard or Relaxed rivals.

Control model:

- The camera and current ball lie are locked while aiming.
- A pointer ray intersects the ball's locked world plane.
- The world target becomes the aim reticle.
- Target distance is clamped to roughly 0.18–9.2 m.
- Release maps ball-to-target world distance to putt speed.
- Mouse uses a 4 px engage / 2 px exit threshold; touch uses a viewport-relative
  1.8% engage / 1.2% exit threshold.
- A 24-segment guide follows the terrain and ends in a ring/arrow.

Flow:

```text
title → intro → aim-enter → aim/aiming → roll
                                      ├→ settling → aim-enter at the next lie
                                      └→ sunk → card → next hole/results → replay
```

Only the hole card owns `Next Hole`; only results owns `Play Again`. An ordinary
stopped ball becomes the next lie. The deterministic 120 Hz physics handles
slopes, friction, walls, cup/lip interaction, settling, and an eight-stroke cap.
Post-hole progression is one deliberate tap on `Next Hole`, never a press-and-
hold gesture.

Preview 7 fixes represented in current source:

- no spinning/circular guide behavior;
- smoother short-putt targeting;
- second shots preserve the actual stopped lie;
- the Hole 2 uphill guide follows terrain instead of being clipped;
- authoritative hole card/results overlays;
- deterministic rival/replay behavior.

What is still unknown:

- real-finger short-putt feel on the target iPad;
- whether the guide remains visually readable at every device angle;
- audio, heat, and sustained frame pacing;
- whether family cup/relaxed rivals need tuning after child play.

Do not redesign the control again before observing a real iPad session unless a
reproducible desktop defect proves it necessary.

### Gridlock Run

Current scope is a deliberate **150 m vertical slice**, not the older 640 m
concept. The playable hero is K-6; rivals are VOLT, NYX, and JET.

Modes:

- Training runs the full 150 m course.
- Final Relay starts at 112 m for a fast final-section test.

Course structure:

| Distance | Section | Purpose |
|---|---|---|
| 0–25 m | Safe Launch | establish speed and framing |
| 25–60 m | Jump | practice gap at 34–38.2 m; nonlethal rewind |
| 60–90 m | Choose Lane | center blocker; nonlethal stumble and continue |
| 90–112 m | Slide | overhead obstacle; nonlethal stumble and continue |
| 112–150 m | Link Moves | lethal side blockers/final gap; shield and local recovery rules |

Controls use immediate swipe thresholds:

- up: jump, with a second jump available;
- down: slide;
- left/right: choose one of three lanes.

Cues use a deterministic `WAIT → READY/NOW` model. An early correct input can
arm once, and READY must paint at least once even at low frame rate. Missing the
practice gap rewinds locally; lane/slide practice hits cause a stumble and the
run continues. A lethal final-section miss spends exactly one shield and rewinds
locally when protection remains; exhausting the last shield ends the run. None
of these paths silently restarts from the title. Terminal physics freezes
cleanly.

Presentation:

- one course model drives rendering, collision, camera, and cues;
- five visual districts establish progression;
- the hero is an athletic courier;
- a close chase camera provides the approved framing direction.

Preview 7 fixes represented in current source:

- no title/countdown overlay loop;
- no five-second fall/restart loop;
- corrected early 22 m split behavior;
- immediate swipe response and clearer cues;
- local recovery rather than remote full reset;
- no terminal fall-through;
- stronger hero/course/presentation foundation.

What is still unknown:

- whether Training feels fun and readable with real fingers;
- whether Calm pace or Easy swipe should become a family default;
- whether the hero and course art now meet the user's visual bar;
- audio, thermals, and device frame pacing.

Do not expand to the old 640 m concept until the 150 m foundation is approved on
the iPad. Expansion before approval multiplies the cost of any control or visual
change.

### Ashfall

Ashfall is a volcanic survival game.

- Quick lasts 30 seconds; Full lasts 60 seconds.
- Intensity options are Calm, Standard, and Inferno.
- Direct drag moves the player.
- A short tap of at most about 14 px and 0.34 seconds uses the exact tapped world
  point to choose a 4.2 m dash direction.
- The player has three hearts.
- Starting at six seconds, perimeter waves arrive every eight seconds. Twelve
  perimeter slots contain one deterministic gap and eleven hazards, preventing
  the old “orbit forever” strategy.
- Flow is title → instructions → countdown → play → finish/fail → results →
  replay.

Current work fixes scoring/invulnerability behavior, replay seeds, arena/shield
visibility, and misleading copy. The scene includes two companions, but it does
not yet implement a fully modeled named three-rival system; do not claim that it
does.

Remaining gate: physical touch feel, readability, intensity, audio, and device
performance.

### Paper Wings

Paper Wings is a gate-flight race.

- Quick has six gates; Full has twelve.
- Controls are Guided or Direct.
- Opponents can be Solo or Rivals; rivals are SORA, VALE, and PIP.
- The control orb has an exact 42 px radius, proportional response inside the
  radius, and radial saturation at the edge.
- Guided uses lower authority, faster centering, a 1.26× multiplier on each
  authored gate's acceptance radius, and mild assistance. Direct uses higher
  authority and slower centering.
- Flow is title → briefing → countdown → flight ↔ recovery → finish/fail →
  results → replay/countdown.
- Missing a gate triggers a 1.15 second recovery roughly 40 m before the same
  gate. Three misses on the same gate fail the run.

The last Preview 7 change corrected exact 42 px control behavior and strengthened
hero/gate/orb contrast. Compared with local Preview 6, Wings is the only built
game file changed in Preview 7; the launcher and other four games remained
byte-identical.

Remaining gate: physical Guided and Direct feel, held-edge behavior, contrast,
audio, and device performance.

### Low Tide

Low Tide is a timed fishing game.

- Quick lasts 45 seconds; Full lasts 90 seconds.
- Line options are Relaxed or Standard.
- Scoring is Haul (kilograms) or Trophy (points).
- Rivals are MARA and ELIAS.
- Drag back/sideways and release to cast.
- During a bite, pointer-down hooks exactly once; it does not implicitly reel.
- A fresh hold reels; release eases the line.
- Pier Lights favors short/center casts, Deep Channel favors long/center casts,
  and Breakwater favors sideways casts. Zones change odds and timing.
- Six species and deterministic tiers provide variety; replay varies the seed.
- A cast released and accepted before the buzzer is honored through overtime
  labeled `LAST FISH`, but no new cast may be accepted after time expires.

Current work fixes kilogram/point semantics, zone behavior, overtime state and
copy, replay/input flow, and screen authority.

Remaining gate: physical cast/hook/reel grammar, zone discoverability, overtime
clarity, audio, and device performance.

## What has already been verified

The durable verification record is
[`worlds-reboot/VERIFICATION.md`](worlds-reboot/VERIFICATION.md). Its current
verdict is PASS for computer/iPad family testing, with physical iPad approval
pending.

Safe focused units were freshly rerun during preparation of this handoff:

| Suite | Result |
|---|---:|
| Golf/Ashfall/Wings/Tide/preview options | 81/81 pass |
| Runner unit | 13/13 pass |
| Runner cue | 7/7 pass |
| Total | 101/101 pass |

Preview 7's built-browser evidence also records:

- launcher and all five game endpoints returned HTTP 200 locally and over LAN;
- full five-game gameplay smoke passed without page, console, request, or HTTP
  errors;
- launcher routes, options, and version-local Back links passed;
- genuine touch paths and shared MENU behavior passed separately for all five
  games;
- Golf close putt, second lie, Hole 2 guide, and progression checks passed;
- Runner cue timing, recovery, Training, and Relay paths passed;
- Ashfall movement/dash/hazards/results passed;
- Wings exact control and race completion passed;
- Tide score modes, zones, and last-fish overtime passed;
- protected official/reference artifacts remained unchanged.

This is automated browser evidence. It cannot prove real-finger feel, audio by
ear, thermal behavior, or sustained iPad frame pacing.

## Reproduce the active practical checks

Start the static server from `worlds-reboot/` in Terminal 1 as shown earlier.
Then, from `worlds-reboot/` in Terminal 2:

```bash
node --test \
  golf/src/*.test.js \
  ashfall/src/*.test.js \
  wings/src/*.test.js \
  tide/src/*.test.js \
  preview/options.test.js
npm run test:runner:unit
npm run test:runner:cue
```

Run the built five-game smoke:

```bash
BASE=http://127.0.0.1:8091/preview-dist/family-preview-20260715-7/
node tools/preview-smoke.mjs --base="$BASE"
```

Run MENU/touch acceptance in a fresh process for each game:

```bash
for game in golf runner ashfall wings tide; do
  node tools/preview-menu-pause.browser.mjs --base="$BASE" --game="$game"
done
```

The isolated `--game` processes are important. A previous aggregate run reused
one Puppeteer touchscreen/browser instance after Golf navigation and could emit
zero Runner pointer events. Each game passes in a fresh browser process. Do not
spend the next session hardening that aggregate harness unless a new practical
need justifies it.

If Chrome is not discovered automatically, use the tool's `--chrome` argument
or set `CHROME_BIN` to the local browser executable.

## Tests that are not the active Preview 7 path

The repository still contains a sophisticated historical release transaction.
It protects the older Runner/Golf official generation. It is not the current
five-game preview acceptance workflow.

| Command/tool | Current role |
|---|---|
| Focused unit commands above | routine and nonpromoting |
| `tools/preview-smoke.mjs` | routine built-preview acceptance |
| five isolated `preview-menu-pause` processes | routine touch/MENU acceptance |
| `tools/build-preview.mjs` | safe separate-preview builder |
| Golf Phase 2 diagnostic | nonpromoting source diagnostic |
| Foundation/post diagnostics | nonpromoting shared-engine diagnostics |
| Runner Phase 3 / `audit:touch` | historical official-parity checks; not current Preview 7 acceptance |
| `test:runner:phase4:dev` | nonpromoting but pinned to incompatible historical inputs |
| negative watchdog suites | structurally nonpromoting, but process/temp invasive; harness work only |
| `npm run test:runner:phase4` | release-mode inner supervisor; not a standalone routine command |
| `npm run test:release` | positive authorization-bearing transaction; never run without explicit promotion authorization |

The frozen Phase 4 harness expects older Runner course/simulation/shared-audio
hashes. Current Preview 7 source intentionally differs, so even the development
Phase 4 gate is not a Preview 7 acceptance test. Migrating that harness would be
a separate project requiring explicit approval.

Historical parity tools also contain an old default LAN address and compare
fresh source against protected official bytes. Do not “repair” them as part of
ordinary gameplay work.

## Safe workflow for the next gameplay change

### 1. Synchronize and claim the work

```bash
git fetch origin --prune
git status --short --branch
git branch -a
```

Stop and reconcile any status output you do not understand. Do not discard or
carry unrelated user work across branches. Synchronize `main`:

```bash
git switch main
git pull --ff-only
```

Now read the current `tasks/active-workstreams.md`, confirm there is no
conflicting claim, choose a unique literal workstream name, and branch:

```bash
WORKSTREAM=ipad-playtest-followup
git switch -c "codex/$WORKSTREAM"
```

Add a precise ledger claim before changing shared files so parallel sessions do
not overwrite one another.

### 2. Verify the boundary before editing

- run the protected official/reference HTML hash preflight;
- confirm the working tree is clean or fully understood;
- identify the exact game/shared files in scope;
- record which Preview 7 files should stay byte-identical if the change is
  isolated.

### 3. Edit source, not generated candidates

Never edit `preview-dist/family-preview-20260715-7/` in place. Never use a
default per-game Vite build in Golf, Runner, Wings, or Tide: it writes to the
game's `dist/` and can overwrite a protected artifact.

For interactive source work, use the relevant Vite development server with an
explicit host/port. For an isolated one-game production experiment, use an
explicitly disposable `--outDir` outside protected paths. For an acceptance
candidate, use the all-five preview builder.

### 4. Run targeted tests while iterating

Run the smallest relevant unit/browser test first, then the complete active
unit set when shared code or behavior stabilizes. If a shared runtime primitive
changes, exercise every downstream game, not only the game that motivated the
change.

### 5. Build a new immutable preview ID

After the canonical hash preflight:

```bash
cd /path/to/playforge-worlds/worlds-reboot
PREVIEW_ID=
printf 'New unused preview ID: '
read -r PREVIEW_ID
node tools/build-preview.mjs --id="$PREVIEW_ID"
```

The builder:

- refuses to overwrite an existing ID;
- builds the launcher and all five single-file games;
- verifies that six expected HTML outputs exist;
- checks that the six protected official/reference HTML files did not change
  during its run;
- writes `preview.json`;
- atomically moves the completed stage into the final candidate directory.

A process kill can leave a `.stage-*` directory. Before deleting residue, prove
that no builder is still running and recheck protected hashes.

### 6. Verify the new candidate

- hash the candidate and save its manifest;
- re-run the canonical protected official/reference HTML hash check;
- prove Preview 7 itself is unchanged;
- serve the new ID and confirm launcher plus five game endpoints are HTTP 200;
- run launcher/routes/options/Back checks;
- run the full built gameplay smoke;
- run isolated MENU checks for each game;
- compare unaffected game files byte-for-byte with the prior accepted preview;
- inspect browser errors and the intended visual changes;
- then put the exact new ID on the physical iPad.

### 7. Publish only an accepted candidate

`.gitignore` currently ignores every generated preview except the exact Preview
7 allowlist. Experimental candidates should stay local. If a later candidate is
explicitly accepted for repository publication, update `.gitignore` with that
one exact directory and stage only intended paths.

Do not use a broad `git add -f` on `preview-dist/`, evidence, dependencies, or
old previews.

### 8. Use a reviewable Git transaction

- inspect `git diff` and `git diff --check`;
- stage explicit paths;
- inspect `git diff --cached`;
- commit on the `codex/*` branch;
- push and open a pull request to `main`;
- merge through a real merge commit after checks/review;
- release the workstream claim;
- fetch/prune and prove local `main` matches `origin/main`;
- for a high-risk publication, verify a fresh clone.

Do not hard reset, force push, or delete unrelated work to make the tree look
clean.

## Physical iPad playtest plan

This is the next substantive gate. The goal is not simply “the page loaded.” It
is to observe whether a child can understand and enjoy each game with real
touches.

Run approval in two passes:

1. **Default/full baseline:** use the launcher's default options in landscape
   and remain in each game for at least five uninterrupted minutes. If a run
   ends sooner, replay within that game until the five-minute observation window
   is complete. This is the minimum useful window for control, audio, heat, and
   frame-pacing observation.
2. **Targeted alternatives:** run the checks below and exercise at least one
   non-default choice in every option family. Short modes are useful for rapid
   defect triage, but they do not replace the default/full baseline.

The default baseline is Front Six Golf; Full Training Runner with Standard pace,
three shields, and Standard swipe; Full/Standard Ashfall; Full/Guided/Rivals
Wings; and Full/Standard/Haul Tide.

### Record the environment once

- iPad model and screen size;
- iPadOS version;
- Safari tab versus Home Screen launch;
- landscape orientation for the baseline, plus any alternate orientation tried;
- selected game options;
- Wi-Fi/IP used;
- whether audio was on;
- screen recording if available;
- visible heat or frame-pacing changes over time;
- the player's unprompted comments and where adult help was needed.

### Golf

1. Play the default Front Six baseline, including several 0.20–0.75 m putts.
2. Confirm the reticle/guide stays with the finger and never spins or circles.
3. Take two ordinary shots and verify shot two starts from shot one's stopped
   lie.
4. Play Practice/Hole 2 with Family cup and Relaxed rivals; inspect the complete
   uphill guide.
5. Sink a hole, wait without touching, then use `Next Hole` once.
6. Reach results and use `Play Again` once.
7. Play Quick Three and note whether Standard or Family cup feels better for
   the child.

### Runner

1. Play the default Full Training baseline with Standard pace, three shields,
   and Standard swipe.
2. Observe the first 25 m without input.
3. Complete jump, lane, slide, and linked-move sections.
4. Deliberately miss the first practice gap and confirm a local rewind.
5. Deliberately hit the lane and slide practice obstacles and confirm a
   nonlethal stumble/continue rather than a rewind or restart.
6. Complete the 150 m finish.
7. Play Calm pace, Easy swipe, and a non-default shield count.
8. Play Final Relay; deliberately miss a lethal hazard and confirm exactly one
   shield is spent plus a local rewind, or results if the last shield is
   exhausted.
9. Ask specifically whether the hero, camera, districts, and cues feel exciting
   and understandable.

### Ashfall

1. Play the default Full/Standard baseline.
2. Play Quick/Standard and try circling the edge only; observe the perimeter
   wave.
3. Find the deterministic gap and use a short-tap dash.
4. Play Quick/Inferno.
5. Note whether hazards, hearts, shield/invulnerability, and results are clear.

### Wings

1. Play the default Full/Guided/Rivals baseline and use the entire control orb.
2. Hold the finger at the exact edge and check stable response.
3. Complete or recover from missed gates.
4. Play Quick/Direct/Solo and compare authority/centering.
5. Note hero, gate, rival, and orb contrast.

### Tide

1. Play the default Full/Standard/Haul baseline.
2. Play Quick/Relaxed/Trophy and cast into Pier Lights, Deep Channel, and
   Breakwater.
3. Confirm bite pointer-down hooks only once.
4. Use a fresh hold to reel and release to ease.
5. Aim and release a valid cast before the timer reaches zero, then finish the
   `LAST FISH` overtime through results. Pointer-down before zero is insufficient
   if release occurs after zero.
6. Confirm no cast can be released/accepted after the buzzer.

### Every game

Open MENU during an active gesture. Confirm the game freezes, the old release
does nothing, and resume is clean with no catch-up motion. Test sound and quality
once. Use version-local Back to return to the same Preview 7 launcher.

### Feedback format

Record each issue as:

```text
Game / mode / options:
iPad + iPadOS:
Exact moment:
What the player tried:
What happened:
Expected behavior:
Reproducible? always / sometimes / once
Screen recording timestamp:
Severity: blocker / frustrating / polish
Player's exact words:
```

Prioritize blockers and frustration that can be reproduced. Avoid redesigning
all five games from one ambiguous gesture without first isolating the cause.

## Known caveats and nonblocking polish

- Physical iPad approval is still absent. This is the only major product gate.
- Runner intentionally stops at 150 m; 640 m is a post-approval expansion.
- The aggregate multi-game touchscreen harness can lose pointer events after
  navigation. The accepted path is one fresh process per game.
- Wings' raw diagnostic `?auto=1` timer path can advance while a MENU is open;
  normal launcher/preview paths pass. Treat this as diagnostic-only unless it
  reproduces in the actual preview.
- The five-card launcher grid leaves the lower-right cell blank on some wide
  layouts. This is minor visual polish.
- Tide results use a normal 0.9 second CSS fade. A screenshot taken immediately
  can look blank before it settles; the screen resolves correctly. It may become
  interactive during the initial transparent fade, which is minor polish.
- Preview 6 and detailed generated evidence exist only on the original Mac and
  are ignored by Git. A new clone should not expect them.

## Local-only state on the original Mac

At the time this handoff was prepared, the original workspace was:

```text
/Users/shaunbaker/Documents/Playforge
```

The project directory was:

```text
/Users/shaunbaker/Documents/Playforge/worlds-reboot
```

A local Python server was already running from that project directory on port
8091 as PID `12837`. The observed Wi-Fi address was `192.168.1.111`, but that
value is ephemeral and must be re-queried. Process IDs and addresses in this
section are a snapshot, not reusable configuration. Discover the current port
owner before starting a second server:

```bash
lsof -nP -iTCP:8091 -sTCP:LISTEN
```

Ignored/local material on that Mac includes:

- `node_modules/`;
- Preview builds 1–6;
- `preview-evidence/` (detailed screenshots and reports);
- Runner private correction captures;
- Tide smoke captures;
- Wings evidence;
- local `AGENTS.md` instructions.

Only Preview 7, the durable verification summary, and committed historical
evidence are portable through Git. The absence of ignored evidence in a new
clone is expected.

## Release and authorization boundary

Preview development, documentation commits, and GitHub publication do not grant
production-release authorization.

The historical positive release transaction can replace 17 protected artifacts
as one operation:

- 12 Runner Phase 4 screenshots;
- the Runner frame board;
- Runner `dist` and standalone HTML;
- Golf `dist` and standalone HTML.

It does not promote the complete five-game preview. Do not run
`npm run test:release` or `npm run test:runner:phase4` merely because a source
change, preview build, documentation commit, or Git push was requested.

If and only if an explicitly authorized release transaction crashes, the
historical recovery entry point is:

```bash
node tools/shipcheck-phase4.mjs --release --recover-only
```

That recovery follows durable journal evidence: before final commit
acknowledgment it restores exact OLD; after acknowledgment it finishes exact
NEW; unreadable/divergent evidence fails closed. Never manually delete release
journals, backup roots, stage roots, or claims. This is emergency context, not a
routine next step.

The exact hashes for the protected Runner frame board and 12 historical Phase 4
screenshots remain recorded in the archived `worlds-reboot/HANDOFF.md`. They are
release-transaction evidence, not current Preview 7 acceptance outputs, so they
are linked rather than duplicated here.

## Rollback principles

For a preview:

- never overwrite the accepted preview;
- keep serving Preview 7 if a later candidate is bad;
- fix source and build another ID;
- do not edit or delete Preview 7 to simulate rollback.

For Git:

- preserve user work;
- revert a published mistake with a new, scoped `git revert` commit after
  confirming impact;
- do not use hard reset or force push as a convenience.

For a release transaction:

- use the journal-aware recovery path only when a previously authorized release
  was interrupted;
- preserve evidence and fail closed when state is ambiguous.

## Historical plan reconciliation

The old foundation plan should be interpreted as follows:

| Plan phase | Actual current state |
|---|---|
| Phase 0 decisions | Approved: direct-target Golf, four-direction/three-lane Runner, athletic courier/close camera |
| Phase 1 shared safety foundation | Implemented |
| Phase 2 Golf vertical slice | Implemented; current source now includes all six holes |
| Phase 3 Runner 0–150 m vertical slice | Implemented |
| Phase 4 Runner presentation rebuild | Implemented in preview source |
| Phase 5 physical iPad approval | Still pending for the five-game preview |
| Phase 6 expansion/promotion | Not done; especially full 640 m Runner and production promotion |

The user's later request to apply the same foundation to every game, with
variety and options, is represented by Preview 7: Ashfall, Wings, and Tide are
real implemented games with option families, not placeholders.

## Immediate next actions

The next account should proceed in this order:

1. Read this file completely.
2. Read [`worlds-reboot/VERIFICATION.md`](worlds-reboot/VERIFICATION.md).
3. Inspect `worlds-reboot/preview-dist/family-preview-20260715-7/preview.json`.
4. Clone/sync `main`, use Node 22.12+, and run `npm ci` if dependencies are
   needed.
5. Run the protected official/reference HTML and Preview 7 hash checks.
6. Serve Preview 7 from `worlds-reboot/` and confirm local access.
7. Put the current LAN URL on the physical iPad.
8. Conduct the all-five-game playtest above and capture concrete evidence.
9. Classify feedback by game and severity.
10. Propose the smallest coherent source changes; discuss material visual or
    control direction changes before implementing them.
11. Build a new immutable preview ID and rerun practical checks.
12. Seek explicit approval before any production promotion or major scope
    expansion.

## Definition of the next milestone

The next milestone is complete only when:

- all five games have been played on the target iPad with real fingers at their
  default/full launcher settings for at least five uninterrupted minutes each;
- targeted alternatives cover at least one non-default choice in every option
  family;
- blocking input/flow defects are either absent or reproducibly documented;
- audio, thermal behavior, and sustained frame pacing have been observed;
- the child can understand the essential control grammar without continuous
  adult intervention;
- feedback is tied to a specific candidate ID and option set;
- any fixes are delivered in a new immutable candidate with protected artifacts
  unchanged;
- the user gives a clear accept/tune decision for each game.

That milestone still does not automatically authorize production promotion.

## Ready-to-paste context for a new account

The following block is intentionally concise enough to paste into a new account
while still directing it to the complete authority:

```text
Repository: https://github.com/spbaker22/playforge-worlds
Default branch: main
Active project: worlds-reboot/
Existing Mac repo: /Users/shaunbaker/Documents/Playforge
Existing Mac project: /Users/shaunbaker/Documents/Playforge/worlds-reboot

Start by reading NEW_ACCOUNT_HANDOFF.md completely, then
worlds-reboot/VERIFICATION.md. Treat NEW_ACCOUNT_HANDOFF.md as operational
authority; worlds-reboot/HANDOFF.md and plans/* are historical context and
contain obsolete commands/statuses.

Current candidate:
worlds-reboot/preview-dist/family-preview-20260715-7/

Current truthful status: Preview 7 is automated/browser-verified for physical
iPad family testing. It is not yet physically iPad-approved, shipped,
production-ready, or promoted. All five games are implemented: Stackyard Golf,
Gridlock Run, Ashfall, Paper Wings, and Low Tide. Runner is intentionally a
150 m vertical slice until device approval.

User's governing decision: isolate real game changes in a separate immutable
preview, run focused unit/practical browser checks, and test the exact preview
on the iPad. Do not return to release-harness hardening unless production
promotion is explicitly authorized.

Before any build, verify the protected hashes listed in NEW_ACCOUNT_HANDOFF.md.
Never edit Preview 7 in place and never run a default per-game Vite build into
Golf/Runner/Wings/Tide dist/. Use Node 22.12+, npm ci, a new codex/* branch, and
a new immutable preview ID for changes.

On the existing Mac, first run lsof -nP -iTCP:8091 -sTCP:LISTEN; PID 12837 owned
that port when this handoff was written, so do not blindly start a second
server. Then serve/confirm Preview 7 from worlds-reboot/, query the Mac's current
Wi-Fi IP, conduct the documented all-five-game physical iPad playtest, capture
exact feedback, and discuss a scoped tuning plan before implementing material
changes. Do not run npm run test:release or
npm run test:runner:phase4 without explicit release authorization.
```

## Reading order and durable references

1. This file — current operational and product authority.
2. [`worlds-reboot/VERIFICATION.md`](worlds-reboot/VERIFICATION.md) — durable
   Preview 7 evidence and hashes.
3. `worlds-reboot/preview-dist/family-preview-20260715-7/preview.json` —
   machine-readable build manifest.
4. `worlds-reboot/engine/`, `preview/`, and each game's current source — runtime
   truth.
5. [`worlds-reboot/HANDOFF.md`](worlds-reboot/HANDOFF.md) — historical release
   safety and design archaeology only.
6. `worlds-reboot/plans/` — historical intent and mockups only.

When this handoff and an older document conflict, follow this handoff unless the
user has since made a newer explicit decision and that decision is committed in
an updated authority document.
