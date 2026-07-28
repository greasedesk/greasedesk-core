/**
 * File: pages/onboarding/tax.tsx
 * Onboarding Step 3 — tax profile. Renders its questions from the locale-keyed config
 * (lib/onboarding-steps), so a new geography is a config row, not a new page (item-13). Writes via
 * /api/onboarding/tax; tax_default_rate_bp going non-NULL advances the wizard to Checkout.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { requireOnboardingStep } from '@/lib/admin-guard';
import { taxQuestionsForLocale, ONBOARDING_COUNTRIES, type OnboardingQuestion } from '@/lib/onboarding-steps';
import { getProfile } from '@/lib/locale-profiles';

type Answers = Record<string, string | boolean>;
type PageProps = { questions: OnboardingQuestion[]; initial: Answers };

const inputClass = 'w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white focus:ring-blue-500 focus:border-blue-500 transition';
const labelClass = 'block text-sm font-medium text-slate-300 mb-1 mt-4';

function shows(q: OnboardingQuestion, answers: Answers): boolean {
  if (!q.appliesWhen) return true;
  return answers[q.appliesWhen.field] === q.appliesWhen.equals;
}

export default function TaxStepPage({ questions, initial }: PageProps) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Answers>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => questions.filter((q) => shows(q, answers)), [questions, answers]);

  function set(field: string, value: string | boolean) {
    setAnswers((a) => ({ ...a, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/onboarding/tax', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tax_country_code: answers.tax_country_code,
          vat_registered: answers.vat_registered === true,
          vat_number: (answers.vat_number as string) || '',
          vat_rate_percent: (answers.vat_rate_percent as string) || '',
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.message || 'Could not save your tax details.');
      router.push('/onboarding/billing');
    } catch (err: any) {
      setError(err?.message || 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 sm:p-8">
      <Head><title>Tax Setup - GreaseDesk</title></Head>
      <div className="max-w-lg mx-auto bg-slate-800 p-6 sm:p-8 rounded-xl shadow-2xl border border-blue-600/50">
        <h1 className="text-3xl font-bold mb-2 text-blue-400">Step 3: Tax</h1>
        <p className="text-slate-400 mb-6">Tell us how your garage is set up for tax. This drives VAT on your quotes and invoices.</p>

        {error && <div className="bg-red-800 text-red-100 p-3 rounded-lg mb-4 text-sm">{error}</div>}

        <form onSubmit={handleSubmit}>
          {visible.map((q) => (
            <div key={q.key}>
              <label htmlFor={q.field} className={labelClass}>{q.question}</label>
              {q.type === 'country' && (
                <select id={q.field} className={inputClass} value={String(answers[q.field] ?? 'GB')} onChange={(e) => set(q.field, e.target.value)}>
                  {ONBOARDING_COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </select>
              )}
              {q.type === 'boolean' && (
                <select id={q.field} className={inputClass} value={answers[q.field] === true ? 'yes' : 'no'} onChange={(e) => set(q.field, e.target.value === 'yes')}>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              )}
              {q.type === 'text' && (
                <input id={q.field} className={inputClass} value={String(answers[q.field] ?? '')} onChange={(e) => set(q.field, e.target.value)} placeholder={q.help ?? ''} />
              )}
              {q.type === 'percent' && (
                <input id={q.field} type="number" step="0.01" min="0" max="100" className={inputClass} value={String(answers[q.field] ?? '')} onChange={(e) => set(q.field, e.target.value)} />
              )}
              {q.help && q.type !== 'text' && <p className="text-xs text-slate-500 mt-1">{q.help}</p>}
            </div>
          ))}

          <button type="submit" disabled={saving} className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition disabled:opacity-50 mt-8">
            {saving ? 'Saving…' : 'Save & Continue to Billing'}
          </button>
        </form>
      </div>
    </div>
  );
}

// Wizard step-guard (item-13) + pre-fill from existing group values.
export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const gate = await requireOnboardingStep(ctx, 'tax');
  if (!gate.ok) return { redirect: gate.redirect };
  const groupId = gate.vis.groupId as string;

  const group = (await prisma.group.findUnique({
    where: { id: groupId },
    // country_code was previously read but NEVER SELECTED (always undefined) — the locale fork
    // only worked via the tax_country_code fallback. Selected properly now (ruling 2026-07-28).
    select: { country_code: true, tax_country_code: true, vat_registered: true, vat_number: true, default_vat_rate: true, tax_default_rate_bp: true },
  })) as { country_code: string | null; tax_country_code: string | null; vat_registered: boolean; vat_number: string | null; default_vat_rate: unknown; tax_default_rate_bp: number | null } | null;

  const locale = group?.country_code || group?.tax_country_code || 'GB';
  const questions = taxQuestionsForLocale(locale);
  // Pre-fill from the COUNTRY PROFILE, not a hardcoded '20' — a US garage accepting defaults was
  // getting 20% "Sales Tax" (the US profile default is 0; the garage types their own rate).
  // default_vat_rate can NOT distinguish "answered" from "untouched" — it is non-nullable with a
  // DB default of 20, so the schema default masquerades as an answer. tax_default_rate_bp is the
  // step's own completion signal (NULL until this step writes it) — THAT is the re-entry test.
  const profile = getProfile(locale);
  const taxStepAnswered = group?.tax_default_rate_bp != null;

  const initial: Answers = {
    tax_country_code: group?.tax_country_code || locale,
    vat_registered: group?.vat_registered ?? true,
    vat_number: group?.vat_number || '',
    vat_rate_percent: taxStepAnswered && group?.default_vat_rate != null
      ? String(group.default_vat_rate)
      : String(profile.defaultTaxRatePercent),
  };

  return { props: { questions, initial } };
};
