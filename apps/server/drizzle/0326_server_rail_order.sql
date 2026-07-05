-- 0326: Per-user server-rail ordering. A user can drag-reorder their server
-- rail (Discord-style); the arrangement is PRIVATE to them. Stored as a JSON
-- array of server ids on the user row. Servers not listed fall to the end in
-- their default order. Additive + nullable — absent/NULL means "default order",
-- so every existing user keeps today's ordering until they drag something.
ALTER TABLE users ADD COLUMN rail_order_json TEXT;
