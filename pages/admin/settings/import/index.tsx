/**
 * File: pages/admin/settings/import/index.tsx
 * MOVED. Invoice import now lives with Invoices, not in Settings — it is part of the invoicing
 * workflow, not a configuration screen. This stub keeps every existing link and bookmark working.
 */
import type { GetServerSideProps } from 'next';
export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: { destination: '/admin/invoices/import', permanent: false },
});
export default function MovedImportIndex() { return null; }
