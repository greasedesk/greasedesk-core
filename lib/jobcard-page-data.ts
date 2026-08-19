/**
 * File: lib/jobcard-page-data.ts
 * THE one builder for a job card's full workspace props — used by BOTH the standalone card page's
 * getServerSideProps AND /api/jobcard-pane (the diary's inline-card pane). One data shape, one
 * JobCardWorkspace component, so the inline card can never drift from the routed page.
 * Returns null when the card isn't visible to the caller. All values are JSON-serialisable.
 *
 * Queries run in three concurrency waves (not one-by-one) — the DB round trip is the dominant
 * cost of a card open, so depth matters: wave 1 = everything keyed on the params alone,
 * wave 2 = the card row (needs the visibility filter), wave 3 = everything keyed on the row.
 */
import { intakeItemStates, DIAG_SCAN_SLOT } from '@/lib/intake-items';
import { openDueItemsForVehicle, reportStatus, closureOffersForCard } from '@/lib/due-items';
import { noShowHistory } from '@/lib/no-show';
import { prisma } from '@/lib/db';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite, canAccessSite } from '@/lib/admin-guard';
import { getTenantPermissions, canEditEstimate, canIssueInvoice, financeVisibility } from '@/lib/permissions';
import { canEditInvoice, invoiceTotals } from '@/lib/invoice';
import { offersPayLink } from '@/lib/invoice-pay-link';
import { refundState } from '@/lib/invoice-refund-state';
import { getTenantVat } from '@/lib/tenant-vat';
import { getCurrentOwnerId } from '@/lib/vehicle-identity';
import { conversationForJobCard, reachabilityForJobCard, ensureThreadToken } from '@/lib/message-threads';
import { resolveTenantProfile } from '@/lib/locale-profiles';
import { computeTabs } from '@/lib/jobcard-tabs';
import { parseBreaks } from '@/lib/occupancy';
import type { JobStatus, StageKey } from '@/lib/jobcard-status';
import type { EstimateLine, CatalogueLite, FixedServiceLite, TierLite } from '@/components/jobcard/EstimateBuilder';
import type { PromoLite } from '@/lib/promo';
import type { CardBooking } from '@/components/jobcard/JobCardWorkspace';
import type { AuditEvent } from '@/components/jobcard/JobCardAudit';
import { isBookedCard } from '@/lib/jobcard-status';
import { quotePriceUnconfirmed } from '@/lib/quotes-list';
import { refuseQuoteSend } from '@/lib/quote-acceptance';
import { acceptanceProvenance, PROVENANCE_LABEL, PROVENANCE_SENTENCE } from '@/lib/acceptance-provenance';

export async function buildJobCardPageProps(userId: string, groupId: string, cardId: string) {
  // Wave 1 — ONLY user/group-scoped queries (never keyed to the requested card). Defence-in-depth
  // (ruling 2026-07-14): the invoice + audit reads were previously fired here on the cardId PARAM,
  // before the access check — so a cross-tenant card's invoice/audit rows were read into memory and
  // discarded. They now wait for Wave 2 (ownership proven). No cross-tenant row is read, ever.
  const [vis, perms, vat, [catalogueRows, tierRows, promoRows]] = await Promise.all([
    getVisibility(userId),
    getTenantPermissions(groupId),
    getTenantVat(groupId),
    Promise.all([
      prisma.catalogueItem.findMany({
        where: { group_id: groupId, active: true },
        orderBy: { code: 'asc' },
        select: {
          id: true, code: true, title: true, name: true, item_type: true, unit_cost: true, unit_price: true, vat_rate: true, base_price_ex_vat: true, labour_hours: true,
          components: { orderBy: { position: 'asc' }, select: { description: true, qty: true, unit_cost_ex_vat: true } },
          tier_prices: { select: { tier_id: true, price_ex_vat: true } },
        },
      }) as Promise<any[]>,
      prisma.serviceTier.findMany({ where: { group_id: groupId, active: true }, orderBy: [{ position: 'asc' }, { created_at: 'asc' }], select: { id: true, name: true } }) as Promise<any[]>,
      prisma.promo.findMany({ where: { group_id: groupId, active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, label: true, promo_type: true, amount: true, targets: { select: { item: { select: { id: true, title: true, name: true } } } } } }) as Promise<any[]>,
    ]),
  ]);

  // Wave 2 — the card row. The site filter IS the access control; nothing card-keyed runs before it.
  const row = (await prisma.jobCard.findFirst({
    where: { id: cardId, site_id: { in: vis.siteIds } },
    include: {
      customer: { select: { name: true, phone: true, email: true } },
      // The intake affirmative ("checked, nothing found") — one half of the findings done-state.
      site: { select: { intake_prompt_findings: true, intake_prompt_mileage_vin: true, intake_prompt_walkaround: true, intake_prompt_diag_scan: true } },
      vehicle: { select: { id: true, registration: true, vin: true, mileage_at_create: true, make: true, model: true, colour: true, year: true, fuel_type: true, engine_cc: true, mot_expiry: true, last_mot_mileage: true, last_mot_date: true } },
      items: { orderBy: { created_at: 'asc' } },
      // Duplicate provenance — enough to say "copied from X" and to spot an ownership change
      // (source customer vs this card's customer, compared by ID at render).
      duplicated_from: { select: { id: true, customer_id: true, customer: { select: { name: true } }, vehicle: { select: { registration: true } } } },
    },
  })) as any;
  if (!row) return null;

  // Card ownership proven → NOW safe to read its invoice + audit trail (keyed on the card).
  const [invoiceRow, auditRows, latestQuote] = await Promise.all([
    prisma.invoice.findUnique({
      where: { job_card_id: cardId },
      // `lines` USED to be `take: 1` — existence alone answered "are the lines FROZEN?", which is
      // all freeze-at-issue needs. It now carries the amounts too, because the Text-pay-link button
      // is hidden when there is nothing to pay and that predicate (lib/invoice-pay-link::
      // offersPayLink) needs a total. Same query, more columns; a handful of rows per invoice.
      // Re-deriving "is there anything to pay" in the page would be a second copy of a chokepoint.
      select: {
        id: true, invoice_number: true, status: true, series: true,
        lines: { select: { id: true, vat_rate: true, line_vat: true, line_total: true } },
        // THE LEDGER, for the refund state. Same query, more columns — no extra round-trip in a
        // builder that is deliberately three waves. buildInvoiceDoc is NOT called here: it pulls a
        // dozen relations to answer a question these rows already answer, and query depth is the
        // latency currency on this page.
        payments: { select: { status: true, amount_pennies: true, refunds: { select: { amount_pennies: true, collected_at: true } } } },
      },
    }) as Promise<{ id: string; invoice_number: string | null; status: string; series: string; lines: any[]; payments: any[] } | null>,
    prisma.auditLog.findMany({
      where: { entity: 'job_card', entity_id: cardId },
      orderBy: { created_at: 'desc' },
      take: 100,
      select: { id: true, action: true, created_at: true, diff_json: true, user: { select: { name: true, email: true } } },
    }) as Promise<any[]>,
    // The card's LATEST quote version status — a `superseded` latest means the estimate was
    // materially edited after sending and never re-sent, so there is no live link for the customer.
    prisma.quoteVersion.findFirst({
      where: { job_card_id: cardId },
      orderBy: { version: 'desc' },
      select: { status: true },
    }) as Promise<{ status: string } | null>,
  ]);
  // No live customer link: the latest version is superseded (clears the moment a fresh quote is sent,
  // as the new `sent` version becomes the latest).
  const quoteSupersededNoLink = latestQuote?.status === 'superseded';
  // ACCEPTANCE BELONGS TO THE VERSION, not the card (ruling 2026-08-05). A card can be `accepted`
  // with no accepted version (marked accepted by phone against a verbal quote), and a version can be
  // accepted on a card that has since moved on. So the question "has this customer already agreed to
  // a price?" is answered by the versions, and it decides whether the next send is a QUOTE or a
  // REVISION — which changes both the button and the message the customer gets.
  // The WHOLE version series — the accepted-vs-latest question needs all of them, and the same
  // read answers "has anything been accepted?".
  const allVersions = (await prisma.quoteVersion.findMany({
    where: { job_card_id: cardId },
    // id + the provenance pair ride along: the same read answers "who confirmed the agreed one?"
    // and feeds the agreed-version control, rather than a second query for each.
    select: { id: true, version: true, status: true, gross_pennies: true, responded_by_user: true, responded_ip: true },
  }).catch(() => [])) as Array<{ id: string; version: number; status: string; gross_pennies: number; responded_by_user: string | null; responded_ip: string | null }>;
  const quoteHasAcceptedVersion = allVersions.some((v) => v.status === 'accepted');
  // ONE RULE, shared with the diary and the quotes list — never re-derived here.
  const priceUnconfirmed = quotePriceUnconfirmed(allVersions);

  // Wave 3 — row-keyed queries, fired together. The owner chain keeps its internal order:
  // CAR-FIRST — resolve the CURRENT owner via the ownership edge (falls back to the card's own
  // customer link only if a card somehow predates its vehicle's edge — the backfill covered all
  // live vehicles).
  const [site, resources, { edgeOwnerId, ownerRow, ownerNoShows }, intakeFacts, skipRows, lastReport, dueItems, labourRateRow] = await Promise.all([
    prisma.site.findUnique({ where: { id: row.site_id }, select: { currency_code: true, locale: true, open_hour: true, close_hour: true, booking_slot_minutes: true, open_days: true, breaks: true } }) as Promise<{ currency_code: string; locale: string; open_hour: number; close_hour: number; booking_slot_minutes: number; open_days: number[]; breaks: unknown } | null>,
    prisma.resource.findMany({
      where: { site_id: row.site_id, is_active: true },
      orderBy: { display_order: 'asc' },
      select: { id: true, name: true },
    }) as Promise<Array<{ id: string; name: string }>>,
    (async () => {
      const ownerId = row.vehicle?.id ? await getCurrentOwnerId(prisma, row.vehicle.id as string) : null;
      const or = ownerId
        ? await prisma.customer.findUnique({ where: { id: ownerId }, select: { name: true, phone: true, phone_e164: true, email: true, address: true, sms_opt_out: true, email_opt_out: true, account_terms_days: true, account_name: true } })
        : (row.customer ?? null);
      // The customer's missed-booking history rides with the owner — derived (lib/no-show), so a
      // reopened card corrects it by construction. THIS card counts too when it is itself a
      // no-show: the section shows the customer's full record, and hiding the newest instance
      // would understate exactly the fact the count exists to surface.
      const hist = ownerId ?? row.customer_id
        ? await noShowHistory(prisma, ownerId ?? (row.customer_id as string | null))
        : { count: 0, dates: [] };
      return { edgeOwnerId: ownerId, ownerRow: or, ownerNoShows: hist };
    })(),
    // INTAKE ARTEFACTS — what the four prompts derive their done-states FROM. Counted, not fetched:
    // the states need to know whether a video and a scan photo exist, never their contents.
    (async () => {
      const [video, scan, onCard] = await Promise.all([
        prisma.jobCardPhoto.count({ where: { job_card_id: cardId, stage: 'intake', media_type: 'video' } }),
        prisma.jobCardPhoto.count({ where: { job_card_id: cardId, stage: 'intake', slot: DIAG_SCAN_SLOT } }),
        prisma.vehicleDueItem.count({ where: { group_id: groupId, found_on_job_card_id: cardId } }),
      ]);
      return { hasIntakeVideo: video > 0, hasDiagScanPhoto: scan > 0, dueItemCount: onCard };
    })(),
    // The most recent skip per item, from the audit log — a skip is an event, never a column.
    prisma.auditLog.findMany({
      where: { group_id: groupId, entity_id: cardId, action: 'intake.item_skipped' },
      orderBy: { created_at: 'desc' }, select: { diff_json: true },
    }) as Promise<Array<{ diff_json: unknown }>>,
    // WHEN THE REPORT WAS LAST SENT — the only stored half of the derived report status.
    prisma.customerMagicLink.findFirst({
      where: { job_card_id: cardId, purpose: 'intake_report' },
      orderBy: { created_at: 'desc' }, select: { created_at: true },
    }) as Promise<{ created_at: Date } | null>,
    // OPEN DUE ITEMS for THIS CAR — what it still needs, found on this visit or any earlier one.
    // Keyed to the vehicle, so a finding from last March surfaces on today's card (lib/due-items).
    openDueItemsForVehicle(prisma, groupId, row.vehicle?.id as string | undefined),
    // The site's default labour rate (Financial settings) — pre-fills new labour lines and is the
    // rate the upcoming margin feature reads (labour retail = labour_hours × rate).
    prisma.serviceCatalogue.findFirst({ where: { group_id: groupId, site_id: row.site_id, service_code: 'LABOUR_HR' }, select: { default_labour_rate: true } }) as Promise<{ default_labour_rate: unknown } | null>,
  ]);
  const canEdit = canManageSite(vis, row.site_id);
  const canOperate = canAccessSite(vis, row.site_id);
  const canEditPricing = canEditEstimate(vis, row.site_id, perms);
  const canIssue = canIssueInvoice(vis, row.site_id); // canManage OR the per-user can_invoice grant

  // QUOTE FROZEN — the state the browser never had. canEditPricing is a PERMISSION; this is the
  // freeze-at-issue lock, and without it the client could not tell the difference: the autosave, the
  // tab-change commit and the route-leave commit all fired at a frozen card and collected 409s, and
  // the only "frozen" wording in the app lived in the API's refusal body. Same predicate as
  // jobcard-quote.ts, read through the same chokepoint, so the two cannot disagree.
  const quoteFrozen = !!invoiceRow && !canEditInvoice({
    status: invoiceRow.status,
    hasFrozenLines: (invoiceRow.lines?.length ?? 0) > 0,
  });
  // WHY THE SEND CONTROL IS ABSENT, in the garage's words — computed from the SAME predicate the
  // API refuses with, so the button cannot be offered where the send would 409. A button that
  // always fails is a trap; a stated reason is an answer. Null when a quote can be sent.
  const quoteSendBlockedReason = refuseQuoteSend(row.status, quoteHasAcceptedVersion)?.message ?? null;

  // ── WHO CONFIRMED THE ACCEPTANCE, in words, for the Quote panel ────────────────────────────────
  // The HIGHEST accepted version is the operative one everywhere (invoice-issue, quotes-list), so it
  // is the one whose provenance gets stated. Versionless → 'garage' by construction, and that is the
  // 219-card majority, not an edge.
  const acceptedVersionRow = [...allVersions].sort((a, b) => b.version - a.version).find((v) => v.status === 'accepted') ?? null;
  const acceptanceProv = (row.status === 'draft' || row.status === 'quoted' || row.status === 'declined')
    ? null // nothing has been accepted, so there is nothing to attribute
    : acceptanceProvenance(acceptedVersionRow);
  const acceptanceNote = acceptanceProv ? PROVENANCE_SENTENCE[acceptanceProv] : null;
  const acceptanceLabel = acceptanceProv ? PROVENANCE_LABEL[acceptanceProv] : null;

  // ── THE AGREED-VERSION CORRECTION (admin, invoiced cards) ──────────────────────────────────────
  // Present ONLY when there is a real mismatch to fix: an invoice whose lines came from an earlier
  // accepted version while a LATER version is still sitting `sent`. Shaped server-side with both
  // totals so the control can state the money before it commits — the client never computes a
  // difference it is about to ask someone to authorise. Absent (not hidden) for non-admins.
  const latestSent = [...allVersions].sort((a, b) => b.version - a.version).find((v) => v.status === 'sent') ?? null;
  // AUTHORITY FOLLOWS THE ARTEFACT (ruling 2026-08-08), matching the endpoint exactly: with an
  // invoice this changes a document, so admin; without one it is ordinary quoting and carries the
  // same authority as the existing verbal control. Shaping it wider than the endpoint would render
  // a button that 403s — a trap; shaping it narrower would hide the remedy from the people who need
  // it most, which is how KR60LCX sat at £156.00 short with a warning and no control.
  const mayFixAgreedVersion = invoiceRow ? vis.isAdmin : canAccessSite(vis, row.site_id);
  const agreedVersionFix = (mayFixAgreedVersion && acceptedVersionRow && latestSent
    && latestSent.version > acceptedVersionRow.version)
    ? {
        versionId: latestSent.id,
        sentVersion: latestSent.version,
        sentPennies: latestSent.gross_pennies,
        agreedVersion: acceptedVersionRow.version,
        agreedPennies: acceptedVersionRow.gross_pennies,
        differencePennies: latestSent.gross_pennies - acceptedVersionRow.gross_pennies,
        agreedProvenance: acceptanceProvenance(acceptedVersionRow),
        customerName: ownerRow?.name ?? null,
        // NULL = no invoice yet: the control drops the unlock/re-issue second step and says the
        // invoice will simply be raised at the agreed figure.
        invoiceNumber: invoiceRow?.invoice_number ?? null,
        invoiced: !!invoiceRow,
      }
    : null;
  // FINANCE SHAPING (ruling 2026-07-12): props are shaped to financeVisibility SERVER-SIDE —
  // a user who may not see money never RECEIVES money. Absent, not hidden.
  //   priceVisible = seeValues OR canEditPricing (edit implies see, for PRICES only)
  //   costVisible  = seeMargin (ADMIN always) — unit_cost / components / BoM are the margin grain
  const fin = financeVisibility(vis, perms);
  const priceVisible = fin.seeValues || canEditPricing;
  const costVisible = fin.seeMargin;
  // phoneE164 is the DERIVED dialable form; smsOptOut/emailOptOut keep their THREE-STATE shape all
  // the way to the screen (`?? null`, never `?? false`) — unknown must not arrive as consent.
  const owner = {
    name: ownerRow?.name ?? '—', phone: ownerRow?.phone ?? null, phoneE164: (ownerRow as any)?.phone_e164 ?? null,
    email: ownerRow?.email ?? null, address: (ownerRow as any)?.address ?? null,
    smsOptOut: (ownerRow as any)?.sms_opt_out ?? null, emailOptOut: (ownerRow as any)?.email_opt_out ?? null,
    // NULL all the way to the screen: no terms is "pays on collection", not "we don't know".
    accountTermsDays: (ownerRow as any)?.account_terms_days ?? null,
    accountName: (ownerRow as any)?.account_name ?? null,
    // Missed bookings, most recent first — shown beside the customer so whoever books the next
    // slot sees the form. Empty array = clean history (derived, so it is a real zero).
    noShowDates: ownerNoShows.dates,
  };

  const booking: CardBooking = isBookedCard(row as any)
    ? {
        resourceId: row.resource_id,
        startAt: (row.start_at as Date).toISOString(),
        endAt: (row.end_at as Date).toISOString(),
        heldOnLift: !!row.held_on_lift,
        // duration is the source of truth; fall back to (end - start) for pre-backfill rows.
        workingMinutes: row.booking_duration_minutes ?? Math.round(((row.end_at as Date).getTime() - (row.start_at as Date).getTime()) / 60000),
      }
    : null;

  // ── IS THERE ANYTHING TO PAY? ────────────────────────────────────────────────────────────────
  // Asked HERE, through the same predicate the endpoint refuses with, so the Text-pay-link button
  // cannot be offered where /api/invoice-sms would 409 `nothing_to_pay`. `underCorrection` is the
  // alias of canEditInvoice already computed above for quoteFrozen — one read, two uses, and they
  // can never disagree about whether this document is settled.
  const offersPay = !!invoiceRow && offersPayLink({
    status: invoiceRow.status as any,
    underCorrection: canEditInvoice({ status: invoiceRow.status, hasFrozenLines: (invoiceRow.lines?.length ?? 0) > 0 }),
    series: invoiceRow.series as any,
    vatRegistered: vat.registered,
    totals: invoiceTotals(invoiceRow.lines ?? []),
  });

  // ONE RULE, INVOKED — not a second reading of it. refundState is the same function
  // buildInvoiceDoc calls for the customer's link; what differs is only where the rows came from.
  // Re-deriving "is it refunded" from amount_paid_pennies here would be the second reading.
  const refund = invoiceRow
    ? refundState({
        receivedPennies: (invoiceRow.payments ?? [])
          .filter((p: any) => p.status === 'succeeded')
          .reduce((a: number, p: any) => a + (p.amount_pennies ?? 0), 0),
        refunds: (invoiceRow.payments ?? []).flatMap((p: any) => p.refunds ?? []),
      })
    : null;

  const invoice = invoiceRow
    ? {
        id: invoiceRow.id,
        number: invoiceRow.invoice_number ?? '',
        status: invoiceRow.status as 'issued' | 'paid_pending' | 'paid',
        // ABSENT IS NOT HIDDEN: false means "there is nothing to pay", not "you may not see this".
        offersPayLink: offersPay,
        refund: refund && refund.kind !== 'none'
          ? { kind: refund.kind, refundedPennies: refund.refundedPennies, receivedPennies: (refund as any).receivedPennies ?? 0, at: refund.at ? refund.at.toISOString() : null }
          : null,
      }
    : null;

  const num = (d: any) => (d == null ? 0 : Number(d));
  // Catalogue for the builder's autocomplete: only editors need it at all; costs are cost-visible
  // only (this payload previously re-shipped requireAdminApi-grade grain to every card visitor).
  const catalogue: CatalogueLite[] = !canEditPricing ? [] : catalogueRows.filter((c) => c.item_type !== 'fixed').map((c) => ({
    id: c.id, code: c.code, name: c.name, item_type: c.item_type,
    unit_cost: costVisible ? (c.unit_cost == null ? null : Number(c.unit_cost)) : 0, unit_price: Number(c.unit_price), vat_rate: Number(c.vat_rate), // null = UNKNOWN (not 0) so it freezes as uncosted
  }));
  const codeById = new Map(catalogueRows.map((c) => [c.id, c.code]));
  const fixedServices: FixedServiceLite[] = !canEditPricing ? [] : catalogueRows.filter((c) => c.item_type === 'fixed').map((c) => ({
    id: c.id, code: c.code, title: c.title, name: c.name,
    basePriceExVat: Number(c.base_price_ex_vat ?? c.unit_price), vatRate: Number(c.vat_rate),
    labourHours: c.labour_hours == null ? null : Number(c.labour_hours),
    // Components are the bill of materials WITH supplier costs — the strictest grain on the page.
    components: costVisible ? c.components.map((x: any) => ({ description: x.description, qty: Number(x.qty), unitCost: Number(x.unit_cost_ex_vat) })) : [],
    tierPrices: c.tier_prices.map((tp: any) => ({ tierId: tp.tier_id, priceExVat: tp.price_ex_vat == null ? null : Number(tp.price_ex_vat) })),
  }));
  const tiers: TierLite[] = tierRows.map((tt) => ({ id: tt.id, name: tt.name }));
  const promos: PromoLite[] = !priceVisible ? [] : promoRows.map((p) => ({ id: p.id, code: p.code, label: p.label, type: p.promo_type, amount: Number(p.amount), targets: p.targets.map((t: any) => ({ id: t.item.id, title: t.item.title || t.item.name })) }));

  const lines: EstimateLine[] = (row.items as any[]).map((it) => ({
    item_type: it.item_type,
    description: it.description ?? '',
    qty: String(num(it.qty)),
    unit_price: priceVisible ? String(num(it.unit_price)) : '',      // absent, not hidden
    unit_cost: costVisible && num(it.unit_cost) ? String(num(it.unit_cost)) : '', // the margin grain
    vatable: num(it.vat_rate) > 0,
    code: it.catalogue_item_id ? (codeById.get(it.catalogue_item_id) ?? '') : '',
    catalogue_item_id: it.catalogue_item_id ?? null,
    labour_hours: it.labour_hours == null ? null : Number(it.labour_hours),
  }));

  const flags = [
    row.flag_urgent && 'urgent', row.flag_sales_car && 'sales', row.flag_customer_car && 'customer',
    row.flag_mot && 'mot', row.flag_diag && 'diag',
  ].filter(Boolean) as string[];

  const stages: Record<StageKey, boolean> = {
    details: !!row.stage_details_done, intake: !!row.stage_intake_done,
    injob: !!row.stage_injob_done, complete: !!row.stage_complete_done,
  };
  const skipped = { intake: !!row.stage_intake_skipped, injob: !!row.stage_injob_skipped, complete: !!row.stage_complete_skipped };
  // THE FOUR PROMPTS, derived. Switches read at RENDER from the site, so flipping one mid-job takes
  // effect on the next load rather than being stamped onto the card.
  const skipsByItem: Partial<Record<string, { reason: string | null }>> = {};
  for (const r of skipRows) {
    const d = (r.diff_json ?? {}) as { item?: string; reason?: string | null };
    if (d.item && !(d.item in skipsByItem)) skipsByItem[d.item] = { reason: d.reason ?? null };
  }
  const intakeItems = intakeItemStates(
    {
      dueItemCount: intakeFacts.dueItemCount,
      nothingFoundAt: (row as { intake_nothing_found_at?: Date | null }).intake_nothing_found_at ?? null,
      odometerIn: row.odometer_in ?? null,
      vin: row.vehicle?.vin ?? null,
      hasIntakeVideo: intakeFacts.hasIntakeVideo,
      hasDiagScanPhoto: intakeFacts.hasDiagScanPhoto,
    },
    (row.site ?? {}) as Record<string, boolean>,
    skipsByItem as never,
  );

  const closureOffers = await closureOffersForCard(prisma, groupId, dueItems.map((d) => d.id));

  const tabsState = computeTabs({
    status: row.status as JobStatus,
    stages,
    skipped,
    hasOwner: !!edgeOwnerId || !!row.customer,
    hasRegistration: !!(row.vehicle?.registration && String(row.vehicle.registration).trim()),
  });

  // Audit trail — this card's events, newest first. Empty for cards created before this shipped.
  // PROVENANCE IN WORDS, resolved server-side. `quote.accepted` is written by BOTH the customer's own
  // click and a garage-recorded answer, so the action name cannot carry this and the client must not
  // have to infer it from a missing name. `quote.agreed_version` is garage-recorded by construction.
  const auditNote = (action: string, diff: any): string | null => {
    if (action === 'quote.agreed_version') {
      return `${PROVENANCE_LABEL.garage} — version ${diff?.version ?? '?'} agreed after this job was invoiced. The job's own status and acceptance date are unchanged.`;
    }
    if (action !== 'quote.accepted') return null;
    // `attested` is written by the chokepoint on every row since 2026-08-05. Its ABSENCE on an older
    // row is unknown, not false — the same honest-null rule the provenance module applies.
    if (diff && typeof diff.attested === 'boolean') {
      return diff.attested ? PROVENANCE_LABEL.customer : PROVENANCE_LABEL.garage;
    }
    return PROVENANCE_LABEL.unknown;
  };
  const events: AuditEvent[] = auditRows.map((a) => ({
    id: a.id, action: a.action, actor: a.user?.name ?? a.user?.email ?? null, at: (a.created_at as Date).toISOString(),
    note: auditNote(a.action, a.diff_json),
  }));

  // Duplicate provenance for the two notices. Ownership change compares customer IDs (source card
  // vs this card — set at duplicate time to the vehicle's then-current owner); names are display
  // only, never the comparison. costsInherited is an editor advisory — shaped to canEditPricing
  // (absent, not hidden) because only an estimate editor can act on it, and the save that clears it.
  // Country-shaped vehicle identity for the details tab (ruling 2026-07-29).
  const profileForCard = resolveTenantProfile(await prisma.group.findUnique({ where: { id: groupId }, select: { country_code: true, ref: true } }));
  const dup = row.duplicated_from;
  const duplicatedFrom = dup
    ? {
        registration: dup.vehicle?.registration ?? null,
        ownershipChanged: !!(dup.customer_id && row.customer_id && dup.customer_id !== row.customer_id),
        previousCustomerName: dup.customer?.name ?? null,
      }
    : null;
  const costsInherited = canEditPricing && !!row.costs_inherited;

  // The conversation for this card's (customer, vehicle) — READ-ONLY, resolved through the ownership
  // edge by lib/message-threads. An absent thread yields an empty list, never an error.
  const conversation = await conversationForJobCard(prisma, row.id);
  // Resolved from the CARD, not the thread — a customer with no thread yet must still be writable
  // to, or the first message could never be sent. Server-side so the box can be closed BEFORE anyone
  // types rather than accepting the words and failing afterwards.
  const reachability = await reachabilityForJobCard(prisma, row.id, 'email');

  return {
    conversation: conversation.messages,
    threadId: conversation.threadId,
    // Unread on THIS card's thread — the tab badge. The sidebar's number is the tenant total.
    messagesUnread: conversation.unread,
    reachability,
    registration: row.vehicle?.registration ?? '—',
    // What this CAR still needs — open findings from this visit or any earlier one. The upsell
    // list, in front of whoever has the car today. Each carries its CLOSURE OFFER: derived from
    // whether every linked estimate line is invoiced, and offered rather than applied.
    dueItems: dueItems.map((d) => ({ ...d, closureOffer: closureOffers.get(d.id) ?? { offer: false as const, reason: 'no_lines' as const } })),
    // The four intake prompts, already resolved to prompted/done/skipped server-side.
    intakeItems,
    // DERIVED, not stored: sent-when plus how many findings carry an answer. "No reply after 3
    // days" needs no scheduled job and cannot drift.
    reportStatus: reportStatus({
      lastSentAt: lastReport?.created_at ?? null,
      totalFindings: dueItems.length,
      answeredFindings: dueItems.filter((d) => d.customerResponse !== 'not_raised').length,
      now: new Date(),
    }),
    nothingFoundAt: ((row as { intake_nothing_found_at?: Date | null }).intake_nothing_found_at ?? null)?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    status: row.status,
    jobCardId: row.id,
    canEdit, canEditPricing, canOperate, canIssueInvoice: canIssue, quoteFrozen,
    quoteSendBlockedReason,
    acceptanceNote, acceptanceLabel, agreedVersionFix,
    quoteSupersededNoLink,
    quoteHasAcceptedVersion,
    priceUnconfirmed,
    isAdmin: vis.isAdmin,
    currency: site?.currency_code ?? 'GBP',
    locale: site?.locale ?? 'en-GB',
    vatRate: lines.length > 0 ? num(row.vat_rate) : vat.defaultRate,
    vatRegistered: vat.registered,
    owner,
    vehicle: {
      // The vehicle's OWN id — the DVSA lookup needs it to store the MOT odometer history it
      // fetches (lib/odometer); without it the readings have nothing to hang on.
      registration: row.vehicle?.registration ?? '—',
      vin: row.vehicle?.vin ?? null,
      id: row.vehicle?.id ?? null,
      mileageIn: row.odometer_in ?? row.vehicle?.mileage_at_create ?? null,
      mileageOut: row.odometer_out ?? null,
      make: row.vehicle?.make ?? null,
      model: row.vehicle?.model ?? null,
      colour: row.vehicle?.colour ?? null,
      year: row.vehicle?.year ?? null,
      fuel: row.vehicle?.fuel_type ?? null,
      engineCc: row.vehicle?.engine_cc ?? null,
      motExpiry: row.vehicle?.mot_expiry ? (row.vehicle.mot_expiry as Date).toISOString().slice(0, 10) : null,
      lastMotMileage: row.vehicle?.last_mot_mileage ?? null,
      lastMotDate: row.vehicle?.last_mot_date ? (row.vehicle.last_mot_date as Date).toISOString().slice(0, 10) : null,
    },
    flags, isComeback: !!row.is_comeback,
    duplicatedFrom, costsInherited,
    vehicleIdLabel: profileForCard.vehicleIdLabel, vehicleLookupProvider: profileForCard.vehicleLookupProvider,
    garageNotes: row.garage_notes ?? '',
    lines, catalogue, fixedServices, tiers, promos,
    priceVisible, costVisible, // the UI renders to these; the DATA above is already shaped to them
    labourRate: priceVisible && labourRateRow?.default_labour_rate != null ? Number(labourRateRow.default_labour_rate) : null,
    hasEstimate: (row.items as any[]).length > 0,
    resources, booking, stages, skipped, tabsState, invoice, events,
    siteHours: { openHour: site?.open_hour ?? 8, closeHour: site?.close_hour ?? 18, slotMinutes: site?.booking_slot_minutes ?? 30, openDays: site?.open_days && site.open_days.length ? site.open_days : [1, 2, 3, 4, 5, 6], breaks: parseBreaks(site?.breaks) },
    siteId: row.site_id,
  };
}

export type JobCardPageProps = NonNullable<Awaited<ReturnType<typeof buildJobCardPageProps>>>;
