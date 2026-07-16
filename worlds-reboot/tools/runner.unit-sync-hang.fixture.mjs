import { spawn } from 'node:child_process';

const marker = process.argv[2];
spawn(process.execPath, [new URL('./phase-wait.fixture.mjs', import.meta.url).pathname, `${marker}:descendant`], {
  stdio: 'ignore',
});
while(true){}
