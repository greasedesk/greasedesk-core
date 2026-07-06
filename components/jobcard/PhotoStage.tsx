/**
 * File: components/jobcard/PhotoStage.tsx
 * Stage 1 photo capture for a job-card stage: pick/take a photo → client-side RESIZE (~1600px jpeg) →
 * presigned R2 PUT (bytes never touch our function) → commit the row → display. Mobile-first: camera
 * capture on phones, file-select on desktop. Deletable until the stage is locked. Free-form for now;
 * the slot checklist + guides land in Stage 2.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';

type Photo = { id: string; slot: string | null; label: string | null; mediaType: 'photo' | 'video'; durationSeconds: number | null; url: string | null; uploadedAt: string; uploadedBy: string | null };
type Props = { jobCardId: string; stage: 'intake' | 'injob' | 'completion'; canEdit: boolean; locked: boolean; locale: string };

// Probe a video's duration client-side (metadata only — no decode). Best-effort; null on any failure.
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { const d = v.duration; URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? Math.round(d) : null); };
    v.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    v.src = url;
  });
}
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

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
  const [warn, setWarn] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);

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

  // Video walkaround — same presign→PUT→commit pipe as photos, minus the resize (no client-side
  // transcoding). >80 MB gets a WARNING, not a block (capture size can't be enforced on a phone).
  async function onVideo(files: FileList | null) {
    if (!files || !files.length) return;
    const file = files[0];
    setBusy(true); setErr(null); setWarn(null);
    try {
      if (file.size > 80 * 1024 * 1024) setWarn(t('photos.videoSizeWarn', { mb: Math.round(file.size / 1048576) }));
      // Type from the browser; fall back to the filename extension (some Androids give an empty type).
      const byExt: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
      const contentType = file.type || byExt[(file.name.split('.').pop() || '').toLowerCase()] || 'video/mp4';
      const durationSeconds = await probeDuration(file);
      const pres = await fetch('/api/photos/presign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, stage, slot: 'walkaround', contentType }) });
      if (!pres.ok) { const d = await pres.json().catch(() => ({})); throw new Error(d?.message || 'presign'); }
      const { photoId, key, uploadUrl } = await pres.json();
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
      if (!put.ok) throw new Error('upload');
      await fetch('/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, stage, slot: 'walkaround', photoId, key, durationSeconds }) });
      await load();
    } catch (e: any) { setErr(e?.message && e.message !== 'presign' && e.message !== 'upload' ? e.message : t('photos.uploadError')); }
    finally { setBusy(false); if (videoRef.current) videoRef.current.value = ''; }
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
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
            <input ref={videoRef} type="file" accept="video/*" capture="environment" className="hidden" onChange={(e) => onVideo(e.target.files)} />
            {stage === 'intake' && (
              <button onClick={() => videoRef.current?.click()} disabled={busy} className="text-sm bg-surface-muted border border-line text-ink rounded-lg px-3 py-2 disabled:opacity-50">
                {t('photos.videoAdd')}
              </button>
            )}
            <button onClick={() => fileRef.current?.click()} disabled={busy} className="text-sm bg-accent hover:bg-accent-hover text-white rounded-lg px-3 py-2 disabled:opacity-50">
              {busy ? t('photos.uploading') : t('photos.add')}
            </button>
          </div>
        )}
      </div>
      {locked && <p className="text-xs text-muted mb-3">{t('photos.locked')}</p>}
      {warn && <div className="bg-warn-soft text-warn rounded-lg p-2 text-sm mb-3">{warn}</div>}
      {err && <div className="bg-danger-soft text-danger rounded-lg p-2 text-sm mb-3">{err}</div>}

      {photos.length === 0 ? (
        <p className="text-sm text-muted">{t('photos.empty')}</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {photos.map((p) => (
            <div key={p.id} className={`relative group rounded-lg overflow-hidden border border-line bg-surface-muted ${p.mediaType === 'video' ? 'col-span-3 sm:col-span-4 aspect-video' : 'aspect-square'}`}>
              {!p.url ? (
                <div className="w-full h-full flex items-center justify-center text-muted text-xs">…</div>
              ) : p.mediaType === 'video' ? (
                // R2 honours range requests via the presigned GET → native streaming + seek, no transcoding.
                <video controls preload="metadata" src={p.url} className="w-full h-full object-contain bg-black" />
              ) : (
                <img src={p.url} alt={p.label || 'photo'} className="w-full h-full object-cover" loading="lazy" />
              )}
              {p.mediaType === 'video' && p.durationSeconds != null && (
                <span className="absolute bottom-1 left-1 bg-black/60 text-white text-[10px] rounded px-1.5 py-0.5 pointer-events-none">{fmtDur(p.durationSeconds)}</span>
              )}
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
