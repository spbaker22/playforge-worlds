# CURRENT STATUS — 2026-07-15

This section is the authority for the current practical-preview state. The historical handoff below remains intact for design, release-safety, and implementation context; older shipment language does not override this status.

- Intended GitHub repository: `spbaker22/playforge-worlds` (`https://github.com/spbaker22/playforge-worlds`).
- Active project: `worlds-reboot/`.
- Current immutable family-test candidate: `preview-dist/family-preview-20260715-7/`.
- Stackyard Golf, Gridlock Run, Ashfall, Paper Wings, and Low Tide all pass focused built-browser gameplay, genuine-touch, routing, and shared-MENU pause/resume checks.
- Preview 6 is preserved locally. Generated screenshots and detailed reports remain local under `preview-evidence/`; the durable summary and hashes are in `VERIFICATION.md`.
- Protected official/reference artifacts are unchanged. Runner remains `009bdb89c804db27a09107ef7b36e371aa858e78615d7f71491d48d934ed6ca0`, Golf remains `cb4a1d5ca25de2a1f0d719fb033bb4b8ba312b386d9ac0065229b054d47f2c28`, Wings reference remains `a35d7ee12261af6eb84d4d9046f5e49dee01bde89b87d77cc2f2714e6020cc4d`, and Tide reference remains `14d04d90ffc6ae2bb708233796335a52777d2e277dbc097292750ae991a80d31`.
- Physical iPad testing is still pending. Do not claim device approval, production shipment, or release promotion until real-finger feel, audio, thermals, and sustained device frame pacing are accepted.
- `npm run test:release` and `npm run test:runner:phase4` remain authorization-bearing promotion gates and are not routine preview checks.

---

# PLAYFORGE — Session Handoff: Cinematic Reboot, Worlds 1–2 of 5 SHIPPED

Written 2026-07-13 for a FRESH SESSION / NEW ACCOUNT with ZERO prior context.
Read this top to bottom before touching anything. It supersedes nothing —
it sits ON TOP of `drift-gp/HANDOFF.md` (the Cinematic Reboot handoff), which
you should also read; both are self-contained enough to work from this one.

## 2026-07-14 PHASE 4 RELEASE-TRANSACTION HARDENING — PRIVATE, NOT PROMOTED

This section is the current release-safety state. It supersedes the Phase 4
transaction mechanics and old test counts below; the visual/gameplay context
in those sections still applies.

The corrected Gridlock Run candidate is still private. No positive production
release command was run during this hardening pass, no release PASS was
printed, and no corrected artifact was promoted. `npm run test:release` and
`npm run test:runner:phase4` remain authorization-bearing positive gates; do
not run either merely to inspect or continue this work. Physical iPad play,
real-finger feel, audio, thermals, and device frame pacing also remain pending.

The release transaction is now an exact, crash-recoverable two-party commit:

- The outer release supervisor creates a one-use candidate handoff. The Phase
  4 child consumes it and holds the exclusive release claim, bound to its
  canonical PID/start identity, from startup through its terminal report.
- Before any grant, the child validates the frozen parent build-input
  manifest, stages and installs one exact NEW generation, retains one exact
  OLD generation, writes a fsynced supervisor report, and publishes a
  PID/start-bound READY record. It is not committed at READY.
- The outer supervisor independently validates the exact live child, all
  current and previously observed process identities, descendants, marker
  processes, handles, requests, temp files, report, candidate hashes, source
  manifest, and gate deadline. LIVE or UNKNOWN unexpected identities fail
  closed. It then atomically races prewritten `COMMIT_GRANTED` and `REVOKED`
  candidates through a same-filesystem hard-link compare-and-set; exactly one
  terminal gate decision can win.
- After `COMMIT_GRANTED`, the child synchronously rechecks the live outer
  authorization, its exact claim, the complete parent build-input manifest,
  and exact NEW/OLD manifests. Only then does it fsync a `commit-intent`
  journal containing `finalCommitAck:true`. That durable final ACK is the
  monotonic commit point; recovery must finish NEW even if the child dies
  before the root rename or committed-journal write. An awaiting-grant or
  generic older commit-intent without the final ACK rolls back exact OLD.
- A committed child deliberately retains the committed journal and exact OLD
  committed-backup root as a durable terminal receipt. The outer supervisor
  always runs bounded recovery after closing the gate, validates whether
  recovery `finished-commit` or `rolled-back`, then removes the receipt. A
  post-grant child timeout plus `finished-commit` is classified `ACKED_NEW`,
  never the contradictory timeout-plus-NEW result. A revoked/READY timeout
  that recovers OLD exits 124. A child exit 0 without a durable final ACK is a
  failure and cannot be promoted.
- The outer supervisor independently revalidates frozen source inputs,
  dist/standalone bytes, all 12 screenshots plus the frame board, and
  localhost/LAN parity before accepting `ACKED_NEW`. Negative fixtures are
  structurally non-release-eligible: even the deliberate final-ACK timeout
  classifier prints only `FIXTURE_OK ACKED_NEW`, exits sentinel 42, and cannot
  print release PASS.

Current serial verification, run without a positive release:

- `npm run test:runner:phase4:negative`: 54/54 pass in 40.91s. Coverage
  includes one-use handoff and exact process identity, atomic grant/revoke,
  late source mutation after READY, every post-ACK crash cut, exact OLD/NEW
  recovery, claim exclusion through final ACK, kill/restart recovery at every
  install boundary, divergent evidence preservation, inode/mode/xattr
  restoration, resource/process/temp hygiene, and fail-closed fixture rules.
- `npm run test:release:watchdog-negative`: 10/10 pass in 32.05s. Coverage
  includes marked and unmarked detached descendants, exit 0 without final ACK,
  mid-install and pre-ACK commit-intent recovery to OLD, killed durable final
  ACK recovery to NEW, the post-grant completion-timeout classifier, READY
  timeout/revoke, late source mutation, and an unexpectedly successful outer
  fixture that still cannot print PASS or touch officials.
- Both package-level Node test-file allowances are now 120s because the
  expanded serial suites exceed the old 30s/15s caps. The safety deadlines
  inside the supervisors and fixtures were not relaxed. All changed release,
  transaction, fixture, and test modules pass `node --check`.

The final read-only audit found no promotion journal or pending journal, no
backup or committed-backup root, no stage root, no Phase 4 claim, no matching
supervisor/release temp root, and no matching live process. Every
official-touching fixture snapshots and rechecks the complete 17-artifact set;
all 17 remained byte-identical. The exact post-suite inventory is:

- Runner dist and standalone:
  `009bdb89c804db27a09107ef7b36e371aa858e78615d7f71491d48d934ed6ca0`
- Golf dist and standalone:
  `cb4a1d5ca25de2a1f0d719fb033bb4b8ba312b386d9ac0065229b054d47f2c28`
- Frame board: `7a6e1b01aea70925dc0ab7320bed86ca4c75ccbb38d92d50a9c72433fce65a10`
- 1024×768 finish/gameplay/recovery/hero/opening/slide, respectively:
  `6f1a8c8dd2aff9cd3cd8f66690be84eb6c24daec18e48710823a5c9be823651c`,
  `a6366d5bd190187590ae3c67c8cf5d2752a2e121fb6a4bd609415fb967165c42`,
  `e37319d4993698fb0ad9f9cb4b2c88eb7344d004eebaf570a6e3579e3ec5b2e1`,
  `f7e2d5b90f7aba789536f0914ef30dbd20acca09805a4c479327cc773e6a48cb`,
  `103dcc47f47a6577d1054f0e1571f62f12eb16a3d08b009a9da885c96c771e88`,
  `eb633eaaf81bd88d425e23ebcbfcd7d1df6a94d029e846822d1e035e09f5cba3`
- 1366×1024 finish/gameplay/recovery/hero/opening/slide, respectively:
  `d0b7025f29e311b94211d48dcdc99ae59550fd586f9fdfc6369ac86b73f3097e`,
  `a6ec11c7810fc707a6a76a2d9ee5fc77ba42e09c8448433776d36b460a332291`,
  `b1dba8bd5a09359c22c38993b0715051c560d2b3d6a4ffab7101653b9d055e20`,
  `6c1c39c31827040701013d6494e5bbd8a9bfcf6466198b36dc1954666ff3b624`,
  `784c52a1cc7f78edc235691e533544fa615a7de1f33b738865e4c6ee6b52e4a7`,
  `96b068b5615035927163e14ce9fa9c672569cb423bb02bfc70c6553ff96fdf78`

Key implementation files are `tools/runner.phase4.handoff.mjs`,
`tools/runner.phase4.lock.mjs`, `tools/runner.phase4.frozen.mjs`,
`tools/runner.phase4.promotion.mjs`,
`tools/runner.phase4.supervisor-report.mjs`,
`tools/shipcheck-phase4.mjs`, and `tools/shipcheck-release.mjs`. The adversarial
coverage lives in `tools/runner.phase4.watchdog.test.mjs` and
`tools/shipcheck-release.watchdog.test.mjs`.

## 2026-07-14 GRIDLOCK RUN PHASE 4 CORRECTION — PRIVATE, NOT PROMOTED

This is the current state. It supersedes the earlier Phase 4 milestone below:

- The corrected private source has independent visual and code-review
  approval. Couriers are articulated athletic humanoids with eight finite,
  deck-safe pose families; recovery now shows the real safe pad, Relay anchor,
  tether, and rewind trail; terminal framing shows all four rank-driven poses;
  the finish handler clears any checkpoint toast and sets `TRAINING CLEAR` at
  the real terminal transition.
- District safety is audited from actual transformed `Mesh` and
  `InstancedMesh` world bounds, not semantic metadata. Seven destructive
  browser mutations prove detection and clean restoration: moved/scaled Aster
  Relay, moved instance, detached Relay, removed tapered mast, detached
  instance batch, and decremented instance count.
- `tools/runner.phase4.mjs` is now worker-only. The advertised parent is
  `tools/shipcheck-phase4.mjs`; it owns a unique marker/temp/process group,
  validates the report and exact artifact set, uses TERM→poll→KILL→poll plus
  marker fallback, removes all owned state, and alone may print PASS. Release
  mode has an atomic exclusive lock and a registered six-destination
  transaction (shots, board, Runner dist/standalone, Golf dist/standalone).
  Staging is fully decoded and hashed; old destinations remain as backups
  through installed-file, network, frozen-source, resource, process, and temp
  validation. Any pre-commit error rolls all six back. Development mode
  cannot write screenshots or promote.
- Parent validation independently hashes the fresh Runner/Golf artifacts and
  requires an exact parity schema for `fresh`, `dist`, `standalone`,
  `localhost`, and `lan`; every value must be lowercase SHA-256, equal fresh,
  and fresh must equal the independently read artifact. Every source, staged,
  and installed PNG is CRC-checked, inflated, structurally decoded, and
  required to be exactly 1366×1024, 1024×768, or 1440×900 as appropriate.
- `npm run test:runner:phase4:negative` passes 11/11 fixtures: malicious
  inherited environment; a deliberate supervisor process/temp leak observed
  before test-side hygiene; concurrent release-lock rejection before writes;
  post-boot synchronous hang; never-resolving evaluation; close failure plus
  detached marker fallback; missing/unequal/stale-equal parity reports;
  truncated/CRC-corrupt/wrong-size PNGs; partial-copy staging failure;
  wrong-size staged screenshot; and post-install rollback of all six official
  destinations while proving backups survive until rollback. Natural residue
  is snapshotted before any emergency kill/remove; successful fixtures leave
  zero process/temp/handle/request/stage/backup residue.
- `npm run test:runner:phase4:dev` passes and prints
  `DEV PASS — NOT RELEASE ELIGIBLE`; it reports `releaseEligible:false`, an
  explicit parity skip, zero shots, a null board, and empty teardown handles
  and requests. The fresh private Runner is
  `326922f940d1543ba8f2f11eb2a9ea8000040acf829c9edb351581bf5526b539`,
  927,795 raw bytes / 247,179 gzip. Worst observed calls are 172 normal and
  143 lowfx. All 13 Runner unit tests pass.
- The visually approved private re-review board is
  `runner/private-phase4-correction/gridlock-run-private-correction-board.png`.
  It contains seven frames at both source resolutions (including results).
  Finish was recaptured from a real full-course autopilot run at 150/150m;
  runtime and pixels both show `TRAINING CLEAR`, an empty toast, and no stale
  `CHECKPOINT 120M`. These are private review assets, not promoted release
  screenshots.
- `npm run test:release` is configured in this exact order: foundation,
  direct post browser, post negatives, Golf Phase 2, Runner Phase 3, Phase 4
  negatives, Phase 4 positive. `audit:touch` was removed. Its outer supervisor
  owns a unique run marker and sampled descendants, applies
  TERM→poll→KILL→poll on timeout, and checks marker/descendant/temp/handle/
  request residue after every phase. `npm run test:release:watchdog-negative`
  passes 1/1 by spawning a detached marked grandchild, timing out in 750ms,
  and proving the supervisor removed it before test-side hygiene. Release
  preflight rejects all inherited `RUNNER_PHASE4_*` controls before starting
  any phase.

Latest bounded evidence: Phase 4 negatives passed 11/11 in 10.81s, the outer
release watchdog negative passed 1/1 in 1.90s, and the non-promoting Phase 4
development gate passed in 7.6s with empty handles/requests. SHA-256 snapshots
of all 12 official shots, the official board, and both games' dist/standalone
files were byte-for-byte identical before and after these tests. Runner stayed
`009bdb89c804db27a09107ef7b36e371aa858e78615d7f71491d48d934ed6ca0`
and Golf stayed
`cb4a1d5ca25de2a1f0d719fb033bb4b8ba312b386d9ac0065229b054d47f2c28`.

**Do not claim shipment:** the Phase 4 release gate, promoted parity, public
artifact promotion, full release chain, and physical iPad validation were
deliberately not run after this correction. The Runner promoted hash/URL in
the historical section below is the older candidate, not this private source.

## 2026-07-14 GRIDLOCK RUN PHASE 4 — PRE-CORRECTION MILESTONE (HISTORICAL)

Phase 4 is the approved presentation rebuild on top of the frozen Phase 3
gameplay foundation. The 150m course is now a coherent midnight delivery run,
not the prior gray-box visual pass:

- `runner/src/courier.js` builds four articulated, top-level courier roots:
  player K-6 plus VOLT, NYX, and JET. They share cached geometry but own
  independent named bilateral rigs, absolute deterministic run/air/slide/
  crouch poses, distinct silhouettes/cadences, and asymmetric accent parcels
  with parcel-eye tethers. The title frames all four at a verified 47° azimuth;
  gameplay uses a restrained 47° chase camera.
- `runner/src/districts.js` is course-model-fed scenery for five exact zones:
  DISPATCH ROOF 0–25m, RAIN SPAN 25–60m, SWITCHYARD 60–90m, MAGLEV
  UNDERCROFT 90–112m, and RELAY CAUSEWAY 112–150m. It adds instanced façade
  hierarchy, rails, signals, maglev traffic, and the Aster Relay landmark.
  Every decoration is outside the cue corridor or safely overhead. Repeated
  Relay rings, warnings, hazard anchors, checkpoints, and safe pads are
  batched; diagnostic anchors remain non-rendering `Object3D`s.
- `runner/src/city.js`, `runner/src/main.js`, and `runner/index.html` own the
  production palette, readable course cues, title/HUD composition, restrained
  rain/bloom, lineup staging, and visual diagnostics. Hazard-body geometry,
  obstacle transforms, collision alignment, and all gameplay timing remain
  untouched.
- The frozen gameplay hashes are still exactly: course
  `b1fd096f0e0461cbf170b3225c3b49eb8991f006641d0fd19122431594535e2c`,
  sim `e439c8de6f5a105d03e4b235771553c05ed0b3097c165e5c98f627dfdbedba95`,
  flow `809f563a6a2b47f5d8f4867697f68bbc56f126af0f02f06ffaae5d97c8e74b72`,
  and action
  `d920c38bf295d6aeb937ad4855ec6fc7e03b82edb0d8262ff59a5a07f84294a8`.
  `engine/post.js` is the one intentional shared-engine correction in this
  release; rebuilding both Golf and Runner after it was mandatory.

`tools/post.browser.mjs` now directly boots the real shared post pipeline and
both private source games at an iPad-class DPR. It proves renderer/composer/
bloom sizing at 1194×834, portrait rotation and landscape return, normal PR
1.6 with MSAA×4, lowfx PR 1 with MSAA off, governed PR 1.35→1.1→1.0, bloom
disable, no WebGL error/context loss, and empty teardown ownership. The
separate watchdog-negative gate proves a synchronous worker hang exits 124 and
a never-resolving page evaluation times out, with no surviving processes,
temporary roots, handles, or requests.

`tools/runner.phase4.mjs` is the production visual hard gate. It freshly builds
both games, enforces Runner raw/gzip limits, requires fresh source == dist ==
standalone == localhost == LAN for BOTH games, checks the courier/district/
camera/slide contracts, sweeps title plus s=5/55/75/145 in normal and lowfx,
drives a genuine final-gap recovery, runs three deterministic clean replays,
and rejects any resource growth. It writes all six named frames at both
1366×1024 and 1024×768 plus `runner/gridlock-run-v1-frames.png`. The final
frames are opening, hero s14, gameplay s60, slide s90–92, genuine recovery,
and finish; all 12 were visually inspected. The screenshot harness waits for
the real countdown/tutorial overlays to clear before the hero frame.

Final Phase 4 measurements from the promoted candidate:

- Runner bundle: 900,888 raw bytes / 239,149 gzip bytes.
- Normal worst case: 171/180 draw calls and 22,869/160,000 submitted
  triangles. Scene inventory is 64/72 geometries, 33/36 materials, 6/8
  textures (largest edge 1024), 15/24 transparent renderables, and 16/16 mesh
  shadow casters.
- Lowfx worst case: 138/145 draw calls and 19,299/90,000 submitted triangles;
  60 geometries. The draw-call margins are 9 normal and 7 lowfx.
- Three replays retained the exact same scene inventory and WebGL memory
  (65 geometries / 22 internal textures), with finite transforms and no page
  errors.

The advertised bounded release command is now `npm run test:release`. Its
900s outer supervisor runs, in order: foundation, direct post browser,
post watchdog negatives, `audit:touch`, Golf Phase 2, Runner Phase 3, and
Runner Phase 4. The final complete chain exited 0. Phase 3 retained 55/55
geometry observations at maximum delta `2.414e-6`; post direct/negative,
Golf, Runner gameplay, visual/replay/budget gates, and all parity checks passed.

Promoted byte-identical surfaces:

- Runner `009bdb89c804db27a09107ef7b36e371aa858e78615d7f71491d48d934ed6ca0`:
  `http://192.168.1.137:8091/runner/gridlock-run-v1.html?v=009bdb89`
- Golf `cb4a1d5ca25de2a1f0d719fb033bb4b8ba312b386d9ac0065229b054d47f2c28`:
  `http://192.168.1.137:8091/golf/stackyard-golf-v1.html?v=cb4a1d5c`

Residual approval is physical only: both candidates are comprehensively
headless-tested, but real-finger feel, audio by ear, thermal behavior, and true
iPad frame pacing remain unverified. Do not claim device approval until Shaun
and his daughter replay Golf and the full Runner course on the actual iPad.

## 2026-07-14 GRIDLOCK RUN PHASE 3 — 0–150M GAMEPLAY FOUNDATION

The approved three-lane vertical slice now replaces the broken five-second
restart loop. This section records the frozen gameplay/readability foundation;
the Phase 4 section above supersedes its former gray-box presentation.

- `runner/src/course.js` owns the private spline and immutable authored route,
  hazards, checkpoints, safe pads, lane offsets, rivals, and all course-to-world
  conversion. No Runner consumer calls a raw path `at()` outside this model.
- `runner/src/sim.js` is pure deterministic gameplay: simulation-time jump
  buffer/coyote/double-jump/slide/lane motion, exactly-once crash events, local
  recovery, rivals, interpolation snapshots, and terminal freeze.
- `runner/src/action.js` resolves up/down/left/right on the canvas as soon as
  the swipe threshold is crossed. The old tap/hold grammar is gone.
- `runner/src/flow.js` owns the guarded title → intro → countdown →
  tutorial/race → crash/recover or failed/results graph using tick-owned
  schedules only.
- `runner/src/main.js` uses actual wall delta with the fixed-step runner,
  presentation interpolation, authoritative screens, completed button clicks,
  close gray-box chase camera, test-visible diagnostics, and the shared
  renderer/atmosphere/audio stack.
- Authored lessons: safe up-swipe launch; forgiving jump; checkpoint 55m;
  nonlethal lane choice; generous 1.25s slide; checkpoint 120m; consequential
  centre-lane + gap test; finish at 150m.
- Each hazard now owns both its early `cueStart` and its safe `actionAt` in the
  course model. The UI visibly fades in `GET READY`, then changes to the
  actionable swipe command at that course-owned point. The first lethal cue
  remains usable for at least 0.75s after its real CSS fade at maximum speed.
- The 2026-07-14 correction pass removed recovery's presentation timer:
  `recover` can leave only when the pure simulation emits
  `recovery-complete`, and gestures remain disabled until that event. Five
  consecutive 420ms main-thread stalls stay locked; the sixth fixed sample
  completes recovery and the first subsequent swipe is accepted.
- Rival meshes, HUD rank, result headline/rows, ordering, and finish times now
  read one time-aware authoritative standings state. The 120Hz path uses
  caller-owned fixed-step, action, presentation, event, and pose buffers; real
  counters prove the legacy allocating paths are not called. Complete replay
  exports include transient hazard Sets.
- City diagnostics now measure 55 constructed observations against independent
  course/collider anchors. Blocker boundaries come from actual body-mesh edge
  vertices, overhead-gate boundaries come from actual body-mesh vertices, and
  gaps come from actual deck-ribbon boundary vertices. The body geometry is
  authored directly at the exact curved course endpoints, eliminating the old
  0.107m straight-box approximation. Missing body/ribbon meshes and deliberate
  1m offsets of the parent group, body child, or deck ribbon fail. Hazard
  body triangle winding is outward with nondegenerate faces, computed normals,
  and default `FrontSide` materials; an actual-mesh unit gate inspects every
  blocker, overhead, and combined body child. Hazard warnings are lane-specific,
  the finish sign faces the approach, and overhead/jump posture remains valid
  through the full obstacle span.
- The Runner gate owns every page, CDP session, HTTP socket, browser process,
  child stdio pipe, and temporary artifact. Success JSON prints only after a
  bounded teardown; macOS Chrome process groups are killed/waited if graceful
  close stalls. The advertised package hard gate does not execute `node:test`
  in its own process: `tools/shipcheck-runner.mjs` is a true parent watchdog
  that runs unit/orientation/ownership tests and then the browser gate in
  separate process groups. It captures descendants before TERM/KILL, removes
  only its uniquely prefixed temporary builds, and returns `124` on timeout.
  Browser-page and CDP operations and the Vite build also have narrower bounds.
- Both success and failure report public/internal file descriptors, endpoints,
  and ref state. The standalone hard gate forces an exactly empty non-stdio
  baseline and an exactly empty final introduced-resource set. `audit:touch`
  explicitly permits resources already owned by its Golf caller, classified by
  stable object identity rather than count or type; a same-type replacement is
  still a Runner leak. Requests use the same identity rule.
- Every ship gate freshly rebuilds Runner and requires those bytes to equal
  dist, standalone, localhost, and LAN. It also enforces the current Golf
  dist/standalone/localhost/LAN parity promise. Stale promoted bytes fail before
  browser gameplay begins; localhost/LAN origins and individual URLs can be
  overridden by environment for a different test host.

Hard gate: `npm run test:runner:phase3` (11 pure simulation scenarios, one
actual-mesh orientation scenario, one handle-ownership identity scenario, plus
fresh-build iPad browser scenarios). Direct developer commands remain
`npm run test:runner:unit` and `npm run test:runner:browser`; only the advertised
combined command carries the preemptive outer guarantee. It verifies 55/55 real
geometry observations at
maximum delta `2.414e-6` inside an honest `2e-5` tolerance; 1m actual hazard
parent, body-child, and deck-ribbon offsets plus missing-body/ribbon negatives;
all four swipes before
pointer-up exactly once; all cancellation paths; and a genuine-swipe run that
waits for emitted, visibly faded cues and course-owned action points. The
combined cue provided `0.926s` usable runtime in the final release run. It
also verifies event-owned 121.5m recovery, three exact shield spends,
authoritative rival parity, JET first/player second across HUD/results/headline,
visible `TRAINING DECK` replay state, one terminal result, frozen terminal
simulation, inactive-screen audits, and zero page errors. The normal-quality
browser gate measured 181 frames at 8.34ms average / 8.90ms p95 / 9.4ms max,
zero frames over 50ms, 181 preallocated presentation writes, zero legacy
fixed/action allocations, and stable caller-owned output identities. Shared
foundation is 17/17 plus 12,291 browser samples with zero violations; the full
Golf Phase 2 regression also passes.

The final release-candidate sequence
`npm run test:foundation && npm run audit:touch && npm run test:golf:phase2 && npm run test:runner:phase3`
exited `0` in `164.301s`: foundation 17/17, Runner 13/13, both promoted hashes,
and zero new Runner handles/requests. The exact advertised hard gate passed
three final-candidate repetitions in `24.715s`, `24.456s`, and `24.603s`, each
with empty baseline handles/requests and empty final handles/requests.
`npm run test:runner:watchdog-negative` injects a synchronous unit busy loop
and same-group descendant without editing production tests; it completed in
`1.570s` after observing the inner `124`, no survivors, and no temp delta.
Stale LAN bytes failed in `386ms`, forced 1ms Vite build in `141ms`, active-CDP
failure in `1.314s`, and browser-phase outer timeout in `2.747s`/`124`; all had
empty introduced-resource diagnostics, no orphan, and no new temp residue.

Historical Phase 3 artifact (superseded by the Phase 4 hash above; dist and
standalone were byte-identical at that gate):
`c66bdc677d108ca276155c8ff64cbd69120e4c47d8377ba772fd87ee98c5bb94`.
It is retained only as a gate record. Real-iPad/finger approval is still required:
`http://192.168.1.137:8091/runner/gridlock-run-v1.html?v=c66bdc67`.

The shared fixed-step correction also required a no-gameplay-change Golf
rebuild. That historical pre-Phase-4 Golf candidate was identical at
`cc2c85ece7038587f08738a5f7367f56353368a806dc88e77a7d50e96fef5205`:
`http://192.168.1.137:8091/golf/stackyard-golf-v1.html?v=cc2c85ec`.

## 2026-07-14 IPAD TOUCH REMEDIATION

Real-device play exposed two failures that the original mouse-based shipchecks
did not cover. They are fixed in the source and rebuilt standalone HTML files:

- Golf now uses a direct **swipe toward the intended shot**. The camera basis is
  captured once at touch-down and the aim camera stays fixed during the gesture,
  eliminating the camera/input feedback loop that made the guide spin.
- The shared touch layer now captures the active pointer, ignores secondary
  touches, prevents browser gesture takeover, and never fires an action from a
  cancelled pointer stream.
- Historical Runner v1 removed the title overlay from layout as soon as play
  started. Phase 3 now supersedes its entire tap/hold gameplay path.
- `tools/audit-touch.mjs` is the supported combined browser-input orchestrator.
  It delegates absolute captured-basis Golf swipes to `tools/golf.phase2.mjs`
  and directional Runner swipes to the `tools/runner.phase3.mjs` browser
  subgate; no superseded rotating-aim or tap/hold assertions remain. It is not
  the Runner release hard gate: `tools/shipcheck-runner.mjs` owns Runner units,
  browser coverage, and the outer process-tree watchdog.

The next gate is still a real-finger retest on Shaun's iPad. The historical golf
frame board still says “drag back”; the playable control now intentionally
supersedes that caption.

---

## 0. WHO / WHAT / WHERE

Playforge is Shaun's browser-native, instant-play UGC game platform — an
adult-first Roblox competitor. 28 worlds + a track editor. Runs as a PWA on
iPads (his kids are the first players). Everything must work as a single
self-contained HTML file or a Vite build with no install.

**THE ONE RULE:** `sundown-mesa-gp-v1.html` (World 1, the racer) is the
PINNED QUALITY BENCHMARK. Shaun's exact words this session:

> "v1 (sundownmesa game) is the new gold standard. No world, game, or level
> has lower quality than this.. Go ahead and build 5 other worlds with the
> same production quality"

**THE APPROVED LINEUP (Shaun picked "Handoff lineup +2" from multiple
choice):** each world gets its own cinematic palette, identical execution
quality:

1. **golf — Stackyard Golf** · dusk garden (string lights, fireflies) — ✅ SHIPPED v1
2. **runner — Gridlock Run** · neon-rain midnight city — ✅ SHIPPED v1
3. **ashfall — Ashfall** · volcanic dusk (embers, red lightning) — ⬜ NOT STARTED
4. **wings — Paper Wings** · alpine dawn above a cloud sea — ⬜ NOT STARTED
5. **tide — Low Tide** · moonlit harbor (lantern glow) — ⬜ NOT STARTED

Deliverable per world: **single-file HTML + 6-panel frame board PNG**, with a
one-line ask for verdict. Shipcheck (human-input Puppeteer gate) must pass
with zero page errors before delivery.

---

## 1. WHAT SHAUN HAS IN HAND (delivered this session)

- `stackyard-golf-v1.html` + `stackyard-golf-v1-frames.png`
- `gridlock-run-v1.html` + `gridlock-run-v1-frames.png`
- `worlds-reboot-src-session1.zip` — full source: shared engine + both worlds
  + shot/shipcheck harnesses + this handoff. **Re-upload this zip to resume.**

From before this session (still relevant):
- `sundown-mesa-gp-v1.html` — THE BENCHMARK (the two uploads
  `sundownmesagpv1.html` / `sundownmesagpv1_1.html` are byte-identical dupes)
- `driftgpsourcev1.zip` — benchmark source (`drift-gp/`), git history included
- `playforge-repo-v0.12.0.zip` — OLD platform: 28 worlds × 20 levels, stars,
  economy, Supabase multiplayer client, 57/57 smoke. **Visuals superseded —
  systems/design reference only** (level ramps, star rules, premises, net).
  three r128 pinned THERE only; the reboot uses three 0.185.

Verification state (be honest with Shaun): both shipped worlds verified
HEADLESS ONLY — full autoplay rounds + human-input gates, 0 page errors.
NOT verified: audio by ear, real-finger touch feel, true iPad framerate.
First real-device session should tune golf `MAXPOW`/friction and runner
jump/slide timing + all volumes.

---

## 2. WORKSPACE LAYOUT (this session's cloud box — recreate from zips)

```
playforge/
  repo/                 old platform v0.12.0 (from playforge-repo-v0.12.0.zip)
  drift-gp-source/      benchmark source (from driftgpsourcev1.zip)
  builds/               benchmark html copies
  worlds-reboot/        ← THE ACTIVE PROJECT (zip: worlds-reboot-src-session1.zip)
    package.json        three 0.185.1 · vite 8 · vite-plugin-singlefile 2.3.3
    node_modules/       (not in zip — npm install restores declared deps, including puppeteer)
    engine/             SHARED QUALITY FLOOR — see §3
    golf/               world 1 rebuild (index.html, src/{main,course}.js, dist/)
    runner/             world 2 rebuild (index.html, src/{main,city,courier,course,sim,action,flow}.js)
    tools/              golf.phase2.mjs = authoritative Golf Phase 2 gate;
                        post.browser.mjs = direct shared-post/iPad browser gate;
                        post.browser.watchdog.test.mjs = post failure cleanup;
                        shipcheck-runner.mjs = authoritative Runner parent hard
                        gate (units + browser + process-tree watchdog);
                        runner.phase3.mjs = Runner browser subgate only;
                        runner.phase4.mjs = production visual/parity/shot gate;
                        shipcheck-release.mjs = bounded exact release order
    HANDOFF.md          this file
```

Setup on a fresh box:
```bash
unzip worlds-reboot-src-session1.zip && cd worlds-reboot
# Use PUPPETEER_SKIP_DOWNLOAD=1 only when system Chrome/Chromium is installed.
PUPPETEER_SKIP_DOWNLOAD=1 npm install

# The release server is rooted HERE, not inside golf/dist or runner/dist.
python3 -m http.server 8091 -d . &

# The current Mac default is http://192.168.1.137:8091. On another machine,
# point the parity gate at that machine's reachable root-server origin; a
# cloud-only check with no LAN interface may use http://127.0.0.1:8091.
export PLAYFORGE_LAN_ORIGIN=http://192.168.1.137:8091

# Supported release gates:
npm run test:foundation
npm run test:post
npm run test:golf:phase2
npm run test:runner:phase3
npm run test:runner:phase4
npm run test:release
```

The Chrome resolver finds macOS Google Chrome and cloud
`/opt/pw-browsers/chromium-*` installs automatically. Set
`PUPPETEER_EXECUTABLE_PATH` only when Chrome lives elsewhere. The root server
must expose both promoted files before the Runner hard gate, because it verifies
fresh/dist/standalone/localhost/LAN parity:
```bash
curl --fail http://127.0.0.1:8091/golf/stackyard-golf-v1.html >/dev/null
curl --fail http://127.0.0.1:8091/runner/gridlock-run-v1.html >/dev/null
curl --fail "$PLAYFORGE_LAN_ORIGIN/runner/gridlock-run-v1.html" >/dev/null
npm run test:runner:phase3                    # exit 0 = complete Runner hard gate

# Exact bounded cross-project release sequence (includes post direct/negative,
# audit:touch, Golf Phase 2, Runner Phase 3, and Runner Phase 4):
npm run test:release
```

If source intentionally changes, rebuild/promote before starting that parity
server. From the project root, use `./node_modules/.bin/vite` (never bare
`npx vite`):
```bash
./node_modules/.bin/vite build golf --config golf/vite.config.js
cp golf/dist/index.html golf/stackyard-golf-v1.html
./node_modules/.bin/vite build runner --config runner/vite.config.js
cp runner/dist/index.html runner/gridlock-run-v1.html
```

---

## 3. THE SHARED ENGINE (worlds-reboot/engine/) — use it, don't re-derive it

Extracted from the benchmark so every world imports the same quality floor.
All five worlds MUST go through these modules.

- **post.js** → `createPipeline({canvas, lowfx, exposure, bloom:{strength,radius,threshold}, vignette, grain, fov, clear})`
  returns `{renderer, scene, camera, composer, bloom, grade, govern(dt), PR}`.
  ACES filmic, MSAA×4 HalfFloat HDR target, UnrealBloom, grade ShaderPass
  (vignette + grain + speed CA via `grade.uniforms.uCA`, keep ≤ ~1.5), pixel-
  ratio governor (PR 1.6→1.0 then bloom off if fps sags). Call
  `pipe.govern(rdt)` + `composer.render()` every frame; resize is wired.
- **atmo.js** → `buildAtmosphere(scene, renderer, cfg)` — parameterized sky
  shader (zenith/violet/horizon/sunHot + optional `stars` 0..1, `sunDisc`,
  `coronaPow`), FogExp2, key sun w/ tight following shadow box, fill + hemi,
  optional Lensflare + billboard clouds + silhouette `ranges`
  `[{radius,height,color,seedMul,blend}]`, PMREM env from the sky (PBR picks
  up the palette). Returns `{sky, sun, clouds, tick(dt,camX,camZ),
  followShadow(x,y,z)}` — CALL BOTH EVERY FRAME.
- **fx.js** → `Particles(scene, max, additive)` `.emit(x,y,z,vx,vy,vz,{life,size,grow,alpha,col,grav})`
  `.tick(dt)`; `SkidRibbon(scene, maxSeg, width, color, opacity)`.
- **sfx.js** → `unlock() onReady(fn) noiseLoop({type,freq,Q}).set(amt,vol,f)`
  `motorLoop(...)` `blip sweep thump beep uiTick notify fanfare(notes)`
  `pad({chords,interval,lp,types,vGain}).on(amt)` `toggleMuted()`.
  Build loops inside `SFX.onReady(...)`, call `SFX.unlock()` on first pointerdown.
- **cam.js** → `SpringCam(camera,{k,lookK,ffPos,ffLook,baseFov})`
  `.tick(dt, targetPos, targetLook, velV, {sway, fovTarget})` — velocity
  feed-forward chase (the "doesn't trail at speed" trick), `.snap()`,
  `.addShake(a)`; `orbit(camera, center, t, {r,h,speed,lookY,rise})`.
- **touch.js** → legacy `dragSteer`, `dragVector`, and `taps` helpers. The
  current Golf/Runner foundations use `gesture.js` controllers instead; do not
  restore Runner's old tap/hold grammar.
- **util.js** → `$ clamp lerp ease ORD mulberry fmt smooth(geo)` (mergeVertices
  + computeVertexNormals — MANDATORY for extruded silhouettes) `canvasTex
  readParams()` (AUTO/FAST/WARP/FREEZE/LOWFX from URL) `mergeGeos`.
- **base.css** → the full cinematic HUD kit (letterbox bars, chips, pill,
  puck, screens, toast, count). Worlds import it (`import '../../engine/base.css'`)
  and define palette CSS vars in their index.html `:root`
  (`--cream --dim --accent --h1/2/3 --glow --glowStrong --bg --frame ...`).
  Body classes: `.cine` = letterbox, `.play` = HUD visible.

**Every world implements this contract** (copy golf/runner as template):
- Modes: `title → intro(3 shots, 6.4s, skippable) → [count] → play →
  slow-mo finale → results`, PLAY AGAIN loops without re-intro.
- URL params: `?auto ?fast ?warp=N ?freeze=T ?lowfx` (+ world-specific).
- `window.__gp` test API: mode getters + `start setFreeze setAuto setWarp
  topcam again slowmo(v)` + world verbs (golf: `stroke(p,ang)`, runner:
  `jump slideOn/Off`). Keep the NAME `__gp` — harnesses rely on it.
- `window.__dbg = { camera, scene, THREE }` — debug raycasts (leave it in).
- 3 named AI rivals + live positions/rank + overtake toasts ("alive" rule).
- Playforge brand chip, GO-orange primary button, letter-spaced SF-style HUD.

---

## 4. THE TWO SHIPPED WORLDS (tuning reference)

### golf/ — Stackyard Golf (dusk garden, front six)
- Palette in `course.js PAL` (zenith 0x1E2650, horizon 0xFF9E78, lawns
  0x8FAC66/0x5A7A52…); sun `(-0.42, 0.225, -0.89)`, fog 0xC48490 d0.0013,
  stars 0.55. Fireflies additive gold; roving lantern PointLight per hole.
- 6 hand-built holes in `HOLES[]`: local frame (tee 0,0 → +z downrange),
  `rects` pads, wall `OUTLINES`, `tilt/mounds/steps`, hedges, moon gate,
  cup funnel (−0.06 gaussian). Pars 2,3,3,4,3,4. Bases/yaws/orgs tuned —
  layout contracted 0.72× around the center fountain; string-light ring R40±13.
- Physics: drag-back putt, `MAXPOW 13.2` (v0 = 2.2 + p*13.2), friction
  `1.35 + 0.05v (+1.4 under v1.8)`, slope accel −9.8∇h, wall restitution 0.55,
  cup capture d<0.40 & v<4.6, lip-out d<0.58 & v≥4.6, 8-stroke pickup.
- **Drag→world mapping is a STABLE DIRECT SWIPE** (`dragToWorldAngle`) — the
  camera basis is captured at touch-down, and swiping toward the target fires
  toward the target. Do not recompute the basis from a moving aim camera.
- Rivals MOSS/DREA/JUNO sample strokes around par (16% birdie / 46% par /
  24% bogey / 12% double) settled when you hole out; card + final leaderboard.
- `?hole=n` jumps start hole. Autopilot has per-hole waypoints (L-shapes,
  moon gate, terrace power boost).

### runner/ — Gridlock Run historical v1 tuning reference (neon rain, 640m)

The details below describe the superseded v1 build and are retained only as a
palette/premise reference. The active playable artifact is the Phase 4
production pass on the frozen Phase 3 150m foundation documented at the top of
this handoff.
- Palette `city.js PAL` (zenith 0x0A0E24, horizon 0x8E3E7E, cyan 0x2EE6FF,
  magenta 0xFF3EC8); moon key `(0.34,0.30,-0.89)` int 1.7 cool; fog 0x241A38
  d0.0024; sprawl-lights ground texture (emissive) fills the valley; 340
  window-lit towers (InstancedMesh ×2 materials), kanji neon signs, holo
  rings, animated traffic dots, rain ~11 emits/frame + deck splashes.
- Deck: open Catmull spline (`buildPath`, arc-length `at(s)`), ribbons
  BETWEEN gaps + under-deck skirts, emissive edge studs (cyan L / magenta R,
  skip gaps). Course s=0 at spline s+22. `deckQ(s)`.
- Obstacles deterministic (`mulberry(20260714)`): gaps 3.6–6+u (jump),
  double gaps 8.4–10.6, bars h1.05 (jump), signs (slide), spacing 26–52m
  tightening. First at 62m.
- Physics: target spd `12.5 + 13.5·min(1,s/520)` (accel 20 below 12, else
  3.2), GRAV 27, jump vy 10.9, double 10.4, coyote 0.12s, slide = hold,
  stumble ×0.45 + shake, 3 shields, fall → slow-mo 0.55 → respawn at 80m
  checkpoint, shields<0 → SIGNAL LOST results (distance). Finish → slow-mo
  orbit + fireworks + times vs bots.
- Rivals VOLT/NYX/JET base 20.6/21.4/22.3 + rubber band + sine pace dips;
  cosmetic hop arcs over gaps.
- Courier bot: extruded-silhouette torso (smooth-normals), visor band must
  keep `rotation.y = +Math.PI/2` (sphere φ=0 faces −x!), run/air/slide/crouch
  procedural poses in `courier.js`.

---

## 5. GOTCHAS PAID FOR THIS SESSION (do not re-pay)

1. **Group rotation vs math frame:** course/pad groups need
   `hold.rotation.y = +yaw` to match `toWorld(lx,lz) = org + (lx cosθ + lz
   sinθ, −lx sinθ + lz cosθ)`. The −yaw bug cost 3 debug rounds — verify with
   a raycast through `__dbg` if geometry "isn't where physics thinks".
2. **Screen-drag → world direction uses a captured camera basis** (golf bug):
   direct swipe is `aim = camFwd·(−ndy) + camRight·ndx`. Capture the basis once
   on pointer-down and keep the aim camera fixed until release; a live camera
   basis creates a direction/camera feedback loop and spinning aim.
3. **SphereGeometry φ=0 faces −x** — partial-sphere features (visors) need
   `rotation.y = +π/2` to face +z.
4. **SwiftShader harness timing:** game clock runs ~4–6× slow; page timers
   (setTimeout, e.g. the 300ms hold-to-slide) fire LATE because the main
   thread is saturated → **poll conditions with waitForFunction, never fixed
   sleeps**, and drive states via `__gp` (`setWarp`, `slowmo(0.02)` freeze for
   action screenshots). The current Runner release command already has a true
   parent process-tree watchdog; use `npm run test:runner:phase3`, not an outer
   shell `timeout`. Future isolated scripts must own an equivalent bound.
5. **One page-boot per harness run** (boot is minutes). Current phase gates own
   their fresh private artifact servers; promotion parity uses the single
   project-root server on 8091. Do not assign separate public ports per world.
   Use `waitUntil:'domcontentloaded'`, a bounded protocol timeout, and
   `?lowfx=1` for state-driving runs (still art-usable).
6. **`npx vite` inside a world folder can resolve a phantom npm-cache copy**
   — always call `../node_modules/.bin/vite build`.
7. **Watch your cwd in compound shell commands** — an `npm install` once
   landed inside `drift-gp-source/worlds-reboot` because `cd` only applied to
   a backgrounded segment (`A && B & C && D` groups as `(A&&B) & (C&&D)`).
8. Inherited from the benchmark (still true): ribbon geometry needs
   `side:DoubleSide` or correct winding; `mergeVertices()+computeVertexNormals()`
   after every Extrude; no CapsuleGeometry habits from r128 thinking; keep sun
   elevation ≥ ~0.19 (0.225 used in golf) or you get 60m shadow slabs —
   also set `castShadow=false` on tall pylons/beams/canopy trees; clamp wall
   dt 0.25 / physics dt 0.05; negative modulo `((i%n)+n)%n`.
9. **Frame boards:** Runner Phase 4 owns its frame board in
   `tools/runner.phase4.mjs`: six production frames at two iPad resolutions,
   then a browser-rendered 3×2 board. Inspect every source frame, not only the
   board. Never capture the hero frame under the GO/countdown overlay.

---

## 6. NEXT WORLDS — approved premises, palettes locked; build order

Process reminder: build standalone in its own folder; screenshot art loop
(build → serve → shot → LOOK → fix); human-input shipcheck; single HTML +
frame board + one-line verdict ask. Control verbs below follow the approved
"equally direct finger verbs" rule — sanity-check them with Shaun via one
multiple-choice ONLY if you change them.

**3. ashfall — "Ashfall" (volcanic dusk).** Old premise: survive 60–75s of
meteor rain, 3 hearts (old repo `src/worlds/ashfall.js` has the level ramp).
Plan: basalt caldera plain, erupting volcano on the skyline, ember-storm
particles, meteors with ground telegraph rings, lava-crack glow, red
lightning flashes in the ash deck (brief sky/light pulses). Palette: charcoal
+ ember orange 0xFF6E3A + magma red + ash violet; key light dim red-orange,
strong emissives. Verbs: **drag anywhere = move** (survivor hover-rover,
relative drag like the racer puck), **tap = dash** (i-frames + whoosh).
Alive: 3 named co-survivors dodging alongside, downed/overtake toasts,
survive-time + hearts results. High cam ~50° following with feed-forward.
**4. wings — "Paper Wings" (alpine dawn).** Old: glider, dive for speed,
ride thermals. Plan: launch peak above a layered cloud sea, pink-gold dawn
(reuse golf's warm sun recipe but colder zenith), snow peaks as ranges +
big instanced spires, 12 glowing ring gates descending to a valley meadow,
thermal columns (updraft particle shafts that give lift). Verbs: **drag =
pitch/bank** (vertical dive/climb trades speed/altitude, horizontal banks),
auto-forward. Alive: 3 rival gliders on the ring line, positions + toasts.
Slow-mo swoop finale over the meadow.
**5. tide — "Low Tide" (moonlit harbor).** Old: cast/hook/reel, haul tiers
t1/t2/t3, bite pacing (see old repo tide.js + its LV ramp). Plan: wooden
skiff, big low moon as key (cool, like runner's but larger disc), warm
lantern point light on the boat, star field, lighthouse sweep, biolum
shoals marking fish, gentle boat bob. Verbs: **drag back + release = cast**
(arc preview, reuses golf drag math), **tap = hook** in the bite window,
**hold = reel** against a tension arc (release before it snaps when the
fish glows red). Alive: rival boats' distant lanterns + harbor-board hauls
("OXBOW LANDED 9.2KG"), 90s night, haul tiers as results.

After all five ship: feel pass from Shaun's iPad notes → then re-integrate
platform systems (old `levels.js` 20-level ramps, stars, economy, `net.js`
multiplayer) into the rebuilt engine — the old repo's designs carry over.
Ship path unchanged: GitHub → Vercel → Add to Home Screen; Supabase keys
flip multiplayer LIVE (SQL in old repo README).

---

## 7. FIRST MOVES IN A FRESH SESSION

1. Read this file; skim `drift-gp/HANDOFF.md` §1 (benchmark checklist) if
   you have it.
2. Unzip `worlds-reboot-src-session1.zip` → `npm install` → start one
   project-root server with `python3 -m http.server 8091 -d .` → run
   `npm run test:release`. Do not serve `golf/dist` on 8091 or allocate a
   separate Runner port.
3. If Shaun has posted real-device feedback: do the golf/runner feel pass
   first (constants in §4 are the knobs).
4. Otherwise: start **ashfall** per §6 — new folder `ashfall/` copied from
   runner's skeleton (index.html palette vars + main.js structure), own
   `caldera.js` world module, and dedicated screenshot/release gates. Follow
   the current private-artifact/root-parity pattern instead of allocating
   fixed public ports 8093–8095. Deliver, then wings, then tide.
5. Keep every delivery: single-file HTML + frame board + one-line verdict ask.
