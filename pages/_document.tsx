/**
 * File: pages/_document.tsx
 * Global document head: the favicon set ONLY. The PWA manifest is deliberately NOT linked here —
 * it lives on the /m phone surface alone (pages/m/*), so the mechanic app is installable and the
 * desktop admin is not (an installed app always opens on the bay board, never the admin panel).
 *
 * ── AND THE THEME, FOR THE ENGINE ROOM ──────────────────────────────────────────────────────────
 * `:root[data-theme="dark"]` sat in globals.css for months as a scaffold "not wired to a selector
 * yet". It is wired here, and only for /superadmin — er.greasedesk.com serves nothing else, so the
 * operator portal is dark throughout while the tenant app stays light, out of ONE set of tokens.
 *
 * STAMPED ON THE SERVER, not from an effect: an effect runs after first paint, so every Engine Room
 * page would flash light before turning dark. `ctx.pathname` is the matched ROUTE, which is what we
 * want — /superadmin/tenants/[id] is a superadmin route whatever id it carries.
 */
import { Html, Head, Main, NextScript, type DocumentContext } from 'next/document';

export default function Document({ theme }: { theme?: string }) {
  return (
    <Html {...(theme ? { 'data-theme': theme } : {})}>
      <Head>
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="icon" href="/favicon.ico" />
        {/* Deliberately OPAQUE (supplied as-is): iOS renders alpha as black on the home screen. */}
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <meta name="msapplication-config" content="/browserconfig.xml" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}

Document.getInitialProps = async (ctx: DocumentContext) => {
  const initial = await ctx.defaultGetInitialProps(ctx);
  // Only the Engine Room. A tenant route must never pick this up: the light workspace is the
  // product, not a default.
  return { ...initial, theme: ctx.pathname.startsWith('/superadmin') ? 'dark' : undefined };
};
