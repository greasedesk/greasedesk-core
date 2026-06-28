/**
 * File: pages/admin/settings/users.tsx
 * Settings → Users. Read-only list of the tenant's users for now (management is a later slice).
 */
import React from 'react';
import Head from 'next/head';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';

type UserRow = { id: string; email: string; role: string; isActive: boolean };
type PageProps = { users: UserRow[] };

export default function UsersSettings({ users }: PageProps) {
  return (
    <SettingsLayout>
      <Head><title>Users - GreaseDesk</title></Head>
      <p className="text-slate-400 mb-6">Users in this account. Inviting and editing users is a later slice.</p>

      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden max-w-3xl">
        <table className="w-full text-left text-sm text-slate-200">
          <thead className="bg-slate-900/60 text-xs uppercase text-slate-400">
            <tr><th className="px-4 py-3">Email</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Status</th></tr>
          </thead>
          <tbody>
            {users.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-slate-400">No users.</td></tr>}
            {users.map((u) => (
              <tr key={u.id} className="border-t border-slate-700">
                <td className="px-4 py-3">{u.email}</td>
                <td className="px-4 py-3">{u.role}</td>
                <td className="px-4 py-3">{u.isActive ? 'Active' : 'Inactive'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SettingsLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.group_id || !user?.site_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }

  type UserDbRow = { id: string; email: string; role: string; is_active: boolean };
  const rows = (await prisma.user.findMany({
    where: { group_id: user.group_id },
    orderBy: { email: 'asc' },
    select: { id: true, email: true, role: true, is_active: true },
  })) as UserDbRow[];

  const users: UserRow[] = rows.map((u: UserDbRow) => ({ id: u.id, email: u.email, role: u.role, isActive: u.is_active }));
  return { props: { users } };
};
