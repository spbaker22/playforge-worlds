const label = process.argv[2] || '';
if(label) process.title = label.slice(0, 180);
setInterval(() => {}, 1_000);
