/**
 * File: lib/video-poster.ts
 * Client-only: derive a small JPEG poster frame from a video BLOB (library / input-capture paths —
 * the live recorder grabs its own frame ~1.2s in). Seeks to ~1s (a good frame, not the floor at the
 * end), draws ONE frame to a canvas → JPEG. Best-effort: any failure resolves null → placeholder tile.
 * Never decodes the whole clip; never touches the original bytes.
 */
export function posterFromVideoBlob(blob: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    let settled = false;
    let url = '';
    const finish = (out: Blob | null) => { if (settled) return; settled = true; try { URL.revokeObjectURL(url); } catch { /* noop */ } resolve(out); };
    try {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'metadata';
      url = URL.createObjectURL(blob);
      v.onloadedmetadata = () => { try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch { finish(null); } };
      v.onseeked = () => {
        try {
          if (!v.videoWidth) return finish(null);
          const scale = Math.min(1, 640 / v.videoWidth);
          const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const cx = c.getContext('2d'); if (!cx) return finish(null);
          cx.drawImage(v, 0, 0, w, h);
          c.toBlob((b) => finish(b), 'image/jpeg', 0.7);
        } catch { finish(null); }
      };
      v.onerror = () => finish(null);
      v.src = url;
      setTimeout(() => finish(null), 5000);
    } catch { resolve(null); }
  });
}
