# Playforge Foundation Rebuild — discussion draft

Date: 2026-07-14  
Status: APPROVAL REQUIRED — no game implementation begins from this document until the control and visual decisions at the end are approved.

## Executive decision

Do not rewrite both games from zero.

- Stackyard Golf needs a bounded input, screen-state, camera, and turn-lifecycle refactor. Preserve the six-hole course, atmosphere, art direction, coordinate math, and baseline ball physics.
- Gridlock Run needs a substantial game-layer rebuild. Preserve the shared renderer, atmosphere/audio/particle utilities, neon-rain premise, and single-file delivery. Rebuild its coordinate model, controls, race/failure flow, course sequencing, camera composition, courier, and environment art.
- The shared rendering engine is already benchmark-capable. The missing foundation is lifecycle, input ownership, deterministic simulation boundaries, and human-path verification.

This is the smallest scope that addresses the real causes without discarding working work.

## What the audit proved

### Stackyard Golf

1. The second-shot tee reset and broken Next Hole action have one exact cause. Hidden overlay buttons remain touch-active because [.hide](../engine/base.css#L51) disables pointer events on the parent while [#tapGo](../engine/base.css#L58) and [.rbtn](../engine/base.css#L77) restore them on descendants. A hidden Play Again button calls [resetRound()](../golf/src/main.js#L328), which resets the score and places the ball at the first tee. This was reproduced against the exact standalone file served on port 8091.
2. The aim basis is captured once, but the visible camera still moves and changes FOV during a drag in the [aim render branch](../golf/src/main.js#L551). That makes the guide feel detached from the finger.
3. Roll transitions directly back to aim at [physics stop handling](../golf/src/main.js#L422), before an authoritative camera-ready entry step. Immediate second shots can capture a transitioning camera.
4. Shot power survives into the next lie, Play Again leaves the spring camera at its old hole-six state, and the DOM callbacks call destructive transitions without mode guards.
5. The normal ball physics does not teleport the ball to the tee. Two genuine sequential touch shots outside the hidden-button region preserved the first lie. A full physics rewrite is therefore not justified by the current evidence.

### Gridlock Run

1. Rendered hazards and gameplay collisions use coordinate systems offset by exactly 22 metres. The player is drawn with [deckQ(s) = path.at(s + 22)](../runner/src/main.js#L77), while gaps, bars, signs, and gates are built at raw course s in [buildCity()](../runner/src/city.js#L147). A player can jump over the visible gap, land, then fall through apparently solid deck 22 metres later.
2. The deterministic first gap starts at 62m in [buildObstacles()](../runner/src/city.js#L55), before the first 80m checkpoint. At the current acceleration it is reached in about 4.6 seconds. [respawn()](../runner/src/main.js#L334) therefore returns the player to the opening position, producing the reported five-second loop.
3. The failure flow is re-entrant. The finish branch keeps running physics; a fallen player below the death threshold repeatedly calls respawn and runEnded, continuously resetting the finish timer. The results screen may never appear.
4. Tap-to-jump waits for finger-up. Hold-to-slide waits about 300ms, and a 260–300ms release performs neither action in [taps()](../engine/touch.js#L93). At race speed, that delay consumes several metres.
5. The visual weakness is not caused by the renderer. The runner uses the same ACES/HDR/bloom/atmosphere foundation as the benchmark. The weak result comes from the nearly straight route, repeated box towers, flat deck, distant wide-FOV camera, and placeholder-level courier in [courier.js](../runner/src/courier.js#L27).

## Preserve / refactor / rebuild boundary

| Area | Preserve | Refactor | Rebuild |
|---|---|---|---|
| Shared rendering | post.js, atmo.js, cam.js, fx.js, sfx.js, Three r185, Vite single-file output | Add small runtime primitives beside them | Do not replace |
| Golf | Course art/data, six holes, world/local frames, height/gradient model, baseline fixed-step ball math, atmosphere | Input session, screen interactivity, aim camera, turn state, timer ownership, test hooks | No wholesale rebuild |
| Runner | Renderer, atmosphere, palette premise, particles/audio utilities, race/rivals concept, 640m event concept | Runtime state, diagnostics, checkpoints, result flow | Course coordinate model, controls, first 150m, hazards, route composition, courier/rig, camera, environment kit |

## Proposed player contracts

### Stackyard Golf — recommended direct-target control

The finger manipulates a world-space target on the turf, not a camera-relative angle.

1. Touch the play surface and drag the target reticle toward the desired shot.
2. A line originates at the ball and ends at the reticle. Direction and strength remain stable even if the camera or frame rate changes.
3. A deliberate deadzone prevents small finger wobble from rotating the guide.
4. Release to putt. Cancel, lost capture, app backgrounding, or a second finger aborts safely without shooting.
5. The camera is fully locked for the entire gesture. It may settle before input becomes ready, never while the finger is controlling the shot.
6. Every stopped ball becomes the next lie. Only an explicit out-of-bounds rule may restore the last legal lie; no ordinary second shot returns to the tee.

Authoritative state flow:

TITLE → INTRO → AIM_ENTER → AIM_READY → AIMING → ROLLING → SETTLING → AIM_ENTER  
or  
ROLLING → HOLED → HOLE_CARD → NEXT_HOLE → AIM_ENTER → … → FINAL_CARD

Rules:

- A state owns all of its timers and gestures; leaving it cancels them.
- Inactive screens are hidden and inert. Their descendants can never receive a touch.
- Next Hole works only in HOLE_CARD. Play Again works only in FINAL_CARD.
- Power, pointer state, camera spring state, and presentation effects reset on every state entry where appropriate.
- The post-hole action is one clear tap on NEXT HOLE; no hold gesture is required.

### Gridlock Run — recommended directional runner

Recommended direction: make Gridlock a true one-hand, three-lane action runner.

- Swipe up: jump / second swipe up: double jump.
- Swipe down: slide.
- Swipe left or right: change lane.
- Actions trigger as soon as the directional threshold is crossed, not when the finger lifts and not after a hold timer.

This adds ongoing choices and makes the game feel materially richer than a fixed-centre timing track. If maximum simplicity is preferred, the same foundation can lock the player to the centre lane and use only up/down swipes; that choice must be made before implementation.

First 150m learning contract:

- 0–25m: safe acceleration and ghosted swipe-up prompt.
- 25–55m: short, forgiving jump with a long landing deck.
- 55m: visible checkpoint.
- 60–90m: lane-choice gate with no fall consequence.
- 90–120m: clearly telegraphed slide obstacle.
- 120m: second checkpoint.
- 125–150m: first real gap combining the learned actions.

Failure contract:

- A miss causes a fast local tether/rewind to the last safe pad, not a return to the title or opening line.
- A shield is spent once; terminal failure stops physics and always reaches results.
- Every hazard has a visible anticipation zone, action cue, takeoff window, and safe landing zone.
- Rendered geometry, player physics, bots, checkpoints, cameras, and diagnostics all read from one course coordinate model.

Authoritative state flow:

TITLE → INTRO → COUNTDOWN → TUTORIAL/RACE → CRASH → RESPAWN → RACE  
or  
RACE → FAILED → RESULTS  
or  
RACE → FINISH → RESULTS

## Visual direction mockup contract

### Golf

- Keep the dusk garden, warm lanterns, fireflies, turf, masonry, and handcrafted holes.
- Reduce bloom where it obscures the cup or guide.
- Use a slightly higher, stable over-ball aiming composition with the ball, target, cup, and important wall geometry visible together.
- Make the reticle and guide feel physically anchored to the turf.
- Keep the HUD quiet: hole, shot, score-to-par, and one concise state cue.

### Gridlock

- Replace the box robot with an athletic courier/android: articulated hips, knees, elbows, hands, layered shell/fabric, parcel rig, expressive visor, and a silhouette readable at gameplay distance.
- Bring the chase camera closer and reduce speed-driven FOV expansion so the hero remains important.
- Rebuild the route as changing districts and compositions rather than one straight magenta ribbon.
- Use three readable deck lanes, rail/edge construction, drainage and puddle detail, maintenance props, traffic below, drones, signs, and architectural landmark clusters.
- Telegraph hazards through lighting and construction: warning bands before gaps, rim light on obstacles, contrasting landing pads, and restrained bloom.
- Keep rain and neon, but add material hierarchy and warm/cool contrast so the course does not flatten into purple.

The companion board is [foundation-rebuild-mockups.html](foundation-rebuild-mockups.html).

## Technical foundation to add

Use a small shell, not a general-purpose engine rewrite.

### Shared primitives

1. Screen activation helper
   - One function controls hidden, inert, aria-hidden, opacity class, and focus.
   - No screen-local CSS rule can restore interactivity while inactive.
2. Mode scope
   - Explicit enter/exit hooks.
   - Cancellable game-time tasks and effects owned by the active mode.
   - Guarded transitions with diagnostic reason codes.
3. Gesture session
   - Enable/disable/cancel/dispose.
   - Pointer capture plus lostpointercapture, pointercancel, blur, and visibility cleanup.
   - Deadzone, direction lock/hysteresis, coalesced samples, device-relative thresholds, and test-visible state.
4. Fixed-step runner
   - Separates wall time, cinematic time, simulation time, and render interpolation.
   - Terminal states cannot continue destructive simulation.
5. Human scenario instrumentation
   - Extends window.__gp with active mode, state transition log, camera-ready flag, gesture state, position/lie, current checkpoint, active screen, and last reset reason.

### Game-specific controllers

- GolfAimController owns world-plane projection, reticle, power, camera lock, and release/cancel.
- GolfFlow owns hole/turn/card/final transitions and preserves lie/score invariants.
- RunnerCourseModel is the only conversion from course distance to world pose and is consumed by geometry, physics, bots, gates, checkpoints, and tests.
- RunnerActionController owns directional gestures, buffering, coyote time, lane changes, jump/slide state, and recovery.
- RunnerFlow owns race/crash/respawn/failure/finish/results.

Do not create one giant generic GameController. Share lifecycle and gesture mechanics; keep genre behavior separate.

## Phased implementation plan

### Phase 0 — approve the experience contract

Deliverables:

- Approve direct-target Golf control or choose pull-back slingshot control.
- Approve three-lane Gridlock or choose fixed-centre up/down rhythm mode.
- Approve the new courier direction and closer camera.
- Record the iPad model, iPadOS version, orientation, and whether play occurs in Safari or a Home Screen install.

Exit gate: the three decisions at the end of this document are answered. No production changes before this gate.

### Phase 1 — build the shared safety foundation

Deliverables:

- Screen activation/inert helper.
- Mode scope and cancellable scheduler.
- Gesture session with full pointer lifecycle.
- Fixed-step simulation helper.
- State trace and viewport-wide hidden-control audit.

Verification:

- No inactive screen button appears in elementFromPoint anywhere on the viewport.
- Pointer cancel, lost capture, background/foreground, multi-touch, and orientation changes leave no active gesture.
- Mode-owned callbacks never fire after leaving their mode.

### Phase 2 — Stackyard Hole 1 vertical slice

Deliverables:

- New Golf aim and flow controllers on Hole 1 only.
- Stable camera entry and full camera lock during aim.
- World-space direct target, deadzone, smoothing, reticle, guide, and power reset.
- Two-shot and multi-shot play; hole card; Next Hole stub; Play Again stub.
- Pure simulation boundary around the existing ball math.

Verification:

- Ten consecutive manual shots preserve the current lie and increment the shot count exactly once.
- Immediate second shot cannot begin until camera-ready, then maps correctly.
- Hole-out → genuine Next Hole touch reaches Hole 2 exactly once.
- Final card → genuine Play Again synchronizes ball, camera, score, and state.
- Camera transform remains fixed within a small tolerance during every active gesture.
- Real iPad playtest: at least three full holes with no accidental reset or unexplained aim rotation.

Exit gate: the user and daughter agree that aiming feels dependable before any visual/physics retuning.

### Phase 3 — Gridlock 0–150m vertical slice

Deliverables:

- One RunnerCourseModel used by visible deck, hazards, collisions, rivals, checkpoints, and debug overlays.
- New directional gesture controller and explicit race/failure flow.
- Guided 150m obstacle sequence with local recovery.
- Jump buffering, coyote time, generous landing windows, and deterministic replay.
- Close gameplay camera and gray-box three-lane deck.

Verification:

- Debug render confirms zero course-coordinate difference between visible hazard and collider.
- Manual player can clear the visible first jump, miss it, recover locally, and clear it on the next attempt.
- Exhausting shields reaches results once, with no repeated damage loop.
- All four gesture directions trigger on threshold and never enter a no-action timing gap.
- A new player can complete the 150m tutorial without verbal coaching after seeing the prompts.

Exit gate: gameplay is fun and readable in gray-box form before expensive art production.

### Phase 4 — Gridlock visual rebuild

Deliverables:

- Production courier rig and full run, lane-change, jump, double-jump, slide, landing, stumble, tether-recovery, win, and fail poses.
- Authored first district with a strong skyline landmark, transit depth, varied architecture, wet-deck construction, props, hazard telegraphs, and rivals.
- Camera/lens, lighting, material, rain, and effects polish against the Sundown Mesa composition bar.
- Updated opening, hero, gameplay, hazard, recovery, and finish frame board.

Verification:

- Hero silhouette is readable in stills and motion at actual iPad size.
- A coming hazard, required action, and landing zone are readable at least two decision windows ahead.
- Key gameplay frame has clear foreground/midground/background hierarchy and no flat magenta-ribbon read.
- Sustained real-device performance is measured; quality governor changes are documented rather than guessed.

### Phase 5 — real iPad approval gate

Run a device session, not an emulator-only check.

- Five uninterrupted minutes per game.
- Golf: multiple holes, second/third shots, wall bounces, hole card, Next Hole, final/replay, cancel, accidental edge touches.
- Gridlock: tutorial, each gesture, visible hazard clears, deliberate misses, recovery, shield exhaustion, replay, and a sustained run.
- Capture screen recording, state trace, touch trace, FPS/quality-governor log, and the player’s unprompted comments.

Exit gate: no implementation expansion until both games pass the real-finger experience.

### Phase 6 — expand and ship

- Golf: migrate remaining holes, then tune power/friction only from clean device feedback.
- Gridlock: expand the approved first district into the full 640m route with escalating combinations and authored checkpoints.
- Rebuild both standalone HTML files from source.
- Run automated human-path scenarios plus the real-device regression matrix.
- Produce new six-panel boards and update HANDOFF.md with exact device coverage and known limitations.

## Verification matrix

| Risk | Automated browser | Deterministic simulation | Real iPad |
|---|---:|---:|---:|
| Hidden overlay receives touch | Required | — | Required |
| Golf second-shot lie persistence | Required | Required | Required |
| Golf camera/gesture stability | Required | — | Required |
| Golf hole/card/replay transitions | Required | Required | Required |
| Runner geometry/collider alignment | Required | Required | Visual confirmation |
| Runner input latency and gesture recognition | Required | — | Required |
| Runner crash/respawn/failure terminal flow | Required | Required | Required |
| Runner tutorial readability/fun | Insufficient alone | — | Required with player |
| Performance/thermal/audio | Insufficient alone | — | Required |

## Anti-patterns explicitly excluded

- No rewrite of post.js, atmo.js, cam.js, fx.js, sfx.js, Three r185, or the build pipeline.
- No patching only the generated standalone HTML; source is authoritative and artifacts are rebuilt.
- No shipping based on one safe touch followed by autoplay.
- No wall-clock timeout as the owner of a gameplay transition or ambiguous tap/hold action.
- No camera-relative Golf control sampled while the camera is still settling.
- No inactive screen represented only by opacity.
- No first lethal Runner hazard before the player has learned the action and crossed a checkpoint.
- No render/collision/AI copies of course coordinates.
- No attempt to fix Runner art with more bloom, neon, or particles while retaining the flat route and placeholder hero.
- No expansion to all six Golf holes or 640m of Runner before the vertical slices pass on the actual iPad.

## Decisions for discussion

1. Golf control
   - Recommended: direct target — drag the reticle where the ball should travel, release to putt.
   - Alternative: pull-back slingshot — familiar to some mobile golf games, but direction is opposite the finger movement.
2. Gridlock game depth
   - Recommended: three lanes with up/down/left/right swipes.
   - Alternative: fixed-centre rhythm runner with only up/down swipes; simpler, but less agency.
3. Gridlock hero
   - Recommended: athletic courier/android with a semi-human silhouette, visor, layered shell/fabric, and parcel rig.
   - Alternative: remain fully robotic, but with a much more articulated and authored silhouette.

Once those three choices are approved, implementation can begin with Phase 1 and stop at each vertical-slice approval gate.
