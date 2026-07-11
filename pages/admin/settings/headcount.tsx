/**
 * File: pages/admin/settings/headcount.tsx
 * RELOCATED: Headcount now lives in the HR section (/admin/hr — ADMIN-only, with the
 * effective-dated employment history). This route stays as a redirect so deep-links survive;
 * retire it once nothing points here.
 */
export default function HeadcountRedirect() { return null; }
export const getServerSideProps = async () => ({ redirect: { destination: '/admin/hr', permanent: false } });
