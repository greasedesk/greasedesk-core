-- Slice 2a: quote versions frozen at send. Purely additive.
CREATE TYPE "QuoteVersionStatus" AS ENUM ('sent', 'accepted', 'declined', 'superseded');

CREATE TABLE "QuoteVersion" (
    "id"                   TEXT NOT NULL,
    "group_id"             TEXT NOT NULL,
    "job_card_id"          TEXT NOT NULL,
    "version"              INTEGER NOT NULL,
    "status"               "QuoteVersionStatus" NOT NULL DEFAULT 'sent',
    "net_pennies"          INTEGER NOT NULL,
    "vat_pennies"          INTEGER NOT NULL,
    "gross_pennies"        INTEGER NOT NULL,
    "vat_registered"       BOOLEAN NOT NULL,
    "tax_label"            TEXT NOT NULL DEFAULT 'VAT',
    "sent_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_to"              TEXT,
    "magic_link_id"        TEXT,
    "created_by_user"      TEXT,
    "responded_at"         TIMESTAMP(3),
    "responded_ip"         TEXT,
    "responded_user_agent" TEXT,
    CONSTRAINT "QuoteVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QuoteVersion_job_card_id_version_key" ON "QuoteVersion"("job_card_id", "version");
CREATE INDEX "QuoteVersion_group_id_job_card_id_idx"       ON "QuoteVersion"("group_id", "job_card_id");
CREATE INDEX "QuoteVersion_status_idx"                     ON "QuoteVersion"("status");

ALTER TABLE "QuoteVersion" ADD CONSTRAINT "QuoteVersion_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuoteVersion" ADD CONSTRAINT "QuoteVersion_job_card_id_fkey"
    FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "QuoteVersionLine" (
    "id"                TEXT NOT NULL,
    "quote_version_id"  TEXT NOT NULL,
    "position"          INTEGER NOT NULL,
    "item_type"         "ItemType" NOT NULL,
    "description"       TEXT NOT NULL,
    "qty"               DECIMAL(12,2) NOT NULL,
    "unit_price"        DECIMAL(12,2) NOT NULL,
    "vat_rate"          DECIMAL(5,2) NOT NULL,
    "line_vat"          DECIMAL(12,2) NOT NULL,
    "line_total"        DECIMAL(12,2) NOT NULL,
    "unit_cost"         DECIMAL(12,2),
    "labour_hours"      DECIMAL(6,2),
    "labour_outsourced" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "QuoteVersionLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QuoteVersionLine_quote_version_id_position_idx" ON "QuoteVersionLine"("quote_version_id", "position");

ALTER TABLE "QuoteVersionLine" ADD CONSTRAINT "QuoteVersionLine_quote_version_id_fkey"
    FOREIGN KEY ("quote_version_id") REFERENCES "QuoteVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
