/**
 * File: pages/admin/settings/invoicing.tsx
 * Settings → Invoicing (ADMIN only): everything about the invoice as a document + how it's sent.
 *  - Sending: Reply-To + sender display name (the From stays GreaseDesk-owned for deliverability;
 *    only these are tenant-set) + garage-copy BCC. Feeds the ONE send path (route + cron).
 *  - Payment terms / footer text: free multi-line block rendered on the document.
 *  - Logo: single image to R2 ({group}/branding/…), rendered top-centre of the PDF (auto-placed).
 *  - Numbering: RELOCATED from Company Details — same /api/company contract, same lock (the
 *    starting-number seed stays locked once chargeable invoices exist; never re-enabled).
 * All saves go through PATCH /api/company (admin-gated server-side).
 */
import React, { useRef, useState } from 'react';
import Head from 'next/head';
import { useTranslation } from 'next-i18next';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { presignGet } from '@/lib/r2';

type PageProps = {
  replyTo: string; senderName: string; bcc: string; footerText: string;
  emailFooter: boolean; logoUrl: string | null;
  invoicePrefix: string; invoicePadWidth: string; invoiceFyDigits: string; fyStartMonth: string;
  warrantyPrefix: string; nextNumber: string; canSeed: boolean; paidWindowHours: string;
  groupName: string; billingEmail: string;
};

const inputClass = 'mt-1 w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const labelClass = 'block text-xs text-muted';

export default function InvoicingSettings(props: PageProps) {
  const { t } = useTranslation('company');
  const [replyTo, setReplyTo] = useState(props.replyTo);
  const [senderName, setSenderName] = useState(props.senderName);
  const [bcc, setBcc] = useState(props.bcc);
  const [footerText, setFooterText] = useState(props.footerText);
  const [footer, setFooter] = useState(props.emailFooter);
  const [logoUrl, setLogoUrl] = useState(props.logoUrl);
  const [invPrefix, setInvPrefix] = useState(props.invoicePrefix);
  const [invPad, setInvPad] = useState(props.invoicePadWidth);
  const [fyDigits, setFyDigits] = useState(props.invoiceFyDigits);
  const [fyMonth, setFyMonth] = useState(props.fyStartMonth);
  const [wPrefix, setWPrefix] = useState(props.warrantyPrefix);
  const [nextNo, setNextNo] = useState(props.nextNumber);
  const [payWindow, setPayWindow] = useState(props.paidWindowHours);
  const [busy, setBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Live preview mirrors formatInvoiceNumber (prefix + optional FY + padded counter).
  const pad = (v: string | number) => String(v).padStart(Math.max(0, Math.min(10, Number(invPad) || 0)), '0');
  const now = new Date();
  const fyStartYear = now.getMonth() + 1 >= (Number(fyMonth) || 1) ? now.getFullYear() : now.getFullYear() - 1;
  const fySeg = fyDigits === '2' ? `${String(fyStartYear).slice(-2)}-` : fyDigits === '4' ? `${fyStartYear}-` : '';
  const previewNumber = `${invPrefix}${fySeg}${pad(props.canSeed && Number(nextNo) > 0 ? Number(nextNo) : Number(props.nextNumber) || 1)}`;

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/company', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoice_reply_to: replyTo, invoice_sender_name: senderName, invoice_bcc: bcc, invoice_footer_text: footerText,
          invoice_email_footer: footer,
          invoice_prefix: invPrefix, invoice_pad_width: Number(invPad || 0),
          invoice_fy_digits: Number(fyDigits || 0), fy_start_month: Number(fyMonth || 4),
          invoice_warranty_prefix: wPrefix, paid_confirm_window_hours: Number(payWindow || 24),
          ...(props.canSeed && nextNo.trim() !== '' && nextNo !== props.nextNumber ? { invoice_next_number: Number(nextNo) } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('details.error'), ok: false }); setBusy(false); return; }
      setMsg({ text: t('details.saved'), ok: true });
    } catch { setMsg({ text: t('details.error'), ok: false }); }
    setBusy(false);
  }

  // Logo: presign → PUT to R2 → PATCH the key (server validates the key belongs to this tenant).
  async function onLogo(files: FileList | null) {
    if (!files || !files.length) return;
    const file = files[0];
    setLogoBusy(true); setMsg(null);
    try {
      const pres = await fetch('/api/branding-logo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentType: file.type }) });
      const pd = await pres.json().catch(() => ({}));
      if (!pres.ok) { setMsg({ text: pd?.message || t('invoicing.logoError'), ok: false }); setLogoBusy(false); return; }
      const put = await fetch(pd.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!put.ok) throw new Error('upload');
      const res = await fetch('/api/company', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ logo_r2_key: pd.key }) });
      if (!res.ok) throw new Error('commit');
      setLogoUrl(pd.previewUrl || null);
      setMsg({ text: t('invoicing.logoSaved'), ok: true });
    } catch { setMsg({ text: t('invoicing.logoError'), ok: false }); }
    finally { setLogoBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  return (
    <SettingsLayout isAdmin>
      <Head><title>Invoicing - GreaseDesk</title></Head>
      <div className="bg-surface border border-line rounded-xl p-6 max-w-xl">
        <h2 className="text-lg font-semibold text-ink mb-1">{t('invoicing.title')}</h2>
        <p className="text-sm text-muted mb-4">{t('invoicing.intro')}</p>
        {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}

        <form onSubmit={save} className="space-y-3">
          {/* --- Sending --- */}
          <div className="text-sm font-medium text-ink">{t('invoicing.sending')}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>{t('invoicing.senderName')}</span>
              <input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder={props.groupName} className={inputClass} />
              <span className="text-xs text-muted mt-0.5 block">{t('invoicing.senderNameHint')}</span>
            </label>
            <label className="block">
              <span className={labelClass}>{t('invoicing.replyTo')}</span>
              <input type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder={props.billingEmail} className={inputClass} />
              <span className="text-xs text-muted mt-0.5 block">{t('invoicing.replyToHint')}</span>
            </label>
            <label className="block sm:col-span-2">
              <span className={labelClass}>{t('invoicing.bcc')}</span>
              <input type="email" value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder={props.billingEmail} className={inputClass} />
              <span className="text-xs text-muted mt-0.5 block">{t('invoicing.bccHint')}</span>
            </label>
          </div>
          <label className="flex items-start gap-3 py-1 cursor-pointer">
            <input type="checkbox" checked={footer} onChange={(e) => setFooter(e.target.checked)} className="w-5 h-5 mt-0.5" />
            <span>
              <span className="text-sm font-medium text-ink block">{t('invoice.emailFooter')}</span>
              <span className="text-xs text-muted">{t('invoice.emailFooterHint')}</span>
            </span>
          </label>

          {/* --- Document footer / payment terms --- */}
          <div className="pt-3 border-t border-line">
            <label className="block">
              <span className="text-sm font-medium text-ink">{t('invoicing.footerText')}</span>
              <textarea rows={5} value={footerText} onChange={(e) => setFooterText(e.target.value)} placeholder={t('invoicing.footerTextPh')} className={`${inputClass} resize-y`} />
              <span className="text-xs text-muted mt-0.5 block">{t('invoicing.footerTextHint')}</span>
            </label>
          </div>

          {/* --- Logo --- */}
          <div className="pt-3 border-t border-line">
            <div className="text-sm font-medium text-ink mb-2">{t('invoicing.logo')}</div>
            <div className="flex items-center gap-4">
              {logoUrl ? <img src={logoUrl} alt="logo" className="h-14 max-w-[10rem] object-contain bg-white border border-line rounded p-1" /> : <span className="text-xs text-muted">{t('invoicing.noLogo')}</span>}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => onLogo(e.target.files)} />
              <button type="button" disabled={logoBusy} onClick={() => fileRef.current?.click()} className="text-sm bg-surface-muted border border-line text-ink rounded-lg px-3 py-2 disabled:opacity-50">
                {logoBusy ? t('invoicing.logoUploading') : t('invoicing.logoUpload')}
              </button>
            </div>
            <p className="text-xs text-muted mt-1">{t('invoicing.logoHint')}</p>
          </div>

          {/* --- Numbering (relocated from Company Details; the seed lock is preserved) --- */}
          <div className="pt-3 border-t border-line">
            <div className="text-sm font-medium text-ink mb-1">{t('invoice.heading')}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={labelClass}>{t('invoice.prefix')}</span>
                <input value={invPrefix} onChange={(e) => setInvPrefix(e.target.value)} placeholder={t('invoice.prefixPlaceholder')} className={inputClass} />
              </label>
              <label className="block">
                <span className={labelClass}>{t('invoice.padWidth')}</span>
                <input type="number" inputMode="numeric" min={0} max={10} value={invPad} onChange={(e) => setInvPad(e.target.value)} className={inputClass} />
              </label>
              <label className="block">
                <span className={labelClass}>{t('invoice.fyDigits')}</span>
                <select value={fyDigits} onChange={(e) => setFyDigits(e.target.value)} className={inputClass}>
                  <option value="0">{t('invoice.fyOff')}</option>
                  <option value="2">{t('invoice.fy2')}</option>
                  <option value="4">{t('invoice.fy4')}</option>
                </select>
              </label>
              {fyDigits !== '0' && (
                <label className="block">
                  <span className={labelClass}>{t('invoice.fyStartMonth')}</span>
                  <select value={fyMonth} onChange={(e) => setFyMonth(e.target.value)} className={inputClass}>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                      <option key={m} value={String(m)}>{new Date(2026, m - 1, 1).toLocaleDateString(undefined, { month: 'long' })}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="block">
                <span className={labelClass}>{t('invoice.nextNumber')}</span>
                <input type="number" inputMode="numeric" min={1} value={nextNo} disabled={!props.canSeed}
                  onChange={(e) => setNextNo(e.target.value)} className={`${inputClass} disabled:opacity-50`} />
                <span className="text-xs text-muted mt-0.5 block">{props.canSeed ? t('invoice.nextNumberHint') : t('invoice.nextNumberLocked')}</span>
              </label>
              <label className="block">
                <span className={labelClass}>{t('invoice.warrantyPrefix')}</span>
                <input value={wPrefix} onChange={(e) => setWPrefix(e.target.value)} className={inputClass} />
                <span className="text-xs text-muted mt-0.5 block">{t('invoice.warrantyPrefixHint')}</span>
              </label>
              <label className="block">
                <span className={labelClass}>{t('invoice.paidWindow')}</span>
                <input type="number" inputMode="numeric" min={1} max={168} value={payWindow} onChange={(e) => setPayWindow(e.target.value)} className={inputClass} />
                <span className="text-xs text-muted mt-0.5 block">{t('invoice.paidWindowHint')}</span>
              </label>
            </div>
            <p className="text-xs text-muted mt-2">{t('invoice.preview')}: <span className="font-mono text-ink">{previewNumber}</span></p>
          </div>

          <button type="submit" disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">
            {busy ? t('details.saving') : t('invoicing.save')}
          </button>
        </form>
      </div>
    </SettingsLayout>
  );
}

export const getServerSideProps = withI18n(['company'])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const g = (await prisma.group.findUnique({
    where: { id: gate.vis.groupId as string },
    select: {
      group_name: true, billing_email: true,
      invoice_reply_to: true, invoice_sender_name: true, invoice_bcc: true, invoice_footer_text: true, invoice_email_footer: true, logo_r2_key: true,
      invoice_prefix: true, invoice_pad_width: true, invoice_fy_digits: true, fy_start_month: true, invoice_warranty_prefix: true, paid_confirm_window_hours: true,
      invoice_sequence: { select: { last_value: true } },
    },
  })) as any;
  const chargeableUsed = await prisma.invoice.count({ where: { group_id: gate.vis.groupId as string, series: 'chargeable' } });
  return {
    props: {
      groupName: g?.group_name ?? '',
      billingEmail: g?.billing_email ?? '',
      replyTo: g?.invoice_reply_to ?? '',
      senderName: g?.invoice_sender_name ?? '',
      bcc: g?.invoice_bcc ?? '',
      footerText: g?.invoice_footer_text ?? '',
      emailFooter: g?.invoice_email_footer ?? true,
      logoUrl: g?.logo_r2_key ? await presignGet(g.logo_r2_key) : null,
      invoicePrefix: g?.invoice_prefix ?? '',
      invoicePadWidth: String(g?.invoice_pad_width ?? 4),
      invoiceFyDigits: String(g?.invoice_fy_digits ?? 0),
      fyStartMonth: String(g?.fy_start_month ?? 4),
      warrantyPrefix: g?.invoice_warranty_prefix ?? 'W',
      nextNumber: String((g?.invoice_sequence?.last_value ?? 0) + 1),
      canSeed: chargeableUsed === 0,
      paidWindowHours: String(g?.paid_confirm_window_hours ?? 24),
    },
  };
});
