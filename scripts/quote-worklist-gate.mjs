/**
 * File: scripts/quote-worklist-gate.mjs
 * THE QUOTE LIST IS A WORKLIST — A QUOTE LEAVES WHEN THERE IS NOTHING LEFT TO CHASE.
 * @gate-requires: db
 *
 * ── THE DEFECT, AND IT WAS NOT THE ONE WE EXPECTED ──────────────────────────────────────────────
 * LO25UGN sat under "Awaiting response" while booked on a lift for Friday. The first theory was that
 * a garage-recorded acceptance did not count. It does: both routes go through lib/quote-acceptance
 * and both flip the live version. The real shape is ORDER:
 *
 *     12:16:43  quote.accepted  via: booked  version: null   ← accept & book, no quote existed yet
 *     13:17:34  quote.sent      version: 1                   ← the written quote, an hour later
 *
 * v1 was born `sent` on a card that was already accepted, and nobody will ever answer it because
 * there is nothing left to answer. deriveQuoteStatus read ONLY the version, so it said "awaiting" —
 * and so did the Marketing board, which calls the same function, and would have filed LO25UGN as an
 * expired-quote lead on 22 September for a job already done.
 *
 * ── THE FIX IS A SIGNATURE, NOT A ROW BUILDER ───────────────────────────────────────────────────
 * deriveQuoteStatus now REQUIRES the card. Every caller failed to compile until it passed one —
 * which is the point: marketing-board calls it directly, and a fix in listQuotes' row builder would
 * have left the board showing LO25UGN as a lead.
 *
 * ── EVERY REMOVAL CLAUSE PASSES ON AN EMPTY LIST ────────────────────────────────────────────────
 * So the positive case is asserted IN THE SAME RUN, twice: a ZZ fixture that must stay, and the
 * genuinely-awaiting quotes on the live tenant, compared against an oracle computed from raw rows
 * without asking deriveQuoteStatus anything — an oracle that calls the function under test is not
 * an oracle.
 *
 * Fixtures on ZZ Gate Garage only, each on its OWN vehicle (the board is keyed by car, so two cards
 * on one car would let one mask the other), removed by their own ids. TMBS is READ, never written.
 */
import './_gate-preflight.mjs';
const { gatePrisma, zzSite, describeError, ZZ_GROUP } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { keyRegex } = await import('../lib/anchored-match.ts');
const { readFileSync } = await import('node:fs');
const { randomUUID } = await import('node:crypto');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const prisma = await gatePrisma();
const L = await import('../lib/quotes-list.ts');
const P = await import('../lib/acceptance-provenance.ts');
const { freezeQuoteVersion } = await import('../lib/quote-version.ts');
const { acceptQuote } = await import('../lib/quote-acceptance.ts');
const { buildBoard } = await import('../lib/marketing-board.ts');
// NOT lib/jobcard-page-data. It reaches pages/api/auth/[...nextauth] through the session helpers,
// and next-auth/providers/credentials resolves to a namespace rather than a callable under this
// harness — "CredentialsProvider is not a function" at load. Second time that limit has blocked a
// gate (rep-auth-gate was the first). Rather than stand NextAuth up to read one label, the card's
// rule is a PURE FUNCTION — cardAcceptance — applied below to each fixture's REAL rows, and a source
// clause proves the page calls that function and nothing of its own.
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const TMBS = '854d38e7-6dd4-4836-af61-a0d169639a78';
const made = { cards: [], vehicles: [], customers: [] };

try {
  const site = await zzSite(prisma);
  const owner = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP, email: 'owner@zzgategarage.test' }, select: { id: true } });
  const bay = await prisma.resource.findFirst({ where: { site_id: site.id }, select: { id: true } });
  if (!bay) throw new Error('ZZ has no resource to book onto — the booked shapes cannot be built');

  /** One card on its own car, with one labour line so a version can be frozen. */
  const mkCard = async (label) => {
    const reg = `QW${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    const cust = await prisma.customer.create({ data: { group_id: ZZ_GROUP, name: `Worklist ${label}`, phone: '07700 900777' }, select: { id: true } });
    made.customers.push(cust.id);
    // AN MOT DATE, FAR OFF — because the Marketing board only considers a car with a CONDITION (MOT,
    // open finding, battery or tyre reading), and a quote then becomes one of its reasons. The first
    // version of these fixtures had none, so the board never looked at them and the agreement clause
    // failed against a car no real tenant has. All 8 open quotes on the live tenant sit on cars the
    // board can see (measured 2026-09-10), so this is the realistic shape, not a convenience.
    const veh = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: reg, registration_normalized: reg, make: 'Worklist', model: label,
      mot_expiry: new Date(Date.now() + 300 * 86_400_000) }, select: { id: true } });
    made.vehicles.push(veh.id);
    await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true } });
    const card = await prisma.jobCard.create({
      data: { group_id: ZZ_GROUP, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'quoted', odometer_in: 40000 },
      select: { id: true } });
    made.cards.push(card.id);
    await prisma.jobCardItem.create({ data: { job_card_id: card.id, item_type: 'labour', description: `Worklist ${label}`,
      qty: 1, unit_price: 100, vat_rate: 20, vat_amount: 20, labour_hours: 1 } });
    return { id: card.id, vehicleId: veh.id };
  };
  const send = (c) => freezeQuoteVersion({ groupId: ZZ_GROUP, jobCardId: c.id, vatRegistered: true, taxLabel: 'VAT' });
  const accept = (c, who) => prisma.$transaction((tx) => acceptQuote(tx, who === 'customer'
    ? { groupId: ZZ_GROUP, jobCardId: c.id, via: 'link', actorUserId: null, attested: { ip: '203.0.113.9', userAgent: 'gate' }, at: new Date() }
    : { groupId: ZZ_GROUP, jobCardId: c.id, via: who === 'booked' ? 'booked' : 'counter', actorUserId: owner.id, attested: null, at: new Date() }));
  const book = (c) => {
    const start = new Date(Date.now() + 2 * 86_400_000);
    return prisma.jobCard.update({ where: { id: c.id }, data: { resource_id: bay.id, start_at: start, end_at: new Date(start.getTime() + 3_600_000) } });
  };

  // ── THE EIGHT SHAPES, BUILT THROUGH THE PRODUCT'S OWN PATH ───────────────────────────────────
  const F = {};
  F.customer = await mkCard('customer');      await send(F.customer); await accept(F.customer, 'customer');
  F.garage = await mkCard('garage');          await send(F.garage);   await accept(F.garage, 'garage');
  // LO25UGN's exact order: accepted and booked with NO version, THEN the written quote goes out.
  F.acceptThenSend = await mkCard('then-send'); await accept(F.acceptThenSend, 'booked'); await book(F.acceptThenSend); await send(F.acceptThenSend);
  F.customerBooked = await mkCard('cust-booked'); await send(F.customerBooked); await accept(F.customerBooked, 'customer'); await book(F.customerBooked);
  // Booked while still quoted, and nobody ever said yes.
  F.bookedNeverAccepted = await mkCard('booked-no-yes'); await send(F.bookedNeverAccepted); await book(F.bookedNeverAccepted);
  F.inProgress = await mkCard('in-progress'); await accept(F.inProgress, 'garage'); await send(F.inProgress);
  await prisma.jobCard.update({ where: { id: F.inProgress.id }, data: { status: 'in_progress' } });
  F.cancelled = await mkCard('cancelled');    await send(F.cancelled);
  await prisma.jobCard.update({ where: { id: F.cancelled.id }, data: { status: 'cancelled' } });
  F.positive = await mkCard('positive');      await send(F.positive);   // out, unanswered, unbooked
  // VERBAL — quoted, no version ever sent. The versionless branch hardcoded 'awaiting', so a booked
  // verbal quote (CF18VNM, live) stayed on the worklist after the versioned path was fixed.
  F.verbalBooked = await mkCard('verbal-booked'); await book(F.verbalBooked);
  F.verbalOpen = await mkCard('verbal-open');     // quoted, unbooked, nobody asked, nobody answered

  // THE FIXTURES REACHED THE STATES THEY NAME — asserted, not assumed.
  const v = async (c) => prisma.quoteVersion.findFirst({ where: { job_card_id: c.id }, orderBy: { version: 'desc' }, select: { status: true } });
  const card = async (c) => prisma.jobCard.findUnique({ where: { id: c.id }, select: { status: true, accepted_at: true } });
  check('the LO25UGN shape is real: card accepted, latest version still SENT',
    (await card(F.acceptThenSend)).status === 'accepted' && (await v(F.acceptThenSend)).status === 'sent',
    'without this, every clause about it would be testing a state nothing is in');
  check('  …and the booked-never-accepted card was never accepted',
    (await card(F.bookedNeverAccepted)).status === 'quoted' && (await card(F.bookedNeverAccepted)).accepted_at === null);

  // ── 1. THE WORKLIST ──────────────────────────────────────────────────────────────────────────
  console.log('\n— what leaves the worklist, and where it goes —');
  const all = await L.listQuotes({ groupId: ZZ_GROUP, siteIds: [site.id] });
  const statusOf = (c) => all.find((r) => r.jobCardId === c.id)?.status ?? '(not listed)';
  const awaiting = new Set(all.filter((r) => r.status === 'awaiting').map((r) => r.jobCardId));

  check('a CUSTOMER-accepted quote leaves Awaiting', !awaiting.has(F.customer.id), statusOf(F.customer));
  check('a GARAGE-accepted quote leaves Awaiting', !awaiting.has(F.garage.id), statusOf(F.garage));
  check('ACCEPT-THEN-SEND leaves Awaiting', !awaiting.has(F.acceptThenSend.id),
    `${statusOf(F.acceptThenSend)} — LO25UGN's shape; this is the clause that was red`);
  check('  …and lands in Accepted & booked, not nowhere', statusOf(F.acceptThenSend) === 'accepted_booked',
    'moved to the honest tab, exactly where a customer-accepted-and-booked card goes');
  check('a booked quote leaves regardless of how it was accepted',
    !awaiting.has(F.customerBooked.id) && statusOf(F.customerBooked) === 'accepted_booked', statusOf(F.customerBooked));
  check('BOOKED BUT NEVER ACCEPTED leaves the worklist', !awaiting.has(F.bookedNeverAccepted.id), statusOf(F.bookedNeverAccepted));
  check('  …into its OWN destination', statusOf(F.bookedNeverAccepted) === 'booked_unaccepted',
    'not accepted_booked — that would be a lie one layer down, the defect being fixed');
  check('  …and it is NOT filed as expired either', statusOf(F.bookedNeverAccepted) !== 'expired',
    'it is in the diary; there is nothing for Marketing to chase');
  check('IN PROGRESS is past acceptance and leaves', !awaiting.has(F.inProgress.id), statusOf(F.inProgress));
  check('a CANCELLED quote leaves', !awaiting.has(F.cancelled.id), statusOf(F.cancelled));
  check('a BOOKED VERBAL quote leaves too', !awaiting.has(F.verbalBooked.id) && statusOf(F.verbalBooked) === 'booked_unaccepted',
    `${statusOf(F.verbalBooked)} — the versionless branch was a second copy of the derivation; CF18VNM sat here`);
  check('an unbooked verbal quote STAYS', awaiting.has(F.verbalOpen.id), statusOf(F.verbalOpen));

  // THE POSITIVE CASE, IN THE SAME RUN. Every clause above passes on an empty list.
  check('an unanswered, unbooked quote STAYS in Awaiting', awaiting.has(F.positive.id),
    `${statusOf(F.positive)} — the list is not simply empty`);

  // ── 2. THE BOARD AGREES, FOR EVERY SHAPE ─────────────────────────────────────────────────────
  console.log('\n— the Marketing board says the same thing about every card —');
  const board = await buildBoard(ZZ_GROUP);
  const rows = [...board.hot, ...board.warm, ...board.later];
  const hasQuoteLead = (c) => rows.some((r) => r.vehicleId === c.vehicleId
    && r.reasons.some((x) => x.kind === 'quote_open' || x.kind === 'quote_expired'));
  const disagreements = Object.entries(F).filter(([, c]) => {
    const listSaysChase = ['awaiting', 'expired'].includes(statusOf(c));
    return listSaysChase !== hasQuoteLead(c);
  }).map(([k, c]) => `${k}: list=${statusOf(c)} board=${hasQuoteLead(c) ? 'lead' : 'no lead'}`);
  check('the board treats every fixture exactly as the list does', disagreements.length === 0,
    disagreements.join('; ') || `${Object.keys(F).length} shapes, no disagreement`);
  check('  …and it DOES carry the positive case as a lead', hasQuoteLead(F.positive),
    'the agreement clause above would pass on a board with no quote leads at all');

  // ── 3. HOW IT WAS ACCEPTED STILL SHOWS — AND FROM THE SAME FACT ──────────────────────────────
  console.log('\n— the card still says who said yes, from the same fact the list uses —');
  // THE CARD'S LABEL, FROM THE CARD'S REAL ROWS: the same function the page calls, fed exactly what
  // the page reads — status, accepted_at, and the whole version series with the provenance pair.
  const label = async (c) => {
    const row = await prisma.jobCard.findUnique({ where: { id: c.id }, select: { status: true, accepted_at: true } });
    const versions = await prisma.quoteVersion.findMany({ where: { job_card_id: c.id },
      select: { version: true, status: true, responded_by_user: true, responded_ip: true } });
    const prov = P.cardAcceptance(row, versions);
    return prov ? P.PROVENANCE_LABEL[prov] : null;
  };
  const lbl = {};
  for (const [k, c] of Object.entries(F)) lbl[k] = await label(c);
  check('a customer acceptance reads as the customer\'s', lbl.customer === P.PROVENANCE_LABEL.customer, String(lbl.customer));
  check('a garage acceptance reads as the garage\'s', lbl.garage === P.PROVENANCE_LABEL.garage, String(lbl.garage));
  check('ACCEPT-THEN-SEND still reads "Recorded by the garage"', lbl.acceptThenSend === P.PROVENANCE_LABEL.garage,
    `${lbl.acceptThenSend} — LO25UGN's evidence survives: nobody but the garage witnessed that yes`);
  check('a card nobody accepted claims no acceptance', lbl.positive === null && lbl.bookedNeverAccepted === null,
    `positive=${lbl.positive} booked-never-accepted=${lbl.bookedNeverAccepted}`);
  check('a card CANCELLED before anyone said yes claims no acceptance', lbl.cancelled === null,
    `${lbl.cancelled} — the card page used to say "Recorded by the garage" here, for a yes that never happened`);

  // THE SAME FACT, BY CONSTRUCTION AND BY BEHAVIOUR. They agreed before by coincidence of both being
  // right about the cases that existed; now both call one predicate, and every fixture proves it.
  const listSaysAccepted = (c) => ['accepted', 'accepted_booked'].includes(statusOf(c));
  const listed = Object.entries(F).filter(([, c]) => all.some((r) => r.jobCardId === c.id));
  const split = listed.filter(([k, c]) => listSaysAccepted(c) !== (lbl[k] !== null)).map(([k]) => k);
  check('the list and the card agree on WHETHER anyone said yes, for every listed card', split.length === 0,
    split.join(', ') || `${listed.length} listed shapes — list-accepted iff card-labelled`);
  const listSrc = code(readFileSync('lib/quotes-list.ts', 'utf8'));
  const pageSrc = code(readFileSync('lib/jobcard-page-data.ts', 'utf8'));
  // THE CHAIN, AS IT ACTUALLY IS. The first version of this asserted the page called cardWasAccepted
  // directly and went red — the page calls cardAcceptance, which calls cardWasAccepted. Both routes
  // end at one predicate; the assertion now says so rather than demanding a shape nobody wrote.
  const provSrc = code(readFileSync('lib/acceptance-provenance.ts', 'utf8'));
  const cardAcceptanceBody = (provSrc.split('export function cardAcceptance')[1] ?? '').split('\nexport ')[0];
  check('  …because both end at cardWasAccepted',
    /cardWasAccepted\(/.test(listSrc) && /cardAcceptance\(/.test(pageSrc) && /cardWasAccepted\(/.test(cardAcceptanceBody),
    'list → cardWasAccepted; page → cardAcceptance → cardWasAccepted. One predicate, two readers');
  check('  …and the page derives its label through cardAcceptance', /acceptanceProv\s*=\s*cardAcceptance\(/.test(pageSrc.replace(/\s+/g, ' ')),
    'so the pure function this gate drives IS the page\'s rule, not a copy of it');
  check('  …and neither re-derives it from a status list of its own',
    !/row\.status === 'draft' \|\| row\.status === 'quoted' \|\| row\.status === 'declined'/.test(pageSrc),
    'the inline rule that labelled a cancelled card as garage-accepted is gone');

  // THE AUDIT TRAIL KEEPS THE DISTINCTION — it evidences HOW, and it must not drive the worklist.
  const audit = await prisma.auditLog.findFirst({ where: { entity_id: F.acceptThenSend.id, action: 'quote.accepted' }, select: { diff_json: true } });
  check('the audit row still records the route and the missing attestation',
    audit?.diff_json?.via === 'booked' && audit?.diff_json?.attested === false, JSON.stringify(audit?.diff_json ?? null));

  // ── 4. THE SIGNATURE IS WHAT KEEPS THE CALLERS HONEST ────────────────────────────────────────
  console.log('\n— every caller must pass the card —');
  const sig = (listSrc.match(/export function deriveQuoteStatus\(([\s\S]*?)\)\s*:/) ?? [])[1] ?? '';
  // Inline or the named QuoteCard — either way REQUIRED. The first version matched only an inline `{` and
  // went red the moment the type was named, which was a test of spelling rather than of the rule.
  check('deriveQuoteStatus REQUIRES the card', keyRegex('card', /(\{|QuoteCard\b)/).test(sig) && !keyRegex('card?').test(sig),
    'booked used to be optional, and marketing-board omitted it — getting `accepted` where it meant `accepted_booked`');
  const boardSrc = code(readFileSync('lib/marketing-board.ts', 'utf8'));
  check('  …and marketing-board passes one', /deriveQuoteStatus\([^)]*card/.test(boardSrc.replace(/\s+/g, ' ')) || /deriveQuoteStatus\([\s\S]{0,200}cardWasAccepted|hasAcceptedVersion/.test(boardSrc),
    'the caller that made a row-builder fix insufficient');

  // ── 5. AND THE LIVE TENANT, READ-ONLY, AGAINST AN INDEPENDENT ORACLE ─────────────────────────
  console.log('\n— the live tenant\'s Awaiting list matches the rule, computed without the function —');
  // THE ORACLE ASKS NOTHING OF deriveQuoteStatus. Latest version sent and inside its window, card not
  // accepted by any evidence, not booked, not closed — the rule as stated, in SQL.
  // BOTH KINDS OF QUOTE. The first version of this oracle only knew about SENT quotes, and the list
  // listed a VERBAL one — CF18VNM, booked — which is how the second copy of the derivation was found.
  // An oracle that knows fewer shapes than the code is an oracle that cannot catch the ones it misses.
  const oracle = new Set((await prisma.$queryRawUnsafe(`
    WITH latest AS (SELECT DISTINCT ON (job_card_id) job_card_id, status, sent_at
                      FROM "QuoteVersion" ORDER BY job_card_id, version DESC)
    SELECT jc.id FROM latest l JOIN "JobCard" jc ON jc.id = l.job_card_id
     WHERE jc.group_id = $1
       AND l.status = 'sent' AND l.sent_at > now() - interval '14 days'
       AND jc.status::text IN ('draft','quoted','declined')
       AND jc.accepted_at IS NULL
       AND NOT (jc.resource_id IS NOT NULL AND jc.start_at IS NOT NULL AND jc.end_at IS NOT NULL)
    UNION
    SELECT jc.id FROM "JobCard" jc
     WHERE jc.group_id = $1 AND jc.status::text = 'quoted'
       AND NOT EXISTS (SELECT 1 FROM "QuoteVersion" q WHERE q.job_card_id = jc.id)
       AND jc.accepted_at IS NULL
       AND NOT (jc.resource_id IS NOT NULL AND jc.start_at IS NOT NULL AND jc.end_at IS NOT NULL)`, TMBS)).map((r) => r.id));
  const tmbsSites = (await prisma.site.findMany({ where: { group_id: TMBS }, select: { id: true } })).map((s) => s.id);
  const live = new Set((await L.listQuotes({ groupId: TMBS, siteIds: tmbsSites, filter: 'awaiting' })).map((r) => r.jobCardId));
  const missing = [...oracle].filter((id) => !live.has(id));
  const extra = [...live].filter((id) => !oracle.has(id));
  check('every genuinely-awaiting live quote is still listed', missing.length === 0,
    missing.length ? `${missing.length} dropped` : `${oracle.size} genuinely awaiting on the live tenant, all present`);
  check('  …and nothing else is', extra.length === 0,
    extra.length ? `${extra.length} listed that the rule says should not be` : 'no accepted, booked or closed card among them');
  check('  …and that is a real population, not an empty one', oracle.size > 0,
    `${oracle.size} — 2 sent quotes measured on 2026-09-10; if the garage answers them all this legitimately reads 0, and the ZZ positive cases above still hold the line`);
  const cf18 = await prisma.jobCard.findFirst({ where: { group_id: TMBS, vehicle: { registration: 'CF18VNM' } }, select: { id: true, status: true } });
  if (cf18) check('CF18VNM — verbal, booked — is no longer awaiting a response', !live.has(cf18.id), `card ${cf18.status}`);
  const lo25 = await prisma.jobCard.findFirst({ where: { group_id: TMBS, vehicle: { registration: 'LO25UGN' } }, select: { id: true, status: true } });
  if (lo25) check('LO25UGN is no longer awaiting a response', !live.has(lo25.id), `card ${lo25.status}`);
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  // BY THEIR OWN IDS. Versions, items, audit and ownership cascade or are left per the AuditLog rule.
  try {
    if (made.cards.length) {
      await prisma.quoteVersion.deleteMany({ where: { job_card_id: { in: made.cards } } });
      await prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: made.cards } } });
      await prisma.jobCard.deleteMany({ where: { id: { in: made.cards } } });
    }
    if (made.vehicles.length) {
      await prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: { in: made.vehicles } } });
      await prisma.vehicle.deleteMany({ where: { id: { in: made.vehicles } } });
    }
    if (made.customers.length) await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
    const left = await prisma.jobCard.count({ where: { id: { in: made.cards } } });
    check('teardown removed every fixture card', left === 0, `${made.cards.length} made, ${left} left`);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
