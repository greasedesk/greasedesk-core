/**
 * File: scripts/_backup-compare.mjs
 * DOES THE RESTORED COPY SAY WHAT THE SOURCE SAID? Pure, so backup-gate can drive it with planted
 * manifests instead of restoring a database to prove the comparison works.
 *
 * ── WHY A MANIFEST AND NOT A LIVE COMPARISON ────────────────────────────────────────────────────
 * The restored copy is last night's database, and the live one has moved on since — comparing the two
 * would fail every night for the honest reason. So the source states what it contained AT DUMP TIME,
 * in a manifest written beside the dump, and the restored copy must reproduce that exactly.
 *
 * ── WHAT A MISMATCH MEANS ───────────────────────────────────────────────────────────────────────
 * Not "the data changed" — the dump and the manifest were taken seconds apart from the same database.
 * It means the DUMP IS NOT A FAITHFUL COPY: a table missed, a restore that silently stopped, an
 * encryption or transfer that truncated. That is the only thing this check is for, and it is the
 * thing nobody finds out until they try to restore.
 */

/** Every problem, never the first — a run that reports one missing table and hides nine is worse than useless. */
export function compareManifests(source, restored) {
  const problems = [];
  if (!source || !restored) return { ok: false, problems: ['one of the two manifests is missing entirely'] };

  const srcTables = Object.keys(source.tables ?? {});
  const resTables = Object.keys(restored.tables ?? {});
  if (!srcTables.length) problems.push('the source manifest lists no tables at all');
  for (const t of srcTables) {
    if (!(t in (restored.tables ?? {}))) { problems.push(`table ${t} is in the source and NOT in the restored copy`); continue; }
    if (restored.tables[t] !== source.tables[t]) problems.push(`table ${t}: source ${source.tables[t]} rows, restored ${restored.tables[t]}`);
  }
  for (const t of resTables) {
    if (!(t in (source.tables ?? {}))) problems.push(`table ${t} is in the restored copy and NOT in the source`);
  }

  // THE JUNE GOLDEN, on the restored copy. Counts can match while the documents differ; the hash cannot.
  const a = source.juneGolden ?? {};
  const b = restored.juneGolden ?? {};
  for (const k of ['invoices', 'lines', 'grossPence', 'sha256']) {
    if (a[k] === undefined || b[k] === undefined) { problems.push(`the June golden is missing ${k} on one side`); continue; }
    if (a[k] !== b[k]) problems.push(`June golden ${k}: source ${a[k]}, restored ${b[k]}`);
  }

  if ((source.migrations ?? null) !== (restored.migrations ?? null)) {
    problems.push(`applied migrations: source ${source.migrations}, restored ${restored.migrations}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * A SIZE THAT COLLAPSED is a truncated dump even when it restores. Compared against the PREVIOUS
 * night rather than a fixed floor: the database only grows, and a number typed today is a number
 * nobody revisits. Silent on the first ever run — there is nothing to compare to, and inventing a
 * baseline would be the invented figure this project refuses.
 */
export function sizeVerdict(bytes, previousBytes, tolerance = 0.5) {
  if (!previousBytes) return { ok: true, note: 'no previous dump to compare against — first run' };
  const floor = Math.floor(previousBytes * tolerance);
  if (bytes < floor) return { ok: false, note: `${bytes} bytes is less than half of last night's ${previousBytes} — a truncated dump restores fine and holds nothing` };
  return { ok: true, note: `${bytes} bytes against last night's ${previousBytes}` };
}

/** Which retention prefix tonight's dump belongs under. Monthly wins over weekly, weekly over nightly. */
export function retentionPrefix(date) {
  if (date.getUTCDate() === 1) return 'monthly';
  if (date.getUTCDay() === 0) return 'weekly';
  return 'nightly';
}
