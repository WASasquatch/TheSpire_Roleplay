import { create } from "zustand";
import type {
  ChatMessage,
  ProfileView,
  RoomOccupant,
  RoomSummary,
  Theme,
  UiHint,
} from "@thekeep/shared";
import { DEFAULT_THEME } from "@thekeep/shared";

export interface AuthMe {
  id: string;
  username: string;
  role: "user" | "mod" | "admin";
}

/**
 * Public site branding, fetched from /site (no auth required) on mount.
 * Drives the banner title, logo styling, BootSplash, AuthGate, and
 * `document.title`. Admin edits via /admin/settings refresh this.
 */
export interface SiteBranding {
  siteName: string;
  bannerCoverCss: string | null;
  logoColor: string | null;
  logoFont: string | null;
  /** Master switch for /auth/register; surfaced so AuthGate can hide the tab. */
  registrationOpen: boolean;
  /** Sanitized welcome HTML rendered above the splash login form. */
  welcomeHtml: string;
  /**
   * Sitewide default theme — used by the splash so the login screen renders
   * in the admin-configured palette instead of inheriting whatever theme the
   * last logged-in user happened to leave on documentElement.
   */
  defaultTheme: Theme;
}

export const DEFAULT_BRANDING: SiteBranding = {
  siteName: "The Spire",
  bannerCoverCss: null,
  logoColor: null,
  logoFont: null,
  registrationOpen: true,
  welcomeHtml: "",
  defaultTheme: DEFAULT_THEME,
};

const BRANDING_CACHE_KEY = "tk:branding:v1";

/**
 * Read the most recent branding from localStorage so the BootSplash and
 * AuthGate render with the right name on first paint, before /site replies.
 * On a fresh install (no cache), falls back to DEFAULT_BRANDING.
 *
 * Defensive: any parse error returns the default. Never throws.
 */
export function loadCachedBranding(): SiteBranding {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_BRANDING;
    const raw = localStorage.getItem(BRANDING_CACHE_KEY);
    if (!raw) return DEFAULT_BRANDING;
    const parsed = JSON.parse(raw) as Partial<SiteBranding>;
    return {
      siteName: typeof parsed.siteName === "string" ? parsed.siteName : DEFAULT_BRANDING.siteName,
      bannerCoverCss: typeof parsed.bannerCoverCss === "string" || parsed.bannerCoverCss === null
        ? parsed.bannerCoverCss
        : null,
      logoColor: typeof parsed.logoColor === "string" || parsed.logoColor === null
        ? parsed.logoColor
        : null,
      logoFont: typeof parsed.logoFont === "string" || parsed.logoFont === null
        ? parsed.logoFont
        : null,
      registrationOpen: typeof parsed.registrationOpen === "boolean"
        ? parsed.registrationOpen
        : DEFAULT_BRANDING.registrationOpen,
      welcomeHtml: typeof parsed.welcomeHtml === "string"
        ? parsed.welcomeHtml
        : DEFAULT_BRANDING.welcomeHtml,
      // Theme is structured; fall through to DEFAULT_THEME if the cached
      // payload is malformed instead of letting a partial value slip in.
      defaultTheme: parsed.defaultTheme && typeof parsed.defaultTheme === "object"
        ? { ...DEFAULT_BRANDING.defaultTheme, ...parsed.defaultTheme }
        : DEFAULT_BRANDING.defaultTheme,
    };
  } catch {
    return DEFAULT_BRANDING;
  }
}

export function saveCachedBranding(b: SiteBranding): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify(b));
  } catch { /* quota or privacy mode — silently skip */ }
}

interface ChatState {
  me: AuthMe | null;
  setMe: (me: AuthMe | null) => void;
  /** False until the initial /auth/me probe resolves. Prevents AuthGate flicker on reload. */
  authChecked: boolean;
  setAuthChecked: (b: boolean) => void;

  currentRoomId: string | null;
  setCurrentRoom: (id: string | null) => void;

  rooms: Record<string, RoomSummary>;
  occupants: Record<string, RoomOccupant[]>;
  messagesByRoom: Record<string, ChatMessage[]>;

  appendMessage: (msg: ChatMessage) => void;
  setMessages: (roomId: string, msgs: ChatMessage[]) => void;
  setOccupants: (roomId: string, occ: RoomOccupant[]) => void;
  setRoom: (room: RoomSummary) => void;
  upsertRoomList: (rooms: RoomSummary[]) => void;

  notice: { code: string; message: string } | null;
  setNotice: (n: { code: string; message: string } | null) => void;

  pendingHint: UiHint | null;
  setHint: (h: UiHint | null) => void;

  openProfile: ProfileView | null;
  setOpenProfile: (p: ProfileView | null) => void;

  /**
   * Editor target — null means closed.
   * mode "master" → edits the master account (no characterId).
   * mode "character" → edits the character with that id.
   */
  editor: { mode: "master" | "character"; characterId: string | null } | null;
  openEditor: (target: { mode: "master" | "character"; characterId: string | null }) => void;
  closeEditor: () => void;

  /** Local UI font-size step (cycled by the Size button). */
  fontStep: 0 | 1 | 2 | 3;
  setFontStep: (n: 0 | 1 | 2 | 3) => void;

  /** 0 = auto-refresh off; otherwise interval in seconds (5–3600). */
  refreshIntervalSec: number;
  setRefreshIntervalSec: (n: number) => void;

  /** Public site branding — see SiteBranding. */
  branding: SiteBranding;
  setBranding: (b: SiteBranding) => void;
}

export const useChat = create<ChatState>((set) => ({
  me: null,
  setMe: (me) => set({ me }),
  authChecked: false,
  setAuthChecked: (b) => set({ authChecked: b }),

  currentRoomId: null,
  setCurrentRoom: (id) => set({ currentRoomId: id }),

  rooms: {},
  occupants: {},
  messagesByRoom: {},

  appendMessage: (msg) =>
    set((s) => {
      const list = s.messagesByRoom[msg.roomId] ?? [];
      return {
        messagesByRoom: { ...s.messagesByRoom, [msg.roomId]: [...list, msg] },
      };
    }),

  setMessages: (roomId, msgs) =>
    set((s) => ({ messagesByRoom: { ...s.messagesByRoom, [roomId]: msgs } })),

  setOccupants: (roomId, occ) =>
    set((s) => ({ occupants: { ...s.occupants, [roomId]: occ } })),

  setRoom: (room) => set((s) => ({ rooms: { ...s.rooms, [room.id]: room } })),

  upsertRoomList: (list) =>
    set((s) => {
      const next = { ...s.rooms };
      for (const r of list) next[r.id] = r;
      return { rooms: next };
    }),

  notice: null,
  setNotice: (n) => set({ notice: n }),

  pendingHint: null,
  setHint: (h) => set({ pendingHint: h }),

  openProfile: null,
  setOpenProfile: (p) => set({ openProfile: p }),

  editor: null,
  openEditor: (target) => set({ editor: target }),
  closeEditor: () => set({ editor: null }),

  fontStep: 1,
  setFontStep: (n) => set({ fontStep: n }),

  refreshIntervalSec: 0,
  setRefreshIntervalSec: (n) => set({ refreshIntervalSec: n }),

  // Seed from localStorage so BootSplash/AuthGate render with the configured
  // site name on the very first paint (no flash before /site responds).
  branding: loadCachedBranding(),
  setBranding: (b) => {
    saveCachedBranding(b);
    set({ branding: b });
  },
}));
