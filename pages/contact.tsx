/**
 * File: pages/contact.tsx
 * Public contact page: click-to-call, email, registered office (all from lib/company-info) plus a
 * Resend-backed form. The form surfaces real success/error states and NEVER silently fails — a send
 * error tells the user and points them at the phone/email fallback.
 */
import { useState } from 'react';
import Link from 'next/link';
import Seo from '@/components/marketing/Seo';
import SiteChrome from '@/components/marketing/SiteChrome';
import { COMPANY, officeOneLine } from '@/lib/company-info';

const inputCls = 'w-full p-3 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-2 focus:ring-accent focus:border-accent outline-none';

export default function ContactPage() {
  const [form, setForm] = useState({ name: '', email: '', message: '', website: '' });
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('sending'); setMsg(null);
    try {
      const res = await fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) { setState('sent'); setMsg(data.message || 'Thanks — we’ll be in touch shortly.'); setForm({ name: '', email: '', message: '', website: '' }); }
      else { setState('error'); setMsg(data?.message || 'Something went wrong. Please try again, or email us directly.'); }
    } catch {
      setState('error'); setMsg('We couldn’t reach the server. Please email or call us instead.');
    }
  }

  return (
    <>
      <Seo
        title="Contact GreaseDesk — talk to us"
        description={`Get in touch with ${COMPANY.legalName}. Call ${COMPANY.phone} or send us a message through the form.`}
        path="/contact"
      />
      <SiteChrome>
        <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 sm:pt-24 pb-16">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-ink tracking-tight">Talk to us</h1>
          <p className="mt-4 text-lg text-muted max-w-2xl">Questions about GreaseDesk, a bigger workshop, or getting set up? Call, email, or drop us a message and we’ll get back to you.</p>

          <div className="mt-10 grid md:grid-cols-2 gap-10">
            {/* Details */}
            <div className="space-y-6">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted mb-1">Phone</div>
                <a href={`tel:${COMPANY.phoneE164}`} className="text-lg font-semibold text-accent hover:underline">{COMPANY.phone}</a>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted mb-1">Registered office</div>
                <address className="not-italic text-ink text-sm leading-relaxed">
                  {COMPANY.legalName}<br />
                  {officeOneLine()}
                </address>
                <p className="mt-1 text-xs text-muted">Company No. {COMPANY.companyNumber}</p>
              </div>
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
                    <label htmlFor="c-name" className="block text-sm text-muted mb-1">Your name</label>
                    <input id="c-name" className={inputCls} value={form.name} onChange={set('name')} required maxLength={100} autoComplete="name" />
                  </div>
                  <div>
                    <label htmlFor="c-email" className="block text-sm text-muted mb-1">Email</label>
                    <input id="c-email" type="email" className={inputCls} value={form.email} onChange={set('email')} required maxLength={200} autoComplete="email" />
                  </div>
                  <div>
                    <label htmlFor="c-message" className="block text-sm text-muted mb-1">Message</label>
                    <textarea id="c-message" rows={5} className={`${inputCls} resize-y`} value={form.message} onChange={set('message')} required maxLength={5000} />
                  </div>
                  {/* Honeypot — visually hidden; real users leave it empty */}
                  <input type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={set('website')} className="hidden" />
                  {state === 'error' && msg && <p className="text-sm text-danger">{msg}</p>}
                  <button type="submit" disabled={state === 'sending'} className="w-full bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3 text-base transition-colors disabled:opacity-60">
                    {state === 'sending' ? 'Sending…' : 'Send message'}
                  </button>
                  <p className="text-xs text-muted">Prefer to talk? Call <a href={`tel:${COMPANY.phoneE164}`} className="text-accent hover:underline">{COMPANY.phone}</a>.</p>
                </form>
              )}
            </div>
          </div>
        </section>
      </SiteChrome>
    </>
  );
}
