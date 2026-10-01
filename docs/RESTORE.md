# Restoring GreaseDesk from a backup

Written on 2026-10-01, the day after the Neon project hit an account quota and refused every query
for a day. The database was unreachable **and so was Neon's own restore**. That is the whole reason
for the copy in R2: a backup inside the account that locks you out is not a second copy.

There are two protections, for two different failures:

| failure | use |
|---|---|
| A bad write, a wrong migration, a deletion — Neon reachable | **Neon point-in-time restore / branch.** Fastest, no download. |
| The Neon account or project is unreachable — quota, billing, suspension | **The R2 copy.** Independent of Neon entirely. |

## What the nightly job leaves you

`.github/workflows/nightly-backup.yml`, 02:17 UTC, into the R2 bucket named by `R2_BUCKET`:

```
nightly/db-<stamp>.dump.gpg        pg_dump custom format, AES256
nightly/manifest-<stamp>.json.gpg  table row counts, migration count, June golden
weekly/…  monthly/…                same files, longer retention
```

The stamp is UTC, e.g. `20261001T021703Z`. Retention is R2 lifecycle per prefix: nightly 14 days,
weekly 8 weeks, monthly 12 months, with versioning on so a leaked key cannot erase history.

**The passphrase is not in the bucket and not recoverable from it.** It is `BACKUP_PASSPHRASE` in
GitHub Actions secrets, and it must also exist somewhere neither GitHub nor Cloudflare controls — a
password manager. A dump you cannot decrypt is not a backup.

## Restoring

You need: `pg_dump`/`pg_restore` 18 (`brew install libpq`), the AWS CLI, the R2 key, the passphrase.

```bash
# 1. Fetch — list first, take the one you mean, not simply the newest
export AWS_ACCESS_KEY_ID=…  AWS_SECRET_ACCESS_KEY=…  AWS_DEFAULT_REGION=auto
ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
aws s3 ls "s3://<bucket>/nightly/" --endpoint-url "$ENDPOINT"
aws s3 cp "s3://<bucket>/nightly/db-<stamp>.dump.gpg" . --endpoint-url "$ENDPOINT"
aws s3 cp "s3://<bucket>/nightly/manifest-<stamp>.json.gpg" . --endpoint-url "$ENDPOINT"

# 2. Decrypt
gpg --batch --decrypt --output db.dump      db-<stamp>.dump.gpg
gpg --batch --decrypt --output manifest.json manifest-<stamp>.json.gpg

# 3. Restore into a NEW database — never over the live one while you are still diagnosing
/opt/homebrew/opt/libpq/bin/pg_restore --no-owner --no-privileges --dbname "<new-database-url>" db.dump

# 4. Prove it before trusting it
DATABASE_URL="<new-database-url>" node scripts/backup-verify.mjs manifest.json
DATABASE_URL="<new-database-url>" npx prisma migrate status
```

`backup-verify` compares every table's row count, the applied-migration count and the June 2026
ledger hash against the manifest, and fails loudly on any difference. `migrate status` is the other
half: it says whether that schema matches the code you are about to deploy.

## Putting it back into service

1. Point `DATABASE_URL` and `DIRECT_URL` at the restored database in Vercel, and redeploy.
2. **Check the invoice counters before anyone invoices.** `InvoiceSequence` holds the gapless
   series; restoring an older copy rewinds them, and a second invoice on a used number is a VAT
   record problem, not an inconvenience. Compare `last_value`, `vehicle_sale_last_value`,
   `historical_last_value` and `warranty_last_value` against the highest numbers actually issued.
3. Re-run the June golden (`node scripts/goldens-june.mjs`) and keep the output with the incident
   notes: 46 invoices, 83 lines, £15,638.83, `f150133f…` as at 2026-10-01.
4. Anything written to the live database after the dump is gone. Establish what that was — the audit
   log in the restored copy ends at the dump, so the gap is the period to reconstruct by hand.

## Rehearsing it

Run the workflow by hand (Actions → nightly-backup → Run workflow) whenever you want to prove the
chain end to end. Every run already restores what it uploaded and verifies it; the manual run is how
you confirm the secrets and the bucket still work after any change to either.

## What the backup does NOT cover

- **R2 job-card photos.** They live in their own bucket and are not in this dump; the database holds
  only their keys.
- **Stripe, Resend and DVSA state.** External systems with their own records.
- **Vercel environment variables.** Keep them somewhere of their own; a restored database with no
  `NEXTAUTH_SECRET` is still a dark site.
