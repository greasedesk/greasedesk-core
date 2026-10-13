/**
 * THE FK PLAN, re-derived from information_schema every run.
 *
 * The unconstrained-`*_id` count moved from 78 to 81 between two audits a few days apart, so a
 * hand-carried list is wrong by the time it is read. This script asks the database what is
 * unconstrained NOW, partitions it against four explicit registries, and REFUSES if it meets a
 * column no registry names — a new column must be classified by a person, never defaulted.
 *
 * It writes nothing to the database. It emits the Prisma relation lines and the SQL they produce.
 *
 * NOT a gate — a reporting script. Run it by hand before writing an FK migration.
 */
import './_ts.mjs';
const { prisma } = await import('@/lib/db');
const q = (s) => prisma.$queryRawUnsafe(s);

/** Columns that get a constraint: [parent, onDelete]. onDelete follows the schema's own convention —
 *  Cascade to Group (57 of 61 existing FKs), SetNull where the column is nullable, and NoAction
 *  where it is NOT NULL (never Restrict: NoAction defers to end-of-statement, so a cascading
 *  tenant purge that removes parent and child in one statement still succeeds). */
const CONSTRAIN = {
  'Booking.resource_id':['Resource','SetNull'],
  'ContactPreferenceEvent.actor_user_id':['User','SetNull'], 'CreditNote.site_id':['Site','NoAction'],
  'ExportJob.requested_by_user_id':['User','NoAction'], 'Invoice.stock_disposal_id':['StockDisposal','SetNull'],
  'InvoiceLine.catalogue_item_id':['CatalogueItem','SetNull'], 'JobCard.import_batch_id':['ImportBatch','SetNull'],
  'JobCard.stock_item_id':['StockItem','SetNull'], 'JobCardItem.option_draft_id':['QuoteOptionDraft','SetNull'],
  'JobCardPhoto.group_id':['Group','Cascade'], 'JobClockSession.corrected_by_user_id':['User','SetNull'],
  'JobClockSession.user_id':['User','NoAction'], 'Payment.fee_rate_id':['ApplicationFeeRate','SetNull'],
  'Payment.site_id':['Site','NoAction'], 'PlatformOperator.user_id':['User','NoAction'],
  'Prospect.consent_by_rep_id':['Rep','SetNull'], 'Prospect.created_by_rep_id':['Rep','NoAction'],
  'Prospect.signed_up_group_id':['Group','SetNull'], 'ProspectVisit.rep_id':['Rep','NoAction'],
  'PurchaseModel.created_by_user_id':['User','NoAction'], 'PurchaseModel.vehicle_id':['Vehicle','SetNull'],
  'PurchaseModelDefaults.updated_by_user_id':['User','NoAction'],
  'QuoteVersion.magic_link_id':['CustomerMagicLink','SetNull'], 'QuoteVersionLine.option_id':['QuoteOption','SetNull'], 'RepVisit.site_id':['Site','NoAction'],
  'StagedInvoice.group_id':['Group','Cascade'], 'StagedInvoice.invoice_id':['Invoice','SetNull'],
  'StagedInvoice.job_card_id':['JobCard','SetNull'], 'StagedInvoice.planned_resource_id':['Resource','SetNull'],
  'StagedLine.catalogue_item_id':['CatalogueItem','SetNull'], 'StockCost.created_by_user_id':['User','NoAction'],
  'StockCost.reverses_id':['StockCost','SetNull'], 'StockCostSnapshot.job_card_id':['JobCard','SetNull'],
  'StockDisposal.buyer_customer_id':['Customer','SetNull'], 'StockDisposal.created_by_user_id':['User','NoAction'],
  'StockItem.created_by_user_id':['User','NoAction'], 'StockItem.reacquired_from_disposal_id':['StockDisposal','SetNull'],
  'StockNumberSequence.group_id':['Group','Cascade'],
  'UploadTelemetry.group_id':['Group','Cascade'], 'UploadTelemetry.job_card_id':['JobCard','NoAction'],
  'User.primary_site_id':['Site','SetNull'], 'VehicleDueItem.service_catalogue_id':['ServiceCatalogue','SetNull'],
  'VinReadShadow.group_id':['Group','Cascade'], 'VinReadShadow.job_card_id':['JobCard','NoAction'],
  'VinReadShadow.photo_id':['JobCardPhoto','NoAction'],
};
/** Columns that must NEVER take one, each with the reason. */
const NEVER = {
  'Account.provider_account_id':'external — the OAuth provider\'s id',
  'Group.stripe_account_id':'external — Stripe', 'GroupBilling.stripe_customer_id':'external — Stripe',
  'GroupBilling.stripe_subscription_id':'external — Stripe', 'InboundEvent.email_id':'external — Resend',
  'InboundEvent.svix_id':'external — Svix', 'NotificationLog.provider_message_id':'external — the SMS/email provider',
  'Payment.application_fee_id':'external — Stripe', 'Payment.charge_id':'external — Stripe',
  'Payment.payment_intent_id':'external — Stripe', 'ProviderConnection.external_id':'external — the provider',
  'Refund.refund_id':'external — Stripe', 'StripeEvent.event_id':'external — Stripe',
  'AuditLog.entity_id':'polymorphic — names a row in whichever table the action was about',
  'DeliveredCode.subject_id':'polymorphic — generic subject table',
  'NotificationLog.subject_id':'polymorphic — generic subject table',
  'TwoFactorRecoveryCode.subject_id':'polymorphic — generic subject table',
  'TwoFactorSecret.subject_id':'polymorphic — generic subject table',
  'CommissionEntry.party_id':'polymorphic — party_type is rep|operator',
  'RepVisit.party_id':'polymorphic — party_type is rep|operator',
  'TenantAttribution.party_id':'polymorphic — party_type is rep|operator',
  'ConsentEvent.consent_id':'not a reference — the browser\'s cookie uuid, deliberately repeated across rows',
  'LeaveRecord.leave_batch_id':'not a reference — a grouping key with no table behind it',
  'SuperAdminAudit.target_group_id':'RECORDS A DELETION — 445 orphans across 425 groups, every one explained by a tenant.purged row in this same table. An FK would block the purge or erase its own evidence.',
  'SuperAdminAudit.actor_rep_id':'audit trail — must outlive the rep it names',
  'SuperAdminAudit.target_rep_id':'audit trail — must outlive the rep it names',
  'CommissionEntry.group_id':'OURS_PER_TENANT — "our accounts payable to a reseller; deliberately survives a purge". CASCADE would delete a reseller payable when the tenant is purged.',
  'TenantAttribution.group_id':'OURS_PER_TENANT — "our commission spine, written once and never theirs"; it outlives the tenant by design.',
  'RepVisit.group_id':'OURS_PER_TENANT — our rep\u2019s record of visiting them, written by our staff about our sales process.',
};
/** Deliberately undecided — the owner rules on these, they are not defaulted. */
const PENDING = {
  'UploadTelemetry.photo_id':'18 orphans (TMBS) — SET NULL vs no constraint, owner deciding',
  'DueItemCustomerAnswer.magic_link_id':'4 orphans (TMBS) — SET NULL vs no constraint, owner deciding',
  'JobCard.sale_of_stock_item_id':'1 orphan (TMBS) — residue of the VS1 repair, owner deciding',
  'CommissionEntry.rate_id':'2 orphans (ZZ gate residue) — owner deciding',
};
const UNRESOLVED = {
  'SuperAdminAudit.operator_user_id':'target table not established — User or PlatformOperator',
  'SuperAdminAudit.target_operator_id':'target table not established — Operator or PlatformOperator',
  'MarketingContact.actor_id':'target table not established — undocumented in the schema',
};

const cols = await q(`SELECT table_name, column_name, is_nullable FROM information_schema.columns
  WHERE table_schema='public' AND column_name ~ '_id$' ORDER BY 1,2`);
const fk = new Set((await q(`SELECT tc.table_name||'.'||kcu.column_name k
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name=tc.constraint_name
   AND kcu.table_schema=tc.table_schema
  WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'`)).map(r=>r.k));
const unconstrained = cols.filter(c => !fk.has(`${c.table_name}.${c.column_name}`));
const nullable = new Map(unconstrained.map(c => [`${c.table_name}.${c.column_name}`, c.is_nullable==='YES']));

console.log(`information_schema says ${unconstrained.length} unconstrained *_id columns right now.`);

// REFUSE on anything unclassified, and on a registry entry that no longer exists.
const keys = new Set(unconstrained.map(c=>`${c.table_name}.${c.column_name}`));
const known = new Set([...Object.keys(CONSTRAIN),...Object.keys(NEVER),...Object.keys(PENDING),...Object.keys(UNRESOLVED)]);
const unclassified = [...keys].filter(k=>!known.has(k));
const vanished = [...known].filter(k=>!keys.has(k));
if (unclassified.length || vanished.length) {
  if (unclassified.length) console.log('\nREFUSING — these are unconstrained and in no registry. Classify them:\n  ' + unclassified.join('\n  '));
  if (vanished.length) console.log('\nREFUSING — these are in a registry but no longer unconstrained (already done, or renamed):\n  ' + vanished.join('\n  '));
  await prisma.$disconnect(); process.exit(2);
}

// Re-check orphans for every column we are about to constrain.
const emit = [], blocked = [];
for (const [key,[parent,onDelete]] of Object.entries(CONSTRAIN)) {
  const [child,col] = key.split('.');
  const n = Number((await q(`SELECT count(*) n FROM "${child}" c WHERE c."${col}" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "${parent}" p WHERE p.id=c."${col}")`))[0].n);
  // A zero orphan count over zero rows is not a tested column, it is an untested one. Say which.
  const rows = Number((await q(`SELECT count(*) n FROM "${child}" WHERE "${col}" IS NOT NULL`))[0].n);
  (n ? blocked : emit).push({ key, child, col, parent, onDelete, n, rows, nul: nullable.get(key) });
}
if (blocked.length) { console.log('\nEXCLUDED — orphans appeared since the audit:');
  for (const b of blocked) console.log(`  ${b.key} -> ${b.parent}: ${b.n}`); }

const vacuous = emit.filter(e => e.rows === 0);
if (vacuous.length) {
  console.log(`\nVACUOUS CLEAN VERDICTS — ${vacuous.length} of ${emit.length} have NO non-null rows, so the`);
  console.log("orphan count proves nothing. Classify these from the manifest's prose, not from the data:");
  for (const v of vacuous) console.log(`  ${v.key} -> ${v.parent}`);
}
console.log(`\n=== ${emit.length} CONSTRAINTS ===\n`);
console.log('--- schema.prisma, CHILD side (add one line to each model) ---');
for (const e of emit) console.log(`  [${e.child}]  ${e.parent.toLowerCase()}_ref ${e.parent}${e.nul?'?':''} @relation(fields: [${e.col}], references: [id], onDelete: ${e.onDelete})`);
console.log('\n--- equivalent SQL (what prisma migrate diff should produce) ---');
for (const e of emit) console.log(`ALTER TABLE "${e.child}" ADD CONSTRAINT "${e.child}_${e.col}_fkey" FOREIGN KEY ("${e.col}") REFERENCES "${e.parent}"("id") ON DELETE ${e.onDelete==='Cascade'?'CASCADE':e.onDelete==='SetNull'?'SET NULL':'NO ACTION'} ON UPDATE CASCADE;`);
console.log(`\nSUMMARY  constrain=${emit.length}  never=${Object.keys(NEVER).length}  pending=${Object.keys(PENDING).length}  unresolved=${Object.keys(UNRESOLVED).length}  total=${emit.length+blocked.length+Object.keys(NEVER).length+Object.keys(PENDING).length+Object.keys(UNRESOLVED).length}`);
await prisma.$disconnect();
