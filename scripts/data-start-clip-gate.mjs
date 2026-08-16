/**
 * File: scripts/data-start-clip-gate.mjs
 * Does a window straddling the tenant's first record report the months it actually traded?
 *
 * THE ASSERTION THAT WOULD HAVE CAUGHT IT. On production, a tenant whose records begin 2025-08-11
 * asked for FY 2025-04-01 → 2026-04-01 was told 38.17% and shown a red light; the eight months it
 * traded ran 62.66%. precedesData never fired, because the window's END is long after the first
 * record — it only ever asked whether the WHOLE window was in the void.
 *
 * The pure half runs with no database (standing rule 1). The DB half reads only.
 */
import './_gate-preflight.mjs';
import { prisma } from '../lib/db.ts';
import { clipToData, precedesData, getTenantDataStart } from '../lib/tenant-data-start.ts';
import { getGroupUtilisation } from '../lib/capacity.ts';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const D = (s) => new Date(`${s}T00:00:00.000Z`);

// ── PURE ────────────────────────────────────────────────────────────────────────────────────────
const ds = D('2025-08-11');
{
  const straddle = clipToData(D('2025-04-01'), D('2026-04-01'), ds);
  check('a straddling window is CLIPPED to the first record',
    straddle.clipped && straddle.from.getTime() === ds.getTime() && !straddle.empty,
    straddle.from.toISOString().slice(0, 10));
  check('… and says so, so a surface can label it', straddle.clipped === true);
  const after = clipToData(D('2025-09-01'), D('2025-10-01'), ds);
  check('a window wholly after the start is untouched', !after.clipped && after.from.getTime() === D('2025-09-01').getTime());
  const before = clipToData(D('2025-01-01'), D('2025-04-01'), ds);
  check('a window wholly before it is EMPTY, not clipped to nothing', before.empty && !before.clipped);
  const none = clipToData(D('2025-01-01'), D('2030-01-01'), null);
  check('a tenant with no records at all measures nothing', none.empty);
  const touching = clipToData(D('2025-01-01'), ds, ds);
  check('`to` is exclusive, so a window ending AT the first record is empty', touching.empty);
  // The fail-check: precedesData alone cannot see this case. That is the bug, stated as a test.
  check('precedesData ALONE would have let the straddling window through',
    precedesData(D('2026-04-01'), ds) === false,
    'this is why clipToData exists — the old guard returns false and the figure was computed anyway');
}

// ── AGAINST THE REAL TENANT ─────────────────────────────────────────────────────────────────────
try {
  const u = await prisma.user.findUnique({ where: { email: 'demo.owner.reference15@example.com' }, select: { group_id: true } });
  if (!u) { check('the reference demo tenant exists', false, 'not found'); throw new Error('no tenant'); }
  const g = u.group_id;
  const site = await prisma.site.findFirst({ where: { group_id: g }, select: { id: true } });
  const real = await getTenantDataStart(g);
  check('the tenant has a first record', !!real, real?.toISOString().slice(0, 10));

  const fyFrom = D('2025-04-01'), fyTo = D('2026-04-01');
  check('and the FY window genuinely straddles it', fyFrom < real && real < fyTo, `${fyFrom.toISOString().slice(0,10)} < ${real.toISOString().slice(0,10)} < ${fyTo.toISOString().slice(0,10)}`);

  const whole = await getGroupUtilisation(g, [site.id], { from: fyFrom, to: fyTo });
  const clip = clipToData(fyFrom, fyTo, real);
  const traded = await getGroupUtilisation(g, [site.id], { from: clip.from, to: clip.to });
  const pc = (x) => x.ratio === null ? null : x.ratio * 100;

  console.log(`\n   unclipped ${pc(whole).toFixed(2)}%  vs  clipped ${pc(traded).toFixed(2)}%\n`);
  check('THE ONE THAT MATTERS: clipped ≠ unclipped on a straddling window',
    Math.abs(pc(whole) - pc(traded)) > 5, `${pc(whole).toFixed(2)}% → ${pc(traded).toFixed(2)}%`);
  check('the clipped figure is HIGHER — phantom capacity was dragging it down',
    pc(traded) > pc(whole));
  check('no sold hours are lost by clipping — only sellable is',
    Math.abs(whole.charged - traded.charged) < 0.01, `${whole.charged}h both sides`);
  check('and the sellable dropped by exactly the pre-existence stretch',
    whole.available > traded.available, `${whole.available}h → ${traded.available}h`);

  // A month wholly inside the traded period must be BYTE-IDENTICAL — the fix must not move figures
  // that were already right.
  const m = { from: D('2026-03-01'), to: D('2026-04-01') };
  const mc = clipToData(m.from, m.to, real);
  check('a normal month is completely untouched by the fix',
    !mc.clipped && mc.from.getTime() === m.from.getTime() && mc.to.getTime() === m.to.getTime());
} catch (e) {
  if (String(e.message) !== 'no tenant') check('run completed', false, String(e?.message ?? e).slice(0, 200));
} finally {
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
