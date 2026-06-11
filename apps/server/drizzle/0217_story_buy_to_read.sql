-- "Buy to Read" paywall (migration 0217). When 1, non-purchasers see only a
-- short faded sample of the first chapter and must buy a copy (at the book's
-- copy_price) to read the rest. Enforced server-side in the chapter-body
-- route. Existing rows default to 0 (free to read). Admins/mods with the
-- `bypass_scriptorium_paywall` permission (seeded in 0218) read in full with
-- a warning.
ALTER TABLE stories ADD COLUMN buy_to_read INTEGER NOT NULL DEFAULT 0;
