/**
 * File: prisma/seed.js
 * Last edited: 2025-11-10 22:55 Europe/London
 *
 * Purpose:
 *  - Seed a neutral UK tenant, site, role, admin user, tax rate,
 *    and a default "Labour (per hour)" catalogue item.
 *  - Nothing is hard-coded to a specific garage; all key values
 *    can be overridden with environment variables.
 *
 * Environment overrides (all optional):
 *  SEED_GROUP_NAME        (default: "Demo Garage Group")
 *  SEED_BILLING_EMAIL     (default: "billing@seed.local")
 *  SEED_SITE_NAME         (default: "Birmingham")
 *  SEED_ADMIN_EMAIL       (default: "admin@seed.local")
 *  SEED_ADMIN_NAME        (default: "Seed Admin")
 *  SEED_ADMIN_PASSHASH    (bcrypt hash; default: null)
 *  SEED_VAT_PERCENT       (default: 20.00)
 *  SEED_LABOUR_RATE_GBP   (default: 75.00)  // £/hr EX VAT
 */

const { PrismaClient, Prisma } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  // ---- Config (with safe defaults) ----
  const groupName   = process.env.SEED_GROUP_NAME      || 'Demo Garage Group';
  const billingEmail= process.env.SEED_BILLING_EMAIL   || 'billing@seed.local';
  const siteName    = process.env.SEED_SITE_NAME       || 'Birmingham';
  const adminEmail  = process.env.SEED_ADMIN_EMAIL     || 'admin@seed.local';
  const adminName   = process.env.SEED_ADMIN_NAME      || 'Seed Admin';
  const passHash    = process.env.SEED_ADMIN_PASSHASH  || null; // optional if using OAuth/magic links
  const vatPct      = parseFloat(process.env.SEED_VAT_PERCENT || '20.00');
  const labourRate  = parseFloat(process.env.SEED_LABOUR_RATE_GBP || '75.00'); // £/hr EX VAT

  // ---- 1) Group (tenant) ----
  const group = await prisma.group.upsert({
    where: { billing_email: billingEmail },
    update: {},
    create: {
      group_name: groupName,
      billing_email: billingEmail,
      trading_name: 'GreaseDesk Seed',
      vat_number: null,
      is_franchise_grp: false,
      tax_rates: {
        create: [{
          name: 'UK VAT',
          percentage: new Prisma.Decimal(vatPct),
          valid_from: new Date()
        }]
      },
      billing: {
        create: {
          plan_name: 'Core Pro',
          status: 'ok',
          retention_months: 24,
          included_sites: 1,
          active_sites_cnt: 1
        }
      }
    }
  });

  // ---- 2) Site (UK defaults) ----
  const existingSite = await prisma.site.findFirst({ where: { group_id: group.id, site_name: siteName }});
  const site = existingSite ?? await prisma.site.create({
    data: {
      group_id: group.id,
      site_name: siteName,
      address: 'Address not set',
      timezone: 'Europe/London',
      currency_code: 'GBP',
      locale: 'en-GB',
      pricing_display_mode: 'ex_vat',
      supported_countries: ['United Kingdom'],
      supported_currencies: ['GBP', 'EUR', 'USD']
    }
  });

  // ---- 3) Role (Admin) ----
  const existingRole = await prisma.role.findFirst({ where: { group_id: group.id, name: 'Admin' }});
  const role = existingRole ?? await prisma.role.create({
    data: {
      group_id: group.id,
      name: 'Admin',
      permissions: { admin: true, manageUsers: true, manageSites: true }
    }
  });

  // ---- 4) Admin user (STAFF) ----
  let user = await prisma.user.findUnique({ where: { email: adminEmail }});
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: adminEmail,
        name: adminName,
        passwordHash: passHash,     // leave null if auth flow does not need it
        role: 'STAFF',
        group_id: group.id,
        site_id: site.id,
        role_id: role.id,
        is_active: true
      }
    });
  }

  // ---- 5) Profit Centre (Workshop) ----
  const pc = await prisma.profitCentre.findFirst({ where: { site_id: site.id, name: 'Workshop' }});
  if (!pc) {
    await prisma.profitCentre.create({
      data: { site_id: site.id, name: 'Workshop', type: 'labour' }
    });
  }

  // ---- 6) Service Catalogue default: Labour (per hour) @ £75 ex VAT (configurable) ----
  const existingLabour = await prisma.serviceCatalogue.findFirst({
    where: { group_id: group.id, site_id: site.id, name: 'Labour (per hour)' }
  });
  if (!existingLabour) {
    await prisma.serviceCatalogue.create({
      data: {
        group_id: group.id,
        site_id: site.id,
        service_code: 'LABOUR_HR',
        name: 'Labour (per hour)',
        description: 'Standard labour rate per hour (ex VAT).',
        default_duration_minutes: 60,
        default_labour_rate: new Prisma.Decimal(labourRate),
        default_price: new Prisma.Decimal(labourRate),
        vat_rate: new Prisma.Decimal(vatPct),
        is_active: true
      }
    });
  }

  console.log('Seed complete →', {
    tenant: group.group_name,
    site: site.site_name,
    adminEmail: user.email,
    vatPercent: vatPct,
    labourRateGBP: labourRate
  });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
