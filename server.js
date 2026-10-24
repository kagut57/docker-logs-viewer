const http = require('http');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '6060', 10);
const HOST = process.env.HOST || '0.0.0.0';
const USER = process.env.AUTH_USER || 'admin';
const PASS = process.env.AUTH_PASS;
const MAX_LINES = Math.max(1000, parseInt(process.env.MAX_LINES || '100000', 10) || 100000);
if (!PASS) {
  console.error('AUTH_PASS env var is required');
  process.exit(1);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function authed(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString();
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEq(decoded.slice(0, i), USER) && safeEq(decoded.slice(i + 1), PASS);
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const BATCH = 1000;

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function streamLogs(req, res, name, tail) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const child = spawn('docker', ['logs', '-f', '--tail', tail, '-t', name]);
  const streams = [child.stdout, child.stderr];
  let batch = [];
  let timer = null;
  let paused = false;
  let closed = false;

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!batch.length || closed) return;
    const ok = res.write(`data: ${JSON.stringify(batch)}\n\n`);
    batch = [];
    if (!ok && !paused) {
      paused = true;
      streams.forEach((s) => s.pause());
      res.once('drain', () => {
        paused = false;
        streams.forEach((s) => s.resume());
      });
    }
  };

  const push = (line, err) => {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    batch.push(err ? [line, 1] : [line]);
    if (batch.length >= BATCH) flush();
    else if (!timer) timer = setTimeout(flush, 40);
  };

  for (const stream of streams) {
    const err = stream === child.stderr;
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) push(line, err);
    });
    stream.on('end', () => { if (buf) push(buf, err); buf = ''; });
  }

  const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 20000);

  child.on('close', () => {
    flush();
    clearInterval(ping);
    if (!closed) { res.write('event: end\ndata: {}\n\n'); res.end(); }
  });
  child.on('error', (e) => {
    clearInterval(ping);
    if (!closed) { res.write(`event: fail\ndata: ${JSON.stringify(String(e.message))}\n\n`); res.end(); }
  });
  res.on('close', () => {
    closed = true;
    clearInterval(ping);
    if (timer) clearTimeout(timer);
    child.kill();
  });
}

const server = http.createServer((req, res) => {
  if (!authed(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Docker Logs"' });
    return res.end('Unauthorized');
  }
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  }

  if (url.pathname === '/api/config') {
    return json(res, 200, { maxLines: MAX_LINES });
  }

  if (url.pathname === '/api/containers') {
    return execFile('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return json(res, 500, { error: String(err.message) });
      const list = out.split('\n').filter(Boolean).map((l) => {
        const c = JSON.parse(l);
        return { id: c.ID, name: c.Names, image: c.Image, state: c.State, status: c.Status };
      });
      json(res, 200, list);
    });
  }

  if (url.pathname === '/api/logs') {
    const name = url.searchParams.get('name') || '';
    let tail = url.searchParams.get('tail') || '200';
    if (!NAME_RE.test(name)) { res.writeHead(400); return res.end('bad name'); }
    if (tail !== 'all' && !/^\d{1,7}$/.test(tail)) tail = '200';
    return streamLogs(req, res, name, tail);
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, HOST, () => console.log(`Docker logs viewer on ${HOST}:${PORT}`));
