/**
 * Copy Excalidraw's font files out of node_modules into `public/` so the
 * Overlook canvas can self-host them.
 *
 * WHY THIS EXISTS: by default Excalidraw fetches its fonts from the esm.run
 * CDN at runtime. Our production CSP is `font-src 'self' data:
 * https://fonts.gstatic.com` with `connect-src 'self'`, so every one of those
 * requests is blocked and text on the canvas silently falls back to a system
 * font. (Same class of bug as the GrapesJS panel icons that vanished in prod
 * when their cdnjs stylesheet was blocked.) Setting
 * `window.EXCALIDRAW_ASSET_PATH` (see `apps/web/src/lib/overlookAssets.ts`)
 * points the loader at our own origin instead, which needs the files to
 * actually be there.
 *
 * A COPY rather than a committed vendor drop: the filenames are content-
 * hashed per Excalidraw release, so a committed copy silently goes stale on
 * the next version bump and you get the CDN fallback (i.e. no fonts) with no
 * error anywhere. Running off node_modules means the files can never
 * disagree with the installed package. The output directory is gitignored.
 *
 * XIAOLAI IS DELIBERATELY SKIPPED: it is a 13MB CJK family split into
 * hundreds of unicode-range subsets, versus ~512KB for the eight Latin
 * families combined. The site ships en + es, so it would be 25x the payload
 * for glyphs nothing renders. If CJK support ever matters, drop the family
 * from SKIP below.
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "..");
const REPO_ROOT = join(WEB_ROOT, "..", "..");
const OUT = join(WEB_ROOT, "public", "excalidraw-assets", "fonts");

/** Families not worth their bytes for an en+es site. See the header. */
const SKIP = new Set(["Xiaolai"]);

/**
 * Locate the installed package's fonts directory.
 *
 * Deliberately NOT `require.resolve`: the package ships an `exports` map that
 * doesn't expose `./package.json`, so resolution throws. Both candidates are
 * checked because pnpm puts the symlink under the workspace's own
 * node_modules, while a hoisted or npm/yarn install may only have the root.
 */
async function findFontsDir() {
  const candidates = [
    join(WEB_ROOT, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts"),
    join(REPO_ROOT, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts"),
  ];
  for (const c of candidates) {
    try {
      const s = await stat(c);
      if (s.isDirectory()) return c;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function main() {
  const src = await findFontsDir();
  if (!src) {
    // Not a hard failure: someone may be running in a checkout that hasn't
    // installed yet. The canvas degrades to system fonts rather than the
    // build dying.
    console.warn("[excalidraw-assets] fonts not found in node_modules, skipping sync");
    return;
  }

  // Wipe first so a version bump can't leave last release's hashed files
  // behind, slowly growing the image with dead bytes.
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  let copied = 0;
  for (const family of await readdir(src)) {
    if (SKIP.has(family)) continue;
    await cp(join(src, family), join(OUT, family), { recursive: true });
    copied++;
  }
  console.log(`[excalidraw-assets] synced ${copied} font families to public/excalidraw-assets/fonts`);
}

await main();
