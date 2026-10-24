const http = require('http');
const net = require('net');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '6060', 10);
const HOST = process.env.HOST || '0.0.0.0';
const USER = process.env.AUTH_USER || 'admin';
const PASS = process.env.AUTH_PASS || '';
const MAX_LINES = Math.max(1000, parseInt(process.env.MAX_LINES || '100000', 10) || 100000);
const MAX_STREAMS = Math.max(1, parseInt(process.env.MAX_STREAMS || '20', 10) || 20);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const ALLOWED = (process.env.ALLOWED_IPS || '').split(/[\s,]+/).filter(Boolean).map(parseRule);

const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const SCRIPT_HASHES = [...INDEX.toString().matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`)
  .join(' ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': `default-src 'none'; script-src ${SCRIPT_HASHES}; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
};

function parseRule(s) {
  const [addr, bits] = s.split('/');
  const v = net.isIP(addr);
  if (!v) throw new Error(`Invalid ALLOWED_IPS entry: ${s}`);
  const max = v === 4 ? 32 : 128;
  const b = bits === undefined ? max : parseInt(bits, 10);
  if (!(b >= 0 && b <= max)) throw new Error(`Invalid ALLOWED_IPS prefix: ${s}`);
  return { v, big: ipToBig(addr, v), bits: b, max };
}

function ipToBig(ip, v) {
  if (v === 4) return ip.split('.').reduce((a, o) => (a << 8n) + BigInt(o), 0n);
  let [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  if (t.length && t[t.length - 1].includes('.')) {
    const v4 = ipToBig(t.pop(), 4);
    t.push((v4 >> 16n).toString(16), (v4 & 0xffffn).toString(16));
  }
  if (h.length && h[h.length - 1].includes('.')) {
    const v4 = ipToBig(h.pop(), 4);
    h.push((v4 >> 16n).toString(16), (v4 & 0xffffn).toString(16));
  }
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.reduce((a, g) => (a << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}

function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (TRUST_PROXY && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (net.isIP(real)) ip = real;
  }
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return ip;
}

function ipAllowed(ip) {
  if (!ALLOWED.length) return true;
  const v = net.isIP(ip);
  if (!v) return false;
  const big = ipToBig(ip, v);
  return ALLOWED.some((r) => r.v === v && (big >> BigInt(r.max - r.bits)) === (r.big >> BigInt(r.max - r.bits)));
}

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function authed(req) {
  if (!PASS) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString();
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEq(decoded.slice(0, i), USER) && safeEq(decoded.slice(i + 1), PASS);
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const BATCH = 1000;
let activeStreams = 0;

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

const json = (res, code, body) => send(res, code, JSON.stringify(body), 'application/json');

function streamLogs(req, res, name, tail) {
  if (activeStreams >= MAX_STREAMS) return send(res, 429, 'Too many open log streams');
  activeStreams++;
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const child = spawn('docker', ['logs', '-f', '--tail', tail, '-t', '--', name]);
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
  child.on('error', () => {
    clearInterval(ping);
    if (!closed) { res.write(`event: fail\ndata: ${JSON.stringify('docker command failed')}\n\n`); res.end(); }
  });
  res.on('close', () => {
    closed = true;
    activeStreams--;
    clearInterval(ping);
    if (timer) clearTimeout(timer);
    child.kill();
  });
}

const server = http.createServer((req, res) => {
  if (!ipAllowed(clientIp(req))) return send(res, 403, 'Forbidden');
  if (!authed(req)) return send(res, 401, 'Unauthorized', undefined, { 'WWW-Authenticate': 'Basic realm="Docker Logs", charset="UTF-8"' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', undefined, { Allow: 'GET, HEAD' });

  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return send(res, 400, 'Bad request'); }

  if (url.pathname === '/') return send(res, 200, INDEX, 'text/html; charset=utf-8');

  if (url.pathname === '/api/config') return json(res, 200, { maxLines: MAX_LINES });

  if (url.pathname === '/api/containers') {
    return execFile('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return json(res, 500, { error: 'Could not list containers. Is Docker running?' });
      try {
        const list = out.split('\n').filter(Boolean).map((l) => {
          const c = JSON.parse(l);
          return { id: c.ID, name: c.Names, image: c.Image, state: c.State, status: c.Status };
        });
        json(res, 200, list);
      } catch (e) {
        json(res, 500, { error: 'Unexpected docker output' });
      }
    });
  }

  if (url.pathname === '/api/logs') {
    const name = url.searchParams.get('name') || '';
    let tail = url.searchParams.get('tail') || '200';
    if (!NAME_RE.test(name)) return send(res, 400, 'bad name');
    if (tail !== 'all' && !/^\d{1,7}$/.test(tail)) tail = '200';
    return streamLogs(req, res, name, tail);
  }

  send(res, 404, 'Not found');
});

server.headersTimeout = 15000;
server.requestTimeout = 0;
server.listen(PORT, HOST, () => {
  console.log(`Docker logs viewer on ${HOST}:${PORT}`);
  if (!PASS) console.log('Login is disabled: anyone who can reach this port can read all container logs.');
  if (ALLOWED.length) console.log(`Only allowing: ${process.env.ALLOWED_IPS}`);
});
