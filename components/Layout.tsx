/**
 * File: components/Layout.tsx
 * Last edited: 2025-10-27 21:25 Europe/London
 */
import TopNav from "./TopNav";
import Head from "next/head";

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
        <TopNav />
        <main className="flex-1">{children}</main>
      </div>
    </>
  );
}
