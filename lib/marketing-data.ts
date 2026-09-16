/**
 * File: lib/marketing-data.ts
 * ONE NUMBER FOR THE BADGE. That is now the whole of this file.
 *
 * It used to hold buildMotList and buildServiceList — the MOT-reminder list and the service-due
 * list, two screens of rows assembled per reason. Both were superseded on 2026-08-21 (440f53d)
 * by the board
 * (lib/marketing-board), which answers ONE row per car across every reason and is what the page has
 * rendered ever since. Neither builder had a single caller from that day on, and both were deleted
 * 2026-09-16 along with everything only they used: MarketingRow, MotList, ServiceList,
 * averageInvoicePennies, motPricePennies, ownerOf and the row `shape` helper.
 *
 * They were kept CORRECT while dead — the opt-out work went through both of them on 2026-09-11
 * (ecd07ad), three weeks after the last caller disappeared. That is the argument for removing them
 * rather than fixing them: somebody spent attention on a screen nobody
 * could reach, and the next person to find them would have revived surfaces carrying the defect the
 * board has just had fixed (they read every Vehicle as a customer's car and knew nothing about
 * stock). buildServiceList also still carried the per-car N+1 the board replaced with bulk reads.
 *
 * lib/marketing-lists holds the RULES and is pure. The board holds the queries.
 */

/**
 * ── THE BADGE IS THE BOARD'S OWN HOT COUNT ──────────────────────────────────────────────────────
 * It used to sum the unactioned totals of the two lists this file USED to build (now deleted, see
 * above), and both of those filtered
 * contacts by `reason: 'mot'` / `reason: 'service'` — values the column stopped holding on
 * 2026-08-21, when reason became the lead's own kind. The lookup would have matched nothing, every
 * car would have counted as unactioned, and the badge would simply never have fallen again.
 *
 * Reading the board fixes more than that defect: a badge computed from a different rule than the
 * screen it points at is a badge that disagrees with the screen. HOT is the honest number — "worth
 * ringing today" is what the board leads with, and a contact pushes a car to Later, so the badge
 * falls for the same reason the stack empties.
 *
 * HOT AND NOT YET RUNG, not raw hot: the stack is about the car's condition and the badge is about
 * outstanding work. An expired MOT is still expired after you have left a voicemail — the car stays
 * Hot, marked with what was done — but it is no longer something nobody has touched. See
 * lib/marketing-board::hotUnactioned.
 *
 * The cost is the board's: roughly a second on a 222-car fleet, once per page load. A cheaper
 * count would mean a second implementation of the hot rule, which is the drift this codebase
 * refuses everywhere else — and a fast wrong number is worse than a slow right one. If it becomes
 * a problem the fix is to make buildBoard cheaper, not to fork it.
 */
export async function marketingBadgeCount(groupId: string, now: Date): Promise<number> {
  const { buildBoard } = await import('@/lib/marketing-board');
  return (await buildBoard(groupId, now)).hotUnactioned;
}
