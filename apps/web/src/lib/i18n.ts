/**
 * Client i18n init (docs/I18N_PLAN.md Phase 0).
 *
 * One i18next instance for the whole SPA, mounted at the app entry via
 * <I18nextProvider>. The catalog lives in `packages/shared/locales/` so the
 * server can translate its own notices/emails from the same source of truth.
 *
 * Loading model:
 *   - `en` is the source locale and is BUNDLED EAGERLY (it is the app's
 *     fallback for every other locale, so it must never be a network race).
 *   - Other locales lazy-load on first switch via Vite's glob loaders.
 *   - ALL namespaces are pre-registered from the shared I18N_NAMESPACES list
 *     and the globs auto-pick-up any `<ns>.json` present per locale, so
 *     domain agents add keys by touching ONLY their own namespace file —
 *     never this init.
 *
 * Detection chain (first hit wins): the signed-in user's `users.locale`
 * (applied when /me/profile arrives, see applyServerLocale) → localStorage
 * `tk:locale` → navigator.language mapped onto SUPPORTED_LOCALES → "en".
 *
 * Pseudo-locale: setting localStorage `tk:locale` to "en-XX" by hand turns
 * every t() output into accent-folded, ~40%-padded, bracketed text
 * ("[Séñd~~]") so un-wrapped literals and layout overflow jump out during
 * sweeps. It is deliberately unreachable through the UI or the server pref.
 */
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import {
  DEFAULT_LOCALE,
  I18N_DEFAULT_NAMESPACE,
  I18N_NAMESPACES,
  PSEUDO_LOCALE,
  isSupportedLocale,
  matchSupportedLocale,
  type SupportedLocale,
} from "@thekeep/shared";
// Direct package-specifier import through the shared `./locales/*` exports
// entry. The glob below picks this same file up (Vite dedupes), but the
// specifier import fails the BUILD loudly if the catalog moves and the
// relative glob starts silently matching nothing.
import enCommon from "@thekeep/shared/locales/en/common.json";
import { useChat } from "../state/store.js";

export const LOCALE_STORAGE_KEY = "tk:locale";

/**
 * Switcher options, shared by the Menu row and the profile editor so both
 * selects stay in lockstep. Labels are autonyms (each language named in
 * itself) — those are never translated, so they live here rather than in
 * the catalog. The "System default" option is the null preference.
 */
export const LOCALE_CHOICES: ReadonlyArray<{ value: SupportedLocale; label: string }> = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
];

type LocaleBundle = Record<string, unknown>;

// Eager: every en namespace file rides the main bundle.
const EN_MODULES = import.meta.glob<{ default: LocaleBundle }>(
  "../../../../packages/shared/locales/en/*.json",
  { eager: true },
);
// Lazy: loaders for every locale file (en included; those entries are
// simply never invoked because en ships eagerly above).
const LAZY_MODULES = import.meta.glob<{ default: LocaleBundle }>(
  "../../../../packages/shared/locales/*/*.json",
);

/** "…/locales/<lng>/<ns>.json" → ["<lng>", "<ns>"]. */
function parseLocalePath(path: string): [string, string] | null {
  const m = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
  return m ? [m[1]!, m[2]!] : null;
}

function collectEnResources(): Record<string, LocaleBundle> {
  const out: Record<string, LocaleBundle> = {};
  for (const [path, mod] of Object.entries(EN_MODULES)) {
    const parsed = parseLocalePath(path);
    if (parsed) out[parsed[1]] = mod.default;
  }
  // Backstop for glob-path rot (see the specifier import's comment).
  out[I18N_DEFAULT_NAMESPACE] ??= enCommon;
  return out;
}

function readStoredLocale(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredLocale(locale: SupportedLocale | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (locale === null) localStorage.removeItem(LOCALE_STORAGE_KEY);
    else localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* quota or privacy mode - silently skip */
  }
}

/** The auto-detected locale when no explicit preference exists. */
function detectAutoLocale(): SupportedLocale {
  const nav = typeof navigator === "undefined" ? null : navigator.language;
  return matchSupportedLocale(nav) ?? DEFAULT_LOCALE;
}

function detectInitialLocale(): string {
  const stored = readStoredLocale();
  if (stored === PSEUDO_LOCALE) return PSEUDO_LOCALE;
  if (isSupportedLocale(stored)) return stored;
  return detectAutoLocale();
}

/* ---------- pseudo-locale postprocessor ---------- */

const ACCENT_FOLD: Record<string, string> = {
  a: "á", e: "é", i: "í", o: "ó", u: "ú", y: "ý", c: "ç", n: "ñ",
  A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", Y: "Ý", C: "Ç", N: "Ñ",
};

/** Accent-fold + pad ~40% + bracket, e.g. "Send" → "[Séñd~~]". Anything
 *  rendered WITHOUT brackets under en-XX is an un-wrapped literal. */
function pseudoize(value: string): string {
  if (value === "") return value;
  let folded = "";
  for (const ch of value) folded += ACCENT_FOLD[ch] ?? ch;
  const pad = Math.max(1, Math.round(value.length * 0.4));
  return `[${folded}${"~".repeat(pad)}]`;
}

/* ---------- instance ---------- */

export const i18n = i18next.createInstance();

// en and the pseudo-locale need no extra files, so they can be active from
// the first render; anything else boots as en and flips right after the
// lazy bundles land (invisible while the catalog is still being filled).
const initialLocale = detectInitialLocale();
const bootSync = initialLocale === DEFAULT_LOCALE || initialLocale === PSEUDO_LOCALE;

i18n
  .use(initReactI18next)
  .use({
    type: "postProcessor" as const,
    name: "pseudo",
    process(value: string): string {
      return i18n.language === PSEUDO_LOCALE ? pseudoize(value) : value;
    },
  })
  // initAsync:false = synchronous init; all en resources are already in
  // memory, so the first render never races the catalog.
  .init({
    resources: { en: collectEnResources() },
    lng: bootSync ? initialLocale : DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    ns: [...I18N_NAMESPACES],
    defaultNS: I18N_DEFAULT_NAMESPACE,
    // React already escapes interpolated values at render time.
    interpolation: { escapeValue: false },
    postProcess: ["pseudo"],
    initAsync: false,
  });

const loadedLocales = new Set<string>([DEFAULT_LOCALE]);

/**
 * Supersede guard for concurrent locale flips. Each applyLocale call bumps
 * the generation and records itself as the pending target; when its lazy
 * chunk loads finish it only calls changeLanguage if no NEWER call started
 * meanwhile. Without this, two overlapping switches (double-click in the
 * Menu, or the boot-time device-pref load racing the /me account pref)
 * could land out of order and strand the UI on a language that no store
 * (localStorage / zustand / account) claims is active.
 */
let localeGeneration = 0;
let pendingLocale: string | null = null;

/** The locale the UI is on, or is guaranteed to land on next (in-flight). */
function activeOrPendingLocale(): string {
  return pendingLocale ?? i18n.language;
}

// Boot-time detection for a non-en device preference (stored or from
// navigator.language): load its bundles and flip as soon as they arrive.
if (!bootSync) void applyLocale(initialLocale);

/** Lazy-load every namespace file present for `lng`, then switch to it. */
async function applyLocale(lng: string): Promise<void> {
  const generation = ++localeGeneration;
  pendingLocale = lng;
  // The pseudo-locale has no files of its own: resolution falls back to the
  // en catalog and the postprocessor mangles the output.
  if (lng !== PSEUDO_LOCALE && !loadedLocales.has(lng)) {
    const loads: Array<Promise<void>> = [];
    for (const [path, load] of Object.entries(LAZY_MODULES)) {
      const parsed = parseLocalePath(path);
      if (!parsed || parsed[0] !== lng) continue;
      loads.push(
        load().then((mod) => {
          i18n.addResourceBundle(lng, parsed[1], mod.default, true, true);
        }),
      );
    }
    await Promise.all(loads);
    loadedLocales.add(lng);
  }
  // A newer applyLocale started while our chunks loaded — its target wins.
  if (generation !== localeGeneration) return;
  await i18n.changeLanguage(lng);
  if (generation === localeGeneration) pendingLocale = null;
}

/**
 * Explicit locale switch from the UI (Menu / profile editor). Flips i18next
 * live (no reload), persists the choice per-device, mirrors it into the
 * store, and — when signed in — PUTs it to /me/profile so it follows the
 * account across devices. `null` = "System default": clears both stores and
 * re-detects from the browser.
 */
export async function changeLocale(locale: SupportedLocale | null): Promise<void> {
  const pick = ++explicitPickGeneration;
  explicitChangesInFlight += 1;
  try {
    writeStoredLocale(locale);
    useChat.getState().setLocalePref(locale);
    await applyLocale(locale ?? detectAutoLocale());
    // A newer pick started while our chunks loaded: only the LATEST pick
    // may write the account, or two rapid switches could land their PUTs
    // out of order and persist the abandoned choice.
    if (pick !== explicitPickGeneration) return;
    if (useChat.getState().me) {
      try {
        await fetch("/me/profile", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ locale }),
        });
      } catch {
        /* offline / expired session - the local flip already applied */
      }
    }
  } finally {
    explicitChangesInFlight -= 1;
  }
}

/**
 * While an explicit changeLocale is running, a concurrently-resolving
 * /me/profile refetch (e.g. the themeVersion-keyed one) can carry the
 * locale from BEFORE the user's pick. applyServerLocale defers to the
 * in-flight explicit change instead of flipping the UI back and
 * overwriting the just-written localStorage value; once changeLocale's
 * PUT lands, the account holds the pick and later payloads agree.
 */
let explicitChangesInFlight = 0;
let explicitPickGeneration = 0;

/**
 * Seed from the /me/profile payload (users.locale). A saved account locale
 * outranks this device's earlier auto-detection, so apply it when it
 * differs from what is active OR in flight; null means "auto" — and since
 * the only writers of tk:locale are changeLocale (always mirrored to the
 * account) and this function, a stored value that contradicts a null
 * account pref is another account's residue on this device, so it is
 * cleared and the auto-detected language restored (otherwise account B
 * inherits account A's Spanish). A hand-set pseudo-locale sweep
 * (localStorage "en-XX") wins over the account pref so a /me refetch
 * can't yank a dev out of it.
 */
export function applyServerLocale(saved: string | null | undefined): void {
  if (explicitChangesInFlight > 0) return;
  const pref = isSupportedLocale(saved) ? saved : null;
  useChat.getState().setLocalePref(pref);
  if (readStoredLocale() === PSEUDO_LOCALE) return;
  if (!pref) {
    writeStoredLocale(null);
    const auto = detectAutoLocale();
    if (activeOrPendingLocale() !== auto) void applyLocale(auto);
    return;
  }
  writeStoredLocale(pref);
  if (activeOrPendingLocale() !== pref) void applyLocale(pref);
}
