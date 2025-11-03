/**
 * File: pages/admin/dashboard.tsx
 * Description: The main landing page for an authenticated staff user, now using AdminLayout.
 */
import Head from 'next/head';
import AdminLayout from '@/components/layout/AdminLayout'; // 👈 Import the new layout component
// import { useSession } from 'next-auth/react'; 

export default function AdminDashboard() {
  // You would typically use this to manage session status and access Group data
  // const { data: session, status } = useSession({ required: true }); 
  
  // if (status === "loading") {
  //   return <AdminLayout>Loading...</AdminLayout>;
  // }

  return (
    <AdminLayout> {/* 👈 Wrap all content */}
      <Head>
        <title>Dashboard - GreaseDesk</title>
      </Head>
      
      {/* This will appear in the main content area of the layout */}
      <h1 className="text-4xl font-bold text-blue-400 mb-4">
        Welcome Back!
      </h1>
      <p className="text-slate-400 mb-8">
        This is your central command for TBMS - Birmingham.
      </p>

      {/* --- Dashboard Content --- */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <h2 className="text-xl font-semibold text-white mb-3">Live Job Cards</h2>
          <p className="text-3xl text-yellow-400">4</p>
        </div>
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <h2 className="text-xl font-semibold text-white mb-3">Today's Bookings</h2>
          <p className="text-3xl text-green-400">2</p>
        </div>
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <h2 className="text-xl font-semibold text-white mb-3">Revenue (Today)</h2>
          <p className="text-3xl text-blue-400">£450.00</p>
        </div>
      </div>
    </AdminLayout>
  );
}