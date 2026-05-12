#!/usr/bin/env bash
set -u
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
cd /home/was/projects/github/TheSpire_Roleplay/apps/web
npx tsc --noEmit 2>&1 | head -40
