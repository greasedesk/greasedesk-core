#!/usr/bin/env node
/**
 * File: scripts/hooks/no-bare-migrate-deploy.mjs
 * A PreToolUse hook: refuse `prisma migrate deploy` typed straight into a shell.
 *
 * ── WHY A HOOK AND NOT JUST THE WRAPPER ─────────────────────────────────────────────────────────
 * scripts/migrate-apply.mjs only protects the database if it is the thing that runs. At eleven at
 * night, fixing something, the command that gets typed is the one in muscle memory. This week's own
 * evidence for that (owner, 2026-09-12): the property-key trap went from nine instances to ten in a
 * slice that had just recorded it as a named fact. A rule in a file does not stop the thing it
 * describes; structure does.
 *
 * ── WHAT IT BLOCKS, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────────────────────────
 * Blocked: prisma migrate deploy / dev / reset, and prisma db push — anything that changes the shared
 * database without going through the deploy check. `migrate dev` and `reset` are worse than the one
 * this was written for: both propose dropping the database.
 *
 * Not blocked: the wrapper itself, `npm run prisma:deploy` (which IS the wrapper), and every read-only
 * prisma command — status, diff, generate, validate. A hook that blocks `migrate status` gets
 * uninstalled within the day, and an uninstalled hook protects nothing.
 *
 * THE TOKEN MUST BE IN COMMAND POSITION. `grep "prisma migrate deploy" notes.md` is a search, not an
 * apply; matching the bare substring would block reading about the rule, which is the fastest way to
 * make somebody remove the rule.
 *
 * ── INSTALL ─────────────────────────────────────────────────────────────────────────────────────
 * In ~/.claude/settings.json (or the project's .claude/settings.json):
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "Bash",
 *           "hooks": [
 *             { "type": "command",
 *               "command": "node /Users/hugh/Developer/greasedesk-core/scripts/hooks/no-bare-migrate-deploy.mjs" }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * Exit 0 allows, exit 2 blocks and shows stderr. Any other failure allows: a broken hook must not
 * become a broken shell.
 */

/** Shell-command positions: start of input, or just after && || ; | ( newline. */
const AT_COMMAND_START = String.raw`(?:^|[\n;|&(]\s*|\b(?:then|do|else)\s+)`;
const RUNNER = String.raw`(?:(?:npx|pnpm|yarn|bunx|bun)\s+(?:--\S+\s+)*)?`;

export const BLOCKED = [
  { re: new RegExp(`${AT_COMMAND_START}${RUNNER}prisma\\s+migrate\\s+deploy\\b`), what: 'prisma migrate deploy' },
  { re: new RegExp(`${AT_COMMAND_START}${RUNNER}prisma\\s+migrate\\s+dev\\b`), what: 'prisma migrate dev' },
  { re: new RegExp(`${AT_COMMAND_START}${RUNNER}prisma\\s+migrate\\s+reset\\b`), what: 'prisma migrate reset' },
  { re: new RegExp(`${AT_COMMAND_START}${RUNNER}prisma\\s+db\\s+push\\b`), what: 'prisma db push' },
];

/**
 * NO EXEMPTION LIST, AND THAT IS THE POINT.
 *
 * There was one — `scripts/migrate-apply.mjs` and `npm run prisma:deploy`, exempted so the right way
 * in would not be blocked by mistake. Removing it changed no answer: neither string contains
 * `prisma migrate deploy`, so neither was ever a candidate. The wrapper's own internal
 * `prisma migrate deploy` is a child process, not a Bash tool call, so the hook never sees it either.
 *
 * An exemption for something that was never blocked is a guard for a hazard that does not exist, and
 * those read as protection while protecting nothing. What keeps the right way in open is the patterns
 * above needing a real prisma invocation in command position — and migration-class-gate asserting,
 * clause by clause, that each legitimate command is allowed.
 */
export function verdict(command) {
  if (typeof command !== 'string' || !command) return null;
  const hit = BLOCKED.find((b) => b.re.test(command));
  return hit ? hit.what : null;
}

export const REFUSAL = (what) => [
  `BLOCKED: \`${what}\` changes the database dev and production share.`,
  '',
  'A migration is live the moment it is applied; the code that honours it is live only when it',
  'deploys. On 2026-09-11 a trigger applied ahead of its push gave the live app four hours of 500s',
  'on every "No SMS" save.',
  '',
  'Use the wrapper, which asks production what it is running first:',
  '    node scripts/migrate-apply.mjs --dry-run     # see the classification and the decision',
  '    node scripts/migrate-apply.mjs               # apply, if production is running this code',
  '',
  'It applies additive migrations without ceremony. It refuses a constraining one until the code',
  'that satisfies it is live — or records a reason in the migration file if you override it.',
].join('\n');

// ── THE HOOK ITSELF ─────────────────────────────────────────────────────────────────────────────
// Only when run directly, so the gate can import the rules above without reading stdin.
if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const payload = JSON.parse(raw || '{}');
    const what = verdict(payload?.tool_input?.command);
    if (what) { process.stderr.write(`${REFUSAL(what)}\n`); process.exit(2); }
  } catch {
    // A HOOK THAT CANNOT PARSE ITS INPUT MUST NOT BLOCK THE SHELL. Failing open here is right: the
    // wrapper and the gate are the other two layers, and a hook that breaks every Bash call is a
    // hook that gets deleted within the hour — taking the protection with it.
  }
  process.exit(0);
}
