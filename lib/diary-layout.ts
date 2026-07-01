/**
 * File: lib/diary-layout.ts
 * THE diary overlap-layout algorithm (pure, testable). Given time intervals (jobs on lifts), lays
 * them out as side-by-side sub-columns so overlapping jobs never visually collide — the standard
 * calendar concurrency layout.
 *
 *   1. sort by start, then end
 *   2. cluster into maximal transitively-overlapping groups (half-open: end==next start ≠ overlap)
 *   3. within a cluster, greedily assign each item to the first freed sub-column
 *   4. every item in a cluster shares width = 1/cols; left = col/cols
 *
 * Returns items in ORIGINAL order, each annotated with { col, cols } → leftFrac=col/cols, width=1/cols.
 */
export type Interval = { s: number; e: number }; // epoch ms, half-open [s, e)
export type Placed<T> = T & { col: number; cols: number };

export function layoutOverlap<T extends Interval>(items: T[]): Placed<T>[] {
  const nodes = items.map((it, i) => ({ it, i })).sort((a, b) => a.it.s - b.it.s || a.it.e - b.it.e);
  const out: Placed<T>[] = new Array(items.length);

  let cluster: Array<{ it: T; i: number }> = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    const colEnds: number[] = []; // last end time per sub-column
    const colOf: number[] = [];
    cluster.forEach((n, k) => {
      let col = colEnds.findIndex((end) => end <= n.it.s); // a column freed at/before this start
      if (col === -1) { col = colEnds.length; colEnds.push(n.it.e); } else { colEnds[col] = n.it.e; }
      colOf[k] = col;
    });
    const cols = colEnds.length; // = max concurrency in the cluster
    cluster.forEach((n, k) => { out[n.i] = { ...(n.it as any), col: colOf[k], cols }; });
    cluster = [];
  };

  for (const node of nodes) {
    if (node.it.s >= clusterEnd) { flush(); cluster = [node]; clusterEnd = node.it.e; }
    else { cluster.push(node); clusterEnd = Math.max(clusterEnd, node.it.e); }
  }
  flush();
  return out;
}
