/**
 * File: pages/unsubscribe/[token].tsx
 * WHERE A GARAGE'S UNSUBSCRIBE LINK LANDS — step 4 of the tenant unsubscribe (owner decision B).
 *
 * ── OPENING IT DOES NOTHING ─────────────────────────────────────────────────────────────────────
 * Mail scanners and link previewers follow every link in an email, so this page only READS. The
 * button posts to /api/unsubscribe; that is the act, and it is harmless to repeat.
 *
 * ── IT NAMES THE GARAGE, NEVER GREASEDESK, AND NEVER THE ADDRESS ────────────────────────────────
 * The customer's relationship is with their garage, and the garage controls their data, so the page
 * speaks for the garage. It never shows who the link was sent to: a forwarded email must not tell
 * its holder whose address it was. No session, no cookie banner (nothing optional loads here).
 *
 * ── WHAT IT PROMISES ────────────────────────────────────────────────────────────────────────────
 * Reminders and offers stop; quotes and invoices for work they asked for still reach them — the
 * whole of decision B, said where the customer decides.
 */
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { useTranslation } from 'next-i18next';

type Props =
  | { state: 'unknown' }
  | { state: 'ready' | 'done' | 'nothing_on_file'; garage: string; channel: 'email' | 'sms'; token: string };

export default function Unsubscribe(props: Props) {
  const { t } = useTranslation('common');
  const box = 'max-w-md mx-auto mt-16 p-6 rounded-xl border border-line bg-surface text-ink';
  if (props.state === 'unknown') {
    return (
      <main className={box} data-testid="unsubscribe-unknown">
        <Head><title>{t('unsubscribe.unknownTitle')}</title><meta name="robots" content="noindex" /></Head>
        <h1 className="text-lg font-semibold">{t('unsubscribe.unknownTitle')}</h1>
        <p className="mt-2 text-sm text-muted">{t('unsubscribe.unknownBody')}</p>
      </main>
    );
  }
  const { garage, channel, token } = props;
  return (
    <main className={box} data-testid={`unsubscribe-${props.state}`}>
      <Head><title>{t('unsubscribe.title', { garage })}</title><meta name="robots" content="noindex" /></Head>
      {props.state === 'ready' && (
        <>
          <h1 className="text-lg font-semibold">{t(`unsubscribe.ready_${channel}`, { garage })}</h1>
          <p className="mt-2 text-sm text-muted">{t('unsubscribe.stillGet')}</p>
          <form method="post" action={`/api/unsubscribe?t=${encodeURIComponent(token)}`} className="mt-5">
            <button type="submit" className="rounded-lg px-4 py-2 text-sm bg-accent text-white" data-testid="unsubscribe-confirm">
              {t('unsubscribe.button')}
            </button>
          </form>
        </>
      )}
      {props.state === 'done' && (
        <>
          <h1 className="text-lg font-semibold">{t(`unsubscribe.done_${channel}`, { garage })}</h1>
          <p className="mt-2 text-sm text-muted">{t('unsubscribe.stillGetDone')}</p>
        </>
      )}
      {props.state === 'nothing_on_file' && (
        <h1 className="text-lg font-semibold">{t('unsubscribe.nothingOnFile', { garage })}</h1>
      )}
    </main>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  ctx.res.setHeader('Cache-Control', 'no-store');
  const token = String(ctx.params?.token ?? '');
  // Server-only, imported here so no database module can reach the page's browser bundle.
  const { unsubscribeView } = await import('@/lib/contact-preferences');
  const view = await unsubscribeView(token);
  if (view.state === 'unknown') { ctx.res.statusCode = 404; return { props: { state: 'unknown' } }; }
  return { props: { state: view.state, garage: view.garage, channel: view.channel, token } };
};
