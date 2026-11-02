# news.greasedesk.com — the records to add, and the one code change that makes them matter

Written 2026-11-02. Everything below about the CURRENT state was measured with `dig`, not assumed.
Re-measure before acting if you read this later.

## What is already true

```
greasedesk.com          TXT   "v=spf1 include:spf.protection.outlook.com -all"
greasedesk.com          TXT   "MS=ms52365742"
_dmarc.greasedesk.com   TXT   "v=DMARC1; p=none;"
resend._domainkey.greasedesk.com  TXT  "p=MIGfMA0GCSq…"   ← Resend DKIM, already live
news.greasedesk.com     —     nothing at all
greasedesk.com          NS    ns1.vercel-dns.com / ns2.vercel-dns.com
```

Three things follow, and they are the reason this runbook is not the generic one.

**1. DNS is hosted at Vercel.** Records go in the Vercel dashboard → the `greasedesk.com` domain →
DNS. Not at the registrar.

**2. Do NOT add Resend or Amazon SES to the apex SPF record.** That record is Microsoft 365's and it
ends in `-all`, a hard fail, deliberately. Transactional mail from Resend passes DMARC today by
**DKIM alignment** (`resend._domainkey.greasedesk.com` above) — the Return-Path is Resend's own
domain, so apex SPF is never consulted for it. Adding `include:amazonses.com` to the apex would
widen what may send as `@greasedesk.com` for no gain. Leave it exactly as it is.

**3. `_dmarc.greasedesk.com` is `p=none` with no `rua=`.** DMARC is published but **nobody is
receiving the reports**, so nothing is being learned from it, and there is no `sp=`, so
`news.greasedesk.com` will inherit `p=none` the moment it exists. That is a safe place to start and
a bad place to stay. Fixing it is step 5 and is independent of everything else here.

---

## Step 1 — add the domain in Resend

Resend → **Domains** → **Add Domain** → `news.greasedesk.com`.

**Choose the Ireland (`eu-west-1`) region.** The recipients are UK garages, the sending
infrastructure then sits in the EU, and the MX hostname in step 2 depends on this choice — picking a
different region makes the record below wrong.

Resend will then show you three records to add. **Copy its exact values**, especially the DKIM key:
it generates a NEW key for this domain and it is not the apex one above.

## Step 2 — add the records at Vercel, with `.news` appended to every name

This is the step that goes wrong. Resend shows record names **relative to the domain you added**
(`news.greasedesk.com`), but Vercel's zone is **`greasedesk.com`**. So every name Resend gives you
needs `.news` on the end before you paste it into Vercel.

| Resend shows | Enter at Vercel as | Type | Value |
|---|---|---|---|
| `send` | `send.news` | MX | `feedback-smtp.eu-west-1.amazonses.com`, priority **10** |
| `send` | `send.news` | TXT | `v=spf1 include:amazonses.com ~all` |
| `resend._domainkey` | `resend._domainkey.news` | TXT | `p=…` — **the key Resend shows you, not the one above** |

Notes on each:

- **The MX record is not for receiving mail.** It is the bounce-and-complaint feedback path, and it
  is what makes the Return-Path domain (`send.news.greasedesk.com`) resolve so SPF aligns on it.
  Leaving it out is the usual cause of "verified but landing in spam".
- **That SPF record is on `send.news`, not on `news`.** It authorises the envelope sender only. It
  does not touch, and must not be merged with, the apex record.
- **One SPF record per name, ever.** Two `v=spf1` TXT records on the same name is a permanent error
  with no warning. `send.news` is currently empty, so there is nothing to merge with.

## Step 3 — verify

Back in Resend, press **Verify**. Vercel's DNS usually propagates in under a minute; give it five
before worrying. Then check from a terminal — Resend's own green tick and the public DNS can
disagree for a while:

```bash
dig +short MX send.news.greasedesk.com; dig +short TXT send.news.greasedesk.com; dig +short TXT resend._domainkey.news.greasedesk.com
```

All three must return something. If DKIM comes back empty, the usual cause is the key being pasted
with a line break in it.

## Step 4 — tell me the From address you want

**Adding the records changes nothing on its own.** There is one from-address in the whole codebase
today — `EMAIL_FROM` in `lib/email-service.ts`, read once at module load — and every message,
invoice and marketing email alike, goes out on it. Until the sender picks a different address for
marketing mail, the new subdomain is a verified domain that nothing uses, and transactional
reputation is exactly as exposed as it is now.

The code change is mine and it is part of the engine slice: a second variable,
`MARKETING_EMAIL_FROM`, chosen by the sender for a marketing template and never for anything else,
with a gate asserting a transactional template can never pick it up. What I need from you:

- the address — `news@news.greasedesk.com` and `hello@news.greasedesk.com` are both fine; and
- **where replies go.** Marketing mail that bounces replies into a void is both rude and a
  deliverability signal. The marketing site deliberately publishes no email address, and a Reply-To
  on mail we chose to send is not a published address, so there is no conflict — but it should be
  somewhere a person actually reads.

Set `MARKETING_EMAIL_FROM` in Vercel → the project → Settings → Environment Variables, for
**Production**, once you have decided. One Resend API key covers both domains; a second key buys
nothing.

## Step 5 — DMARC, which is worth doing whatever happens to the rest

Independent of the marketing engine. Two records.

**Start receiving the reports you are already asking for.** Replace `_dmarc.greasedesk.com`:

```
v=DMARC1; p=none; rua=mailto:dmarc@greasedesk.com; pct=100
```

Nothing enforces anything yet; you simply start getting the daily XML that says who is sending as
you and whether it passes. Without `rua=` the current record does nothing at all.

**And give the subdomain its own, so the two can be tightened separately.** Add
`_dmarc.news` TXT:

```
v=DMARC1; p=none; rua=mailto:dmarc@greasedesk.com; pct=100
```

Why separately: a marketing subdomain is the thing you want to be able to move to `p=reject`
early — it has exactly one sender and it is the domain a spam complaint would point at. The apex
has Microsoft 365 and Resend on it and deserves a slower, evidence-led tightening. One inherited
record forces the same decision on both.

After a fortnight of reports showing only Resend on `news.`, move the subdomain to `p=quarantine`
and then `p=reject`. Leave the apex at `p=none` until its own reports say it is safe.

---

## What this does not do

Sending from a subdomain protects the **apex's** reputation from marketing complaints. It does not
make the marketing mail itself more deliverable — that is the copy, the consent, and the fact that
every sequence here only ever goes to someone who asked. A subdomain sending unwanted mail simply
burns the subdomain instead, which is the point: the invoice still arrives.
