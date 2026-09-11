/**
 * File: lib/unsubscribe-links.ts
 * WHERE A GARAGE'S UNSUBSCRIBE LINK POINTS, AND THE HEADERS THAT CARRY IT — one definition, read by
 * the sender (lib/notify), the page and the gate. A LEAF: it imports nothing.
 *
 * TWO URLS, on purpose:
 *   page     — the link in the email body. A page WITH A BUTTON: mail scanners and link previewers
 *              follow links, so opening it must never act.
 *   oneClick — RFC 8058. A mail client POSTs `List-Unsubscribe=One-Click` here without opening
 *              anything; that POST is the act. Repeating it changes nothing.
 * Both on the apex, which middleware serves to anyone; the er. and reps. hosts refuse them.
 *
 * The token is minted by the sender (24 random bytes, base64url) and lives on the email's own
 * NotificationLog row — see migration 20260911120000_unsubscribe_token.
 */

/** The only shape a token can have. Checked before anything reaches the database. */
export const UNSUBSCRIBE_TOKEN = /^[A-Za-z0-9_-]{32}$/;

export function unsubscribeLinks(token: string, base?: string) {
  const origin = (base || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'https://greasedesk.com').replace(/\/$/, '');
  return {
    page: `${origin}/unsubscribe/${token}`,
    oneClick: `${origin}/api/unsubscribe?t=${encodeURIComponent(token)}`,
  };
}

/** The mail headers every marketing email carries — so a mail client can offer its own Unsubscribe. */
export function unsubscribeHeaders(links: { oneClick: string }): Record<string, string> {
  return {
    'List-Unsubscribe': `<${links.oneClick}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
