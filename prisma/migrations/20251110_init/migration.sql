-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('STAFF', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('ok', 'grace', 'suspended');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('labour', 'part', 'misc');

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "trading_name" TEXT,
    "company_number" TEXT,
    "vat_number" TEXT,
    "address" TEXT,
    "billing_email" TEXT NOT NULL,
    "is_franchise_grp" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupBilling" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL,
    "status" "BillingStatus" NOT NULL,
    "retention_months" INTEGER NOT NULL,
    "included_sites" INTEGER NOT NULL,
    "active_sites_cnt" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupBilling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupFeature" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "feature_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "GroupFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "site_name" TEXT NOT NULL,
    "trading_name" TEXT,
    "company_number" TEXT,
    "vat_number" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/London',
    "currency_code" TEXT NOT NULL DEFAULT 'GBP',
    "locale" TEXT NOT NULL DEFAULT 'en-GB',
    "is_franchise" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pricing_display_mode" TEXT NOT NULL DEFAULT 'ex_vat',
    "supported_countries" JSONB,
    "supported_currencies" JSONB,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteFeature" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "feature_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SiteFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfitCentre" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfitCentre_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "passwordHash" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'STAFF',
    "group_id" TEXT,
    "site_id" TEXT,
    "role_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerId" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "registration" TEXT NOT NULL,
    "vin" TEXT,
    "make" TEXT,
    "model" TEXT,
    "derivative" TEXT,
    "fuel_type" TEXT,
    "transmission" TEXT,
    "engine_code" TEXT,
    "year" INTEGER,
    "mileage_at_create" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCatalogue" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "site_id" TEXT,
    "service_code" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "default_duration_minutes" INTEGER,
    "default_labour_rate" DECIMAL(12,2),
    "default_price" DECIMAL(12,2),
    "vat_rate" DECIMAL(5,2) DEFAULT 20.00,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceCatalogue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartCatalogue" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "part_number" TEXT NOT NULL,
    "description" TEXT,
    "brand" TEXT,
    "cost_price" DECIMAL(12,2),
    "sell_price" DECIMAL(12,2),
    "vat_rate" DECIMAL(5,2) DEFAULT 20.00,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartCatalogue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRate" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "name" TEXT,
    "percentage" DECIMAL(5,2) NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "profit_centre_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "booking_date" TIMESTAMP(3) NOT NULL,
    "start_time" TIMESTAMP(3),
    "end_time" TIMESTAMP(3),
    "service_id" TEXT,
    "resource_id" TEXT,
    "resource_type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'booked',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobCard" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "profit_centre_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "mechanic_assigned_id" TEXT,
    "odometer_in" INTEGER,
    "odometer_out" INTEGER,
    "labour_bill_numeric" DECIMAL(12,2) DEFAULT 0,
    "labour_cost_numeric" DECIMAL(12,2) DEFAULT 0,
    "parts_bill_numeric" DECIMAL(12,2) DEFAULT 0,
    "parts_cost_numeric" DECIMAL(12,2) DEFAULT 0,
    "completed_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "signed_off_by_customer" BOOLEAN NOT NULL DEFAULT false,
    "signed_off_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobCardPhoto" (
    "id" TEXT NOT NULL,
    "job_card_id" TEXT NOT NULL,
    "photo_type" TEXT,
    "file_url" TEXT NOT NULL,
    "uploaded_by" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobCardPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobCardItem" (
    "id" TEXT NOT NULL,
    "job_card_id" TEXT NOT NULL,
    "item_type" "ItemType" NOT NULL,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(12,2) NOT NULL DEFAULT 1.00,
    "unit_cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "vat_rate" DECIMAL(5,2) NOT NULL DEFAULT 20.00,
    "vat_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobCardItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "user_id" TEXT,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "diff_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "session_token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupBilling_group_id_key" ON "GroupBilling"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "GroupFeature_group_id_feature_key_key" ON "GroupFeature"("group_id", "feature_key");

-- CreateIndex
CREATE INDEX "Site_group_id_idx" ON "Site"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "SiteFeature_site_id_feature_key_key" ON "SiteFeature"("site_id", "feature_key");

-- CreateIndex
CREATE INDEX "ProfitCentre_site_id_idx" ON "ProfitCentre"("site_id");

-- CreateIndex
CREATE INDEX "Role_group_id_idx" ON "Role"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_customerId_key" ON "User"("customerId");

-- CreateIndex
CREATE INDEX "User_group_id_idx" ON "User"("group_id");

-- CreateIndex
CREATE INDEX "User_site_id_idx" ON "User"("site_id");

-- CreateIndex
CREATE INDEX "User_role_id_idx" ON "User"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_userId_key" ON "Customer"("userId");

-- CreateIndex
CREATE INDEX "Customer_group_id_site_id_idx" ON "Customer"("group_id", "site_id");

-- CreateIndex
CREATE INDEX "Vehicle_group_id_customer_id_idx" ON "Vehicle"("group_id", "customer_id");

-- CreateIndex
CREATE INDEX "Vehicle_registration_idx" ON "Vehicle"("registration");

-- CreateIndex
CREATE INDEX "ServiceCatalogue_group_id_site_id_idx" ON "ServiceCatalogue"("group_id", "site_id");

-- CreateIndex
CREATE INDEX "PartCatalogue_group_id_part_number_idx" ON "PartCatalogue"("group_id", "part_number");

-- CreateIndex
CREATE INDEX "TaxRate_group_id_idx" ON "TaxRate"("group_id");

-- CreateIndex
CREATE INDEX "Booking_group_id_site_id_profit_centre_id_customer_id_vehic_idx" ON "Booking"("group_id", "site_id", "profit_centre_id", "customer_id", "vehicle_id");

-- CreateIndex
CREATE INDEX "JobCard_group_id_site_id_profit_centre_id_customer_id_vehic_idx" ON "JobCard"("group_id", "site_id", "profit_centre_id", "customer_id", "vehicle_id");

-- CreateIndex
CREATE INDEX "JobCard_status_idx" ON "JobCard"("status");

-- CreateIndex
CREATE INDEX "JobCardPhoto_job_card_id_idx" ON "JobCardPhoto"("job_card_id");

-- CreateIndex
CREATE INDEX "JobCardItem_job_card_id_idx" ON "JobCardItem"("job_card_id");

-- CreateIndex
CREATE INDEX "AuditLog_group_id_idx" ON "AuditLog"("group_id");

-- CreateIndex
CREATE INDEX "AuditLog_user_id_idx" ON "AuditLog"("user_id");

-- CreateIndex
CREATE INDEX "Account_user_id_idx" ON "Account"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_provider_account_id_key" ON "Account"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "Session_session_token_key" ON "Session"("session_token");

-- CreateIndex
CREATE INDEX "Session_user_id_idx" ON "Session"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- AddForeignKey
ALTER TABLE "GroupBilling" ADD CONSTRAINT "GroupBilling_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupFeature" ADD CONSTRAINT "GroupFeature_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteFeature" ADD CONSTRAINT "SiteFeature_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfitCentre" ADD CONSTRAINT "ProfitCentre_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCatalogue" ADD CONSTRAINT "ServiceCatalogue_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCatalogue" ADD CONSTRAINT "ServiceCatalogue_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartCatalogue" ADD CONSTRAINT "PartCatalogue_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_profit_centre_id_fkey" FOREIGN KEY ("profit_centre_id") REFERENCES "ProfitCentre"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "Vehicle"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "ServiceCatalogue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_profit_centre_id_fkey" FOREIGN KEY ("profit_centre_id") REFERENCES "ProfitCentre"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "Vehicle"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_mechanic_assigned_id_fkey" FOREIGN KEY ("mechanic_assigned_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCardPhoto" ADD CONSTRAINT "JobCardPhoto_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCardPhoto" ADD CONSTRAINT "JobCardPhoto_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCardItem" ADD CONSTRAINT "JobCardItem_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

