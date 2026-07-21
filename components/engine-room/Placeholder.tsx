/**
 * File: components/engine-room/Placeholder.tsx
 * A clean, dark "coming soon" panel for Engine Room screens whose feature layer hasn't landed —
 * states what's coming, never a broken control.
 */
export default function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold mb-2">{title}</h1>
      <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/60 p-8 text-slate-400">
        {body}
      </div>
    </div>
  );
}
