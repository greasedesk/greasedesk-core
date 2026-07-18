/**
 * File: components/media/WalkaroundRecorder.tsx
 * THE walkaround recorder (desktop PhotoStage + phone job card — one implementation). Replaces
 * naive <input capture> video, which offers no control over resolution: a handset on 4K60 makes
 * ~500MB of 90 seconds, discovered only after the mechanic walks away. Here the encode is pinned
 * client-side: 720p ideal, ~2.5 Mbps video + 128 kbps audio (narration is evidence too) ≈ 28 MB
 * at the 90-second HARD CAP — recording stops itself at the cap, with a visible countdown.
 *
 * Codec: negotiated via isTypeSupported, H.264/MP4 preferred (iOS plays WebM badly; review
 * happens at the desk but MP4 travels best): mp4/avc1 → webm/h264 → webm/vp9 → webm.
 * Where MediaRecorder or getUserMedia is missing/refused (iOS <14.3, permission denied), callers
 * fall back to their existing <input capture> path via onUnavailable — the camera never dead-ends.
 *
 * Labels arrive as props: desktop reads them from 'jobcard', the phone from 'pwa' — the component
 * stays namespace-agnostic so neither surface loads a foreign i18n bundle.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export const MAX_SECONDS = 90;
const COUNTDOWN_FROM = 15; // the visible "wrap it up" window
const MIME_LADDER = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=h264,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
  for (const m of MIME_LADDER) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* next */ } }
  return null;
}

/** Can this browser run the recorder at all? False → caller uses its <input capture> fallback. */
export function canRecord(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && pickMimeType() !== null;
}

export type RecorderLabels = {
  start: string; stop: string; cancel: string; capNote: string;
  countdown: (s: number) => string; error: string;
};
type Props = {
  labels: RecorderLabels;
  // posterBlob: a JPEG frame grabbed ~1.2s INTO the clip (a good frame of the car — NOT the last
  // frame, which is the phone being lowered to the floor). null when the clip was too short to grab one.
  onCaptured: (blob: Blob, contentType: string, durationSeconds: number, posterBlob: Blob | null) => void;
  onClose: () => void;
  /** getUserMedia refused / recorder failed — caller shows its fallback path. */
  onUnavailable: () => void;
};

export default function WalkaroundRecorder({ labels, onCaptured, onClose, onUnavailable }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef(0);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const posterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const posterRef = useRef<Blob | null>(null);
  const doneRef = useRef<'captured' | 'cancelled' | null>(null);

  // Grab a poster frame from the live preview (best-effort — a missing poster just shows the placeholder).
  const capturePoster = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    try {
      const scale = Math.min(1, 640 / v.videoWidth);
      const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const cx = c.getContext('2d'); if (!cx) return;
      cx.drawImage(v, 0, 0, w, h);
      c.toBlob((b) => { if (b) posterRef.current = b; }, 'image/jpeg', 0.7);
    } catch { /* no poster → placeholder tile */ }
  }, []);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [failed, setFailed] = useState(false);

  const teardown = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    if (posterTimerRef.current) clearTimeout(posterTimerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Open the camera on mount; refusal (no permission, no camera) → the fallback path, not a wall.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: true,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
      } catch { if (!cancelled) { setFailed(true); } }
    })();
    return () => { cancelled = true; teardown(); };
  }, [teardown]);

  const stop = useCallback(() => {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
  }, []);

  function begin() {
    const stream = streamRef.current;
    const mime = pickMimeType();
    if (!stream || !mime) { setFailed(true); return; }
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
    } catch { setFailed(true); return; }
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      teardown();
      if (doneRef.current === 'cancelled') return;
      doneRef.current = 'captured';
      const base = mime.split(';')[0];
      const blob = new Blob(chunksRef.current, { type: base });
      const duration = Math.min(MAX_SECONDS, Math.round((Date.now() - startedAtRef.current) / 1000));
      onCaptured(blob, base, duration, posterRef.current);
    };
    startedAtRef.current = Date.now();
    posterRef.current = null;
    rec.start(3000); // timeslice: chunks land every 3s — an encoder hiccup loses seconds, not the take
    recRef.current = rec;
    setRecording(true);
    // Poster frame ~1.2s in — a good frame of the car, not the last frame (phone pointed at the floor).
    posterTimerRef.current = setTimeout(() => { if (recRef.current?.state === 'recording') capturePoster(); }, 1200);
    // THE HARD CAP — the recorder stops itself; the interval below is only the visible clock.
    stopTimerRef.current = setTimeout(stop, MAX_SECONDS * 1000);
  }

  useEffect(() => {
    if (!recording) return;
    const iv = setInterval(() => setElapsed(Math.min(MAX_SECONDS, Math.round((Date.now() - startedAtRef.current) / 1000))), 250);
    return () => clearInterval(iv);
  }, [recording]);

  function cancel() {
    doneRef.current = 'cancelled';
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
    teardown();
    onClose();
  }

  useEffect(() => { if (failed) { teardown(); onUnavailable(); } }, [failed, teardown, onUnavailable]);
  if (failed) return null;

  const remaining = MAX_SECONDS - elapsed;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col" role="dialog" aria-label={labels.start}>
      <video ref={videoRef} muted playsInline className="flex-1 min-h-0 w-full object-contain" />
      <div className="absolute top-0 inset-x-0 flex items-center justify-between p-3" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <span className={`text-sm font-bold tabular-nums rounded-full px-3 py-1 ${recording ? 'bg-black/60 text-white' : 'bg-black/40 text-white/70'}`}>
          {recording ? `${fmt(elapsed)} / ${fmt(MAX_SECONDS)}` : fmt(MAX_SECONDS)}
        </span>
        {/* The countdown the spec demands: impossible to miss for the last 15 seconds. */}
        {recording && remaining <= COUNTDOWN_FROM && (
          <span className="text-lg font-bold text-white bg-red-600 rounded-full px-4 py-1 animate-pulse tabular-nums">{labels.countdown(remaining)}</span>
        )}
      </div>
      <div className="p-4 pb-6 bg-black/80 flex flex-col items-center gap-2" style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}>
        {!recording && <p className="text-xs text-white/70 text-center">{labels.capNote}</p>}
        <div className="flex items-center gap-6">
          <button onClick={cancel} className="min-h-[48px] px-5 text-sm font-semibold text-white/80" aria-label={labels.cancel}>{labels.cancel}</button>
          {recording ? (
            <button onClick={stop} aria-label={labels.stop}
              className="w-16 h-16 rounded-full bg-red-600 border-4 border-white flex items-center justify-center">
              <span className="w-6 h-6 bg-white rounded-sm" />
            </button>
          ) : (
            <button onClick={begin} aria-label={labels.start}
              className="w-16 h-16 rounded-full bg-white border-4 border-red-600 flex items-center justify-center">
              <span className="w-10 h-10 bg-red-600 rounded-full" />
            </button>
          )}
          <span className="min-h-[48px] px-5" aria-hidden />
        </div>
      </div>
    </div>
  );
}
