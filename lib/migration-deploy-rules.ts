/**
 * File: lib/migration-deploy-rules.ts
 * MAY THIS MIGRATION BE APPLIED YET? The rules, as pure functions, importing nothing.
 *
 * ── THE HAZARD ──────────────────────────────────────────────────────────────────────────────────
 * Dev and production share one database. A migration is LIVE the moment it is applied; the code that
 * honours it is live only when it deploys. So a migration that CONSTRAINS an existing write breaks
 * production from the instant it is applied until the push lands — and no gate can catch it, because
 * every gate runs against this working copy, where the satisfying code is already present.
 *
 * On 2026-09-11 20260911090000_contact_preference_trigger was applied at 17:43 UTC while production
 * ran 68fa1a3, whose owner-edit API wrote the constrained columns directly. Every "No SMS / No email"
 * save on the live app returned 500 for about four hours. Nothing here could even see it.
 *
 * ── THE POLICY THIS ENFORCES (owner, 2026-09-12) ────────────────────────────────────────────────
 * TWO PUSHES per constraining change: push the code, wait until production is RUNNING it, then apply
 * and push the migration. Most migrations are additive and unaffected. The cost is one extra push on
 * the rare commit that constrains an existing write, against a failure that leaves no trace and
 * surfaces weeks later as a support call.
 *
 * ── WHY THESE LIVE IN A LEAF MODULE ─────────────────────────────────────────────────────────────
 * Every refusal below is a pure function of text. That is deliberate: the wrapper needs a database
 * and the network, so its refusals could only be proved by arranging an out-of-date production.
 * Here they are proved by passing in the facts — all five branches, in milliseconds, with nothing
 * applied. Importing nothing also keeps migration-class-gate's import cheap and honest.
 */

export type MigrationClass = 'additive' | 'constraining';

/**
 * THE DECLARED CLASS. One line, anywhere in the file:
 *   -- @migration: additive
 *   -- @migration: constraining <why it constrains an existing write>
 *
 * Two of them is malformed rather than "the first one wins" — a file that says both is a file
 * somebody edited without reading.
 */
export function readDeclaredClass(sql: string): { declared: MigrationClass | null; why: string; malformed: string | null } {
  const lines = [...sql.matchAll(/^[ \t]*--[ \t]*@migration:[ \t]*(.*)$/gm)].map((m) => m[1].trim());
  if (lines.length === 0) return { declared: null, why: '', malformed: null };
  if (lines.length > 1) return { declared: null, why: '', malformed: `${lines.length} @migration: lines — a file that declares itself twice was edited without being read` };
  const [, word, rest] = /^(\S+)[ \t]*(.*)$/.exec(lines[0]) ?? [];
  if (word !== 'additive' && word !== 'constraining') {
    return { declared: null, why: '', malformed: `@migration: ${lines[0] || '(blank)'} — must be "additive" or "constraining <why>"` };
  }
  if (word === 'constraining' && !rest) {
    return { declared: null, why: '', malformed: 'constraining without a why — name what existing write it constrains' };
  }
  return { declared: word, why: rest, malformed: null };
}

/**
 * WHAT MAKES SQL CONSTRAINING. Deliberately coarse, and deliberately biased: a false refusal costs
 * an override, a false pass costs production (owner, 2026-09-12).
 *
 * UPDATE and DELETE count. A data rewrite is a constraint on what the running code may already have
 * written — it is the same hazard wearing different clothes.
 *
 * Known conservative classification, recorded so nobody "fixes" it later:
 * 20260911120000_unsubscribe_token adds a NULLABLE column, a unique index and a CHECK that tolerates
 * NULL, so it could not in fact have broken a writer that knew nothing about the column. It still
 * classifies constraining, because distinguishing "a CHECK naming only new columns" from "a CHECK
 * naming an existing one" means parsing arbitrary expressions — exactly the cleverness that makes a
 * classifier wrong in the expensive direction. One extra push is the agreed price.
 */
export const CONSTRAINING_SQL: { re: RegExp; what: string }[] = [
  { re: /\bADD\s+CONSTRAINT\b/i, what: 'ADD CONSTRAINT — an existing writer may already breach it' },
  { re: /\bCHECK\s*\(/i, what: 'CHECK — a row production writes today may not satisfy it' },
  { re: /\bSET\s+NOT\s+NULL\b/i, what: 'SET NOT NULL — production may still be omitting the column' },
  { re: /\bCREATE\s+(UNIQUE\s+INDEX|INDEX\s+\S+\s+ON\s+\S+\s*\(\s*\)\s*UNIQUE)/i, what: 'UNIQUE INDEX — production may already create duplicates' },
  { re: /\bUNIQUE\s*\(/i, what: 'UNIQUE — production may already create duplicates' },
  { re: /\bCREATE\s+(OR\s+REPLACE\s+)?(CONSTRAINT\s+)?TRIGGER\b/i, what: 'TRIGGER — it runs against whatever production writes' },
  { re: /\bFOREIGN\s+KEY\b|\bREFERENCES\s+"/i, what: 'FOREIGN KEY — production may write an id this now rejects' },
  { re: /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|TRIGGER|FUNCTION|TYPE|DEFAULT|SCHEMA|VIEW)\b/i, what: 'DROP — production may still be reading or writing it' },
  { re: /\bALTER\s+COLUMN\b[\s\S]{0,80}?\bTYPE\b/i, what: 'ALTER COLUMN TYPE — production serialises to the old type' },
  { re: /\bRENAME\b/i, what: 'RENAME — production still names the old one' },
  { re: /^\s*UPDATE\s+/im, what: 'UPDATE — a data rewrite constrains what production may already have written' },
  { re: /^\s*DELETE\s+FROM\b/im, what: 'DELETE — a data rewrite constrains what production may already have written' },
  { re: /\bREVOKE\b/i, what: 'REVOKE — production may be using the privilege' },
];

/**
 * STATEMENTS THAT CANNOT REACH AN EXISTING WRITER, WHATEVER IS INSIDE THEM.
 *
 * This is the one refinement allowed past "ambiguity is constraining", because it is not a judgement
 * — it is decidable. A brand-new table's own CHECK, UNIQUE and FOREIGN KEY constrain inserts into a
 * table production has never heard of, so they constrain nothing that is running. Without this, a
 * plain new table with a foreign key — the commonest non-trivial migration there is — would classify
 * constraining and cost a second push for nothing, and a refusal that is routine is a refusal people
 * stop reading.
 *
 * A non-unique CREATE INDEX is here for the same reason: an index rejects no write.
 *
 * NOT here: `ALTER TABLE ... ADD COLUMN`. A constraint hung on a new column of an EXISTING table can
 * reach production — see the unsubscribe_token note above — so those statements are scanned.
 */
export const SELF_CONTAINED_ADDITIVE: RegExp[] = [
  /^CREATE\s+TABLE\b/i,
  /^CREATE\s+SCHEMA\b/i,
  /^CREATE\s+TYPE\b/i,
  /^COMMENT\s+ON\b/i,
  /^CREATE\s+INDEX\b/i,            // CREATE UNIQUE INDEX does not match: "UNIQUE" sits before "INDEX"
  /^ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE\b/i,
];

/**
 * WHAT IS ADDITIVE ONCE SCANNED AND FOUND CLEAN. Anything outside both lists is constraining,
 * including anything this does not recognise: ambiguity resolves to constraining (owner,
 * 2026-09-12). An INSERT into a table that already existed is ambiguous on purpose — it may be
 * seeding a row some writer will collide with.
 */
export const ADDITIVE_SQL: RegExp[] = [
  /^ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\b/i,
];

/**
 * SQL statements, comments removed, split on `;`.
 *
 * DOLLAR-QUOTE AWARE. A trigger function body is full of semicolons; splitting naively turns one
 * CREATE FUNCTION into twenty fragments, and then the reasons read as twenty unrecognised statements
 * instead of one function. The answer would still be "constraining", which is how a splitter this
 * wrong could have survived unnoticed — the right answer for the wrong reason.
 */
export function statements(sql: string): string[] {
  const bare = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  const out: string[] = [];
  let buf = '';
  let tag: string | null = null;       // the open dollar-quote tag, e.g. "$$" or "$fn$"
  for (let i = 0; i < bare.length; i += 1) {
    if (tag) {
      if (bare.startsWith(tag, i)) { buf += tag; i += tag.length - 1; tag = null; continue; }
      buf += bare[i];
      continue;
    }
    const open = /^\$[A-Za-z_]*\$/.exec(bare.slice(i));
    if (open) { tag = open[0]; buf += tag; i += tag.length - 1; continue; }
    if (bare[i] === ';') { out.push(buf); buf = ''; continue; }
    buf += bare[i];
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function classifySql(sql: string): { detected: MigrationClass; reasons: string[] } {
  const reasons: string[] = [];
  for (const st of statements(sql)) {
    if (SELF_CONTAINED_ADDITIVE.some((re) => re.test(st))) continue;
    const hit = CONSTRAINING_SQL.find((p) => p.re.test(st));
    if (hit) { reasons.push(`${hit.what}\n      ${st.replace(/\s+/g, ' ').slice(0, 150)}`); continue; }
    if (!ADDITIVE_SQL.some((re) => re.test(st))) {
      reasons.push(`not recognised, so treated as constraining\n      ${st.replace(/\s+/g, ' ').slice(0, 150)}`);
    }
  }
  // NAMED REASONS FIRST. The trigger migration that caused all this yields four "CREATE TRIGGER" hits
  // and three unrecognised CREATE FUNCTION bodies; printed in file order the reader sees three
  // shrugs before the actual finding, and a refusal nobody reads to the end is a refusal people
  // override blind.
  return { detected: reasons.length ? 'constraining' : 'additive', reasons: reasons.sort((a, b) => Number(a.startsWith('not recognised')) - Number(b.startsWith('not recognised'))) };
}

/**
 * WHERE THE HEADER BECAME COMPULSORY. Name-based, not a date comparison: the 221 migrations written
 * before this rule existed are grandfathered by sorting at or below this one, and a migration's
 * directory name is its own timestamp, so nothing has to be remembered or kept in step.
 */
export const HEADER_REQUIRED_AFTER = '20260911120000_unsubscribe_token';

export function headerRequired(migrationName: string): boolean {
  return migrationName > HEADER_REQUIRED_AFTER;
}

export type ClassifiedMigration = {
  name: string;
  klass: MigrationClass | null;     // null = refuse; the disagreement IS the answer
  declared: MigrationClass | null;
  detected: MigrationClass;
  reasons: string[];
  refusal: string | null;
};

/**
 * THE TWO SOURCES, AND WHAT HAPPENS WHEN THEY DISAGREE.
 *
 * They disagree → REFUSE. Never pick a winner, in either direction (owner, 2026-09-12): the
 * disagreement is the signal. Either the classifier misread the SQL or the author misread their own
 * migration, and both want a human. Trusting the header "because it is the cautious direction"
 * throws away the only evidence that one of them is wrong.
 */
export function classifyMigration(name: string, sql: string): ClassifiedMigration {
  const { declared, malformed } = readDeclaredClass(sql);
  const { detected, reasons } = classifySql(sql);
  const base = { name, declared, detected, reasons };
  if (malformed) return { ...base, klass: null, refusal: `${name}: ${malformed}` };
  if (declared === null) {
    return { ...base, klass: null, refusal: `${name}: no "-- @migration:" header. The SQL reads ${detected}${reasons.length ? `:\n    • ${reasons.join('\n    • ')}` : ''}` };
  }
  if (declared !== detected) {
    return {
      ...base,
      klass: null,
      refusal: `${name}: the header says ${declared}, the SQL reads ${detected}. Refusing rather than choosing — one of the two is wrong and it matters which.`
        + (reasons.length ? `\n    • ${reasons.join('\n    • ')}` : '\n    • nothing in it constrains an existing write'),
    };
  }
  return { ...base, klass: declared, refusal: null };
}

/**
 * WHAT THE DEPLOYED-COMMIT COMPARISON IGNORES, and why each one is safe to ignore.
 *
 * prisma/migrations/** — under two pushes the migration is applied BEFORE it is pushed. That is the
 *   policy, not an oversight; comparing it would refuse every time by construction.
 *
 * prisma/schema.prisma — it cannot safely travel in push 1. Tightening `String?` to `String` while
 *   the column is still nullable makes production's generated client STRICTER THAN THE DATABASE, and
 *   Prisma throws reading a null into a required field. So it belongs in push 2 with the migration,
 *   and refusing on it would be a false refusal on every tightening migration — the kind that trains
 *   people to override without reading.
 *   Excluding it is safe because with the app code identical, the QUERIES production sends are
 *   identical: new models and fields it cannot reference, and tightened optionality only makes its
 *   own client fussier, which is the safe direction. The ONE exception is a client-generated
 *   `@default(...)`, the single way identical app code sends a different value because of
 *   schema.prisma alone — so that is checked separately rather than excluded. See schemaRisk below.
 */
export const DEPLOY_DIFF_EXCLUDES = ['prisma/migrations/', 'prisma/schema.prisma'];

export function comparedByDeployCheck(path: string): boolean {
  return !DEPLOY_DIFF_EXCLUDES.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

/**
 * THE HOLE THE schema.prisma EXCLUSION WOULD OTHERWISE LEAVE. An added `@default(uuid())` (or
 * now(), cuid(), a literal) is generated CLIENT-SIDE: production, running identical app code against
 * its older schema, sends no value where this tree would send one. If the migration then demands one,
 * production breaks. Added lines only — a removed default makes production the generous one.
 */
export function schemaRisk(schemaDiff: string): string[] {
  return schemaDiff
    .split('\n')
    .filter((l) => /^\+/.test(l) && !/^\+\+\+/.test(l))
    .filter((l) => /@default\(/.test(l))
    .map((l) => l.slice(1).trim());
}

/**
 * PATHS OUT OF `git status --porcelain`, and this is a pure function because getting it wrong was
 * silent and expensive.
 *
 * The wrapper's git helper trims its output — reasonable for a commit hash, WRONG here: porcelain
 * puts a two-column status field before each path, and an unstaged change starts with a SPACE. The
 * trim ate the first line's leading space, `slice(3)` then ate a character of the path, and
 * `prisma/schema.prisma` arrived as `risma/schema.prisma` — which matched no exclusion, so the
 * wrapper refused on the ONE file it is designed to ignore, naming a path that does not exist.
 *
 * A refusal is a report a human acts on. A mangled path sends them to the wrong file.
 */
export function uncommittedPaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => {
      const m = /^(..)[ \t](.*)$/.exec(l);            // XY<space>path — the status field is TWO columns
      const raw = (m ? m[2] : l).trim();
      const renamed = raw.split(' -> ').pop() as string;  // "R  old -> new" reports the new path
      return renamed.replace(/^"|"$/g, '');            // git quotes paths containing odd characters
    })
    .filter(Boolean);
}

export type VersionAnswer =
  | { ok: false; why: string }
  | { ok: true; commit: string | null; ref: string | null; env: string | null; source: string | null };

export type DeployFacts = {
  pending: ClassifiedMigration[];
  version: VersionAnswer;
  /** null = could not be determined, e.g. the commit is not in this clone even after a fetch. */
  liveIsAncestor: boolean | null;
  head: string;
  appFilesNotLive: string[];
  uncommittedAppFiles: string[];
  schemaDefaults: string[];
  override: string | null;        // the operator's reason, already trimmed
};

export type DeployDecision = {
  allow: boolean;
  constraining: ClassifiedMigration[];
  refusals: string[];
  overridden: boolean;
  /** The durable record, to be written into the migration file BEFORE applying. */
  note: string | null;
};

/**
 * THE DECISION. Every refusal is a pure function of the facts above, so every one of them is proved
 * in migration-class-gate without arranging an out-of-date production.
 *
 * FAILS CLOSED on anything it cannot establish: unreachable, non-200, a null commit, a commit this
 * clone has never heard of, a commit that is not an ancestor of HEAD. "I could not tell" and "it is
 * safe" must never be the same answer.
 */
export function deployDecision(f: DeployFacts): DeployDecision {
  const refusals: string[] = [];
  for (const m of f.pending) if (m.refusal) refusals.push(m.refusal);
  const constraining = f.pending.filter((m) => m.klass === 'constraining');

  // A CLASSIFICATION REFUSAL IS NEVER OVERRIDABLE. The override accepts a known window against a
  // known production; it does not accept "we do not know what this migration does".
  if (refusals.length) return { allow: false, constraining, refusals, overridden: false, note: null };
  if (!constraining.length) return { allow: true, constraining, refusals, overridden: false, note: null };

  const blocking: string[] = [];
  if (!f.version.ok) {
    blocking.push(`production did not answer: ${f.version.why}\n    Refusing. An unreachable production is not a safe production.`);
  } else if (!f.version.commit) {
    blocking.push(`production answered with no commit (source: ${f.version.source ?? 'unknown'}, env: ${f.version.env ?? 'unknown'}).\n    Refusing — a null is an honest "I do not know", and it must not read as a match.`);
  } else if (f.liveIsAncestor === null) {
    blocking.push(`production is running ${f.version.commit.slice(0, 12)}, which this clone does not have even after a fetch.\n    Refusing — nothing here can say what that commit contains.`);
  } else if (f.liveIsAncestor === false) {
    blocking.push(`production is running ${f.version.commit.slice(0, 12)}, which is not an ancestor of HEAD (${f.head.slice(0, 12)}).\n    Refusing — production may be ahead of this tree, or on another branch entirely.`);
  } else {
    if (f.uncommittedAppFiles.length) {
      blocking.push(`app code is uncommitted, so it certainly is not live:\n      ${f.uncommittedAppFiles.slice(0, 20).join('\n      ')}`);
    }
    if (f.appFilesNotLive.length) {
      blocking.push(`production is running ${f.version.commit.slice(0, 12)}; ${f.appFilesNotLive.length} app file(s) in this tree are not live yet:\n      ${f.appFilesNotLive.slice(0, 20).join('\n      ')}`
        + `\n    Push the code, wait for /api/version to report this commit, then apply.`);
    }
    if (f.schemaDefaults.length) {
      blocking.push(`prisma/schema.prisma adds a client-generated default that production does not have:\n      ${f.schemaDefaults.join('\n      ')}`
        + `\n    A default is generated in the client, so production would send no value where this tree sends one.`);
    }
  }

  if (!blocking.length) return { allow: true, constraining, refusals, overridden: false, note: null };
  if (!f.override) return { allow: false, constraining, refusals: blocking, overridden: false, note: null };
  return {
    allow: true,
    constraining,
    refusals: blocking,
    overridden: true,
    note: overrideNote({ when: new Date(), live: f.version.ok ? f.version.commit : null, head: f.head, appFilesNotLive: f.appFilesNotLive, reason: f.override, blocking }),
  };
}

/**
 * THE DURABLE RECORD. An override is a deliberate decision to accept a window; whoever looks in six
 * months wants to know which migrations were applied against an out-of-date production and why
 * (owner, 2026-09-12). So it goes in the migration file, which travels with what it describes —
 * not only into a run log that nobody keeps.
 *
 * WRITTEN BEFORE THE APPLY, and that ordering is not a detail: Prisma records a checksum of
 * migration.sql when it applies it, so a line added AFTERWARDS makes every later `migrate deploy`
 * refuse the file as modified. Written first, the checksum covers it.
 *
 * Phrased as the DECISION and the MEASUREMENT, both of which are true whether or not the apply then
 * succeeds — a note left behind by a crashed run is still an accurate record of what was decided.
 */
export function overrideNote(i: { when: Date; live: string | null; head: string; appFilesNotLive: string[]; reason: string; blocking: string[] }): string {
  const files = i.appFilesNotLive.length ? i.appFilesNotLive.slice(0, 12).join(', ') + (i.appFilesNotLive.length > 12 ? `, +${i.appFilesNotLive.length - 12} more` : '') : 'none';
  return [
    `-- @applied-ahead-of-deploy: ${i.when.toISOString()}`,
    `--   production was running: ${i.live ?? 'UNKNOWN — it did not answer'}`,
    `--   this tree: ${i.head}`,
    `--   app files not live at the time: ${files}`,
    `--   reason given: ${i.reason}`,
    `--   Applied with --even-if-not-live. Until the push landed, production ran code that did not`,
    `--   satisfy this migration. If something broke in that window, this is the window.`,
  ].join('\n');
}

/** Already recorded for this same production commit — so a retried apply does not stack notes. */
export function hasOverrideNote(sql: string, live: string | null): boolean {
  return new RegExp(`^--   production was running: ${live ?? 'UNKNOWN'}`, 'm').test(sql);
}

/** The note belongs with the declaration, or failing that at the very top. Comments only, so it is always valid SQL. */
export function withOverrideNote(sql: string, note: string): string {
  const m = /^[ \t]*--[ \t]*@migration:.*$/m.exec(sql);
  if (!m) return `${note}\n${sql}`;
  const at = m.index + m[0].length;
  return `${sql.slice(0, at)}\n${note}${sql.slice(at)}`;
}

/**
 * WHERE THE TRUTH ABOUT PRODUCTION LIVES. Hardcoded, and not readable from the environment on
 * purpose: an env var would let a local .env pointing at localhost satisfy the check, which is the
 * one way this whole mechanism could pass while proving nothing.
 */
export const PRODUCTION_VERSION_URL = 'https://greasedesk.com/api/version';
