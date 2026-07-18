/**
 * File: pages/reseller.tsx
 * "Become a reseller" — an EXPRESSION OF INTEREST page (not terms; no commission figures or contract
 * detail — the model isn't final). Same design system, SEO and trust footer as the rest of the site.
 * Form → /api/reseller (Turnstile-protected, delivered to CONTACT_FORM_TO server-side, stores nothing).
 */
import { useState } from 'react';
import Link from 'next/link';
import Seo from '@/components/marketing/Seo';
import SiteChrome from '@/components/marketing/SiteChrome';
import Turnstile from '@/components/marketing/Turnstile';
import { COMPANY } from '@/lib/company-info';

const inputCls = 'w-full p-3 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-2 focus:ring-accent focus:border-accent outline-none';

const Check = () => (
  <svg className="w-5 h-5 text-accent shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

export default function ResellerPage() {
  const [form, setForm] = useState({ name: '', company: '', area: '', email: '', phone: '', message: '', website: '' });
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('sending'); setMsg(null);
    try {
      const res = await fetch('/api/reseller', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, turnstileToken: token }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) { setState('sent'); setMsg(data.message || 'Thanks — we’ll be in touch.'); setForm({ name: '', company: '', area: '', email: '', phone: '', message: '', website: '' }); }
      else { setState('error'); setMsg(data?.message || 'Something went wrong. Please try again.'); }
    } catch {
      setState('error'); setMsg('We couldn’t reach the server. Please try again shortly.');
    }
  }

  return (
    <>
      <Seo
        title="Become a GreaseDesk reseller — earn recurring commission"
        description="Already visiting independent garages every week? Introduce GreaseDesk, own the relationship, and earn recurring monthly commission. Register your interest."
        path="/reseller"
      />
      <SiteChrome>
        <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 sm:pt-24 pb-16">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-ink tracking-tight">Become a GreaseDesk reseller</h1>
          <p className="mt-4 text-lg text-muted max-w-2xl">
            If you’re already in and out of independent garages every week, GreaseDesk is a product you can
            introduce and earn from — building a recurring income alongside what you already do.
          </p>

          <div className="mt-10 grid md:grid-cols-2 gap-10">
            {/* The opportunity + who it suits */}
            <div className="space-y-8">
              <div>
                <h2 className="text-lg font-semibold text-ink">The opportunity</h2>
                <ul className="mt-3 space-y-3 text-sm text-ink">
                  <li className="flex items-start gap-3"><Check /><span><strong>Recurring monthly commission</strong> for every garage you bring on — income that builds as your patch grows.</span></li>
                  <li className="flex items-start gap-3"><Check /><span><strong>You own the relationship.</strong> The garages you sign up are yours to look after.</span></li>
                  <li className="flex items-start gap-3"><Check /><span><strong>Onboarding &amp; first-line support</strong> are part of the role — you help your garages get set up and answer their first questions, with us behind you.</span></li>
                </ul>
                <p className="mt-4 text-sm text-muted">Garages are looked after by resellers, not by us. GreaseDesk is sold and supported through our reseller network, so garages in your area would normally be yours to manage.</p>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-ink">Who it suits</h2>
                <ul className="mt-3 space-y-3 text-sm text-ink">
                  <li className="flex items-start gap-3"><Check /><span>Tool-van reps with an established round</span></li>
                  <li className="flex items-start gap-3"><Check /><span>Motor factor reps and delivery drivers</span></li>
                  <li className="flex items-start gap-3"><Check /><span>Equipment and calibration engineers — MOT kit, ramps, diagnostics</span></li>
                  <li className="flex items-start gap-3"><Check /><span>Oil, consumables and workwear reps</span></li>
                  <li className="flex items-start gap-3"><Check /><span>Retired garage owners and trade consultants</span></li>
                </ul>
              </div>
              <p className="text-xs text-muted">This is an expression of interest — we’ll follow up with the detail. Prefer to talk? Call <a href={`tel:${COMPANY.phoneE164}`} className="text-accent hover:underline">{COMPANY.phone}</a>.</p>
            </div>

            {/* Form */}
            <div className="bg-surface border border-line rounded-2xl p-6 shadow-card">
              {state === 'sent' ? (
                <div className="text-center py-8">
                  <div className="text-3xl mb-2" aria-hidden="true">✅</div>
                  <p className="text-ink font-medium">{msg}</p>
                  <Link href="/" className="mt-4 inline-block text-sm text-accent hover:underline">Back to home</Link>
                </div>
              ) : (
                <form onSubmit={submit} className="space-y-4" noValidate>
                  <div>
                    <label htmlFor="r-name" className="block text-sm text-muted mb-1">Your name</label>
                    <input id="r-name" className={inputCls} value={form.name} onChange={set('name')} required maxLength={100} autoComplete="name" />
                  </div>
                  <div>
                    <label htmlFor="r-company" className="block text-sm text-muted mb-1">Company / round</label>
                    <input id="r-company" className={inputCls} value={form.company} onChange={set('company')} maxLength={200} />
                  </div>
                  <div>
                    <label htmlFor="r-area" className="block text-sm text-muted mb-1">Area covered</label>
                    <input id="r-area" className={inputCls} value={form.area} onChange={set('area')} maxLength={200} placeholder="e.g. West Midlands" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="r-email" className="block text-sm text-muted mb-1">Email</label>
                      <input id="r-email" type="email" className={inputCls} value={form.email} onChange={set('email')} required maxLength={200} autoComplete="email" />
                    </div>
                    <div>
                      <label htmlFor="r-phone" className="block text-sm text-muted mb-1">Phone</label>
                      <input id="r-phone" type="tel" className={inputCls} value={form.phone} onChange={set('phone')} maxLength={50} autoComplete="tel" />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="r-message" className="block text-sm text-muted mb-1">Anything to add?</label>
                    <textarea id="r-message" rows={4} className={`${inputCls} resize-y`} value={form.message} onChange={set('message')} maxLength={5000} />
                  </div>
                  {/* Honeypot */}
                  <input type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={set('website')} className="hidden" />
                  <Turnstile onToken={setToken} />
                  {state === 'error' && msg && <p className="text-sm text-danger">{msg}</p>}
                  <button type="submit" disabled={state === 'sending'} className="w-full bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3 text-base transition-colors disabled:opacity-60">
                    {state === 'sending' ? 'Sending…' : 'Register my interest'}
                  </button>
                </form>
              )}
            </div>
          </div>
        </section>
      </SiteChrome>
    </>
  );
}
