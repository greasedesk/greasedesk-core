/**
 * File: pages/_document.tsx
 * Global document head: the favicon set ONLY. The PWA manifest is deliberately NOT linked here —
 * it lives on the /m phone surface alone (pages/m/*), so the mechanic app is installable and the
 * desktop admin is not (an installed app always opens on the bay board, never the admin panel).
 */
import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html>
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
