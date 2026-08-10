/**
 * File: components/layout/DemoBanner.tsx
 * Says two things a demo user needs to know: this data is invented, and it is going away.
 *
 * ── IT SAYS "INVENTED" EVEN WHEN THERE IS NO DEADLINE ───────────────────────────────────────────
 * The long-lived sales demo never expires, and it is the one somebody is most likely to mistake for
 * a real garage — it is being shown to them across a desk. So the "this is a demo" half is
 * unconditional and the countdown half is the part that appears near the end.
 *
 * ── THE COUNTDOWN COMES FROM THE SAME RULE THE CRON DELETES ON ──────────────────────────────────
 * lib/demo-lifecycle, via /api/demo-status. A banner counting to a different instant than the purge
 * would be the exact failure the chokepoint exists to prevent.
 */
import React, { useEffect, useState } from 'react';

type Status = { isDemo: boolean; phase: 'none' | 'live' | 'warning' | 'final' | 'expired'; daysLeft: number | null };

export default function DemoBanner() {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/demo-status', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setS(d); })
      .catch(() => { /* a banner is not worth breaking a page over */ });
    return () => { alive = false; };
  }, []);

  if (!s?.isDemo) return null;

  const ending = s.phase === 'warning' || s.phase === 'final' || s.phase === 'expired';
  const d = s.daysLeft ?? 0;
  const when = s.phase === 'expired' ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;

  return (
    <div
      className={`px-4 sm:px-6 lg:px-8 py-2 text-sm border-b ${ending ? 'bg-warn-soft border-warn text-warn' : 'bg-accent-soft border-accent/30 text-accent'}`}
      data-testid="demo-banner"
      data-phase={s.phase}
    >
      <span className="font-semibold">Demo garage</span>
      {' — every customer, car and invoice here is invented.'}
      {ending && (
        <>
          {' '}
          <span className="font-semibold">It will be deleted {when}.</span>
          {' Nothing in it is real, so there is nothing to export — start a trial when you want to '}
          <span className="font-medium">begin with your own work</span>
          {'.'}
        </>
      )}
    </div>
  );
}
