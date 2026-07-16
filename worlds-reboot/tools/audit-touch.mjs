/* Current iPad touch audit orchestrator.

   Golf Phase 2 owns absolute, captured-camera-basis swipe coverage and touch
   cancellation. Runner Phase 3 owns immediate directional swipe thresholds,
   all cancellation paths, visibly emitted course cues, recovery, and replay.
   Keep this entry point as a compatibility command, but never duplicate the
   gameplay grammars here: the authoritative gates build fresh private
   artifacts and exercise iPad touch input themselves. */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

console.log('Playforge current touch audit: Golf Phase 2 + Runner Phase 3');
await import('./golf.phase2.mjs');
const runnerSupervisor = fileURLToPath(new URL('./shipcheck-runner.mjs', import.meta.url));
const runner = spawnSync(process.execPath, [runnerSupervisor, '--browser-only'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: { ...process.env },
  stdio: 'inherit',
  timeout: 300_000,
  killSignal: 'SIGKILL',
});
if(runner.error) throw new Error(`Runner browser supervisor failed: ${runner.error.message}`, {
  cause: runner.error,
});
if(runner.status !== 0){
  throw new Error(`Runner browser supervisor exited ${runner.status}${runner.signal ? ` by ${runner.signal}` : ''}`);
}
