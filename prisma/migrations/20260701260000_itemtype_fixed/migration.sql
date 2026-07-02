-- Add the 'fixed' item type (published fixed-price service bundles). ADDITIVE: a single enum
-- ADD VALUE. No table is created/altered/dropped; no column changes; no existing row changes —
-- JobCardItem.item_type / CatalogueItem.item_type simply gain a newly-permitted value.
ALTER TYPE "ItemType" ADD VALUE 'fixed';
