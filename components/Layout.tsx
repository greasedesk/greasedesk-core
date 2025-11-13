/**
 * File: components/Layout.tsx
 * Last edited: 2025-11-13 17:58 Europe/London (FIXED - Integrated Header.tsx)
 */
import Header from "./Header"; // 💥 FIX 1: Changed import from TopNav to Header
import Head from "next/head";
import React from 'react';

export default function Layout(props: {
  title?: string;
  children: React.ReactNode;
}) {
  const { title = "GreaseDesk", children } = props;
  return (
    <>
      <Head>
        <title>{title} • GreaseDesk</title>
      </Head>
      <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
        <Header /> {/* 💥 FIX 2: Using the new Header component */}
        <main className="flex-1">{children}</main>
      </div>
    </>
  );
}