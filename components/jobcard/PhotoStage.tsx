/**
 * File: components/jobcard/PhotoStage.tsx
 * Free-form photo + video capture for a job-card stage — THE one capture component, mounted on
 * Intake, In-Job and Completion alike (media keyed per stage: {group}/{card}/{stage}/…):
 * pick/take a photo → client-side RESIZE (~1600px jpeg) → presigned R2 PUT (bytes never touch our
 * function) → commit the row → display. Mobile-first: camera capture on phones, file-select on
 * desktop. Deletable until the stage is locked (manager override server-side).
 * VIDEO is the primary intake artefact (ruling 2026-07-13: a continuous unbroken take beats a
 * photo grid as dispute evidence — guided angle slots are dead, photos stay free-form for the
 * sharp stills a pan can't give). Capture goes through WalkaroundRecorder (720p/2.5Mbps/90s cap)
 * where the browser supports it; the file input remains for uploads + unsupported browsers.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { resizeImage } from '@/lib/image-resize';
import WalkaroundRecorder, { canRecord } from '@/components/media/WalkaroundRecorder';
import MediaGallery from '@/components/media/MediaGallery';
import { posterFromVideoBlob } from '@/lib/video-poster';

type Photo = { id: string; slot: string | null; label: string | null; mediaType: 'photo' | 'video'; durationSeconds: number | null; url: string | null; posterUrl: string | null; rotation: number; uploadedAt: string; uploadedBy: string | null };
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

// Downscale moved to the SHARED lib/image-resize (desktop + phone, one implementation).

export default function PhotoStage({ jobCardId, stage, canEdit, locked }: Props) {
  const { t } = useTranslation('jobcard');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
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

  // Video walkaround upload — same presign→PUT→commit pipe as photos, minus the resize (no
  // client-side transcoding). Desktop stays single-PUT (workshop LAN; the resumable multipart
  // lane exists for the phone's 4G, in sw.js). Recorder-made blobs are size-pinned (~28MB);
  // file-picked ones aren't, so >80 MB still gets a WARNING, not a block.
  // Poster: presign→PUT→commit with posterFor (attaches to the video row, no tile of its own).
  // Sequential AFTER the video commit here, so the row exists — best-effort (failure → placeholder).
  async function uploadPoster(posterBlob: Blob, videoPhotoId: string) {
    try {
      const pres = await fetch('/api/photos/presign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, stage, slot: 'poster', contentType: 'image/jpeg' }) });
      if (!pres.ok) return;
      const { photoId, key, uploadUrl } = await pres.json();
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: posterBlob });
      if (!put.ok) return;
      await fetch('/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, stage, slot: 'poster', photoId, key, posterFor: videoPhotoId }) });
    } catch { /* poster is best-effort → placeholder tile */ }
  }

  async function uploadVideoBlob(blob: Blob, contentType: string, durationSeconds: number | null, poster?: Blob | null) {
    setBusy(true); setErr(null); setWarn(null);
    try {
      if (blob.size > 80 * 1024 * 1024) setWarn(t('photos.videoSizeWarn', { mb: Math.round(blob.size / 1048576) }));
      const pres = await fetch('/api/photos/presign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, stage, slot: 'walkaround', contentType }) });
      if (!pres.ok) { const d = await pres.json().catch(() => ({})); throw new Error(d?.message || 'presign'); }
      const { photoId, key, uploadUrl } = await pres.json();
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: blob });
      if (!put.ok) throw new Error('upload');
      await fetch('/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, stage, slot: 'walkaround', photoId, key, durationSeconds }) });
      const posterBlob = poster ?? await posterFromVideoBlob(blob).catch(() => null);
      if (posterBlob) await uploadPoster(posterBlob, photoId);
      await load();
    } catch (e: any) { setErr(e?.message && e.message !== 'presign' && e.message !== 'upload' ? e.message : t('photos.uploadError')); }
    finally { setBusy(false); if (videoRef.current) videoRef.current.value = ''; }
  }

  async function onVideo(files: FileList | null) {
    if (!files || !files.length) return;
    const file = files[0];
    // Type from the browser; fall back to the filename extension (some Androids give an empty type).
    const byExt: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
    const contentType = file.type || byExt[(file.name.split('.').pop() || '').toLowerCase()] || 'video/mp4';
    const durationSeconds = await probeDuration(file);
    await uploadVideoBlob(file, contentType, durationSeconds); // poster derived from the blob inside
  }

  // Rotation: persist via PATCH (display interpretation, no re-encode), then reflect locally.
  async function rotate(id: string, rotation: number) {
    setPhotos((ps) => ps.map((p) => (p.id === id ? { ...p, rotation } : p)));
    try {
      const res = await fetch('/api/photos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photoId: id, rotation }) });
      if (!res.ok) await load(); // revert to server truth on failure
    } catch { await load(); }
  }

  async function del(id: string, mediaType: 'photo' | 'video') {
    // Unrecoverable once gone — always confirm, with media-specific wording.
    if (!window.confirm(t(mediaType === 'video' ? 'photos.confirmDeleteVideo' : 'photos.confirmDelete'))) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/photos/${id}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); setErr(d?.message || t('photos.deleteError')); }
      await load();
    } catch { setErr(t('photos.deleteError')); }
    finally { setBusy(false); }
  }

  return (
    <div className="bg-surface border border-line rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-ink">{t('photos.title')} <span className="text-muted font-normal">({photos.length})</span></h3>
        {canEdit && !locked && (
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
            <input ref={videoRef} type="file" accept="video/*" capture="environment" className="hidden" onChange={(e) => onVideo(e.target.files)} />
            {/* Video capture on every stage — the recorder (pinned 720p/2.5Mbps/90s) where the
                browser supports it; the file input remains as the fallback AND the upload route. */}
            <button onClick={() => (canRecord() ? setRecording(true) : videoRef.current?.click())} disabled={busy} className="text-sm bg-surface-muted border border-line text-ink rounded-lg px-3 py-2 disabled:opacity-50">
              {t('photos.videoAdd')}
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={busy} className="text-sm bg-accent hover:bg-accent-hover text-white rounded-lg px-3 py-2 disabled:opacity-50">
              {busy ? t('photos.uploading') : t('photos.add')}
            </button>
          </div>
        )}
      </div>
      {recording && (
        <WalkaroundRecorder
          labels={{
            start: t('photos.recStart'), stop: t('photos.recStop'), cancel: t('photos.recCancel'),
            capNote: t('photos.recCapNote'), countdown: (s) => t('photos.recCountdown', { s }), error: t('photos.recError'),
          }}
          onCaptured={(blob, contentType, duration, poster) => { setRecording(false); uploadVideoBlob(blob, contentType, duration, poster); }}
          onClose={() => setRecording(false)}
          onUnavailable={() => { setRecording(false); videoRef.current?.click(); }}
        />
      )}
      {locked && <p className="text-xs text-muted mb-3">{t('photos.locked')}</p>}
      {warn && <div className="bg-warn-soft text-warn rounded-lg p-2 text-sm mb-3">{warn}</div>}
      {err && <div className="bg-danger-soft text-danger rounded-lg p-2 text-sm mb-3">{err}</div>}

      {photos.length === 0 ? (
        <p className="text-sm text-muted">{t('photos.empty')}</p>
      ) : (
        // THE shared media surface (grid + lightbox + rotation) — identical on desktop and /m.
        <MediaGallery
          items={photos.map((p) => ({ id: p.id, mediaType: p.mediaType, url: p.url, posterUrl: p.posterUrl, rotation: p.rotation, durationSeconds: p.durationSeconds, label: p.label }))}
          onRotate={rotate}
          onDelete={del}
          canEdit={canEdit && !locked}
        />
      )}
    </div>
  );
}
