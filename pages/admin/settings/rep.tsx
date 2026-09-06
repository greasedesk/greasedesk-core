/**
 * File: pages/admin/settings/rep.tsx
 * RELOCATED: who to call now lives at /admin/support, reachable from the main rail rather than four
 * levels down under a label naming a person most garages do not have. The rep card is a section of
 * that page; the GreaseDesk number leads it.
 *
 * This route stays as a redirect so deep-links survive; retire it once nothing points here — the
 * same treatment settings/headcount.tsx got when Headcount moved to HR.
 */
export default function RepRedirect() { return null; }
export const getServerSideProps = async () => ({ redirect: { destination: '/admin/support', permanent: false } });
