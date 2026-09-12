/**
 * File: scripts/version-endpoint-gate.mjs
 * WHAT IS PRODUCTION RUNNING? FOUR FIELDS, PUBLIC, AND NOTHING ELSE IN THEM.
 * @gate-requires: server
 *
 * /api/version exists because a migration is live the moment it is applied while the code that
 * honours it is not live until it deploys — and on 2026-09-11 nothing here could say which commit
 * production was running, so a trigger broke the live app for four hours unseen. The migration
 * wrapper will ask this endpoint before applying anything that constrains an existing write.
 *
 * TWO THINGS MATTER, and they pull against each other: it must answer WITHOUT a session (the caller
 * runs before anyone signs in, often when something is wrong), and it must therefore never carry
 * anything but the build's identity. So the field set is PINNED here — a later "just add the
 * database URL while we debug" fails this gate instead of shipping — and the route's environment
 * reads are held to an allow-list.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { describeError, gateOrigin, erOrigin, repOrigin } = await import('./_gate-preflight.mjs');
const { readFileSync } = await import('node:fs');
const http = await import('node:http');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const B = gateOrigin();
const ask = (host, path) => new Promise((resolve) => {
  const u = new URL(B);
  const r = http.request({ hostname: u.hostname, port: u.port, path, method: 'GET', headers: { Host: `${host}:${u.port}` } }, (res) => {
    let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  r.on('error', (e) => resolve({ status: 0, body: String(e) })); r.end();
});

try {
  console.log('\n— it answers, without a session —');
  const res = await fetch(`${B}/api/version`);
  const body = await res.json().catch(() => null);
  check('GET /api/version answers 200 with JSON, unauthenticated', res.status === 200 && !!body, `HTTP ${res.status}`);
  check('  …and is never cached — a stale answer would be worse than none', /no-store/.test(res.headers.get('cache-control') ?? ''), res.headers.get('cache-control') ?? 'no header');
  check('the field set is EXACTLY the build\'s identity', JSON.stringify(Object.keys(body ?? {}).sort()) === JSON.stringify(['commit', 'env', 'ref', 'source']),
    Object.keys(body ?? {}).join(', ') + ' — pinned so a later addition of anything else fails here');
  check('  …and every value is a short string or null', Object.values(body ?? {}).every((v) => v === null || (typeof v === 'string' && v.length <= 64)),
    JSON.stringify(body));

  console.log('\n— off Vercel it says so, rather than inventing a version —');
  check('this machine has no commit, and the answer is null', body?.commit === null && body?.source === 'unknown' && body?.env === 'development',
    JSON.stringify(body) + ' — a caller comparing against null must fail closed, and the wrapper will');

  // THE VERCEL BRANCH, without Vercel: the handler is a pure function of its environment, so the
  // environment is what the gate changes. Restored immediately, whatever happens.
  const handler = (await import('../pages/api/version.ts')).default;
  const call = () => new Promise((resolve) => {
    const r = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    handler({ method: 'GET' }, r);
  });
  const before = { sha: process.env.VERCEL_GIT_COMMIT_SHA, ref: process.env.VERCEL_GIT_COMMIT_REF, env: process.env.VERCEL_ENV };
  let asVercel;
  try {
    process.env.VERCEL_GIT_COMMIT_SHA = 'a'.repeat(40);
    process.env.VERCEL_GIT_COMMIT_REF = 'main';
    process.env.VERCEL_ENV = 'production';
    asVercel = await call();
  } finally {
    for (const [k, v] of [['VERCEL_GIT_COMMIT_SHA', before.sha], ['VERCEL_GIT_COMMIT_REF', before.ref], ['VERCEL_ENV', before.env]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  check('given Vercel\'s own variables it reports the commit, the branch and the environment',
    asVercel.body.commit === 'a'.repeat(40) && asVercel.body.ref === 'main' && asVercel.body.env === 'production' && asVercel.body.source === 'runtime',
    JSON.stringify(asVercel.body));
  check('  …and the environment is restored', process.env.VERCEL_GIT_COMMIT_SHA === before.sha && (await fetch(`${B}/api/version`).then((r) => r.json())).commit === null);

  console.log('\n— and it carries nothing else —');
  const src = code(readFileSync('pages/api/version.ts', 'utf8'));
  const reads = [...src.matchAll(/process\.env\.([A-Z_0-9]+)/g)].map((m) => m[1]);
  const ALLOWED = ['BUILD_COMMIT', 'VERCEL_GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_REF', 'VERCEL_ENV', 'NODE_ENV'];
  check('the route reads only the build\'s own variables', reads.every((r) => ALLOWED.includes(r)) && reads.length >= 4,
    `${[...new Set(reads)].join(', ')} — nothing about the database, the providers or the tenants`);
  check('  …and the build passes the commit in, for when the runtime variable is not there',
    /env: \{ BUILD_COMMIT: process\.env\.VERCEL_GIT_COMMIT_SHA \|\| '' \}/.test(code(readFileSync('next.config.js', 'utf8'))));
  const post = await fetch(`${B}/api/version`, { method: 'POST' });
  check('POST is refused — it answers a question, it does not take one', post.status === 405 && /GET/.test(post.headers.get('allow') ?? ''), `HTTP ${post.status}`);
  check('the Engine Room and rep hosts do not serve it', (await ask(new URL(erOrigin()).hostname, '/api/version')).status === 404 && (await ask(new URL(repOrigin()).hostname, '/api/version')).status === 404,
    'it answers for the tenant app, on the apex');
} catch (e) {
  check('gate run completed', false, describeError(e));
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
