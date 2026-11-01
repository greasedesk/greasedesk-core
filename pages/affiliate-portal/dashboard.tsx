/**
 * File: pages/affiliate-portal/dashboard.tsx — served at /dashboard on affiliates.greasedesk.com.
 * THE AFFILIATE'S OWN PAGE: their code, how it works, what to post, who signed up, and what we owe.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────────────────────────
 * Everything withheld is withheld in lib/affiliate-portal-data's SELECT, not in this file's markup.
 * No sort code, no account number, no per-garage revenue, no pay-run hold reasons. A component
 * cannot render a field that was never fetched, and a later edit to this file cannot uncover one.
 *
 * ── ONE FETCH, SIX SECTIONS ─────────────────────────────────────────────────────────────────────
 * The menu switches which section is shown; it does not navigate. affiliatePortalData is a seven-deep
 * serial chain of queries and the functions are pinned to lhr1 beside the database for exactly that
 * reason, so six routes would pay that chain again on every click. lib/affiliate-portal-nav's header
 * carries the reasoning; the hash in the address bar is the single source of truth for which section
 * is open, and this file's only job is to render the one it names.
 *
 * ── THE QR IS BUILT ON THE SERVER ───────────────────────────────────────────────────────────────
 * `qrcode` renders to a data URL in getServerSideProps and arrives as a string. Doing it in the
 * browser would ship the library to every visitor and leave the poster depending on client JS to
 * contain the one thing it exists to carry.
 */
import { useEffect, useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireAffiliatePage } from '@/lib/rep-auth';
import { affiliatePortalData, type PortalData } from '@/lib/affiliate-portal-data';
import { formatMoney } from '@/lib/format-money';
import { PAYEE_COPY, AD_LABEL, REFUND_RULE } from '@/lib/affiliate-portal-copy';
import {
  PAYEE_KINDS, SORT_CODE_DIGITS, ACCOUNT_NUMBER_DIGITS, sortCodeAsTyped, normaliseSortCode,
} from '@/lib/payee';
import AffiliatePortalShell from '@/components/affiliate-portal/AffiliatePortalShell';
import {
  PORTAL_DEFAULT_SECTION, PORTAL_TERMS_PATH, sectionFromHash, type PortalSectionKey,
} from '@/lib/affiliate-portal-nav';

type Props = { data: PortalData; qr: string };

const money = (p: number) => formatMoney(p, { currency: 'GBP' });

/** One copy button, used by the link and by each post. Falls back to selecting the text. */
function CopyButton({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      window.setTimeout(() => setDone(false), 2000);
    } catch {
      // NO SILENT FAILURE. A clipboard write is refused in plenty of ordinary situations (an
      // insecure origin, a browser setting, an iOS webview), and a button that does nothing reads
      // as a broken page. Telling them to copy it by hand is a worse outcome, not a hidden one.
      setDone(false);
      window.alert('Your browser would not let us copy that. Select the text and copy it by hand.');
    }
  };
  return (
    <button type="button" onClick={copy} data-testid={testId}
      className="min-h-[40px] px-3 rounded-lg border border-line text-sm font-medium text-ink hover:bg-canvas transition-colors">
      {done ? 'Copied' : label}
    </button>
  );
}

/**
 * WHICH SECTION IS OPEN, READ FROM THE ADDRESS BAR.
 *
 * The server cannot know: a fragment is never sent to it. So the first render is the default section
 * and the hash is read on mount — which is right for a signed-in, noindex page, and is why the
 * sections are all in the DOM rather than fetched one at a time.
 *
 * THE LISTENER IS THE WHOLE MECHANISM. The menu items are plain `#key` links, so clicking one
 * changes the hash and this fires; nothing calls a setter directly. One path in, so a pasted link,
 * a click and the Back button cannot disagree about what is showing.
 */
function useHashSection(): PortalSectionKey {
  const [active, setActive] = useState<PortalSectionKey>(PORTAL_DEFAULT_SECTION);
  useEffect(() => {
    const read = () => setActive(sectionFromHash(window.location.hash));
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  return active;
}

/**
 * HIDDEN, NOT UNMOUNTED. The `hidden` attribute (display:none via Tailwind's preflight) keeps the
 * payee form's half-typed input and a copied-post confirmation alive while somebody checks their
 * earnings — and keeps a clause that asserts a section is NOT visible honest, because Playwright
 * reports a display:none element as hidden rather than as absent.
 */
function Pane({ k, active, children }: { k: PortalSectionKey; active: PortalSectionKey; children: React.ReactNode }) {
  return <div hidden={k !== active} data-testid={`portal-section-${k}`} className="space-y-6">{children}</div>;
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="bg-surface border border-line rounded-2xl p-5 sm:p-6 shadow-card" data-testid={testId}>
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function PayeeForm({ state, masked, accountName }: PortalData['payee']) {
  const [kind, setKind] = useState<string>(PAYEE_KINDS[0]);
  const [accountNameIn, setAccountName] = useState('');
  const [sortCode, setSortCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [nomineeEmail, setNomineeEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/affiliate-portal/payee', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        /**
         * THE SIX DIGITS, NOT WHAT THE FIELD SHOWS. The field groups as somebody types — '11-03-00'
         * — and the grouping is for their eyes only: the route normalises anyway, so sending the
         * dashes would work and would leave two shapes of the same value travelling the wire.
         */
        body: JSON.stringify({
          payeeKind: kind, accountName: accountNameIn, accountNumber, nomineeEmail,
          sortCode: normaliseSortCode(sortCode),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(body?.message ?? 'We could not save that.'); return; }
      setOk(true);
      setMsg('Thank you — your details are with us and will be checked before the next payment run.');
    } finally {
      // CLEARED IN finally — the page re-renders in place and will never unmount to do it for us.
      setBusy(false);
    }
  };

  return (
    <>
      <p className="mt-2 text-sm text-muted" data-testid="payee-state">
        {state === 'none' ? PAYEE_COPY.none : state === 'pending' ? PAYEE_COPY.pending : PAYEE_COPY.held}
      </p>
      {masked && (
        <p className="mt-2 text-sm text-ink" data-testid="payee-masked">
          {accountName ? `${accountName} — ` : ''}{masked}
        </p>
      )}
      {ok ? null : (
        <form onSubmit={submit} className="mt-4 space-y-3" data-testid="payee-form">
          <div>
            <label className="block text-sm text-ink mb-1" htmlFor="payee-kind">Who should we pay?</label>
            <select id="payee-kind" value={kind} onChange={(e) => setKind(e.target.value)} data-testid="payee-kind"
              className="w-full min-h-[48px] border border-line rounded-lg px-3 bg-surface text-ink">
              <option value="self">Me</option>
              <option value="nominee">Someone I nominate</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-ink mb-1" htmlFor="payee-name">Name on the account</label>
            <input id="payee-name" value={accountNameIn} onChange={(e) => setAccountName(e.target.value)} required
              data-testid="payee-name" autoComplete="off"
              className="w-full min-h-[48px] border border-line rounded-lg px-3 bg-surface text-ink" />
          </div>
          {kind === 'nominee' && (
            <div>
              <label className="block text-sm text-ink mb-1" htmlFor="payee-nominee-email">Their email address</label>
              <input id="payee-nominee-email" type="email" value={nomineeEmail} onChange={(e) => setNomineeEmail(e.target.value)}
                required data-testid="payee-nominee-email" autoComplete="off"
                className="w-full min-h-[48px] border border-line rounded-lg px-3 bg-surface text-ink" />
              <p className="mt-1 text-xs text-muted">
                We check it is not someone at a garage you introduced — a reward is for introducing a garage.
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-ink mb-1" htmlFor="payee-sort">Sort code</label>
              {/* GROUPED AS IT IS TYPED, and on paste, by the one rule in lib/payee. The previous
                  value is passed because deleting a separator is only distinguishable from
                  deleting a digit by comparing the two — see sortCodeAsTyped. */}
              <input id="payee-sort" value={sortCode} required
                onChange={(e) => setSortCode(sortCodeAsTyped(e.target.value, sortCode))}
                inputMode="numeric" maxLength={SORT_CODE_DIGITS + 2} placeholder="00-00-00"
                data-testid="payee-sort" autoComplete="off"
                className="w-full min-h-[48px] border border-line rounded-lg px-3 bg-surface text-ink" />
            </div>
            <div>
              <label className="block text-sm text-ink mb-1" htmlFor="payee-account">Account number</label>
              <input id="payee-account" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} required
                inputMode="numeric" maxLength={ACCOUNT_NUMBER_DIGITS + 3} placeholder={'0'.repeat(ACCOUNT_NUMBER_DIGITS)}
                data-testid="payee-account" autoComplete="off"
                className="w-full min-h-[48px] border border-line rounded-lg px-3 bg-surface text-ink" />
            </div>
          </div>
          <p className="text-xs text-muted">{PAYEE_COPY.whyChecked}</p>
          <button type="submit" disabled={busy} data-testid="payee-submit"
            className="min-h-[48px] px-5 bg-accent hover:bg-accent-hover text-white rounded-lg font-semibold disabled:opacity-60 transition-colors">
            {busy ? 'Sending…' : state === 'none' ? 'Send my details' : 'Change these details'}
          </button>
          <p className="text-xs text-muted">
            {SORT_CODE_DIGITS} digits and {ACCOUNT_NUMBER_DIGITS} digits, UK accounts only.
          </p>
        </form>
      )}
      {msg && <p className="mt-3 text-sm text-ink" data-testid="payee-message">{msg}</p>}
    </>
  );
}

export default function AffiliateDashboard({ data, qr }: Props) {
  const e = data.earnings;
  const active = useHashSection();
  return (
    <>
      <Head><title>Your affiliate page — GreaseDesk</title><meta name="robots" content="noindex" /></Head>
      <AffiliatePortalShell active={active}>
        {/* OUTSIDE THE SECTIONS, because these are true wherever you are standing: whose page this
            is, that the account is paused, and where the agreement lives. A suspension notice that
            only appeared on Overview would be missed by somebody who opened Earnings. */}
        <header className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-ink tracking-tight" data-testid="affiliate-home">
            {data.name}
          </h1>
          <p className="mt-1 text-sm text-muted">Your GreaseDesk affiliate page</p>
        </header>

        {data.suspended && (
          <div className="mb-6 rounded-2xl border border-line bg-surface p-5 text-sm text-ink" data-testid="affiliate-suspended">
            Your account is paused, so new sign-ups will not be matched to you. Anything you have already
            earned is unaffected and still shown below.
          </div>
        )}

        <Pane k="overview" active={active}>
          <Section title="How it works" testId="affiliate-how-section">
            <ol className="mt-4 space-y-4">
              {data.howItWorks.map((s) => (
                <li key={s.n} className="flex items-start gap-3">
                  <span className="shrink-0 w-7 h-7 rounded-full bg-accent text-white text-sm font-semibold flex items-center justify-center">
                    {s.n}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-ink">{s.title}</p>
                    <p className="text-sm text-muted mt-0.5">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          {/* THE ONE THING STOPPING THEM BEING PAID, said on the page they land on. It is a NUDGE and
              not a block: everything else on the portal works without bank details, and rewards wait
              rather than being lost (terms 6.3). It disappears the moment there is anything to pay
              into, including a request still being checked — "nothing from you" is the only state
              that needs anything doing about it. */}
          {data.payee.state === 'none' && (
            <Section title="Before we can pay you" testId="affiliate-next-step">
              <p className="mt-2 text-sm text-muted">
                We do not have your bank details yet. Nothing is lost while we wait — your rewards sit
                there until they arrive.
              </p>
              <a href="#payment-details" data-testid="affiliate-next-step-link"
                className="mt-4 min-h-[44px] inline-flex items-center px-4 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-semibold transition-colors">
                Add your payment details
              </a>
            </Section>
          )}
        </Pane>

        <Pane k="share" active={active}>
          <Section title="Your code and link" testId="affiliate-code-section">
            <p className="mt-2 text-sm text-muted">Anyone who signs up through these is matched to you.</p>
            <p className="mt-4 text-3xl font-extrabold tracking-[0.15em] text-ink" data-testid="affiliate-code">
              {data.refCode}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <code className="text-sm text-ink break-all bg-canvas border border-line rounded-lg px-3 py-2" data-testid="affiliate-link">
                {data.referralLink}
              </code>
              <CopyButton text={data.referralLink} label="Copy link" testId="affiliate-copy-link" />
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-5">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data URL, not an optimisable asset */}
              <img src={qr} alt={`QR code for ${data.referralLink}`} width={160} height={160}
                className="border border-line rounded-lg bg-white" data-testid="affiliate-qr" />
              <a href="/poster" target="_blank" rel="noreferrer" data-testid="affiliate-poster-link"
                className="min-h-[44px] inline-flex items-center px-4 rounded-lg border border-line text-sm font-medium text-ink hover:bg-canvas transition-colors">
                Printable A4 poster
              </a>
            </div>
          </Section>
        </Pane>

        <Pane k="posts" active={active}>
          <Section title="Ready-made posts" testId="affiliate-posts-section">
            <p className="mt-2 text-sm text-muted">
              Each one already starts with {AD_LABEL}, which the advertising rules require when you are
              paid for a recommendation. Please leave it in.
            </p>
            <ul className="mt-4 space-y-4">
              {data.posts.map((p) => (
                <li key={p.id} className="border border-line rounded-xl p-4 bg-canvas">
                  <p className="text-xs uppercase tracking-wide text-muted">{p.title}</p>
                  <p className="mt-2 text-sm text-ink whitespace-pre-wrap" data-testid={`affiliate-post-${p.id}`}>{p.text}</p>
                  <div className="mt-3">
                    <CopyButton text={p.text} label="Copy post" testId={`affiliate-copy-post-${p.id}`} />
                  </div>
                </li>
              ))}
            </ul>
          </Section>

          {/* EMPTY SLOTS ARE HIDDEN, not shown as "coming soon": an empty frame promises something
              nobody committed to. The section simply is not there until the owner publishes a video. */}
          {data.videos.length > 0 && (
            <Section title="Videos" testId="affiliate-videos-section">
              <ul className="mt-4 space-y-2">
                {data.videos.map((v) => (
                  <li key={v.url}>
                    <a href={v.url} target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">
                      {v.title}
                    </a>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </Pane>

        <Pane k="garages" active={active}>
          <Section title="Your garages" testId="affiliate-garages-section">
            {data.garages.length === 0 ? (
              // NOT AN EMPTY TABLE. "None yet" is a different fact from a row of dashes.
              <p className="mt-3 text-sm text-muted" data-testid="affiliate-no-garages">
                No garages yet. Anyone who signs up through your link or code appears here.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-line" data-testid="affiliate-garages">
                {data.garages.map((g, i) => (
                  <li key={`${g.name}-${i}`} className="py-3 flex items-center justify-between gap-4">
                    <span className="text-sm text-ink">{g.name}</span>
                    <span className="text-xs font-medium text-muted">{g.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </Pane>

        <Pane k="earnings" active={active}>
          <Section title="Your rewards" testId="affiliate-earnings-section">
            <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Earned</dt>
                <dd className="text-xl font-bold text-ink" data-testid="earn-earned">{money(e.earnedPennies)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Held</dt>
                <dd className="text-xl font-bold text-ink" data-testid="earn-held">{money(e.heldPennies)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Payable</dt>
                <dd className="text-xl font-bold text-ink" data-testid="earn-payable">{money(e.payablePennies)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Paid</dt>
                {/* paidRecorded IS THE POINT. There is no payout record yet, so "£0.00 paid" would be
                    a claim about a thing that does not exist; "No payouts yet" is the true sentence
                    and it changes when the fact does, not when somebody notices the zero. */}
                <dd className="text-xl font-bold text-ink" data-testid="earn-paid">
                  {e.paidRecorded ? money(e.paidPennies) : <span className="text-base font-semibold text-muted">No payouts yet</span>}
                </dd>
              </div>
            </dl>

            {data.held.length > 0 && (
              <>
                <h3 className="mt-6 text-sm font-semibold text-ink">Becoming payable</h3>
                <ul className="mt-2 space-y-1" data-testid="affiliate-held-schedule">
                  {data.held.map((h, i) => (
                    <li key={`${h.payableFrom}-${i}`} className="text-sm text-muted">
                      {money(h.amountPennies)} on {h.payableFrom}
                    </li>
                  ))}
                </ul>
              </>
            )}

            <p className="mt-6 text-sm text-muted" data-testid="affiliate-cadence">{data.cadence}</p>
            <p className="mt-1 text-sm text-muted" data-testid="affiliate-minimum">
              We send a payment once at least {money(data.minimumPayoutPennies)} is payable.
            </p>
            {/* THE SAME SENTENCE AS STEP 4, from the same constant. Said here because this is the
                screen somebody reads when they are counting on a figure, and terms 6.5 and 6.6 mean
                a figure on it can still move after a payout. */}
            <p className="mt-4 text-sm text-muted" data-testid="affiliate-refund-rule">{REFUND_RULE}</p>
          </Section>
        </Pane>

        <Pane k="payment-details" active={active}>
          <Section title="Where we send it" testId="affiliate-payee-section">
            <PayeeForm {...data.payee} />
          </Section>
        </Pane>

        {/* ── THE AGREEMENT IS A PAGE NOW, AND THE ACCEPTANCE LINE WENT WITH IT (owner, 2026-11-01)
            This said "you accepted version X on Y" in the footer, which was the only place that
            fact appeared and only when there WAS a version — an affiliate who accepted the summary
            saw nothing at all. /my-terms answers it in all three states, inside this same shell,
            so there is one renderer of it rather than two that can drift. */}
        <footer className="pt-8 pb-2 text-xs text-muted">
          <a href={PORTAL_TERMS_PATH} className="text-accent hover:underline" data-testid="affiliate-terms-footer-link">
            Affiliate terms, and what you accepted
          </a>
        </footer>
      </AffiliatePortalShell>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const gate = await requireAffiliatePage(ctx);
  if (!gate.ok) return gate.result as any;

  const data = await affiliatePortalData(gate.rep.repId);
  // NULL MEANS THE GUARD PASSED AND THE ROW IS GONE (or is not an affiliate). 404, not a crash.
  if (!data) return { notFound: true };

  const QRCode = await import('qrcode');
  const qr = await QRCode.toDataURL(data.referralLink, { width: 480, margin: 1 });

  return { props: { data: JSON.parse(JSON.stringify(data)), qr } };
};
