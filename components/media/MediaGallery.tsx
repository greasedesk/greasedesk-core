/**
 * File: components/media/MediaGallery.tsx
 * THE shared media surface for job-card photos/videos — used by BOTH the desktop card (PhotoStage)
 * and the phone (/m), so a uniform grid + lightbox + rotation render identically in both.
 *  - Uniform SQUARE tile grid (3 on a phone, 4 at sm+); photos and videos in one grid; a video tile
 *    shows its poster (or a placeholder) + a play badge + duration.
 *  - Tap → full-screen lightbox: swipe L/R between items, pinch-zoom on photos, video plays in place,
 *    a rotate control, tap-outside/✕ to dismiss.
 *  - ROTATION is a display interpretation (CSS transform), applied to BOTH the thumbnail and the
 *    lightbox. It NEVER re-encodes or rewrites the R2 bytes. At 90/270 the fit-box swaps its width/
 *    height constraints so a rotated (video especially) doesn't overflow or letterbox.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type MediaItem = {
  id: string;
  mediaType: 'photo' | 'video';
  url: string | null;
  posterUrl?: string | null;
  rotation?: number; // 0/90/180/270
  durationSeconds?: number | null;
  label?: string | null;
};

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const norm = (r?: number) => (((r ?? 0) % 360) + 360) % 360;

function PlayBadge() {
  return (
    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <span className="w-10 h-10 rounded-full bg-black/55 flex items-center justify-center">
        <svg viewBox="0 0 24 24" className="w-5 h-5 text-white ml-0.5" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
      </span>
    </span>
  );
}

/** Fit constraints for a rotated element: at 90/270 the viewport width/height swap. */
function fitStyle(rotation: number): React.CSSProperties {
  const swap = rotation === 90 || rotation === 270;
  return {
    maxWidth: swap ? '100vh' : '100vw',
    maxHeight: swap ? '100vw' : '100vh',
    transform: `rotate(${rotation}deg)`,
  };
}

export default function MediaGallery({ items, onRotate, onDelete, canEdit = false }: {
  items: MediaItem[];
  onRotate?: (id: string, rotation: number) => void;
  onDelete?: (id: string, mediaType: 'photo' | 'video') => void;
  canEdit?: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {items.map((m, i) => {
          const rot = norm(m.rotation);
          const thumb = m.mediaType === 'video' ? (m.posterUrl ?? null) : m.url;
          return (
            <button key={m.id} type="button" onClick={() => setOpen(i)}
              className="relative aspect-square rounded-lg overflow-hidden border border-line bg-surface-muted group">
              {thumb ? (
                <img src={thumb} alt={m.label || ''} loading="lazy"
                  className="w-full h-full object-cover" style={{ transform: `rotate(${rot}deg)` }} />
              ) : (
                // No poster (pre-poster video) → placeholder, never a black box.
                <span className="w-full h-full flex items-center justify-center bg-surface-muted text-muted">
                  <svg viewBox="0 0 24 24" className="w-8 h-8" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                </span>
              )}
              {m.mediaType === 'video' && <PlayBadge />}
              {m.mediaType === 'video' && m.durationSeconds != null && (
                <span className="absolute bottom-1 left-1 bg-black/60 text-white text-[10px] rounded px-1.5 py-0.5 pointer-events-none">{fmtDur(m.durationSeconds)}</span>
              )}
            </button>
          );
        })}
      </div>
      {open != null && items[open] && (
        <Lightbox items={items} index={open} setIndex={setOpen} onRotate={onRotate} onDelete={onDelete} canEdit={canEdit} />
      )}
    </>
  );
}

function Lightbox({ items, index, setIndex, onRotate, onDelete, canEdit }: {
  items: MediaItem[]; index: number; setIndex: (i: number | null) => void;
  onRotate?: (id: string, rotation: number) => void; onDelete?: (id: string, mediaType: 'photo' | 'video') => void; canEdit: boolean;
}) {
  const m = items[index];
  const rot = norm(m.rotation);
  // pinch-zoom state (photos only)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);

  const reset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);
  useEffect(() => { reset(); }, [index, reset]);

  const go = useCallback((d: number) => {
    const n = index + d;
    if (n >= 0 && n < items.length) setIndex(n);
  }, [index, items.length, setIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIndex(null);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, setIndex]);

  const isPhoto = m.mediaType === 'photo';

  function onPointerDown(e: React.PointerEvent) {
    if (!isPhoto) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) swipeRef.current = { x: e.clientX, y: e.clientY };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom };
      swipeRef.current = null;
    }
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!isPhoto || !pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId)!;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      setZoom(Math.max(1, Math.min(5, pinchRef.current.zoom * (dist / pinchRef.current.dist))));
    } else if (pointers.current.size === 1 && zoom > 1) {
      setPan((p) => ({ x: p.x + (e.clientX - prev.x), y: p.y + (e.clientY - prev.y) }));
    }
  }
  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchRef.current = null;
    // swipe navigation only when not zoomed
    if (isPhoto && zoom === 1 && swipeRef.current) {
      const dx = e.clientX - swipeRef.current.x, dy = e.clientY - swipeRef.current.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
      swipeRef.current = null;
    }
  }

  function rotate() {
    if (!onRotate) return;
    onRotate(m.id, (rot + 90) % 360);
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center select-none touch-none"
      onClick={(e) => { if (e.target === e.currentTarget) setIndex(null); }}>
      {/* Controls */}
      <div className="absolute top-0 inset-x-0 flex items-center justify-between p-3 z-10">
        <span className="text-white/80 text-sm">{index + 1} / {items.length}</span>
        <div className="flex items-center gap-2">
          {canEdit && onRotate && (
            <button onClick={rotate} aria-label="Rotate" className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6M20 10a8 8 0 00-15-3M4 14a8 8 0 0015 3" /></svg>
            </button>
          )}
          {canEdit && onDelete && (
            <button onClick={() => { onDelete(m.id, m.mediaType); setIndex(null); }} aria-label="Delete" className="w-10 h-10 rounded-full bg-white/15 hover:bg-danger text-white flex items-center justify-center text-lg">🗑</button>
          )}
          <button onClick={() => setIndex(null)} aria-label="Close" className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center text-xl">✕</button>
        </div>
      </div>

      {/* Prev / next (desktop) */}
      {index > 0 && <button onClick={() => go(-1)} aria-label="Previous" className="absolute left-2 z-10 w-11 h-11 rounded-full bg-white/15 hover:bg-white/25 text-white text-2xl hidden sm:flex items-center justify-center">‹</button>}
      {index < items.length - 1 && <button onClick={() => go(1)} aria-label="Next" className="absolute right-2 z-10 w-11 h-11 rounded-full bg-white/15 hover:bg-white/25 text-white text-2xl hidden sm:flex items-center justify-center">›</button>}

      {/* Media */}
      {isPhoto ? (
        <img
          src={m.url ?? ''} alt={m.label || ''} draggable={false}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          className="object-contain"
          style={{ ...fitStyle(rot), transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rot}deg)` }}
        />
      ) : (
        // Video plays in place; the fit-box swaps at 90/270 so a rotated clip fits, not overflows.
        <video src={m.url ?? ''} controls autoPlay playsInline className="object-contain bg-black" style={fitStyle(rot)} />
      )}
    </div>
  );
}
