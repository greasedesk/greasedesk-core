/**
 * File: scripts/_firefox-bidi.mjs
 * A REAL FIREFOX, DRIVEN, IN ABOUT EIGHTY LINES.
 *
 * ── WHY NOT PLAYWRIGHT ──────────────────────────────────────────────────────────────────────────
 * The suite already drives Chrome with `chromium.launch({ channel: 'chrome' })`, so Firefox through
 * the same library looks like one word's difference. It is not: Playwright's Firefox is a PATCHED
 * build carrying its Juggler protocol, and pointing it at /Applications/Firefox.app fails with
 * "Target page, context or browser has been closed" — measured, 2026-11-05. Installing Playwright's
 * own Firefox would mean a second Firefox on the machine, and then the gate would be proving
 * something about a browser nobody uses.
 *
 * ── SO: THE BROWSER'S OWN PROTOCOL ──────────────────────────────────────────────────────────────
 * `firefox --headless --remote-debugging-port=N` prints "WebDriver BiDi listening on ws://…". CDP is
 * gone from modern Firefox (/json/version 404s on 159), and BiDi is the W3C standard that replaced
 * it. Node 22+ has a global WebSocket, so the whole client is four commands and no dependency:
 * session.new, browsingContext.getTree, browsingContext.navigate, script.evaluate.
 *
 * ── IT RETURNS A VALUE, NOT A PICTURE ───────────────────────────────────────────────────────────
 * `firefox --screenshot` was the obvious alternative and it is the wrong one: a PNG is not an
 * assertion. A gate that renders an image somebody is meant to look at has moved the check out of
 * the gate and into a human's good intentions, which is precisely what a gate is for not doing.
 * This returns the value Firefox's own DOM reports, and a clause can be red about it.
 *
 * ── ITS OWN PROFILE, ITS OWN PORT, AND IT ALWAYS DIES ───────────────────────────────────────────
 * Firefox refuses --screenshot and --remote-debugging-port against a profile another instance holds,
 * so the caller's profile directory is made fresh. The process is killed in a `finally` by the
 * caller; `detached` is deliberately NOT set, so a killed gate takes the browser with it rather than
 * leaving one listening on a port the next run wants.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIREFOX_BIN = '/Applications/Firefox.app/Contents/MacOS/firefox';
export const firefoxInstalled = () => existsSync(FIREFOX_BIN);

/** Opens a headless Firefox and returns { evaluate, close }. `url` may be a data: or file: URL. */
export async function openFirefox({ port = 9877, timeoutMs = 30_000 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'gd-ff-'));
  // MOZ_REMOTE_ALLOW_SYSTEM_ACCESS, because BiDi refuses a file:// navigation without it:
  // "unsupported operation: System access is required." It is scoped to this throwaway profile and
  // this child process, and the only files it will be pointed at are ones this gate just wrote
  // into that same profile directory.
  const proc = spawn(FIREFOX_BIN, ['-profile', profile, '--headless', `--remote-debugging-port=${port}`],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } });

  // THE BROWSER SAYS WHEN IT IS READY. Polling the port would race a half-open listener, and a
  // fixed sleep is the same race with a worse name.
  const wsUrl = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Firefox did not announce a BiDi endpoint in time')), timeoutMs);
    const onData = (buf) => {
      const m = String(buf).match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error(`Firefox exited early (${code})`)); });
  });

  // THE ANNOUNCED URL IS THE BASE, NOT THE ENDPOINT. Connecting to it directly is refused;
  // `/session` is where BiDi creates one. Measured both ways rather than read off a doc, because the
  // failure is a bare "socket refused" that says nothing about which half is wrong.
  const ws = new WebSocket(`${wsUrl.replace(/\/$/, '')}/session`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('BiDi socket refused')); });

  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    const p = pending.get(msg.id);
    if (!p) return;                       // an event, not a reply to anything we sent
    pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(`${msg.error}: ${msg.message}`));
    else p.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('session.new', { capabilities: { alwaysMatch: {} } });
  const tree = await send('browsingContext.getTree', {});
  const context = tree.contexts[0].context;

  return {
    async goto(url) { await send('browsingContext.navigate', { context, url, wait: 'complete' }); },
    /**
     * LOAD SOME HTML. Via a FILE, because Firefox refuses a top-level `data:` navigation outright —
     * "Navigation to data:… is not allowed in this context" — which is a security rule and not a
     * quirk to route around. The file lives in this session's own profile directory and goes with
     * it, so nothing is left behind.
     */
    async setContent(html) {
      const f = join(profile, `page-${Date.now()}.html`);
      writeFileSync(f, html);
      await send('browsingContext.navigate', { context, url: `file://${f}`, wait: 'complete' });
    },
    /** The value Firefox's own DOM reports. Throws on a script error rather than returning undefined. */
    async evaluate(expression) {
      const r = await send('script.evaluate', { expression, target: { context }, awaitPromise: true });
      if (r.type === 'exception') throw new Error(`Firefox threw: ${r.exceptionDetails?.text ?? 'unknown'}`);
      return r.result?.value;
    },
    async close() {
      try { ws.close(); } catch { /* already gone */ }
      proc.kill('SIGKILL');
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* a temp dir */ }
    },
  };
}
