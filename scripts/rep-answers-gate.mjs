// @gate-timeout: 300
/**
 * File: scripts/rep-answers-gate.mjs
 * "NOT ASKED" IS A VALUE, AND THE VISIT ITSELF CANNOT BE EDITED.
 *
 * The four answers a rep writes up after a visit, and the payments lead one of them becomes.
 *
 * ── THE PRECEDENT THIS FOLLOWS, RATHER THAN A SECOND ONE ────────────────────────────────────────
 * lib/due-items already solved three-state: `not_raised` is a VALUE on a NOT NULL column and
 * `response_at` is the nullable one, because "nobody answered" is an absence rather than an answer
 * at time-unknown. Every answer here is shaped the same way. Using NULL for "not asked" would have
 * collided with the two answers where the negative is real and commercially useful — "they are not
 * interested" is the lead outcome, and "nothing is missing, we are happy" is a genuine reply.
 *
 * ── INSERT-ONLY BY CONSTRUCTION ─────────────────────────────────────────────────────────────────
 * The answers live in their own rows so RepVisit has nothing to update. That is what makes the
 * scan below cheap and honest: the same scan over one combined table would be unenforceable,
 * because the answer writer would legitimately need `update`.
 *
 * Everything is DORMANT. Nothing reads an answer or a lead; the only wired change is that a tenant
 * login now stamps User.last_login_at, which nothing reads either.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync, readdirSync, statSync } = await import('node:fs');
const { join } = await import('node:path');
const { randomUUID } = await import('node:crypto');
const A = await import('../lib/rep-answers.ts');
const prisma = await gatePrisma();

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const NOW = new Date('2026-09-07T10:00:00.000Z');

try {
  // ── 1. THREE-STATE, THE WAY due-items DOES IT ────────────────────────────────────────────────
  console.log('\n— "not asked" is a value, not an absence —');
  check('every answer set carries not_asked', [A.APP_WORKING, A.USING_IT, A.WHATS_MISSING, A.LEAD_INTEREST]
    .every((set) => set.includes('not_asked')));
  check('  …and the workflow status does NOT', !A.LEAD_STATUS.includes('not_asked'),
    'status is what WE did about the lead; interest is what the garage said. Two axes, never one');
  check('the negatives are real values, not nulls',
    A.APP_WORKING.includes('problems') && A.USING_IT.includes('barely')
    && A.WHATS_MISSING.includes('nothing') && A.LEAD_INTEREST.includes('not_interested'),
    'the two that matter commercially: "not interested" is the lead outcome, "nothing" is a happy garage');
  // THE responseAtFor RULE, borrowed exactly. Only an ANSWER is an event.
  check('an answer stamps a time', A.answeredAtFor('problems', NOW)?.getTime() === NOW.getTime());
  check('  …and so does a negative one', A.answeredAtFor('nothing', NOW)?.getTime() === NOW.getTime(),
    '"nothing is missing" was asked and answered — the whole point of it not being null');
  check('  …while not_asked stamps nothing', A.answeredAtFor('not_asked', NOW) === null,
    'an absence, not an answer at time-unknown — lib/due-items::responseAtFor, same rule');
  // RAW, not prose(): the precedent is named in a COMMENT, which is exactly where an argument
  // belongs and exactly what prose() strips. The first version of this check ran the file through
  // prose() and failed on correct code — the same mistake this suite has made four times.
  check('the precedent is named in the source', /not_raised/.test(readFileSync('lib/rep-answers.ts', 'utf8')),
    'so the next reader finds the argument rather than re-deciding it');

  // ── 2. THE REFUSALS ──────────────────────────────────────────────────────────────────────────
  console.log('\n— a recorded problem nobody described is a ticket nobody can action —');
  const ans = (o = {}) => ({ appWorking: 'working', appWorkingNote: null, usingIt: 'daily',
    whatsMissingState: 'not_asked', whatsMissingText: null, ...o });
  check('a clean answer is accepted', A.refuseAnswer(ans()) === null, JSON.stringify(A.refuseAnswer(ans())));
  const noNote = A.refuseAnswer(ans({ appWorking: 'problems' }));
  check('problems with no prose is REFUSED', noNote?.code === 'problem_undescribed', JSON.stringify(noNote));
  check('  …and a blank note is not a description', A.refuseAnswer(ans({ appWorking: 'problems', appWorkingNote: '   ' }))?.code === 'problem_undescribed');
  check('  …while a described problem is accepted', A.refuseAnswer(ans({ appWorking: 'problems', appWorkingNote: 'Diary is slow on their tablet' })) === null);
  // THE CLAIM IS NARROW, and the first version got it wrong: app_working IS constrained, to its
  // closed set and to its timestamp pairing. What must NOT exist is a constraint tying `problems`
  // to the note, because the database can only demand non-emptiness and half a rule in the schema
  // reads as the whole rule to the next person.
  const mig = readFileSync('prisma/migrations/20260907160000_rep_answers/migration.sql', 'utf8');
  check('  …and this one is a REFUSAL, not a constraint',
    !/app_working_note[^;]*problems|problems[^;]*app_working_note/.test(mig),
    'the database cannot say a note is a description, only that it is non-empty — so the rule lives where judgement does');
  check('  …while the SHAPE rules ARE constraints', /RepVisitAnswer_missing_chk/.test(mig) && /RepVisitAnswer_asked_at_chk/.test(mig),
    'the asymmetry is the point: a shape is what a CHECK is good at, judgement is not');
  check('working with a note is fine', A.refuseAnswer(ans({ appWorkingNote: 'They love it' })) === null,
    'prose is welcome anywhere; it is only REQUIRED beside a problem');
  console.log('\n— and the values themselves are closed sets —');
  check('an invented answer is refused', A.refuseAnswer(ans({ usingIt: 'loads' }))?.code === 'bad_value');
  check('  …including an empty one', A.refuseAnswer(ans({ appWorking: '' }))?.code === 'bad_value');
  check('  …and NULL is not a way in', A.refuseAnswer(ans({ usingIt: null }))?.code === 'bad_value',
    'the column is NOT NULL; a writer that could pass null would be routing round the whole design');

  console.log('\n— what is missing: three states, one of which carries prose —');
  check('said with text is accepted', A.refuseAnswer(ans({ whatsMissingState: 'said', whatsMissingText: 'Tyre stock ordering' })) === null);
  check('said with NO text is refused', A.refuseAnswer(ans({ whatsMissingState: 'said', whatsMissingText: null }))?.code === 'missing_text');
  check('nothing WITH text is refused', A.refuseAnswer(ans({ whatsMissingState: 'nothing', whatsMissingText: 'x' }))?.code === 'missing_text',
    'four representable combinations for three real states is how the fourth becomes nonsense nobody prevents');
  check('not_asked with text is refused', A.refuseAnswer(ans({ whatsMissingState: 'not_asked', whatsMissingText: 'x' }))?.code === 'missing_text');

  console.log('\n— the lead —');
  const lead = (o = {}) => ({ interest: 'not_asked', status: 'open', closedAt: null, ...o });
  check('an open lead nobody has asked yet is fine', A.refuseLead(lead()) === null);
  check('interest and status are independent',
    A.refuseLead(lead({ interest: 'interested', status: 'open' })) === null
    && A.refuseLead(lead({ interest: 'not_interested', status: 'declined', closedAt: NOW })) === null,
    'a lead can be open with interest not_asked (ran out of time) or open with interest interested (nobody followed up)');
  check('a closed lead must say when', A.refuseLead(lead({ status: 'converted', closedAt: null }))?.code === 'bad_closure');
  check('  …and an open one must NOT', A.refuseLead(lead({ status: 'open', closedAt: NOW }))?.code === 'bad_closure');
  check('an invented status is refused', A.refuseLead(lead({ status: 'maybe' }))?.code === 'bad_value');

  console.log('\n— completeness is derived, never stored —');
  check('all three answered is complete', A.answersComplete(ans({ whatsMissingState: 'nothing' })) === true);
  check('  …and one not_asked is not', A.answersComplete(ans()) === false,
    'not_asked IS the incomplete state — that is what makes a "needs writing up" list possible');
  check('  …and a stored flag would drift', !/complete\s+Boolean/.test(readFileSync('prisma/schema.prisma', 'utf8')));

  // ── 3. THE VISIT CANNOT BE EDITED ────────────────────────────────────────────────────────────
  console.log('\n— RepVisit is insert-only, by construction —');
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const model = (n) => schema.split(`model ${n} {`)[1]?.split('\n}')[0] ?? '';
  check('RepVisitAnswer is its own row', model('RepVisitAnswer').length > 0);
  check('  …at most one per visit', /visit_id\s+String\s+@unique/.test(model('RepVisitAnswer')));
  check('RepLead is its own row, also 0..1', /visit_id\s+String\s+@unique/.test(model('RepLead')));
  check('RepVisit still has no updatedAt', !/updatedAt/.test(model('RepVisit')),
    'a column that stamps an edit is a column that expects one');
  // THE SCAN. Split terms, because a scan whose search string appears in its own source finds
  // itself — which is how the node_modules scan in client-freshness-gate failed on its first run.
  const VERBS = ['repVisit' + '.update(', 'repVisit' + '.updateMany(', 'repVisit' + '.upsert('];
  const walk = (d) => readdirSync(d).flatMap((e) => {
    const p = join(d, e);
    return statSync(p).isDirectory() ? walk(p) : (/\.(ts|tsx)$/.test(p) ? [p] : []);
  });
  const sources = [...walk('lib'), ...walk('pages')];
  const offenders = sources.filter((f) => { const s = readFileSync(f, 'utf8'); return VERBS.some((v) => s.includes(v)); });
  check('nothing updates a RepVisit', offenders.length === 0, offenders.join(', ') || `${sources.length} files scanned`);
  check('  …and the scan can still see one',
    VERBS.some((v) => `x ${'repVisit' + '.update('}y`.includes(v)),
    'otherwise it passes by looking for nothing');
  check('  …across a population worth the name', sources.length >= 300, `${sources.length} files`);

  // ── 4. THE PAIRING THE DATABASE ENFORCES ─────────────────────────────────────────────────────
  // Asked of Postgres, not read off the migration: a CHECK has drifted from the code twice here and
  // enum-drift-gate compares pg_enum, a different object. Every probe rolls back.
  console.log('\n— and Postgres holds the whats_missing pairing —');
  const zz = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
  const site = await prisma.site.findFirst({ where: { group_id: zz }, select: { id: true } });
  let visitId = null;
  const tryAnswer = async (row) => {
    try {
      await prisma.$transaction(async (tx) => {
        const v = await tx.repVisit.create({ data: { group_id: zz, site_id: site.id, party_type: 'rep',
          party_id: randomUUID(), scanned_at: NOW, satisfies_period: null, source: 'scan',
          code_step: Math.floor(Math.random() * 1e9) }, select: { id: true } });
        await tx.repVisitAnswer.create({ data: { visit_id: v.id, app_working: 'working', app_working_at: NOW,
          using_it: 'daily', using_it_at: NOW, whats_missing_state: 'not_asked', whats_missing_at: null, ...row } });
        throw new Error('ROLLBACK');
      });
      return 'accepted';
    } catch (e) {
      if (/ROLLBACK/.test(String(e?.message))) return 'accepted';
      return describeError(e);
    }
  };
  const refused = (r) => /23514/.test(r);
  check('said with no text is refused by the database',
    refused(await tryAnswer({ whats_missing_state: 'said', whats_missing_text: null, whats_missing_at: NOW })));
  check('  …and a blank one too', refused(await tryAnswer({ whats_missing_state: 'said', whats_missing_text: '  ', whats_missing_at: NOW })));
  check('  …while said WITH text is accepted',
    (await tryAnswer({ whats_missing_state: 'said', whats_missing_text: 'Tyre stock', whats_missing_at: NOW })) === 'accepted');
  check('nothing-with-text is refused', refused(await tryAnswer({ whats_missing_state: 'nothing', whats_missing_text: 'x', whats_missing_at: NOW })));
  check('an answer that was asked must carry its time',
    refused(await tryAnswer({ whats_missing_state: 'nothing', whats_missing_text: null, whats_missing_at: null })),
    'the responseAtFor rule made physical: only not_asked leaves the timestamp null');
  check('  …and one that was NOT asked must not', refused(await tryAnswer({ whats_missing_state: 'not_asked', whats_missing_at: NOW })));
  check('an invented state is refused', refused(await tryAnswer({ whats_missing_state: 'invented' })));
  check('nothing was kept', (await prisma.repVisit.count({ where: { group_id: zz } })) === 0
    && (await prisma.repVisitAnswer.count()) === 0, 'every probe ran inside a rolled-back transaction');

  // ── 5. THE EDIT TRAIL IS THE PLATFORM'S, NOT THE GARAGE'S ────────────────────────────────────
  console.log('\n— an answer edit is not the garage’s business —');
  const audit = model('SuperAdminAudit');
  check('the platform ledger can name a REP actor', /actor_rep_id\s+String\?/.test(audit),
    'AuditLog is the tenant’s trail and a garage can read theirs; what a rep said about them is not theirs to read');
  check('  …without making the platform sentinel ambiguous',
    /both null/i.test(audit) || /platform itself acted/i.test(audit),
    'operator_user_id NULL already means "the platform acted" — a second nullable actor must not blur that');
  check('lib/rep-answers writes the edit trail', /superAdminAudit/.test(readFileSync('lib/rep-answers.ts', 'utf8')));
  check('  …and never AuditLog', !/auditLog|writeAudit/.test(readFileSync('lib/rep-answers.ts', 'utf8')),
    'one line in the wrong table publishes a rep’s assessment to the garage it is about');

  // ── 6. THE LOGIN STAMP ───────────────────────────────────────────────────────────────────────
  console.log('\n— a tenant login is recorded, the way an operator login already is —');
  check('User carries last_login_at', /last_login_at\s+DateTime\?/.test(model('User')));
  const auth = readFileSync('pages/api/auth/[...nextauth].ts', 'utf8');
  check('the tenant provider stamps it', /user\.update\(\{ where: \{ id: user\.id \}, data: \{ last_login_at/.test(auth));
  check('  …and never blocks the login if it fails', /last_login_at[\s\S]{0,160}catch\(\(\) => \{\}\)/.test(auth),
    'the operator provider already does exactly this — a telemetry write must not cost somebody their session');
  check('  …after the second factor, not before', auth.indexOf('last_login_at: new Date() } }).catch(() => {})',
    auth.indexOf('actorClass: \'tenant\'') - 4000) > auth.indexOf('TWO_FACTOR_REQUIRED'),
    'a stamp before the last gate records a login that never happened');

  // ── 7. STILL DORMANT ─────────────────────────────────────────────────────────────────────────
  console.log('\n— and nothing reads any of it —');
  // ONE NAMED EXCEPTION, and it is not a read of an answer. lib/tenant-purge COUNTS these rows
  // before and after an erasure to prove they are gone — the honest-after-count rule that exists
  // because a purge once reported a clean sweep over a real mobile number. Counting rows is not
  // reading what a rep wrote, so the exception is named rather than the claim weakened; the
  // narrower assertion below is what stops it widening into one.
  const PURGE = 'lib/tenant-purge.ts';
  const readers = sources.filter((f) => f !== PURGE
    && /repVisitAnswer\.(find|count|aggregate)|repLead\.(find|count|aggregate)/.test(readFileSync(f, 'utf8')));
  check('nothing reads an answer or a lead', readers.length === 0, readers.join(', '));
  const purgeSrc = readFileSync(PURGE, 'utf8');
  const verbs = [...purgeSrc.matchAll(/\b(?:repVisitAnswer|repLead)\.(\w+)\(/g)].map((m) => m[1]);
  check('  …and the purge only counts and deletes them', verbs.every((v) => v === 'count' || v === 'deleteMany'),
    [...new Set(verbs)].join(', ') || 'none');
  check('  …never selecting a column', !/repVisitAnswer[\s\S]{0,120}app_working_note|repLead[\s\S]{0,120}provider/.test(purgeSrc),
    'the prose is what erasure is about — an after-count must never have to look at it');
  // THE LOGIN STAMP NEEDS A NARROWER CLAIM. Operator.last_login_at has existed for weeks and IS
  // read, in the Engine Room operator list — the first version of this check flagged those two
  // files and was measuring the wrong column. So: every mention on the TENANT model must be the
  // one write in the auth provider.
  const tenantStamp = [];
  for (const f of sources) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/last_login_at/g)) {
      const before = src.slice(Math.max(0, m.index - 160), m.index);
      if (/prisma\.user\.|tx\.user\./.test(before)) tenantStamp.push({ f, write: /\.update\(/.test(before) });
    }
  }
  check('the tenant stamp is written in exactly one place', tenantStamp.length === 1,
    tenantStamp.map((t) => t.f).join(', ') || 'none');
  check('  …and that place WRITES it rather than reading it', tenantStamp.every((t) => t.write),
    'dormant means recorded and not yet consulted');
  check('  …while the operator column, which IS read, is untouched by this claim',
    sources.some((f) => /prisma\.operator[\s\S]{0,200}last_login_at|last_login_at[\s\S]{0,80}operator/i.test(readFileSync(f, 'utf8'))),
    'it has been read in the Engine Room for weeks — a scan that flagged it was measuring the wrong column');
  check('  …and no surface renders one', !readdirSync('pages/rep').some((f) => /answer|lead/i.test(f)));
  check('there are no rows', (await prisma.repVisitAnswer.count()) === 0 && (await prisma.repLead.count()) === 0);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 400));
} finally {
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(f ? 1 : 0);
}
