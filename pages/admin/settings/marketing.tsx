/**
 * File: pages/admin/settings/marketing.tsx
 * SETTINGS → MARKETING. Tenant-wide, ADMIN only, three switches over the call board.
 *
 * ── WHY A TAB AND NOT A BLOCK ON LOCATIONS ──────────────────────────────────────────────────────
 * The board is per-TENANT — buildBoard takes a groupId and scopes nothing by site — so these are
 * Group columns and sit beside Invoicing. The intake prompts look like the same kind of thing and
 * are the opposite: Site columns, edited per location. Putting these there would make the board's
 * settings read as site-scoped when they are not.
 *
 * ── TWO OF THE THREE CAN BE LEFT UNSET, AND THAT IS A REAL ANSWER ───────────────────────────────
 * An empty box means "we have not chosen", not zero. The platform default applies and can move
 * later without silently overriding a garage that deliberately picked the same number. Writing 30
 * into every tenant would make those two states identical for ever — the same argument as
 * mot_checked_at and the deliberately empty mileage-out box.
 */
import { useState } from 'react';
import Head from 'next/head';
import { withI18n } from '@/lib/gssp-i18n';
import { prisma } from '@/lib/db';
import { requireAdminPage } from '@/lib/admin-guard';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { SNOOZE_DAYS } from '@/lib/marketing-lists';

type PageProps = {
  expiredQuotes: boolean;
  snoozeDays: string;
  quoteHotDays: string;
  fallbackSnooze: number;
};

const input = 'w-32 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink';

export default function MarketingSettings(props: PageProps) {
  const [expiredQuotes, setExpiredQuotes] = useState(props.expiredQuotes);
  const [snoozeDays, setSnoozeDays] = useState(props.snoozeDays);
  const [quoteHotDays, setQuoteHotDays] = useState(props.quoteHotDays);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true); setErr(null); setSaved(null);
    try {
      const res = await fetch('/api/settings-marketing', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // BLANK TRAVELS AS NULL, never as 0 — the whole point of the nullable column.
        body: JSON.stringify({
          expiredQuotes,
          snoozeDays: snoozeDays.trim() === '' ? null : Number(snoozeDays),
          quoteHotDays: quoteHotDays.trim() === '' ? null : Number(quoteHotDays),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j?.message ?? 'That did not save.'); return; }
      setSaved('Saved');
    } catch { setErr('That did not save.'); }
    finally { setBusy(false); }
  }

  return (
    <SettingsLayout isAdmin>
      <Head><title>Marketing — Settings</title></Head>
      <div className="max-w-2xl space-y-6" data-testid="marketing-settings">
        <div>
          <h1 className="text-lg font-semibold text-ink">Marketing</h1>
          <p className="text-sm text-muted mt-1">
            How the call board behaves. These apply to the whole business, not to one location.
          </p>
        </div>

        <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
          <label className="flex items-start gap-3">
            <input type="checkbox" checked={expiredQuotes} disabled={busy}
              onChange={(e) => setExpiredQuotes(e.target.checked)}
              data-testid="marketing-expired-quotes" className="mt-1" />
            <span>
              <span className="text-sm font-medium text-ink">Show cars whose quote has run out</span>
              <span className="block text-xs text-muted mt-0.5">
                They asked the price and never answered, so the quote lapsed. Turning this off leaves
                your live quotes on the board and hides only the ones that ran out.
              </span>
            </span>
          </label>

          <div>
            <label className="text-sm font-medium text-ink" htmlFor="snooze">Snooze lasts</label>
            <p className="text-xs text-muted mt-0.5 mb-2">
              How long a car stays out of the way after you snooze it. Leave blank to use {props.fallbackSnooze} days.
            </p>
            <div className="flex items-center gap-2">
              <input id="snooze" inputMode="numeric" value={snoozeDays} disabled={busy}
                onChange={(e) => setSnoozeDays(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
                placeholder={String(props.fallbackSnooze)} data-testid="marketing-snooze-days" className={input} />
              <span className="text-sm text-muted">days</span>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-ink" htmlFor="hot">Chase a quote before it runs out</label>
            <p className="text-xs text-muted mt-0.5 mb-2">
              Move a quote to Hot this many days before it expires. Leave blank to move it only once
              it has run out.
            </p>
            <div className="flex items-center gap-2">
              <input id="hot" inputMode="numeric" value={quoteHotDays} disabled={busy}
                onChange={(e) => setQuoteHotDays(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
                placeholder="only once it runs out" data-testid="marketing-quote-hot-days" className={`${input} w-56`} />
              <span className="text-sm text-muted">days before</span>
            </div>
          </div>

          {err && <p className="text-sm text-danger" data-testid="marketing-settings-error">{err}</p>}
          {saved && <p className="text-sm text-ok" data-testid="marketing-settings-saved">{saved}</p>}
          <button type="button" onClick={save} disabled={busy} data-testid="marketing-settings-save"
            className="text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">
            Save
          </button>
        </div>
      </div>
    </SettingsLayout>
  );
}

export const getServerSideProps = withI18n(['common'])(async (ctx: any) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const g = await prisma.group.findUnique({
    where: { id: gate.vis.groupId as string },
    select: { marketing_expired_quotes: true, marketing_snooze_days: true, marketing_quote_hot_days: true },
  });
  return {
    props: {
      expiredQuotes: g?.marketing_expired_quotes ?? true,
      // NULL RENDERS AS EMPTY, not as the fallback: a box showing 30 cannot be told apart from a
      // garage having typed 30, and saving the form would then write the number they never chose.
      snoozeDays: g?.marketing_snooze_days == null ? '' : String(g.marketing_snooze_days),
      quoteHotDays: g?.marketing_quote_hot_days == null ? '' : String(g.marketing_quote_hot_days),
      fallbackSnooze: SNOOZE_DAYS,
    } as PageProps,
  };
});
