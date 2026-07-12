/**
 * File: lib/image-resize.ts
 * THE client-side photo downscale (extracted VERBATIM from the desktop PhotoStage — desktop and
 * phone share one implementation): 1600px longest edge, JPEG q0.8, EXIF orientation respected
 * where supported. Runs AT CAPTURE, before the blob is held anywhere — a 12MB phone photo never
 * lives in memory longer than it has to and never enters a queue at full size. Client-only.
 */
export async function resizeImage(file: File | Blob, max = 1600, quality = 0.8): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as any).catch(() => createImageBitmap(file));
  let { width, height } = bitmap;
  if (width > max || height > max) { const s = max / Math.max(width, height); width = Math.round(width * s); height = Math.round(height * s); }
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', quality));
}
