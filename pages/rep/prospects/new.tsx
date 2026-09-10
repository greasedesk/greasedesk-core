/**
 * File: pages/rep/prospects/new.tsx
 * RECORD A VISIT — on a phone, in a forecourt, one-handed. If this is tedious a rep will not use it,
 * and the whole argument for keeping the trail collapses. So: big targets, the least typing that
 * still leaves a useful record, and nothing asked that the next reader will not need.
 *
 * ── THE DUPLICATE IS PRESENTED, AND THE REP DECIDES ─────────────────────────────────────────────
 * When the name or postcode is entered, garages that might be this one are shown. "This is the one"
 * adds a visit to it; "a different garage" records a new one. Nothing merges on its own — two
 * half-histories of one garage is the failure this record exists to prevent, and so is one history
 * of two garages.
 *
 * ── CONSENT HAS NO DEFAULT ──────────────────────────────────────────────────────────────────────
 * Three buttons, none pre-selected. A pre-selected answer makes the unasked case look like a
 * recorded one — the rule lib/due-items settled for findings, for the same reason.
 *
 * No database in this file: it ships whole to the phone. Labels come from lib/prospects, which
 * imports nothing.
 */
import { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import { PROSPECT_STATUSES, STATUS_LABEL, STOP_LABEL, type ProspectStatus, type StopReason } from '@/lib/prospects';

type Match = { id: string; garageName: string; postcode: string | null; addressLine1: string | null; status: string; lastVisit: string | null; visitCount: number };

export default function NewVisit() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [postcode, setPostcode] = useState('');
  const [address, setAddress] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [chosen, setChosen] = useState<Match | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [status, setStatus] = useState<ProspectStatus | null>(null);
  const [spokeTo, setSpokeTo] = useState('');
  const [note, setNote] = useState('');
  const [email, setEmail] = useState('');
  // UNTOUCHED (undefined) IS NOT THE SAME AS "I DIDN'T ASK" (null), though both send no emails: an
  // untouched form must highlight no answer at all, or it shows a choice the rep never made.
  const [consent, setConsent] = useState<true | false | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const lookForMatches = async () => {
    if (chosen || dismissed || name.trim().length < 2) return;
    try {
      const r = await fetch(`/api/rep/prospect-matches?name=${encodeURIComponent(name)}&postcode=${encodeURIComponent(postcode)}`);
      if (r.ok) setMatches((await r.json()).matches ?? []);
    } catch { /* a failed lookup must not block recording the visit */ }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!status) { setErr('Pick how the visit went.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/rep/prospects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prospectId: chosen?.id ?? null,
          garage: chosen ? undefined : { name, addressLine1: address, postcode },
          visit: { status, spokeTo, note },
          email: email || null,
          consent: email ? (consent ?? null) : null,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.message ?? 'That could not be saved.'); return; }
      // SAY WHAT HAPPENED TO THE FOLLOW-UP, in words. "Saved" alone would leave a rep unsure whether
      // the emails they promised the owner are actually going.
      const seq = j.sequence as { state: string; stoppedReason: StopReason | null } | null;
      setDone(!seq ? 'Visit saved. No follow-up emails — no address was given, or they were not asked.'
        : seq.state === 'active' ? 'Visit saved. Follow-up emails from GreaseDesk have started.'
        : `Visit saved. ${STOP_LABEL[seq.stoppedReason as StopReason] ?? 'No follow-up emails.'}`);
    } finally {
      setBusy(false);
    }
  };

  const big = 'w-full min-h-[52px] rounded-xl px-4 text-base text-slate-900';
  if (done) {
    return (
      <div className="min-h-screen bg-emerald-950 text-white p-6">
        <p className="text-lg mt-8" data-testid="prospect-saved">{done}</p>
        <div className="mt-8 grid gap-3">
          <button onClick={() => router.reload()} className="min-h-[52px] rounded-xl bg-emerald-600 font-medium">Record another visit</button>
          <Link href="/rep/prospects" className="min-h-[52px] rounded-xl bg-emerald-900 flex items-center justify-center">Back to my visits</Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <Head><title>Record a visit</title><meta name="robots" content="noindex" /></Head>
      <form onSubmit={save} className="min-h-screen bg-emerald-950 text-white p-5 space-y-5 pb-28" data-testid="prospect-form">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Record a visit</h1>
          <Link href="/rep/prospects" className="text-sm text-emerald-300 underline">Cancel</Link>
        </div>

        {chosen ? (
          <div className="rounded-xl bg-emerald-900 p-4" data-testid="prospect-chosen">
            <div className="text-xs text-emerald-300">Adding a visit to</div>
            <div className="font-semibold">{chosen.garageName}</div>
            <div className="text-xs text-emerald-300">{[chosen.addressLine1, chosen.postcode].filter(Boolean).join(', ')}</div>
            <button type="button" onClick={() => setChosen(null)} className="mt-2 text-sm underline text-emerald-200">Not this one</button>
          </div>
        ) : (
          <>
            <input className={big} placeholder="Garage name" value={name} onChange={(e) => setName(e.target.value)} onBlur={lookForMatches} required data-testid="prospect-name" />
            <div className="grid grid-cols-2 gap-3">
              <input className={big} placeholder="Postcode" value={postcode} onChange={(e) => setPostcode(e.target.value)} onBlur={lookForMatches} autoCapitalize="characters" data-testid="prospect-postcode" />
              <input className={big} placeholder="Street" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
            {matches.length > 0 && !dismissed && (
              <div className="rounded-xl bg-amber-100 text-amber-950 p-4 space-y-2" data-testid="prospect-matches">
                <div className="text-sm font-medium">Is it one of these? Someone has visited them before.</div>
                {matches.map((m) => (
                  <button key={m.id} type="button" onClick={() => setChosen(m)} data-testid="prospect-match"
                    className="w-full text-left min-h-[52px] rounded-lg bg-white px-3 py-2">
                    <div className="font-medium">{m.garageName}</div>
                    <div className="text-xs text-slate-500">{[m.postcode, `${m.visitCount} visit${m.visitCount === 1 ? '' : 's'}`, m.lastVisit ? `last ${m.lastVisit.slice(0, 10)}` : null].filter(Boolean).join(' · ')}</div>
                  </button>
                ))}
                <button type="button" onClick={() => setDismissed(true)} className="w-full min-h-[48px] rounded-lg bg-amber-200 font-medium" data-testid="prospect-not-a-match">
                  No — it&apos;s a different garage
                </button>
              </div>
            )}
          </>
        )}

        <fieldset>
          <legend className="text-sm text-emerald-300 mb-2">How did it go?</legend>
          <div className="grid grid-cols-2 gap-3">
            {PROSPECT_STATUSES.map((s) => (
              <button key={s} type="button" onClick={() => setStatus(s)} data-testid={`prospect-status-${s}`}
                className={`min-h-[56px] rounded-xl font-medium ${status === s ? 'bg-emerald-400 text-emerald-950' : 'bg-emerald-900'}`}>
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </fieldset>

        <input className={big} placeholder="Who did you speak to? (optional)" value={spokeTo} onChange={(e) => setSpokeTo(e.target.value)} />
        <textarea className="w-full rounded-xl px-4 py-3 text-base text-slate-900 min-h-[96px]" placeholder="About the business — ramps, what they use now, what they said (optional)"
          value={note} onChange={(e) => setNote(e.target.value)} />

        <div className="rounded-xl bg-emerald-900 p-4 space-y-3">
          <input className={big} type="email" inputMode="email" autoCapitalize="none" placeholder="Owner's email, if they gave it (optional)"
            value={email} onChange={(e) => { setEmail(e.target.value); if (!e.target.value) setConsent(undefined); }} data-testid="prospect-email" />
          {email && (
            <fieldset data-testid="prospect-consent">
              <legend className="text-sm text-emerald-200 mb-2">Did you ask if GreaseDesk can email them, and did they agree?</legend>
              <div className="grid gap-2">
                {([[true, 'Yes — I asked and they agreed'], [false, 'I asked — they said no'], [null, "I didn't ask"]] as const).map(([v, label]) => (
                  <button key={String(v)} type="button" onClick={() => setConsent(v)} data-testid={`prospect-consent-${String(v)}`}
                    className={`min-h-[48px] rounded-lg text-left px-3 ${consent === v ? 'bg-emerald-400 text-emerald-950 font-medium' : 'bg-emerald-800'}`}>
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-emerald-400 mt-2">Only &ldquo;Yes&rdquo; starts the follow-up emails.</p>
            </fieldset>
          )}
        </div>

        {err && <p className="text-sm text-red-300" data-testid="prospect-error">{err}</p>}
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-emerald-950 border-t border-emerald-900">
          <button type="submit" disabled={busy} data-testid="prospect-save" className="w-full min-h-[56px] rounded-xl bg-emerald-500 text-emerald-950 font-semibold text-lg disabled:opacity-60">
            {busy ? 'Saving…' : 'Save visit'}
          </button>
        </div>
      </form>
    </>
  );
}

// SERVER-SIDE ONLY TO GUARD THE PAGE. It returns no data, so it imports none — the guard is the reason.
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const { requireRepPage } = await import('@/lib/rep-auth');
  const gate = await requireRepPage(ctx);
  if (!gate.ok) return gate.result;
  return { props: {} };
};
