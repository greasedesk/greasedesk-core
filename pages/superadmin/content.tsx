/**
 * File: pages/superadmin/content.tsx
 * Engine Room Content — Owner + Country Manager (Support 404s via the gSSP guard). Legal actions are
 * Owner-only, enforced server-side in /api/superadmin/content (the UI mirrors it but is never the guard).
 * List → editor (markdown + live preview) → publish (legal: effective date + immutable warning; page:
 * immediate) → version history. Region-scoped by country for a CM.
 */
import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { requireOperatorPage, erMinRole, type OperatorRoleName } from '@/lib/operator-auth';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';

type DocRow = { slug: string; country: string; type: 'legal' | 'page'; title: string; publishedVersion: string | null; effectiveFrom: string | null; hasDraft: boolean };
type Version = { id: string; version: string; effective_from: string | null; published_at: string | null; created_by: string | null; title: string };
type Draft = { id: string; title: string; body: string; type: 'legal' | 'page'; country_code: string } | null;

const input = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:ring-2 focus:ring-slate-500 focus:outline-none';
const btn = 'bg-slate-100 text-slate-900 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50';
const canLegal = (role: string) => role === 'owner';

function Preview({ body }: { body: string }) {
  return (
    <div className="text-sm text-slate-300 leading-relaxed [&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-white [&_h1]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-white [&_h2]:mt-3 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-sky-400 [&_strong]:text-white [&_table]:w-full [&_th]:text-left [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1 [&_td]:border-t [&_td]:border-slate-700 [&_blockquote]:border-l-4 [&_blockquote]:border-amber-500 [&_blockquote]:bg-amber-950/40 [&_blockquote]:text-amber-200 [&_blockquote]:px-3 [&_blockquote]:py-2 [&_code]:font-mono [&_code]:text-xs [&_code]:bg-slate-800 [&_code]:px-1 [&_code]:rounded">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body || '_Nothing to preview yet._'}</ReactMarkdown>
    </div>
  );
}

export default function ContentScreen({ role }: { role: OperatorRoleName }) {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<{ slug: string; country: string } | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [published, setPublished] = useState<Version[]>([]);
  const [title, setTitle] = useState(''); const [body, setBody] = useState('');
  const [effective, setEffective] = useState('');
  // create form
  const [nc, setNc] = useState<{ slug: string; title: string; type: 'legal' | 'page'; country: string } | null>(null);

  const flash = (ok: boolean, text: string) => setMsg({ ok, text });
  const api = async (method: string, body?: any, qs = '') => {
    const r = await fetch('/api/superadmin/content' + qs, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, d };
  };
  const loadList = useCallback(async () => { const { ok, d } = await api('GET'); if (ok) setDocs(d.documents); }, []);
  useEffect(() => { loadList(); }, [loadList]);

  async function openDoc(slug: string, country: string) {
    setSel({ slug, country }); setMsg(null); setEffective('');
    const { ok, d } = await api('GET', undefined, `?slug=${encodeURIComponent(slug)}&country=${encodeURIComponent(country)}`);
    if (!ok) { flash(false, d.message || 'Failed to load.'); return; }
    setDraft(d.draft); setPublished(d.published);
    setTitle(d.draft?.title ?? d.published[0]?.title ?? ''); setBody(d.draft?.body ?? '');
  }
  const backToList = () => { setSel(null); setDraft(null); setPublished([]); loadList(); };

  async function saveDraft() {
    if (!draft) return; setBusy(true);
    const { ok, d } = await api('PATCH', { id: draft.id, title, body }); setBusy(false);
    flash(ok, d.message || (ok ? 'Saved.' : 'Failed.'));
  }
  async function publish() {
    if (!draft) return;
    const isLegal = draft.type === 'legal';
    if (isLegal && !effective) { flash(false, 'A legal document needs an effective date.'); return; }
    if (isLegal && !confirm(`Publish this LEGAL version effective ${effective}?\n\nOnce published it becomes IMMUTABLE — it can never be edited or deleted. Corrections mean publishing a new version.`)) return;
    setBusy(true);
    const { ok, d } = await api('POST', { action: 'publish', id: draft.id, effectiveFrom: effective || undefined }); setBusy(false);
    if (!ok) { flash(false, d.message || 'Failed.'); return; }
    flash(true, d.message); await openDoc(sel!.slug, sel!.country);
  }
  async function newVersion() {
    if (!sel) return; setBusy(true);
    const { ok, d } = await api('POST', { action: 'new_version', slug: sel.slug, country: sel.country }); setBusy(false);
    if (!ok) { flash(false, d.message || 'Failed.'); return; }
    await openDoc(sel.slug, sel.country);
  }
  async function discard() {
    if (!draft || !confirm('Discard this draft? The published version is unaffected.')) return;
    setBusy(true); const { ok, d } = await api('DELETE', { id: draft.id }); setBusy(false);
    if (!ok) { flash(false, d.message || 'Failed.'); return; }
    await openDoc(sel!.slug, sel!.country);
  }
  async function create() {
    if (!nc) return; setBusy(true);
    const { ok, d } = await api('POST', { action: 'create', ...nc, body: '' }); setBusy(false);
    if (!ok) { flash(false, d.message || 'Failed.'); return; }
    setNc(null); await openDoc(nc.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''), nc.country);
  }

  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — content</title><meta name="robots" content="noindex" /></Head>
      <div className="p-6 max-w-4xl">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold">{sel ? `${sel.slug} · ${sel.country}` : 'Content'}</h1>
          {sel ? <button onClick={backToList} className="text-sm text-slate-400 hover:text-white">← All documents</button>
            : <button onClick={() => setNc({ slug: '', title: '', type: canLegal(role) ? 'legal' : 'page', country: 'GB' })} className={btn}>New document</button>}
        </div>
        {msg && <div className={`mb-4 text-sm rounded-lg px-3 py-2 ${msg.ok ? 'bg-emerald-900/50 text-emerald-200' : 'bg-red-900/50 text-red-200'}`}>{msg.text}</div>}

        {/* CREATE FORM */}
        {!sel && nc && (
          <div className="mb-5 rounded-xl border border-slate-800 bg-slate-900 p-4 grid grid-cols-2 gap-3">
            <div><label className="block text-xs text-slate-400 mb-1">Slug</label><input value={nc.slug} onChange={(e) => setNc({ ...nc, slug: e.target.value })} className={input} placeholder="about-us" /></div>
            <div><label className="block text-xs text-slate-400 mb-1">Title</label><input value={nc.title} onChange={(e) => setNc({ ...nc, title: e.target.value })} className={input} /></div>
            <div><label className="block text-xs text-slate-400 mb-1">Type</label>
              <select value={nc.type} onChange={(e) => setNc({ ...nc, type: e.target.value as any })} className={input}>
                <option value="page">Page</option>
                {canLegal(role) && <option value="legal">Legal</option>}
              </select>
            </div>
            <div><label className="block text-xs text-slate-400 mb-1">Country</label><input value={nc.country} onChange={(e) => setNc({ ...nc, country: e.target.value.toUpperCase() })} maxLength={2} className={input} /></div>
            <div className="col-span-2 flex gap-2"><button onClick={create} disabled={busy} className={btn}>Create draft</button><button onClick={() => setNc(null)} className="text-slate-400 text-sm px-2">Cancel</button></div>
          </div>
        )}

        {/* LIST */}
        {!sel && (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-slate-400 text-left"><tr>{['Document', 'Type', 'Country', 'Published', 'Effective', ''].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {docs.length === 0 ? <tr><td colSpan={6} className="px-3 py-6 text-slate-500 text-center">No documents yet.</td></tr> : docs.map((r) => (
                  <tr key={`${r.slug}/${r.country}`} className="border-t border-slate-800 hover:bg-slate-900/50 cursor-pointer" onClick={() => openDoc(r.slug, r.country)}>
                    <td className="px-3 py-2"><div className="text-white">{r.title}</div><div className="text-xs text-slate-500">{r.slug}</div></td>
                    <td className="px-3 py-2"><span className={`text-xs rounded-full px-2 py-0.5 border ${r.type === 'legal' ? 'border-amber-800 text-amber-300' : 'border-slate-700 text-slate-300'}`}>{r.type}</span></td>
                    <td className="px-3 py-2 text-slate-300">{r.country}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-300">{r.publishedVersion ?? <span className="text-slate-600">—</span>}</td>
                    <td className="px-3 py-2 text-xs text-slate-400">{r.effectiveFrom ?? '—'}</td>
                    <td className="px-3 py-2 text-right">{r.hasDraft && <span className="text-[10px] text-amber-400">draft in progress</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* EDITOR */}
        {sel && (
          <div className="space-y-4">
            {draft ? (
              <>
                <div><label className="block text-xs text-slate-400 mb-1">Title</label><input value={title} onChange={(e) => setTitle(e.target.value)} className={input} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="block text-xs text-slate-400 mb-1">Body (markdown — raw HTML is not rendered)</label><textarea value={body} onChange={(e) => setBody(e.target.value)} rows={18} className={`${input} font-mono`} /></div>
                  <div><label className="block text-xs text-slate-400 mb-1">Preview</label><div className="rounded-lg border border-slate-800 bg-slate-950 p-3 h-[26rem] overflow-auto"><Preview body={body} /></div></div>
                </div>
                <div className="flex flex-wrap items-end gap-3 border-t border-slate-800 pt-4">
                  <button onClick={saveDraft} disabled={busy} className="rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-800 px-4 py-2 text-sm">Save draft</button>
                  {draft.type === 'legal' && <div><label className="block text-xs text-slate-400 mb-1">Effective date (required)</label><input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} className={input} /></div>}
                  <button onClick={publish} disabled={busy} className={btn}>{draft.type === 'legal' ? 'Publish immutable version' : 'Publish'}</button>
                  <button onClick={discard} disabled={busy} className="text-red-300 text-sm px-2 hover:text-red-200">Discard draft</button>
                </div>
                {draft.type === 'legal' && <p className="text-xs text-amber-300/80">⚠ Publishing a legal version freezes it forever — it can never be edited or deleted. Corrections mean publishing a new version.</p>}
              </>
            ) : (
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 flex items-center justify-between">
                <div className="text-sm text-slate-300">{published.length ? `Current published: version ${published[0].version}. No draft in progress.` : 'No draft and nothing published.'}</div>
                {published.length > 0 && <button onClick={newVersion} disabled={busy} className={btn}>New version</button>}
              </div>
            )}

            {/* VERSION HISTORY */}
            {published.length > 0 && (
              <div className="rounded-xl border border-slate-800">
                <div className="bg-slate-900 px-4 py-2 text-sm font-medium text-slate-300">Version history</div>
                <table className="w-full text-sm">
                  <thead className="text-slate-500 text-left"><tr>{['Version', 'Effective', 'Published', 'By'].map((h) => <th key={h} className="px-4 py-1.5 font-medium">{h}</th>)}</tr></thead>
                  <tbody>
                    {published.map((v, i) => (
                      <tr key={v.id} className="border-t border-slate-800">
                        <td className="px-4 py-2 font-mono text-xs text-slate-200">{v.version}{i === 0 && <span className="ml-2 text-[10px] text-emerald-400">current</span>}</td>
                        <td className="px-4 py-2 text-xs text-slate-400">{v.effective_from ?? '—'}</td>
                        <td className="px-4 py-2 text-xs text-slate-400">{v.published_at ? new Date(v.published_at).toLocaleString('en-GB') : '—'}</td>
                        <td className="px-4 py-2 text-xs text-slate-500 font-mono">{v.created_by?.slice(0, 8) ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOperatorPage(ctx, { minRole: erMinRole('/superadmin/content') }); // country_manager+ (Support → 404)
  if (!gate.ok) return { notFound: true };
  return { props: { role: gate.op.role } };
};
