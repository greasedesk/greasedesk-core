/**
 * File: pages/m/job/[id].tsx
 * The phone job card: customer · vehicle · work sold · notes · stage photos — plus the TWO
 * bay-side facts only the person at the car can capture: VIN (off the scuttle) and mileage (off
 * the dash), written through the EXISTING vehicle-facts path via the outbox (kind:'vehicle' —
 * the second proof the envelope generalises). NO MONEY on this surface, any role — the endpoint
 * carries none. Nothing else writes: no status, no notes, no clock. CACHE-FIRST like My Day — the card TEXT paints
 * instantly from IndexedDB in a dead-signal bay; photo thumbnails lazy-load live (their presigned
 * URLs expire, so they are never cached). VIN is the anchor grain a mechanic reads to a parts
 * factor while standing at the car: rendered BIG, tap-to-copy. Money arrives pre-shaped by the
 * server (financeVisibility) — this page renders what it was sent and nothing more.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { withI18n } from '@/lib/gssp-i18n';
import { cacheGet, cachePut } from '@/lib/pwa-idb';
import { resizeImage } from '@/lib/image-resize';
import { enqueuePhoto, enqueuePoster, enqueueVehicle, enqueueVideo, outboxAll, retryItem, discardItem, subscribeOutbox, OutboxItem } from '@/lib/pwa-outbox';
import { isValidVin, normaliseVinInput } from '@/lib/vin';
import OutboxStatus from '@/components/pwa/OutboxStatus';
import InstallBar from '@/components/pwa/InstallBar';
import WalkaroundRecorder, { canRecord } from '@/components/media/WalkaroundRecorder';
import { posterFromVideoBlob } from '@/lib/video-poster';
import MediaGallery from '@/components/media/MediaGallery';

type JobLine = { type: string; description: string; qty: string; hours: number | null };
type JobData = {
  id: string; status: string; isComeback: boolean;
  customer: { name: string; phone: string | null };
  vehicle: { registration: string; make: string | null; model: string | null; colour: string | null; vin: string | null; mileageIn: number | null };
  vinHint?: string | null;
  lines: JobLine[]; notes: string; invoice: { number: string; status: string } | null;
  currency: string; locale: string;
};
type StagePhoto = { id: string; stage: string; slot?: string | null; mediaType: 'photo' | 'video'; url: string | null; posterUrl?: string | null; rotation?: number; durationSeconds?: number | null; label: string | null };
// A capture living on THIS phone = an OUTBOX row (IndexedDB-first: an OS-killed app loses
// nothing). Thumbnails render from the queued blobs; failure is a STATE on the thumbnail
// (tap retries, explicit discard), never an error dialogue.
type LocalShot = { photoId: string; url: string; state: 'pending' | 'failed'; lastError: string | null; isVideo: boolean };

const STAGES = ['intake', 'injob', 'completion'] as const;

export default function MobileJobCard() {
  const { t } = useTranslation('pwa');
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const [job, setJob] = useState<JobData | null>(null);
  const [net, setNet] = useState<'loading' | 'fresh' | 'offline'>('loading');
  const [photos, setPhotos] = useState<StagePhoto[] | null>(null); // null = not loaded (offline/laggy) — text never waits on these
  const [copied, setCopied] = useState(false);
  const [shots, setShots] = useState<Record<string, LocalShot[]>>({}); // per-stage local captures
  // Bay-side fact editors. null = closed; string = the in-progress value.
  const [vinEdit, setVinEdit] = useState<string | null>(null);
  const [vinErr, setVinErr] = useState(false);
  const [milesEdit, setMilesEdit] = useState<string | null>(null);
  const [milesWarnLow, setMilesWarnLow] = useState(false); // lower-than-recorded needs a second, explicit tap
  const [vinPhotoLarge, setVinPhotoLarge] = useState<string | null>(null); // tapped-to-enlarge URL
  const [vinLocalUrl, setVinLocalUrl] = useState<string | null>(null); // the shot JUST taken — visible offline, before the drain
  const vinFileRef = useRef<HTMLInputElement | null>(null);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const videoFileRefs = useRef<Record<string, HTMLInputElement | null>>({}); // <input capture> fallback where the recorder can't run
  const libraryRefs = useRef<Record<string, HTMLInputElement | null>>({}); // NO-capture picker: media the app didn't take itself
  const [recordingStage, setRecordingStage] = useState<string | null>(null); // recorder overlay open for this stage
  const [videoErr, setVideoErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/pwa/job/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const fresh = (await res.json()) as JobData;
      setJob(fresh); setNet('fresh');
      cachePut(`job:${id}`, fresh);
    } catch { setNet('offline'); }
    // Photos: lazy + live only (presigned URLs expire — never cached). Failure is quiet.
    try {
      const pr = await fetch(`/api/photos?jobCardId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (pr.ok) setPhotos(((await pr.json()).photos ?? []) as StagePhoto[]);
    } catch { /* offline — text stands alone */ }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const cached = await cacheGet<JobData>(`job:${id}`);
      if (cached && !cancelled) setJob(cached.value); // instant paint from last-known
      await load();
    })();
    return () => { cancelled = true; };
  }, [id, load]);

  const refreshPhotos = useCallback(async () => {
    try {
      const pr = await fetch(`/api/photos?jobCardId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (pr.ok) setPhotos(((await pr.json()).photos ?? []) as StagePhoto[]);
    } catch { /* quiet */ }
  }, [id]);

  // Pending thumbnails = THIS card's outbox rows (IndexedDB) — they survive app kills and render
  // on reopen; when the drain sends one, its row vanishes and the server list takes over.
  const loadShots = useCallback(async () => {
    const items = (await outboxAll()).filter((i: OutboxItem) => i.jobCardId === id && (i.kind === 'photo' || i.kind === 'video') && i.stage && (i.blob || i.parts?.length));
    setShots((prev) => {
      for (const arr of Object.values(prev)) for (const sh of arr) URL.revokeObjectURL(sh.url);
      const next: Record<string, LocalShot[]> = {};
      for (const it of items) {
        // Videos are stored pre-sliced (WebKit post-mortem) — the preview recomposes the parts.
        const media = it.blob ?? new Blob(it.parts!, { type: it.contentType || 'video/mp4' });
        (next[it.stage!] ??= []).push({ photoId: it.id, url: URL.createObjectURL(media), state: it.state === 'failed' ? 'failed' : 'pending', lastError: it.lastError, isVideo: it.kind === 'video' });
      }
      return next;
    });
  }, [id]);

  useEffect(() => {
    if (!id) return;
    loadShots();
    const un = subscribeOutbox(() => { loadShots(); refreshPhotos(); }); // a drained item = a fresh server thumbnail
    return un;
  }, [id, loadShots, refreshPhotos]);

  // Shutter → downscale FIRST (full-size bytes never held) → IDB BEFORE any network → walk away.
  async function onCapture(stage: string, files: FileList | null) {
    if (!files || !files.length) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const blob = await resizeImage(file); // 1600px/q0.8 — the ONLY size that ever exists from here on
      await enqueuePhoto({ jobCardId: id, stage, blob, label: job?.vehicle.registration }); // durably parked, then the drain is invited
    }
    await loadShots();
    const el = fileRefs.current[stage]; if (el) el.value = '';
  }

  // Best-effort duration probe for library-picked videos (metadata only, no decode).
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

  // "Choose from phone" (ruling 2026-07-13): media the app didn't capture — native-camera
  // walkarounds, clips customers send, photos taken before the card existed. NO capture
  // attribute → the OS picker (camera or library, user's choice). Same pipeline, one hard
  // guard: a library video is uncapped (a 4K60 clip can be 500MB — the size explosion the
  // in-app recorder exists to prevent), so >200MB is refused HERE with a plain message,
  // before it ever enters the queue. Photos take the existing 1600px downscale; videos are
  // read to ArrayBuffer parts AT ENQUEUE (never a stored Blob — that's the whole pathology);
  // ≤20MB single PUT, over that the proven multipart lane. Same ids, same drain, same receipts.
  async function onLibraryPick(stage: string, files: FileList | null) {
    if (!files || !files.length) return;
    setVideoErr(null);
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const blob = await resizeImage(file);
        await enqueuePhoto({ jobCardId: id, stage, blob, label: job?.vehicle.registration });
      } else if (file.type.startsWith('video/')) {
        if (file.size > 200 * 1024 * 1024) { setVideoErr(t('videoTooLarge')); continue; }
        const byExt: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
        const contentType = file.type || byExt[(file.name.split('.').pop() || '').toLowerCase()] || 'video/mp4';
        const durationSeconds = await probeDuration(file);
        await enqueueVideoWithPoster(stage, file, contentType, durationSeconds);
      }
    }
    await loadShots();
    const el = libraryRefs.current[stage]; if (el) el.value = '';
  }

  // Rotate a committed photo/video — display interpretation, PATCH-persisted (no re-encode). Optimistic.
  async function rotateM(photoId: string, rotation: number) {
    setPhotos((ps) => (ps ? ps.map((p) => (p.id === photoId ? { ...p, rotation } : p)) : ps));
    try {
      const res = await fetch('/api/photos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photoId, rotation }) });
      if (!res.ok) await refreshPhotos();
    } catch { await refreshPhotos(); }
  }

  function retry(_stage: string, shot: LocalShot) { retryItem(shot.photoId); }
  function discard(shot: LocalShot) { discardItem(shot.photoId).then(loadShots); }
  // Video discard is confirmed: before it sends, this is the only copy in existence.
  function discardVideo(shot: LocalShot) {
    if (!window.confirm(t('videoDiscardConfirm'))) return;
    discardItem(shot.photoId).then(loadShots);
  }

  // SECOND COPY OFF THE QUEUE (ruling 2026-07-13, after a walkaround was lost to WebKit IDB
  // corruption): the recorded bytes auto-download at capture — zero taps. On iOS this lands in
  // FILES, not Photos: no browser API can write the photo library (verified against Apple's
  // docs; the share sheet's "Save Video" is user-initiated only). Files is not Photos, but it
  // is real. Best-effort: a blocked download never disturbs the capture flow.
  function saveSecondCopy(blob: Blob, contentType: string) {
    try {
      const ext = contentType.includes('webm') ? 'webm' : contentType.includes('quicktime') ? 'mov' : 'mp4';
      const ts = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const name = `walkaround-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}.${ext}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
    } catch { /* the queue copy still stands */ }
  }

  // Enqueue a video AND its poster: video on its lane, poster on the fast photo lane (posterFor links
  // it to the video row at commit). The recorder hands us a poster grabbed ~1.2s in; for library/
  // input-capture videos we derive one from the blob (seek ~1s — a good frame, not the floor).
  async function enqueueVideoWithPoster(stage: string, blob: Blob, contentType: string, durationSeconds: number | null, poster?: Blob | null) {
    const videoId = await enqueueVideo({ jobCardId: id, stage, blob, contentType, durationSeconds, label: job?.vehicle.registration });
    const posterBlob = poster ?? await posterFromVideoBlob(blob).catch(() => null);
    if (posterBlob) await enqueuePoster({ jobCardId: id, stage, blob: posterBlob, posterFor: videoId, label: job?.vehicle.registration });
  }

  // Walkaround video: recorder-constrained (720p / ~2.5 Mbps / 90s hard cap ≈ 28MB) → outbox
  // kind:'video' (sends IMMEDIATELY when online — the queue is for the bay with no bars, never
  // a resting place; photos still always go first).
  async function onVideoCaptured(stage: string, blob: Blob, contentType: string, durationSeconds: number, poster: Blob | null) {
    setRecordingStage(null);
    saveSecondCopy(blob, contentType);
    await enqueueVideoWithPoster(stage, blob, contentType, durationSeconds, poster);
    await loadShots();
  }

  // <input capture> fallback (no MediaRecorder / camera refused): size is UNCONTROLLED here —
  // a 4K60 handset can hand us hundreds of MB, so anything the multipart lane can't carry
  // (>200MB) is refused with a plain message instead of failing after the mechanic walks away.
  async function onVideoFile(stage: string, files: FileList | null) {
    if (!files || !files.length) return;
    const file = files[0];
    if (!file.type.startsWith('video/')) return;
    if (file.size > 200 * 1024 * 1024) { setVideoErr(t('videoTooLarge')); return; }
    setVideoErr(null);
    const byExt: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
    const contentType = file.type || byExt[(file.name.split('.').pop() || '').toLowerCase()] || 'video/mp4';
    saveSecondCopy(file, contentType); // iOS <input capture> videos aren't saved to Photos either
    await enqueueVideoWithPoster(stage, file, contentType, null);
    await loadShots();
    const el = videoFileRefs.current[stage]; if (el) el.value = '';
  }

  // VIN gate: 17 chars, no I/O/Q, AND the ISO position-9 check digit (lib/vin — one chokepoint,
  // confirmed against real vehicles and a 50/53 pass rate on the existing book). A VIN that fails
  // is a read error or a typo — never saved.
  const applyLocal = (patch: Partial<JobData['vehicle']>) => {
    setJob((j) => {
      if (!j) return j;
      const next = { ...j, vehicle: { ...j.vehicle, ...patch } };
      cachePut(`job:${id}`, next); // the bay is often offline — the cached card shows what was queued
      return next;
    });
  };

  async function saveVin() {
    const vin = normaliseVinInput(vinEdit ?? '');
    if (!isValidVin(vin)) { setVinErr(true); return; }
    setVinErr(false); setVinEdit(null);
    applyLocal({ vin });
    await enqueueVehicle({ jobCardId: id, vin }); // rides the outbox — a bay has no signal
  }

  async function saveMiles() {
    const n = Number((milesEdit ?? '').replace(/[^\d]/g, ''));
    if (!Number.isInteger(n) || n < 0 || n > 999999) return;
    const last = job?.vehicle.mileageIn;
    if (last != null && n < last && !milesWarnLow) { setMilesWarnLow(true); return; } // warn once, save on the second, deliberate tap
    setMilesWarnLow(false); setMilesEdit(null);
    applyLocal({ mileageIn: n });
    await enqueueVehicle({ jobCardId: id, mileageIn: n });
  }

  // Photograph the VIN plate → type it from the photo (what the floor does today with a camera
  // roll — it just lands on the right card). Rides the outbox: kind:'photo', stage intake,
  // slot 'vin' — the existing pipe, no new plumbing.
  async function onVinPhoto(files: FileList | null) {
    if (!files || !files.length) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) return;
    const blob = await resizeImage(file);
    setVinLocalUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); }); // beside the input immediately — a bay has no signal
    await enqueuePhoto({ jobCardId: id, stage: 'intake', blob, slot: 'vin', label: job?.vehicle.registration });
    await loadShots();
    if (vinFileRef.current) vinFileRef.current.value = '';
    if (vinEdit == null) setVinEdit(job?.vehicle.vin ?? ''); // open the input — the typing happens against the photo
  }

  async function copyVin(vin: string) {
    try {
      await navigator.clipboard.writeText(vin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard denied — the VIN is still on screen */ }
  }

  return (
    <>
      <Head>
        <title>{job?.vehicle.registration ?? t('title')} - GreaseDesk</title>
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#0B1E3B" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>
      <div className="min-h-screen" style={{ background: 'var(--content-bg)' }}>
        <header className="px-4 py-3" style={{ background: '#0B1E3B', color: '#FFFFFF', paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
          <div className="flex items-center gap-3">
            <Link href="/m" aria-label={t('back')} className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-lg" style={{ background: '#1C3257' }}>←</Link>
            <div className="min-w-0">
              <h1 className="text-base font-bold truncate">{job?.vehicle.registration ?? '…'}</h1>
              <p className="text-xs" style={{ color: '#C7D2E1' }}>
                {net === 'offline' ? t('offline') : net === 'fresh' ? t('updated') : t('updating')}
              </p>
            </div>
            {job && (
              <span className="ml-auto shrink-0 text-[11px] font-semibold rounded-full px-2 py-1" style={{ background: '#1C3257', color: '#FFFFFF' }}>
                {t(`status.${job.status}`)}
              </span>
            )}
          </div>
        </header>
        <OutboxStatus />
        <InstallBar />

        <main className="p-3 space-y-3 pb-8">
          {job == null ? (
            <p className="text-sm text-muted p-2">{net === 'offline' ? t('offlineNoCache') : t('updating')}</p>
          ) : (
            <>
              {/* Vehicle — VIN is the hero: big, tap-to-copy (parts-factor-on-the-phone grain). */}
              <section className="bg-surface border border-line rounded-xl p-4">
                <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">{t('vehicle')}</h2>
                <p className="text-sm text-ink">{[job.vehicle.make, job.vehicle.model].filter(Boolean).join(' ') || '—'}{job.vehicle.colour ? ` · ${job.vehicle.colour}` : ''}</p>

                {/* Mileage — the dash is in front of the mechanic; a LOWER value than recorded
                    needs a second, explicit tap (fat-fingered 40,000 into a 140,000 car corrupts
                    history quietly). */}
                {milesEdit == null ? (
                  <p className="text-sm text-muted mt-0.5 min-h-[44px] flex items-center gap-2">
                    <span>{t('mileage')}: {job.vehicle.mileageIn != null ? job.vehicle.mileageIn.toLocaleString('en-GB') : '—'}</span>
                    <button onClick={() => { setMilesEdit(job.vehicle.mileageIn != null ? String(job.vehicle.mileageIn) : ''); setMilesWarnLow(false); }} className="text-accent underline text-sm min-h-[44px]">{job.vehicle.mileageIn != null ? t('edit') : t('addMileage')}</button>
                  </p>
                ) : (
                  <div className="mt-2">
                    <input
                      type="text" inputMode="numeric" autoComplete="off"
                      value={milesEdit}
                      onChange={(e) => { setMilesEdit(e.target.value.replace(/[^\d]/g, '')); setMilesWarnLow(false); }}
                      aria-label={t('mileage')}
                      className="w-full min-h-[48px] bg-surface border border-line rounded-lg px-3 text-base text-ink tabular-nums"
                    />
                    {milesWarnLow && <p className="text-xs text-warn mt-1">{t('mileageLowWarn', { last: (job.vehicle.mileageIn ?? 0).toLocaleString('en-GB') })}</p>}
                    <div className="flex gap-2 mt-2">
                      <button onClick={saveMiles} className="min-h-[44px] rounded-lg px-4 text-sm font-semibold bg-accent text-white">{milesWarnLow ? t('saveAnyway') : t('save')}</button>
                      <button onClick={() => { setMilesEdit(null); setMilesWarnLow(false); }} className="min-h-[44px] rounded-lg px-4 text-sm text-muted">{t('cancel')}</button>
                    </div>
                  </div>
                )}

                {/* VIN — the scuttle is in front of the mechanic. Uppercase keyboard, no autocorrect;
                    strict 17 chars, no I/O/Q. */}
                {(() => {
                  // The VIN reference photo: local queue first (dead-signal bay), else the newest
                  // server copy. Tap to enlarge — the mechanic types while looking at it.
                  const serverVin = (photos ?? []).filter((p2) => p2.slot === 'vin').slice(-1);
                  const vinShotUrl = vinLocalUrl ?? serverVin[0]?.url ?? null; // just-taken beats server (offline-first)
                  return (
                    <>
                      {vinEdit != null ? (
                  <div className="mt-3">
                    <div className="flex items-start gap-2">
                      {vinShotUrl && (
                        <button onClick={() => setVinPhotoLarge(vinShotUrl)} className="shrink-0" aria-label={t('vinPhotoEnlarge')}>
                          <img src={vinShotUrl} alt="" className="w-20 h-20 object-cover rounded-lg border border-line" />
                        </button>
                      )}
                      <div className="min-w-0 flex-1">
                        <input
                          type="text" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" maxLength={17}
                          value={vinEdit}
                          onChange={(e) => { setVinEdit(e.target.value.toUpperCase()); setVinErr(false); }}
                          placeholder={t('vinPlaceholder')}
                          aria-label={t('vin')}
                          className="w-full min-h-[48px] bg-surface border border-line rounded-lg px-3 text-base font-bold tracking-wider text-ink"
                        />
                        {vinErr && <p className="text-xs text-danger mt-1">{t('vinInvalid')}</p>}
                        {job.vinHint && <p className="text-xs text-muted mt-1">{job.vinHint}</p>}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <button onClick={saveVin} className="min-h-[44px] rounded-lg px-4 text-sm font-semibold bg-accent text-white">{t('save')}</button>
                      <button onClick={() => vinFileRef.current?.click()} className="min-h-[44px] rounded-lg px-4 text-sm font-semibold border border-accent text-accent">{t('vinPhotoAdd')}</button>
                      <button onClick={() => { setVinEdit(null); setVinErr(false); }} className="min-h-[44px] rounded-lg px-4 text-sm text-muted">{t('cancel')}</button>
                    </div>
                    <input ref={vinFileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onVinPhoto(e.target.files)} />
                  </div>
                ) : job.vehicle.vin ? (
                  <div className="mt-3">
                    <button
                      onClick={() => copyVin(job.vehicle.vin!)}
                      className="w-full text-left bg-surface-muted border border-line rounded-lg p-3 min-h-[56px]"
                      aria-label={t('copyVin')}
                    >
                      <span className="block text-[10px] font-semibold text-muted uppercase tracking-wide">{t('vin')}</span>
                      <span className="block text-lg font-bold text-ink tracking-wider break-all tabular-nums">{job.vehicle.vin}</span>
                      <span className="block text-xs mt-0.5" style={{ color: copied ? 'var(--ok)' : 'var(--accent)' }}>{copied ? t('copied') : t('copyVin')}</span>
                    </button>
                    <button onClick={() => setVinEdit(job.vehicle.vin ?? '')} className="text-accent underline text-sm min-h-[44px]">{t('editVin')}</button>
                  </div>
                ) : (
                  <button onClick={() => setVinEdit('')} className="mt-3 w-full text-left bg-surface-muted border border-line rounded-lg p-3 min-h-[56px]">
                    <span className="block text-[10px] font-semibold text-muted uppercase tracking-wide">{t('vin')}</span>
                    <span className="block text-sm text-accent underline">{t('addVin')}</span>
                    {job.vinHint && <span className="block text-xs text-muted mt-0.5">{job.vinHint}</span>}
                  </button>
                )}
                    </>
                  );
                })()}
              </section>

              {/* Tap-to-enlarge VIN photo overlay — tap anywhere to close. */}
              {vinPhotoLarge && (
                <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-2" onClick={() => setVinPhotoLarge(null)}>
                  <img src={vinPhotoLarge} alt="" className="max-w-full max-h-full rounded-lg" />
                </div>
              )}

              {/* The walkaround recorder — constrained capture (never <input capture>'s 4K surprise). */}
              {recordingStage && (
                <WalkaroundRecorder
                  labels={{
                    start: t('recStart'), stop: t('recStop'), cancel: t('cancel'),
                    capNote: t('recCapNote'), countdown: (s) => t('recCountdown', { s }), error: t('recError'),
                  }}
                  onCaptured={(blob, contentType, duration, poster) => onVideoCaptured(recordingStage, blob, contentType, duration, poster)}
                  onClose={() => setRecordingStage(null)}
                  onUnavailable={() => { const st2 = recordingStage; setRecordingStage(null); videoFileRefs.current[st2!]?.click(); }}
                />
              )}

              {/* Customer */}
              <section className="bg-surface border border-line rounded-xl p-4">
                <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">{t('customer')}</h2>
                <p className="text-sm font-medium text-ink">{job.customer.name}</p>
                {job.customer.phone && <a href={`tel:${job.customer.phone}`} className="inline-block mt-1 text-sm text-accent underline min-h-[44px] leading-[44px]">{job.customer.phone}</a>}
              </section>

              {/* Work sold — read-only lines; prices only if the server sent them. */}
              <section className="bg-surface border border-line rounded-xl p-4">
                <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">{t('workSold')}</h2>
                {job.isComeback && <p className="text-xs font-semibold text-warn mb-2">{t('warrantyJob')}</p>}
                {job.lines.length === 0 ? (
                  <p className="text-sm text-muted">{t('noLines')}</p>
                ) : (
                  <ul className="divide-y divide-line/60">
                    {job.lines.map((l, i) => (
                      <li key={i} className="py-2 flex items-start gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-ink whitespace-pre-line">{l.description || '—'}</span>
                          <span className="block text-xs text-muted">
                            {l.type === 'labour' ? t('lineHours', { hours: l.qty }) : t('lineQty', { qty: l.qty })}
                            {l.hours != null ? ` · ${t('lineHours', { hours: String(l.hours) })}` : ''}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {job.invoice && <p className="text-xs text-muted mt-2">{t('invoiceLabel', { number: job.invoice.number })}</p>}
              </section>

              {/* Notes */}
              {job.notes && (
                <section className="bg-surface border border-line rounded-xl p-4">
                  <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">{t('notes')}</h2>
                  <p className="text-sm text-ink whitespace-pre-line">{job.notes}</p>
                </section>
              )}

              {/* Stage media — walkaround VIDEO is the primary intake artefact (a continuous
                  unbroken take can't be accused of cropping damage out of frame); photos stay
                  free-form for the sharp deliberate stills a pan can't give (VIN, mileage,
                  damage close-ups). */}
              {STAGES.map((stage) => {
                const st = (photos ?? []).filter((p) => p.stage === stage);
                const mine = shots[stage] ?? [];
                return (
                  <section key={stage} className="bg-surface border border-line rounded-xl p-4">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <h2 className="text-xs font-semibold text-muted uppercase tracking-wide">{t(`photoStage.${stage}`)} {photos != null && <span className="text-muted font-normal">({st.length + mine.length})</span>}</h2>
                      <div className="flex gap-2">
                        <input ref={(el) => { videoFileRefs.current[stage] = el; }} type="file" accept="video/*" capture="environment" className="hidden" onChange={(e) => onVideoFile(stage, e.target.files)} />
                        <button
                          onClick={() => (canRecord() ? setRecordingStage(stage) : videoFileRefs.current[stage]?.click())}
                          className={`min-h-[44px] text-sm font-semibold rounded-lg px-3 ${stage === 'intake' ? 'bg-accent text-white' : 'border border-accent text-accent'}`}
                          aria-label={t('recordWalkaround')}>
                          {t('recordWalkaround')}
                        </button>
                        {/* Tap 2 of two: opens the NATIVE camera directly — no picker modal, no confirm. */}
                        <input ref={(el) => { fileRefs.current[stage] = el; }} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => onCapture(stage, e.target.files)} />
                        <button onClick={() => fileRefs.current[stage]?.click()} className={`min-h-[44px] text-sm font-semibold rounded-lg px-3 ${stage === 'intake' ? 'border border-accent text-accent' : 'bg-accent text-white'}`} aria-label={t('addPhoto')}>
                          {t('addPhoto')}
                        </button>
                        {/* NO capture attribute → the OS picker (library or camera, user's choice):
                            the route for media the app didn't take itself. */}
                        <input ref={(el) => { libraryRefs.current[stage] = el; }} type="file" accept="image/*,video/*" multiple className="hidden" onChange={(e) => onLibraryPick(stage, e.target.files)} />
                        <button onClick={() => libraryRefs.current[stage]?.click()} className="min-h-[44px] text-sm font-semibold rounded-lg px-3 border border-line text-ink" aria-label={t('choosePhone')}>
                          {t('choosePhone')}
                        </button>
                      </div>
                    </div>
                    {videoErr && <p className="text-xs text-danger mb-2">{videoErr}</p>}
                    {(photos == null && mine.length === 0) ? (
                      <p className="text-xs text-muted">{net === 'offline' ? t('photosOffline') : t('updating')}</p>
                    ) : (st.length === 0 && mine.length === 0) ? (
                      <p className="text-xs text-muted">{t('noPhotos')}</p>
                    ) : (
                      <div className="space-y-2">
                        {mine.length > 0 && (
                        <div className="grid grid-cols-3 gap-2">
                        {mine.map((sh) => sh.isVideo ? (
                          /* The queued walkaround plays FROM THE PHONE (the blob is right here) —
                             reviewable before it ever sends. Retry is its own control (the video
                             surface belongs to the player). Discard exists in EVERY state (ruling
                             2026-07-13: nothing sits in the queue the user can't end) — confirmed,
                             because pre-send it destroys the only copy. */
                          <span key={sh.photoId} className="relative block col-span-3">
                            <video src={sh.url} className={`w-full h-auto max-h-[70vh] object-contain rounded-lg border bg-black ${sh.state === 'failed' ? 'border-danger' : 'border-line'}`} preload="metadata" controls playsInline />
                            {sh.state === 'failed' ? (
                              sh.lastError?.includes('"code":"unrecoverable"') ? (
                                <span className="block mt-1 w-full text-center text-[11px] font-semibold rounded px-1 py-1 bg-danger-soft text-danger">{t('videoUnrecoverable')}</span>
                              ) : (
                                <button onClick={() => retry(stage, sh)} className="mt-1 w-full text-center text-[11px] font-semibold rounded px-1 py-1 bg-danger-soft text-danger" aria-label={t('sendFailedRetry')}>
                                  {t('sendFailedRetry')}
                                </button>
                              )
                            ) : (
                              <span className="block mt-1 w-full text-center text-[11px] font-semibold rounded px-1 py-1 bg-surface/90 text-muted">{t('videoPending')}</span>
                            )}
                            <button onClick={() => discardVideo(sh)} aria-label={t('discardVideo')} className="absolute top-1 right-1 w-7 h-7 rounded-full bg-danger text-white text-xs font-bold">✕</button>
                          </span>
                        ) : (
                          <span key={sh.photoId} className="relative block">
                            <button onClick={() => sh.state === 'failed' && retry(stage, sh)} className="block w-full" aria-label={sh.state === 'failed' ? t('sendFailedRetry') : t('pendingSend')}>
                              <img src={sh.url} alt="" className={`w-full aspect-square object-cover rounded-lg border ${sh.state === 'failed' ? 'border-danger' : 'border-line'} ${sh.state === 'pending' ? 'opacity-70' : ''}`} />
                              <span className={`absolute bottom-1 left-1 right-1 text-center text-[10px] font-semibold rounded px-1 py-0.5 ${sh.state === 'failed' ? 'bg-danger-soft text-danger' : 'bg-surface/90 text-muted'}`}>
                                {sh.state === 'failed' ? t('sendFailedRetry') : t('pendingSend')}
                              </span>
                            </button>
                            {sh.state === 'failed' && (
                              /* Explicit discard — a permanently failed photo never vanishes on its own. */
                              <button onClick={() => discard(sh)} aria-label={t('discard')} className="absolute top-1 right-1 w-7 h-7 rounded-full bg-danger text-white text-xs font-bold">✕</button>
                            )}
                          </span>
                        ))}
                        </div>
                        )}
                        {/* Committed media — THE shared grid + lightbox + rotation (same as desktop). */}
                        {st.length > 0 && (
                          <MediaGallery
                            items={st.map((p) => ({ id: p.id, mediaType: p.mediaType, url: p.url, posterUrl: p.posterUrl, rotation: p.rotation, durationSeconds: p.durationSeconds, label: p.label }))}
                            onRotate={rotateM}
                            canEdit
                          />
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </>
          )}
        </main>
      </div>
    </>
  );
}

export const getServerSideProps = withI18n(['pwa'])(async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) {
    return { redirect: { destination: `/admin/login?callbackUrl=${encodeURIComponent(ctx.resolvedUrl)}`, permanent: false } };
  }
  return { props: {} };
});
