#!/usr/bin/env bash
set -u
cd /home/was/projects/github/TheSpire_Roleplay/apps/web/src/lib/ornaments/styles
for f in medieval-sandstone.ts medieval-wood.ts modern-flat.ts modern-glass.ts modern-paper.ts scifi-cyberpunk.ts scifi-geiger.ts scifi-space-junk.ts; do
  sed -i 's|      texture: makeTexture(p),|      // texture omitted: tiled noise looked bad at viewport scale.|' "$f"
done
echo "done"
