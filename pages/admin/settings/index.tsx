/**
 * File: pages/admin/settings/index.tsx
 * /admin/settings → redirect to the first sub-section (Locations & Resources).
 */
import { GetServerSideProps } from 'next';

export default function SettingsIndex() {
  return null;
}

export const getServerSideProps: GetServerSideProps = async () => {
  return { redirect: { destination: '/admin/settings/locations', permanent: false } };
};
