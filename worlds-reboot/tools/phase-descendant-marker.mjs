import assert from 'node:assert/strict';
import './phase-child-process-guard.mjs';

const marker = process.env.PLAYFORGE_INTERNAL_DESCENDANT_MARKER;
assert.match(marker || '', /^[A-Za-z0-9:_-]{8,220}$/, 'owned descendant marker');

// A separately gated leader must retain its exact parent-captured title. Any
// ordinary nested Node process gets a recursively inherited, discoverable
// title before its requested script/test module can execute.
if(process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_FD === undefined
  && process.env.PLAYFORGE_INTERNAL_SPAWN_GATE_NONCE === undefined){
  process.title = `${marker}:owned-descendant`;
}
