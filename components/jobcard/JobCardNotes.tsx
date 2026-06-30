/**
 * File: components/jobcard/JobCardNotes.tsx
 * Internal garage notes on a job card. Operational — editable by anyone with site access
 * (incl. STANDARD mechanics) via /api/jobcard-notes. Light theme/tokens, i18n-native, mobile-first.
 */
import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';

type Props = { jobCardId: string; canEdit: boolean; initialNotes: string };

export default function JobCardNotes({ jobCardId, canEdit, initialNotes }: Props) {
  const { t } = useTranslation('jobcard');
  const [notes, setNotes] = useState(initialNotes);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/jobcard-notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, notes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('notes.error'), ok: false }); setBusy(false); return; }
      setMsg({ text: t('notes.saved'), ok: true });
    } catch {
      setMsg({ text: t('notes.error'), ok: false });
    }
    setBusy(false);
  }

  return (
    <div className="bg-surface border border-line rounded-xl p-5 mb-5">
      <h2 className="text-lg font-semibold text-ink mb-3">{t('notes.title')}</h2>
      {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}
      <textarea
        className="w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent"
        rows={4}
        value={notes}
        disabled={!canEdit}
        placeholder={t('notes.placeholder')}
        onChange={(e) => setNotes(e.target.value)}
      />
      {canEdit && (
        <div className="mt-3">
          <button onClick={save} disabled={busy} className="bg-ok hover:bg-ok text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50 w-full sm:w-auto">
            {busy ? t('notes.saving') : t('notes.save')}
          </button>
        </div>
      )}
    </div>
  );
}
