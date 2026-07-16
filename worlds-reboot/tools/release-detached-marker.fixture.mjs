import {
  releaseCapturedGatedNode,
  spawnCapturedGatedNode,
} from './phase-isolated-node.mjs';

const marker = process.argv[2];
const waitFixture = new URL('./phase-wait.fixture.mjs', import.meta.url).pathname;
const owned = spawnCapturedGatedNode({
  title: `${marker}:detached`,
  args: [waitFixture, `${marker}:detached-target`],
  stdio: 'ignore',
});
await releaseCapturedGatedNode(owned);
owned.child.unref();
process.stderr.write(`release-detached-marker-fixture:${marker}\n`);
setInterval(() => {}, 1_000);
