/**
 * File: pages/admin/jobcards/new.tsx
 * Slice 1: create a job card.
 *
 * Captures vehicle/customer fields + flags and POSTs to /api/jobcard, which creates the
 * JobCard (and find-or-creates Customer + Vehicle) scoped to the session's group_id/site_id.
 * Auth-guarded in getServerSideProps, mirroring the Settings page.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import AdminLayout from '@/components/layout/AdminLayout';

const inputClass =
  'w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:ring-blue-500 focus:border-blue-500 transition';
const labelClass = 'block text-sm font-medium text-slate-300 mb-1';

type Flags = {
  flag_urgent: boolean;
  flag_sales_car: boolean;
  flag_customer_car: boolean;
  flag_mot: boolean;
  flag_diag: boolean;
};

const FLAG_LABELS: Array<[keyof Flags, string]> = [
  ['flag_urgent', 'Urgent / Priority'],
  ['flag_sales_car', 'Sales Car'],
  ['flag_customer_car', 'Customer Car'],
  ['flag_mot', 'MOT (bay needed)'],
  ['flag_diag', 'DIAG (diagnostic)'],
];

export default function NewJobCardPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    registration: '',
    customerName: '',
    phone: '',
    email: '',
    vin: '',
    mileage: '',
  });
  const [flags, setFlags] = useState<Flags>({
    flag_urgent: false,
    flag_sales_car: false,
    flag_customer_car: false,
    flag_mot: false,
    flag_diag: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleField(e: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function toggleFlag(key: keyof Flags) {
    setFlags((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/jobcard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, ...flags }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || 'Failed to create job card.');
      router.push(`/admin/jobcards/${data.id}`);
    } catch (err: any) {
      setError(err?.message || 'Failed to create job card.');
      setSaving(false);
    }
  }

  return (
    <AdminLayout>
      <Head>
        <title>New Job Card - GreaseDesk</title>
      </Head>

      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold text-white">New Job Card</h1>
          <Link href="/admin/jobcards" className="text-sm text-slate-400 hover:text-white">
            ← Back to list
          </Link>
        </div>

        {error && (
          <div className="bg-red-700 text-red-100 p-3 rounded-lg mb-4 text-sm">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="bg-slate-800 border border-slate-700 rounded-xl p-6 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Registration *</label>
              <input
                name="registration"
                value={form.registration}
                onChange={handleField}
                required
                placeholder="e.g. AB12 CDE"
                className={`${inputClass} uppercase`}
              />
            </div>
            <div>
              <label className={labelClass}>Customer name *</label>
              <input name="customerName" value={form.customerName} onChange={handleField} required className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Phone</label>
              <input name="phone" value={form.phone} onChange={handleField} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Email</label>
              <input name="email" type="email" value={form.email} onChange={handleField} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>VIN</label>
              <input name="vin" value={form.vin} onChange={handleField} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Current mileage</label>
              <input name="mileage" type="number" min="0" value={form.mileage} onChange={handleField} className={inputClass} />
            </div>
          </div>

          <div>
            <label className={labelClass}>Flags</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {FLAG_LABELS.map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => toggleFlag(key)}
                  className={`text-sm px-3 py-1.5 rounded-lg border transition ${
                    flags[key]
                      ? 'bg-blue-600 text-white border-blue-400'
                      : 'bg-slate-700 text-slate-300 border-slate-600 hover:border-slate-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={saving}
              className="bg-blue-500 hover:bg-blue-400 text-slate-900 font-semibold rounded-lg px-5 py-2.5 disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create Job Card'}
            </button>
          </div>
        </form>
      </div>
    </AdminLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.group_id || !user?.site_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }
  return { props: {} };
};
