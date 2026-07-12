#!/usr/bin/env bash
#
# Compress the vendored "Urugal's Descent" audio assets (Spire Arcade game #2).
#
# The upstream game ships its music as 48 kHz / ~196 kbps stereo MP3, which is
# ~44 MB and dominates the vendored bundle (apps/web/public/games/urugal). For a
# chat-background web game that's overkill; this re-encodes everything to a
# leaner bitrate with ffmpeg, typically cutting the audio footprint by half or
# more with no audible difference in-game.
#
# Safe to run repeatedly: each file is only re-encoded when its current bitrate
# is meaningfully above the target (a guard via ffprobe), so a second run is a
# no-op and you never stack lossy passes. Each file is encoded to a temp file
# and atomically swapped in, so an interrupted run can't corrupt an asset.
#
# Requirements: ffmpeg + ffprobe on PATH (apt: `sudo apt install ffmpeg`).
#
# Usage:
#   scripts/compress-urugal-audio.sh [options]
#
# Options:
#   --dir <path>        Target static dir (default: the vendored urugal/static)
#   --music-kbps <n>    Music bitrate, stereo (default: 96)
#   --sfx-kbps <n>      Short SFX bitrate, mono (default: 64)
#   --dry-run           Report what would change; encode nothing
#   -h, --help          This help
#
set -euo pipefail

# Resolve the repo root from this script's location so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GAME_DIR="$REPO_ROOT/apps/web/public/games/urugal/static"
MUSIC_KBPS=96
SFX_KBPS=64
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)         GAME_DIR="$2"; shift 2 ;;
    --music-kbps)  MUSIC_KBPS="$2"; shift 2 ;;
    --sfx-kbps)    SFX_KBPS="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

for bin in ffmpeg ffprobe; do
  command -v "$bin" >/dev/null 2>&1 || { echo "error: '$bin' not found on PATH (apt install ffmpeg)" >&2; exit 1; }
done
[[ -d "$GAME_DIR" ]] || { echo "error: target dir not found: $GAME_DIR" >&2; exit 1; }

human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "${1}B"; }
file_size() { stat -c '%s' "$1"; }
# Container-level bitrate in bits/sec (reliable for VBR, unlike per-stream).
file_bitrate() { ffprobe -v error -show_entries format=bit_rate -of csv=p=0 "$1" 2>/dev/null || echo 0; }

total_before=0
total_after=0
changed=0
skipped=0

# encode <file> <target_kbps> <channels>
encode() {
  local f="$1" kbps="$2" ch="$3"
  local before target_bps cur_bps
  before=$(file_size "$f")
  total_before=$((total_before + before))
  target_bps=$((kbps * 1000))
  cur_bps=$(file_bitrate "$f"); [[ "$cur_bps" =~ ^[0-9]+$ ]] || cur_bps=0

  # Guard: skip if already at/below ~110% of target (idempotent re-runs).
  if [[ "$cur_bps" -gt 0 && "$cur_bps" -le $((target_bps * 110 / 100)) ]]; then
    total_after=$((total_after + before))
    skipped=$((skipped + 1))
    printf '  skip   %-34s %8s  (already %d kbps)\n' "$(basename "$f")" "$(human "$before")" "$((cur_bps / 1000))"
    return
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    total_after=$((total_after + before))
    printf '  would  %-34s %8s  -> ~%d kbps %s\n' "$(basename "$f")" "$(human "$before")" "$kbps" "$([[ $ch -eq 1 ]] && echo mono || echo stereo)"
    return
  fi

  local tmp="${f}.tmp.mp3"
  ffmpeg -nostdin -v error -y -i "$f" \
    -map 0:a:0 -c:a libmp3lame -b:a "${kbps}k" -ar 44100 -ac "$ch" \
    "$tmp"
  mv -f "$tmp" "$f"

  local after; after=$(file_size "$f")
  total_after=$((total_after + after))
  changed=$((changed + 1))
  printf '  done   %-34s %8s -> %8s\n' "$(basename "$f")" "$(human "$before")" "$(human "$after")"
}

echo "Compressing audio in: $GAME_DIR"
echo "  music: ${MUSIC_KBPS} kbps stereo   sfx: ${SFX_KBPS} kbps mono   ${DRY_RUN:+}$([[ $DRY_RUN -eq 1 ]] && echo '(dry run)')"
echo

if [[ -d "$GAME_DIR/sfx/music" ]]; then
  echo "Music:"
  while IFS= read -r -d '' f; do encode "$f" "$MUSIC_KBPS" 2; done \
    < <(find "$GAME_DIR/sfx/music" -type f -name '*.mp3' -print0 | sort -z)
  echo
fi

if [[ -d "$GAME_DIR/sfx/actions" ]]; then
  echo "Sound effects:"
  while IFS= read -r -d '' f; do encode "$f" "$SFX_KBPS" 1; done \
    < <(find "$GAME_DIR/sfx/actions" -type f -name '*.mp3' -print0 | sort -z)
  echo
fi

saved=$((total_before - total_after))
pct=0; [[ "$total_before" -gt 0 ]] && pct=$((saved * 100 / total_before))
echo "----------------------------------------------------------------"
printf 'Re-encoded %d file(s), skipped %d.\n' "$changed" "$skipped"
printf 'Audio total: %s -> %s  (saved %s, %d%%)\n' \
  "$(human "$total_before")" "$(human "$total_after")" "$(human "$saved")" "$pct"
if [[ "$DRY_RUN" -eq 1 ]]; then echo "(dry run — no files were modified)"; fi
