// This file is a re-export barrel. The schema is split into per-domain
// modules under ./schema/. Every table/type keeps its original export name
// so importers of "../db/schema.js" resolve to the same symbols.
export * from "./schema/users.js";
export * from "./schema/chat.js";
export * from "./schema/moderation.js";
export * from "./schema/commands.js";
export * from "./schema/site.js";
export * from "./schema/affiliates.js";
export * from "./schema/worlds.js";
export * from "./schema/stories.js";
export * from "./schema/messaging.js";
export * from "./schema/forums.js";
export * from "./schema/notifications.js";
export * from "./schema/servers.js";
export * from "./schema/earning.js";
export * from "./schema/permissions.js";
export * from "./schema/games.js";
export * from "./schema/email.js";
export * from "./schema/analytics.js";
