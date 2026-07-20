/**
 * File: pages/admin/settings/import/[id].tsx
 * MOVED — see ./index.tsx. Redirects to the wizard's new home, preserving the invoice id so a
 * bookmarked wizard link lands on the same staged invoice rather than the list.
 */
import type { GetServerSideProps } from 'next';
export const getServerSideProps: GetServerSideProps = async (ctx) => ({
  redirect: { destination: `/admin/invoices/import/${ctx.params?.id ?? ''}`, permanent: false },
});
export default function MovedImportWizard() { return null; }
