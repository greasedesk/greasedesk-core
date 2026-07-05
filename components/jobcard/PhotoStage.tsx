/**
 * File: components/jobcard/PhotoStage.tsx
 * Stage 1 photo capture for a job-card stage: pick/take a photo → client-side RESIZE (~1600px jpeg) →
 * presigned R2 PUT (bytes never touch our function) → commit the row → display. Mobile-first: camera
 * capture on phones, file-select on desktop. Deletable until the stage is locked. Free-form for now;
 * the slot checklist + guides land in Stage 2.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';

type Photo = { id: string; slot: string | null; label: string | null; url: string | null; uploadedAt: string; uploadedBy: string | null };
type Props = { jobCardId: string; stage: 'intake' | 'injob' | 'completion'; canEdit: boolean; locked: boolean; locale: string };

// Shrink a (huge) phone photo to a web-sane jpeg before upload. Respects EXIF orientation where supported.
async function resizeImage(file: File, max = 1600, quality = 0.8): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as any).catch(() => createImageBitmap(file));
  let { width, height } = bitmap;
  if (width > max || height > max) { const s = max / Math.max(width, height); width = Math.round(width * s); height = Math.round(height * s); }
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', quality));
}

export default function PhotoStage({ jobCardId, stage, canEdit, locked }: Props) {
  const { t } = useTranslation('jobcard');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/photos?jobCardId=${encodeURIComponent(jobCardId)}&stage=${stage}`, { cache: 'no-store' });
    if (res.ok) setPhotos((await res.json()).photos || []);
  }, [jobCardId, stage]);
  useEffect(() => { load(); }, [load]);

  async function onFiles(files: FileList | null) {
    if (!files || !files.length) return;
    setBusy(true); setErr(null);
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue;
        const blob = await resizeImage(file);
        const pres = await fetch('/api/photos/presign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, stage, slot: 'freeform', contentType: 'image/jpeg' }) });
        if (!pres.ok) throw new Error('presign');
        const { photoId, key, uploadUrl } = await pres.json();
        const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
        if (!put.ok) throw new Error('upload');
        await fetch('/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, stage, slot: 'freeform', photoId, key }) });
      }
      await load();
    } catch { setErr(t('photos.uploadError')); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function del(id: string) {
    if (!window.confirm(t('photos.confirmDelete'))) return;
    setBusy(true); setErr(null);
    const res = await fetch(`/api/photos/${id}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); setErr(d?.message || t('photos.deleteError')); }
    await load(); setBusy(false);
  }

  return (
    <div className="bg-surface border border-line rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-ink">{t('photos.title')} <span className="text-muted font-normal">({photos.length})</span></h3>
        {canEdit && !locked && (
          <>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
            <button onClick={() => fileRef.current?.click()} disabled={busy} className="text-sm bg-accent hover:bg-accent-hover text-white rounded-lg px-3 py-2 disabled:opacity-50">
              {busy ? t('photos.uploading') : t('photos.add')}
            </button>
          </>
        )}
      </div>
      {locked && <p className="text-xs text-muted mb-3">{t('photos.locked')}</p>}
      {err && <div className="bg-danger-soft text-danger rounded-lg p-2 text-sm mb-3">{err}</div>}

      {photos.length === 0 ? (
        <p className="text-sm text-muted">{t('photos.empty')}</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {photos.map((p) => (
            <div key={p.id} className="relative group aspect-square rounded-lg overflow-hidden border border-line bg-surface-muted">
              {p.url ? <img src={p.url} alt={p.label || 'photo'} className="w-full h-full object-cover" loading="lazy" /> : <div className="w-full h-full flex items-center justify-center text-muted text-xs">…</div>}
              {canEdit && !locked && (
                <button onClick={() => del(p.id)} aria-label={t('photos.delete')} className="absolute top-1 right-1 bg-black/60 text-white rounded-full w-6 h-6 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100">✕</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
