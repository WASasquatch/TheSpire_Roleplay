import type { ChatMessage } from "@thekeep/shared";
import { i18n } from "./i18n.js";
import { isMentioned } from "./mentions.js";

export type NotifyPref = "off" | "mentions" | "all";

/**
 * Plaintext view of a message body for toast copy + mention matching.
 * Rich-HTML rows (format 'html', migration 0352) carry markup in
 * `body`; the server-derived `bodyText` mirror is the readable text.
 */
function plainBody(msg: ChatMessage): string {
  return msg.format === "html" ? (msg.bodyText ?? "") : msg.body;
}

/**
 * Browser support is hit-and-miss - older browsers and Safari embedded webviews
 * may not have the API. All callers must guard via `isSupported()`.
 */
export function isSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function permission(): NotificationPermission | "unsupported" {
  if (!isSupported()) return "unsupported";
  return Notification.permission;
}

/**
 * Request permission. Browsers REQUIRE this be called from a user gesture,
 * which is why we expose this as an explicit button instead of asking on
 * mount. Returns the resolved permission state.
 */
export async function requestPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!isSupported()) return "unsupported";
  return Notification.requestPermission();
}

/**
 * Decide whether a given message should fire a desktop toast, given the
 * user's preference and current focus state. Pure function - testable.
 *
 * Skips:
 *   - your own messages (msg.userId === selfUserId)
 *   - system messages (kind=system) regardless of pref
 *   - tab is currently focused (document.hidden === false)
 *   - pref="off"
 *   - pref="mentions" + message isn't a whisper, announcement, OR an
 *     @mention of one of `selfNames` (master username / active character).
 *
 * Self-mentions are treated as "mention-grade" alongside whispers and
 * announcements - they ride the same notification budget.
 */
export function shouldNotify(
  msg: ChatMessage,
  selfUserId: string | null,
  pref: NotifyPref,
  hidden: boolean,
  selfNames: ReadonlyArray<string> = [],
): boolean {
  if (!hidden) return false;
  if (pref === "off") return false;
  if (msg.userId === selfUserId) return false;
  if (msg.kind === "system") return false;
  if (pref === "mentions") {
    if (msg.kind === "whisper" || msg.kind === "announce") return true;
    return isMentioned(plainBody(msg), selfNames);
  }
  // pref === "all"
  return true;
}

/**
 * Format a message into a (title, body) pair appropriate for the
 * Notification API. When the message mentions the viewer (selfNames),
 * the title is prefixed with "🔔 mention" so the toast reads as a
 * mention even for ordinary say/ooc lines.
 */
export function formatNotification(
  msg: ChatMessage,
  selfNames: ReadonlyArray<string> = [],
): { title: string; body: string } {
  const mentioned = isMentioned(plainBody(msg), selfNames);
  switch (msg.kind) {
    case "whisper":
      return {
        title: i18n.t("common:notify.whispers", { name: msg.displayName }),
        body: plainBody(msg),
      };
    case "announce":
      return {
        title: mentioned
          ? i18n.t("common:notify.announcementMention")
          : i18n.t("common:notify.announcement"),
        body: plainBody(msg),
      };
    case "me":
      return {
        title: mentioned
          ? i18n.t("common:notify.nameMention", { name: msg.displayName })
          : i18n.t("common:appName"),
        body: `${msg.displayName} ${plainBody(msg)}`,
      };
    case "roll":
      return {
        title: i18n.t("common:appName"),
        body: i18n.t("common:notify.rolls", { name: msg.displayName, body: plainBody(msg) }),
      };
    case "say":
    case "ooc":
    default:
      return {
        title: mentioned
          ? i18n.t("common:notify.mentionsYou", { name: msg.displayName })
          : msg.displayName,
        body: plainBody(msg),
      };
  }
}

/**
 * Fire a desktop toast for a message. Quietly does nothing if permission
 * isn't granted (we don't want to spam the user with prompts).
 *
 * `selfNames` (master username + active character name, lower-cased) lets
 * the formatter prefix mention-grade messages so they read as mentions in
 * the OS toast tray.
 */
export function fire(msg: ChatMessage, selfNames: ReadonlyArray<string> = []): void {
  if (!isSupported() || Notification.permission !== "granted") return;
  const { title, body } = formatNotification(msg, selfNames);
  const mentioned = isMentioned(plainBody(msg), selfNames);
  try {
    const n = new Notification(title, {
      body,
      icon: "/favicon.ico",
      // tag groups same-author whispers so we don't stack a thousand toasts
      // when someone is chatty; the latest replaces the prior.
      tag: `tk-${msg.userId}-${msg.kind}`,
      // Whispers, announcements, and self-mentions buzz the desktop.
      // Background chatter stays silent.
      silent: !mentioned && msg.kind !== "whisper" && msg.kind !== "announce",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* Some browsers throw on construction in obscure cases - swallow. */
  }
}
