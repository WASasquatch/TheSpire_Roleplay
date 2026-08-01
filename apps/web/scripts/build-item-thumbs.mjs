/**
 * Derive small WebP thumbnails for the bundled shop-item art.
 *
 * Every file in public/assets/items is a 600x600 alpha PNG at roughly 260KB,
 * and almost nowhere shows one at 600px. Catalog cards top out at 112px,
 * profile item tiles at 128px, and list rows at 32-48px, so a full trophy case
 * or shop grid was pulling ~10MB to paint icons. A 256px thumbnail covers all
 * of those at 2x retina and lands near 20KB.
 *
 * The originals are never touched, and the surfaces that DO render art large
 * (pets, which reach 256px on a wide container, and the pinned detail view)
 * keep pointing at them. See lib/itemThumbs.ts for the client half.
 *
 * Output is generated, not committed: it is gitignored and dockerignored, and
 * regenerated here during the web build, so neither the repo nor the Docker
 * build context grows. That matters because the context is already ~104MB and
 * shipping 213 more files would work against the deploy time this was meant to
 * help.
 *
 * Failure is always soft. sharp needs a platform-matched native binary, and a
 * dev box whose install only pulled the musl build cannot run it (the Alpine
 * builder, which is what actually matters, can). When that happens the thumbs
 * simply don't exist and the client falls back to the original PNG, which is
 * exactly today's behaviour.
 */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, "../public/assets/items");
const OUT_DIR = join(SRC_DIR, "thumbs");

/** Longest edge of a thumbnail. 128px is the largest non-pet display, so this
 *  is that at 2x; anything bigger is wasted bytes on every catalog page. */
const MAX_EDGE = 256;
/** WebP is lossy but keeps the alpha channel, which these cut-out items need.
 *  82 is visually clean at the sizes these are actually drawn. */
const QUALITY = 82;

async function main() {
  let sharp;
  try {
    ({ default: sharp } = await import("sharp"));
  } catch (err) {
    console.warn(
      `[item-thumbs] sharp unavailable, skipping thumbnails (${err instanceof Error ? err.message : err}).`,
    );
    console.warn("[item-thumbs] Icons will fall back to the full-size PNGs.");
    return;
  }

  let entries;
  try {
    entries = (await readdir(SRC_DIR)).filter((f) => f.toLowerCase().endsWith(".png"));
  } catch {
    console.warn("[item-thumbs] no item art directory, nothing to do.");
    return;
  }
  if (entries.length === 0) return;

  await mkdir(OUT_DIR, { recursive: true });

  let built = 0;
  let skipped = 0;
  let failed = 0;
  let srcBytes = 0;
  let outBytes = 0;

  for (const name of entries) {
    const src = join(SRC_DIR, name);
    const out = join(OUT_DIR, `${name.replace(/\.png$/i, "")}.webp`);
    const srcStat = await stat(src);
    srcBytes += srcStat.size;

    // Incremental: a rebuild with untouched art costs one stat per file.
    try {
      const outStat = await stat(out);
      if (outStat.mtimeMs >= srcStat.mtimeMs) {
        skipped += 1;
        outBytes += outStat.size;
        continue;
      }
    } catch {
      /* not built yet */
    }

    try {
      const buf = await sharp(src)
        .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: QUALITY, alphaQuality: 100 })
        .toBuffer();
      await writeFile(out, buf);
      built += 1;
      outBytes += buf.byteLength;
    } catch (err) {
      // One unreadable file must not fail the build; that icon keeps using
      // its original.
      failed += 1;
      console.warn(`[item-thumbs] skipped ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
  console.log(
    `[item-thumbs] ${built} built, ${skipped} up to date`
    + `${failed ? `, ${failed} failed` : ""}`
    + ` (${mb(srcBytes)} of art -> ${mb(outBytes)} of thumbnails)`,
  );
}

// Never fail the build over an optimization.
main().catch((err) => {
  console.warn(`[item-thumbs] skipped: ${err instanceof Error ? err.message : err}`);
});
