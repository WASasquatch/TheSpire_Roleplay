#!/usr/bin/env bash
cd /home/was/projects/github/TheSpire_Roleplay/apps/web/src/components
for f in MessageList.tsx ThreadModal.tsx ProfileEditor.tsx AdminPanel.tsx; do
  sed -i '/^import { KeepPanelCorners } from/d' "$f"
done
echo done
