/**
 * File: pages/affiliate-portal/poster.tsx — served at /poster on affiliates.greasedesk.com.
 * ONE SHEET OF A4 TO PUT ON A COUNTER. Big QR, big code, and the offer in words.
 *
 * ── IT IS A PAGE AND NOT A PDF, DELIBERATELY ────────────────────────────────────────────────────
 * The browser's own print dialogue produces A4 or PDF from this, on any device, with no generator to
 * keep working and no font to embed. The invoice PDF exists because a document has to be archivable
 * and identical for ever; a poster has to come out of whatever printer is in the office.
 *
 * ── SIZED IN MILLIMETRES, AND THE MARGIN IS THE PRINTER'S ───────────────────────────────────────
 * @page sets A4 with a 12mm margin, so nothing important sits inside the unprintable edge every
 * office laser has. The on-screen view is the same sheet at the same proportions, so what somebody
 * sees is what comes out — a preview that differs from the print is worse than no preview.
 */
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireAffiliatePage } from '@/lib/rep-auth';
import { affiliatePortalData } from '@/lib/affiliate-portal-data';

type Props = { refCode: string; referralLink: string; qr: string; monthsLine: string };

export default function AffiliatePoster({ refCode, referralLink, qr, monthsLine }: Props) {
  return (
    <>
      <Head>
        <title>Poster — GreaseDesk affiliates</title>
        <meta name="robots" content="noindex" />
      </Head>
      {/* The print rules are page-scoped: @page cannot be set from a component's className, and this
          is the one page in the app that owns a paper size. */}
      <style>{`
        @page { size: A4; margin: 12mm; }
        @media print {
          .no-print { display: none !important; }
          html, body { background: #fff; }
          .sheet { box-shadow: none !important; border: 0 !important; width: auto !important; min-height: auto !important; }
        }
      `}</style>
      <main className="min-h-screen bg-canvas py-8 px-4 flex flex-col items-center">
        <div className="no-print mb-6 flex items-center gap-3">
          <button type="button" onClick={() => window.print()} data-testid="poster-print"
            className="min-h-[44px] px-5 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold transition-colors">
            Print this
          </button>
          <a href="/dashboard" className="text-sm text-accent hover:underline">Back to your page</a>
        </div>

        <div className="sheet bg-white border border-line shadow-card w-full max-w-[210mm] min-h-[297mm] p-[16mm] flex flex-col items-center text-center"
          data-testid="poster-sheet">
          <p className="text-[11pt] tracking-[0.2em] uppercase text-slate-500">Garage software</p>
          <h1 className="mt-[6mm] text-[34pt] leading-[1.05] font-extrabold text-slate-900">
            Run the whole garage<br />from one screen
          </h1>
          <p className="mt-[8mm] text-[14pt] text-slate-700 max-w-[150mm]">
            Diary, job cards, quotes, invoices and MOT reminders — built for independent garages,
            not main dealers.
          </p>

          {/* eslint-disable-next-line @next/next/no-img-element -- a data URL, not an optimisable asset */}
          <img src={qr} alt={`QR code for ${referralLink}`} className="mt-[12mm] w-[70mm] h-[70mm]" data-testid="poster-qr" />

          <p className="mt-[6mm] text-[12pt] text-slate-600">Scan it, or go to</p>
          <p className="text-[13pt] font-semibold text-slate-900 break-all" data-testid="poster-link">{referralLink}</p>

          <div className="mt-[10mm] border-2 border-slate-900 rounded-xl px-[10mm] py-[6mm]">
            <p className="text-[11pt] uppercase tracking-[0.15em] text-slate-500">Quote this code</p>
            <p className="text-[30pt] font-extrabold tracking-[0.15em] text-slate-900" data-testid="poster-code">{refCode}</p>
          </div>

          <p className="mt-[8mm] text-[14pt] font-semibold text-slate-900" data-testid="poster-offer">{monthsLine}</p>

          <div className="mt-auto pt-[10mm]">
            <p className="text-[10pt] text-slate-500">greasedesk.com</p>
          </div>
        </div>
      </main>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const gate = await requireAffiliatePage(ctx);
  if (!gate.ok) return gate.result as any;

  const data = await affiliatePortalData(gate.rep.repId);
  if (!data) return { notFound: true };

  const QRCode = await import('qrcode');
  // LARGER THAN THE DASHBOARD'S. This one is printed at 70mm and scanned across a counter, so the
  // bitmap has to carry enough pixels for the printer rather than for a screen.
  const qr = await QRCode.toDataURL(data.referralLink, { width: 1200, margin: 1 });

  /**
   * THE OFFER IN THE AFFILIATE'S OWN WORDS COMES FROM THE SAME COPY THE DASHBOARD SHOWS — step 2 of
   * howItWorks — rather than being written again here. A poster that promises a different offer from
   * the page that produced it is the kind of disagreement nobody finds until a garage quotes it back.
   */
  const monthsLine = data.howItWorks[1]?.body.split('.')[0] ?? '';

  return { props: { refCode: data.refCode, referralLink: data.referralLink, qr, monthsLine } };
};
