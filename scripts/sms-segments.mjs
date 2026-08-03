/**
 * File: scripts/sms-segments.mjs
 * THE segment gate. Computes encoding + segment count FROM THE RENDERED BODY — never from the code
 * that produced it — so it measures what a handset would actually receive.
 *
 * GSM 03.38: the default alphabet is 7 bits/char, 160 per single segment, 153 per segment once
 * concatenated (the UDH eats 7). A single character outside it forces UCS-2: 70 per single segment,
 * 67 concatenated. £ is at 0x01 of the DEFAULT alphabet — one septet, GSM-7 safe. € is in the
 * EXTENSION table, so it is GSM-7 but costs TWO septets.
 */
export const GSM7_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
export const GSM7_EXT = "^{}\\[~]|€";

export function gsm7(text) {
  let septets = 0; const offenders = [];
  for (const ch of text) {
    if (GSM7_BASIC.includes(ch)) septets += 1;
    else if (GSM7_EXT.includes(ch)) septets += 2;   // escape-prefixed
    else { offenders.push(ch); septets += 1; }
  }
  return { ok: offenders.length === 0, septets, offenders: [...new Set(offenders)] };
}

export function segmentsOf(text) {
  const g = gsm7(text);
  if (g.ok) {
    return { encoding: 'GSM-7', units: g.septets, segments: g.septets <= 160 ? 1 : Math.ceil(g.septets / 153), offenders: [] };
  }
  const units = [...text].reduce((a, c) => a + (c.codePointAt(0) > 0xffff ? 2 : 1), 0);
  return { encoding: 'UCS-2', units, segments: units <= 70 ? 1 : Math.ceil(units / 67), offenders: g.offenders };
}

export const describe = (t) => { const s = segmentsOf(t); return `${String(t.length).padStart(3)} chars  ${s.encoding} ${String(s.units).padStart(3)}u = ${s.segments} seg${s.offenders.length ? '   non-GSM7: ' + s.offenders.map(c => JSON.stringify(c)).join(' ') : ''}`; };
