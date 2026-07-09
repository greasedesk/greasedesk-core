/**
 * File: pages/api/branding-logo.ts
 * POST { contentType } → presigned R2 PUT for the tenant logo (ADMIN only). Reuses the ONE R2
 * chokepoint (lib/r2); key is tenant-partitioned under {group}/branding/ — the /api/company PATCH
 * that commits the key validates that prefix. Image-only allowlist (png/jpeg). Returns a preview
 * GET url so the settings page can show the upload immediately.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { presignPut, presignGet, r2Configured } from '@/lib/r2';

const ALLOWED: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const vis = await getVisibility(user.id as string);
  if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can change the logo.' });
  if (!r2Configured()) return res.status(503).json({ message: 'File storage isn’t configured yet.' });

  const ct = String((req.body || {}).contentType || '').toLowerCase();
  const ext = ALLOWED[ct];
  if (!ext) return res.status(400).json({ message: 'The logo must be a PNG or JPEG image.' });

  const key = `${user.group_id}/branding/logo-${randomUUID()}.${ext}`;
  const uploadUrl = await presignPut(key, ct);
  const previewUrl = await presignGet(key);
  return res.status(200).json({ key, uploadUrl, previewUrl });
}
