const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const APP = process.argv[2] || path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fake-docker.js');
const LOG = path.join(require('os').tmpdir(), 'dlv-spawned.log');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); };

function start(port, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-r', FAKE, path.join(APP, 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', FAKE_LOG: LOG, SETTINGS_FILE: path.join(require('os').tmpdir(), `dlv-settings-${port}.json`), ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('Docker logs viewer on')) resolve({ p, out: () => out }); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => reject(new Error('exited ' + c + ': ' + out)));
  });
}

function req(port, opts = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method: opts.method || 'GET', path: opts.path || '/', headers: opts.headers || {} }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; if (opts.peek && body.length > 200) { res.destroy(); resolve({ status: res.statusCode, headers: res.headers, body }); } });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (opts.timeout) r.setTimeout(opts.timeout, () => r.destroy());
    r.end(opts.body);
  });
}

function rawReq(port, text) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let d = '';
    s.on('data', (x) => { d += x; });
    s.on('end', () => resolve(d));
    s.on('error', () => resolve(d));
    setTimeout(() => { s.destroy(); resolve(d); }, 1500);
  });
}

(async () => {
  fs.writeFileSync(LOG, '');
  const A = 6071;
  const s1 = await start(A, {});

  const home = await req(A);
  check('No login: page opens without credentials', home.status === 200);
  const h = home.headers;
  check('Header X-Content-Type-Options: nosniff', h['x-content-type-options'] === 'nosniff');
  check('Header X-Frame-Options: DENY (no clickjacking)', h['x-frame-options'] === 'DENY');
  check('Header Referrer-Policy: no-referrer', h['referrer-policy'] === 'no-referrer');
  const csp = h['content-security-policy'] || '';
  check('CSP blocks injected scripts (no unsafe-inline/eval in script-src)', /script-src 'sha256-/.test(csp) && !/script-src[^;]*unsafe/.test(csp), csp.slice(0, 80) + '…');
  check('CSP frame-ancestors none + connect-src self', csp.includes("frame-ancestors 'none'") && csp.includes("connect-src 'self'"));
  check('No X-Powered-By / server version leak', !h['x-powered-by'] && !h['server']);

  for (const p of ['/server.js', '/public/index.html', '/../server.js', '/%2e%2e/server.js', '/config.env', '/..%2fconfig.env', '/etc/passwd', '/.git/config']) {
    const r = await req(A, { path: p });
    check(`Path traversal / file leak blocked: ${p}`, r.status === 404 && !r.body.includes('require(') && !r.body.includes('AUTH_PASS'), `status ${r.status}`);
  }
  const raw = await rawReq(A, 'GET /../../config.env HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  check('Raw ../ request path does not serve files', /^HTTP\/1\.1 404/.test(raw), raw.split('\r\n')[0]);

  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await req(A, { method: m, path: '/api/containers' });
    check(`${m} on /api/containers rejected`, r.status === 405, `status ${r.status}`);
  }

  const badNames = ['--help', '-f', '../etc', 'a;rm -rf /', 'a$(id)', 'a`id`', 'a b', 'a|id', 'a&&id', '%0aid', 'x'.repeat(300)];
  for (const n of badNames) {
    const r = await req(A, { path: '/api/logs?name=' + encodeURIComponent(n) });
    check(`Command/flag injection blocked: name=${JSON.stringify(n.length > 20 ? n.slice(0, 12) + '…' : n)}`, r.status === 400, `status ${r.status}`);
  }

  fs.writeFileSync(LOG, '');
  await req(A, { path: '/api/logs?name=web&tail=' + encodeURIComponent('5 --details; id'), peek: true, timeout: 800 });
  const spawned = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const last = spawned[spawned.length - 1] || [];
  check('Bad tail value is replaced, not passed to docker', JSON.stringify(last) === JSON.stringify(['logs', '-f', '--tail', '200', '-t', '--', 'web']), JSON.stringify(last));
  check('docker is called without a shell (args array, "--" before name)', last.includes('--') && last[last.length - 1] === 'web');

  const list = await req(A, { path: '/api/containers' });
  check('Container list is JSON (served as application/json, not HTML)', list.headers['content-type'].startsWith('application/json'));

  const streams = [];
  for (let i = 0; i < 20; i++) streams.push(http.get({ host: '127.0.0.1', port: A, path: '/api/logs?name=web&tail=1' }));
  await new Promise((r) => setTimeout(r, 600));
  const extra = await req(A, { path: '/api/logs?name=web&tail=1', timeout: 1500 });
  check('Stream flood limited (21st stream gets 429)', extra.status === 429, `status ${extra.status}`);
  streams.forEach((s) => s.destroy());
  await new Promise((r) => setTimeout(r, 500));
  const after = await req(A, { path: '/api/logs?name=web&tail=1', peek: true, timeout: 1500 });
  check('Stream slots are freed after clients disconnect', after.status === 200, `status ${after.status}`);

  const spoof = await req(A, { headers: { 'X-Real-IP': '1.2.3.4', 'X-Forwarded-For': '1.2.3.4' } });
  check('Works normally with spoofed proxy headers', spoof.status === 200);

  const act = (p, opts = {}) => req(A, { method: 'POST', path: p, ...opts });
  const H = { 'X-DLV-Action': '1', Host: '127.0.0.1:' + A };
  fs.writeFileSync(LOG, '');
  const noHeader = await act('/api/containers/web/restart');
  check('Actions: POST without the app header is rejected (CSRF)', noHeader.status === 403, `status ${noHeader.status}`);
  const evilOrigin = await act('/api/containers/web/stop', { headers: { ...H, Origin: 'https://evil.example' } });
  check('Actions: request from another website (Origin) is rejected', evilOrigin.status === 403, `status ${evilOrigin.status}`);
  const crossSite = await act('/api/containers/web/stop', { headers: { ...H, 'Sec-Fetch-Site': 'cross-site' } });
  check('Actions: cross-site fetch (Sec-Fetch-Site) is rejected', crossSite.status === 403, `status ${crossSite.status}`);
  const nullOrigin = await act('/api/containers/web/stop', { headers: { ...H, Origin: 'null' } });
  check('Actions: sandboxed/null Origin is rejected', nullOrigin.status === 403, `status ${nullOrigin.status}`);
  const getAct = await req(A, { path: '/api/containers/web/stop', headers: H });
  check('Actions: GET on an action URL is not allowed (no link/img triggering)', getAct.status === 405, `status ${getAct.status}`);
  let rejectedCalls = fs.readFileSync(LOG, 'utf8').trim();
  check('Actions: rejected requests never reach docker', rejectedCalls === '', rejectedCalls);
  for (const n of ['--all', '-t', 'a%3Bid', '..%2F..', '%00x']) {
    const r = await act(`/api/containers/${n}/stop`, { headers: H });
    check(`Actions: bad container name blocked: ${decodeURIComponent(n).replace('\0', '\\0')}`, r.status === 400 || r.status === 404, `status ${r.status}`);
  }
  const badAct = await act('/api/containers/web/rm', { headers: H });
  check('Actions: only start/stop/restart exist (no rm/kill/exec)', badAct.status === 405 || badAct.status === 404, `status ${badAct.status}`);
  fs.writeFileSync(LOG, '');
  const [first, second] = await Promise.all([act('/api/containers/web/restart', { headers: H }), new Promise((r) => setTimeout(r, 50)).then(() => act('/api/containers/web/stop', { headers: H }))]);
  check('Actions: same-origin restart works', first.status === 200 && JSON.parse(first.body).ok === true, `status ${first.status}`);
  check('Actions: a second action on the same container while busy gets 409', second.status === 409, `status ${second.status}`);
  const calls = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('Actions: docker called as ["restart","--",name] without a shell', calls.length === 1 && JSON.stringify(calls[0]) === '["restart","--","web"]', JSON.stringify(calls));
  const setPost = (body, headers = H) => req(A, { method: 'POST', path: '/api/settings', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body });
  const goodSet = await setPost(JSON.stringify({ theme: 'white', fontsize: 14 }));
  check('Settings: same-origin save works and is shared', goodSet.status === 200 && JSON.parse((await req(A, { path: '/api/settings' })).body).theme === 'white', `status ${goodSet.status}`);
  const csrfSet = await setPost(JSON.stringify({ theme: 'black' }), { Origin: 'https://evil.example', 'X-DLV-Action': '1' });
  const noHdrSet = await setPost(JSON.stringify({ theme: 'black' }), {});
  check('Settings: other websites cannot change settings (CSRF)', csrfSet.status === 403 && noHdrSet.status === 403, `${csrfSet.status}/${noHdrSet.status}`);
  await setPost('{"theme":"<script>x</script>","fontsize":9999,"tail":"1; id","evil":"x","__proto__":{"polluted":1}}');
  const stored = JSON.parse((await req(A, { path: '/api/settings' })).body);
  check('Settings: invalid values and unknown keys are ignored', stored.theme === 'white' && stored.fontsize === 14 && !('tail' in stored) && !('evil' in stored) && !('polluted' in stored), JSON.stringify(stored));
  const huge = await setPost(JSON.stringify({ theme: 'x'.repeat(10000) }));
  check('Settings: oversized body is refused', huge.status !== 200, `status ${huge.status}`);
  const fail = await act('/api/containers/broken/stop', { headers: H });
  check('Actions: docker errors are reported cleanly', fail.status === 500 && /No such container/.test(JSON.parse(fail.body).error), fail.body);
  s1.p.kill();

  const E = 6075;
  const s5 = await start(E, { ACTIONS: 'false' });
  const disabled = await req(E, { method: 'POST', path: '/api/containers/web/stop', headers: { 'X-DLV-Action': '1' } });
  const cfg = JSON.parse((await req(E, { path: '/api/config' })).body);
  check('ACTIONS=false: actions are refused and hidden in the UI config', disabled.status === 403 && cfg.actions === false, `status ${disabled.status}`);
  s5.p.kill();

  const B = 6072;
  const s2 = await start(B, { ALLOWED_IPS: '10.9.9.9,192.168.50.0/24' });
  const denied = await req(B);
  check('ALLOWED_IPS: non-listed IP gets 403', denied.status === 403, `status ${denied.status}`);
  const spoofB = await req(B, { headers: { 'X-Real-IP': '10.9.9.9' } });
  check('ALLOWED_IPS: spoofed X-Real-IP is ignored without TRUST_PROXY', spoofB.status === 403, `status ${spoofB.status}`);
  s2.p.kill();

  const C = 6073;
  const s3 = await start(C, { ALLOWED_IPS: '127.0.0.1', TRUST_PROXY: 'true' });
  const viaProxyAllowed = await req(C, { headers: { 'X-Real-IP': '127.0.0.1' } });
  const viaProxyDenied = await req(C, { headers: { 'X-Real-IP': '8.8.8.8' } });
  check('Behind nginx: real client IP is checked against ALLOWED_IPS', viaProxyAllowed.status === 200 && viaProxyDenied.status === 403, `${viaProxyAllowed.status}/${viaProxyDenied.status}`);
  s3.p.kill();

  const D = 6074;
  const s4 = await start(D, { AUTH_PASS: 'hunter2-test', AUTH_USER: 'admin' });
  const noAuth = await req(D);
  const wrong = await req(D, { headers: { Authorization: 'Basic ' + Buffer.from('admin:nope').toString('base64') } });
  const right = await req(D, { headers: { Authorization: 'Basic ' + Buffer.from('admin:hunter2-test').toString('base64') } });
  check('LOGIN=true still works (401 without / wrong, 200 with right password)', noAuth.status === 401 && wrong.status === 401 && right.status === 200, `${noAuth.status}/${wrong.status}/${right.status}`);
  s4.p.kill();

  const pass = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? '  [' + r.detail + ']' : ''}`);
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
