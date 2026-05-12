#!/usr/bin/env bash
set -u
cd /home/was/projects/github/TheSpire_Roleplay/apps/web/src
# Remove every occurrence of `keep-panel-texture ` and `keep-panel-depth ` and
# the standalone `keep-panel-corners` from component class strings. The new
# frame system replaces these — components opt in via `keep-frame` instead.
for f in components/MessageList.tsx components/ThreadModal.tsx components/Composer.tsx components/AdminPanel.tsx components/ProfileEditor.tsx components/RoomsTree.tsx components/Banner.tsx App.tsx; do
  if [ -f "$f" ]; then
    sed -i 's/keep-panel-texture keep-panel-depth keep-panel-corners //g;
            s/keep-panel-texture keep-panel-depth //g;
            s/keep-panel-texture keep-panel-corners //g;
            s/keep-panel-depth keep-panel-corners //g;
            s/keep-panel-texture //g;
            s/keep-panel-depth //g;
            s/keep-panel-corners //g;
            s/ keep-panel-texture//g;
            s/ keep-panel-depth//g;
            s/ keep-panel-corners//g' "$f"
  fi
done
echo "done"
