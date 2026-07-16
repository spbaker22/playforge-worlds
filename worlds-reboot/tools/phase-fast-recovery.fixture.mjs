const marker = process.argv[2];
const code = Number(process.argv[3]);
process.stdout.write(`${JSON.stringify({ recovered: false, action: 'none', transactionId: marker })}\n`);
process.exitCode = code;
