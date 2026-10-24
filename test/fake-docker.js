const cp = require('child_process');
const fs = require('fs');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');

const record = (args) => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\n'); };

cp.execFile = (cmd, args, opts, cb) => {
  record(args);
  const rows = [
    { ID: 'a1', Names: 'web', Image: 'nginx:latest', State: 'running', Status: 'Up 3 days' },
    { ID: 'b2', Names: 'api', Image: 'node:20', State: 'running', Status: 'Up 2 hours' },
    { ID: 'c3', Names: '<img src=x onerror="window.__pwned=1">', Image: '<script>window.__pwned=2</script>', State: 'running" onmouseover="window.__pwned=3', Status: '<b>x</b>' },
  ];
  setImmediate(() => cb(null, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'));
};

cp.spawn = (cmd, args) => {
  record(args);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const tail = args[args.indexOf('--tail') + 1];
  const total = 60000;
  const n = tail === 'all' ? total : Math.min(total, parseInt(tail, 10));
  const samples = [
    (i) => `INFO  request handled id=${i} duration=12ms`,
    (i) => `ERROR <img src=x onerror="window.__pwned=4"> <script>window.__pwned=5</script>`,
    (i) => `\x1b[31m<svg onload="window.__pwned=6">\x1b[0m red`,
    (i) => `WARN  "quote \\" <iframe src=javascript:window.__pwned=7>" https://evil.example/"><script>window.__pwned=8</script>`,
  ];
  let i = total - n;
  let killed = false;
  const base = Date.parse('2026-10-24T00:00:00Z');
  const pump = () => {
    let chunk = '';
    for (let k = 0; k < 2000 && i < total; k++, i++) chunk += `${new Date(base + i * 1000).toISOString()} ${samples[i % samples.length](i)}\n`;
    if (chunk) child.stdout.write(chunk);
    if (i < total && !killed) setImmediate(pump);
  };
  setImmediate(pump);
  child.kill = () => { killed = true; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', 0)); };
  return child;
};
