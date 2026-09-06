/**
 * File: pages/admin/settings/overheads.tsx
 * RETIRED: Overheads are now Costs (/admin/costs — dated rates, one entry per period, editable when
 * the real bill arrives). The register this panel edited held ONE amount with no dates, so a rent
 * rise silently restated every closed month.
 *
 * This route stays as a redirect so deep-links survive; retire it once nothing points here — the
 * same treatment settings/headcount.tsx got when Headcount moved to HR.
 *
 * The Overhead TABLE is deliberately retained: for a tenant whose costs have been carried across,
 * those rows are the only record of what the figures were before.
 */
export default function OverheadsRedirect() { return null; }
export const getServerSideProps = async () => ({ redirect: { destination: '/admin/costs', permanent: false } });
