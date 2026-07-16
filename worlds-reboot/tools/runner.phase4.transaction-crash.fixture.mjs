import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { readFile, truncate } from 'node:fs/promises';
import {
  commitPromotionTransaction,
  createPromotionTransaction,
  finalizeGrantedPromotionJournalSync,
  installPromotionTransaction,
  preparePromotionForCommitGate,
  recoverPromotionJournal,
  stagePromotionTransaction,
  validateInstalledTransaction,
} from './runner.phase4.promotion.mjs';

const configPath = process.argv[2];
if(!configPath) throw new Error('transaction crash fixture requires a config path');
const config = JSON.parse(await readFile(configPath, 'utf8'));
if(![
  'mid-stage', 'mid-directory-backup', 'mid-file-backup', 'directory-displaced', 'mid-install',
  'post-install', 'recovery-directory-new-displaced', 'recovery-directory-old-restored',
  'recovery-file-old-restored', 'recovery-rollback-complete', 'recovery-partial-cleanup',
  'commit-intent', 'final-commit-ack', 'commit-point', 'post-commit', 'mid-committed-cleanup',
].includes(config.point)){
  throw new Error('invalid transaction crash point');
}

const transaction = createPromotionTransaction(config);
await stagePromotionTransaction(transaction, config.point === 'mid-stage' ? {
  afterCopy: async ({ count }) => {
    if(count !== 4) return;
    await new Promise(resolve => process.stdout.write(`transaction-crash-ready:${config.marker}:mid-stage\n`, resolve));
    process.kill(process.pid, 'SIGKILL');
  },
} : {});
if(config.point === 'mid-stage') throw new Error('mid-stage crash fixture unexpectedly survived SIGKILL');
if(config.point === 'mid-directory-backup' || config.point === 'mid-file-backup'){
  let killed = false;
  await installPromotionTransaction(transaction, {
    afterBackupChunk: async ({ item, destination }) => {
      const wantedKind = config.point === 'mid-directory-backup' ? 'directory' : 'file';
      if(killed || item.kind !== wantedKind) return;
      killed = true;
      // Files leave an exact unpublished hard link to the original inode;
      // directories die before the atomic OLD->backup rename.
      await new Promise(resolve => process.stdout.write(`transaction-crash-ready:${config.marker}:${config.point}\n`, resolve));
      process.kill(process.pid, 'SIGKILL');
    },
  });
  throw new Error(`${config.point} crash fixture unexpectedly survived SIGKILL`);
}
if(config.point === 'directory-displaced'){
  await installPromotionTransaction(transaction, {
    afterDisplaceItem: async ({ item }) => {
      if(item.id !== 'shots') return;
      await new Promise(resolve => process.stdout.write(
        `transaction-crash-ready:${config.marker}:directory-displaced\n`, resolve,
      ));
      process.kill(process.pid, 'SIGKILL');
    },
  });
  throw new Error('directory-displaced crash fixture unexpectedly survived SIGKILL');
}
if(config.point === 'mid-install'){
  await installPromotionTransaction(transaction, {
    afterInstallItem: async ({ index }) => {
      if(index !== 1) return;
      await new Promise(resolve => process.stdout.write(`transaction-crash-ready:${config.marker}:mid-install\n`, resolve));
      process.kill(process.pid, 'SIGKILL');
    },
  });
  throw new Error('mid-install crash fixture unexpectedly survived SIGKILL');
}

await installPromotionTransaction(transaction);
await validateInstalledTransaction(transaction);
if(config.point === 'final-commit-ack'){
  await preparePromotionForCommitGate(transaction);
  finalizeGrantedPromotionJournalSync({
    projectRoot: config.runnerRoot.replace(/[\\/]runner$/, ''),
    transactionId: transaction.marker,
    transaction,
    finalCommitGuard: () => {},
    afterDurableFinalCommitAck: () => {
      writeSync(1, `transaction-crash-ready:${config.marker}:final-commit-ack\n`);
      process.kill(process.pid, 'SIGKILL');
    },
  });
  throw new Error('final-commit-ack crash fixture unexpectedly survived SIGKILL');
}
if(config.point.startsWith('recovery-')){
  const wantedStep = {
    'recovery-directory-new-displaced': 'directory-new-displaced',
    'recovery-directory-old-restored': 'directory-old-restored',
    'recovery-file-old-restored': 'file-old-restored',
    'recovery-rollback-complete': 'rollback-complete-terminal',
    'recovery-partial-cleanup': 'cleanup-stage',
  }[config.point];
  await recoverPromotionJournal({
    projectRoot: config.runnerRoot.replace(/[\\/]runner$/, ''),
    afterRecoveryStep: async ({ step, item, existedBefore }) => {
      if(step !== wantedStep) return;
      if(config.point === 'recovery-partial-cleanup'){
        if(item?.id !== 'shots') return;
        assert.equal(existedBefore, true, 'partial-cleanup fixture requires a real owned stage removal');
      }
      await new Promise(resolve => process.stdout.write(
        `transaction-crash-ready:${config.marker}:${config.point}\n`, resolve,
      ));
      process.kill(process.pid, 'SIGKILL');
    },
  });
  throw new Error(`${config.point} crash fixture unexpectedly survived SIGKILL`);
}
if([
  'commit-intent', 'commit-point', 'post-commit', 'mid-committed-cleanup',
].includes(config.point)){
  const killAt = async () => {
    if(config.point === 'mid-committed-cleanup'){
      await truncate(`${transaction.committedBackupRoot}/runner-dist.html`, 3);
    }
    await new Promise(resolve => process.stdout.write(`transaction-crash-ready:${config.marker}:${config.point}\n`, resolve));
    process.kill(process.pid, 'SIGKILL');
  };
  await commitPromotionTransaction(transaction,
    config.point === 'commit-intent' ? { afterCommitIntent: killAt }
      : config.point === 'commit-point' ? { afterCommitPoint: killAt }
        : { afterCommittedJournal: killAt });
  throw new Error(`${config.point} crash fixture unexpectedly survived SIGKILL`);
}
await new Promise(resolve => process.stdout.write(`transaction-crash-ready:${config.marker}:post-install\n`, resolve));
setInterval(() => {}, 1_000);
