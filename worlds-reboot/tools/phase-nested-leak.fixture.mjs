import {
  releaseCapturedGatedNode,
  scopedGatedTitle,
  spawnCapturedGatedNode,
} from './phase-isolated-node.mjs';

const marker = process.argv[2];
const waitFixture = new URL('./phase-wait.fixture.mjs', import.meta.url).pathname;
const nested = spawnCapturedGatedNode({
  title: scopedGatedTitle(`${marker}:nested-leak`),
  args: [waitFixture, `${marker}:nested-leak-target`],
  stdio: 'ignore',
});
await releaseCapturedGatedNode(nested);
nested.child.unref();
process.stdout.write('nested-leak-created\n');
