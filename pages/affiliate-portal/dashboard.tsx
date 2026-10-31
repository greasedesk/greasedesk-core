/**
 * File: pages/affiliate-portal/dashboard.tsx — served at /dashboard on affiliates.greasedesk.com.
 * THE AFFILIATE'S OWN PAGE: their code, how it works, what to post, who signed up, and what we owe.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────────────────────────
 * Everything withheld is withheld in lib/affiliate-portal-data's SELECT, not in this file's markup.
 * No sort code, no account number, no per-garage revenue, no pay-run hold reasons. A component
 * cannot render a field that was never fetched, and a later edit to this file cannot uncover one.
 *
 * ── THE QR IS BUILT ON THE SERVER ───────────────────────────────────────────────────────────────
 * `qrcode` renders to a data URL in getServerSideProps and arrives as a string. Doing it in the
 * browser would ship the library to every visitor and leave the poster depending on client JS to
 * contain the one thing it exists to carry.
 */
import { useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireAffiliatePage } from '@/lib/rep-auth';
import { affiliatePortalData, type PortalData } from '@/lib/affiliate-portal-data';
import { formatMoney } from '@/lib/format-money';
import { PAYEE_COPY, AD_LABEL } from '@/lib/affiliate-portal-copy';
import { PAYEE_KINDS, SORT_CODE_DIGITS, ACCOUNT_NUMBER_DIGITS } from '@/lib/payee';

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
        body: JSON.stringify({ payeeKind: kind, accountName: accountNameIn, sortCode, accountNumber, nomineeEmail }),
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
              <input id="payee-sort" value={sortCode} onChange={(e) => setSortCode(e.target.value)} required
                inputMode="numeric" maxLength={8} placeholder="00-00-00" data-testid="payee-sort" autoComplete="off"
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
  return (
    <>
      <Head><title>Your affiliate page — GreaseDesk</title><meta name="robots" content="noindex" /></Head>
      <main className="min-h-screen bg-canvas">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-6">
          <header>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-ink tracking-tight" data-testid="affiliate-home">
              {data.name}
            </h1>
            <p className="mt-1 text-sm text-muted">Your GreaseDesk affiliate page</p>
          </header>

          {/* SUSPENSION IS SAID PLAINLY AND THE PAGE STILL OPENS. Suspension stops new attribution
              and never touches what is already earned, so hiding the earnings would be a lie about
              money that is still theirs. */}
          {data.suspended && (
            <div className="rounded-2xl border border-line bg-surface p-5 text-sm text-ink" data-testid="affiliate-suspended">
              Your account is paused, so new sign-ups will not be matched to you. Anything you have already
              earned is unaffected and still shown below.
            </div>
          )}

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
          </Section>

          <Section title="Where we send it" testId="affiliate-payee-section">
            <PayeeForm {...data.payee} />
          </Section>

          <footer className="pt-2 pb-8 text-xs text-muted">
            <a href="/terms" className="text-accent hover:underline">Affiliate terms</a>
            {data.terms.acceptedVersion && (
              <span data-testid="affiliate-terms-accepted"> — you accepted version {data.terms.acceptedVersion} on {data.terms.acceptedAt}</span>
            )}
          </footer>
        </div>
      </main>
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
