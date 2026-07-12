#!/usr/bin/env bash
# Canonical Node-v22 nvm bin path, shared by the deploy/dev shell scripts.
# The system Node 18 on this WSL dev box can't run better-sqlite3 (built
# against v22), so every script that shells out to node/pnpm must prepend
# this to PATH. This file shares ONLY the path string: each script keeps
# its own guard/warning/export policy on purpose (local-deploy warns,
# ship is silent, the dev helpers export unconditionally). Source it, then
# apply your own export.
NODE_V22_BIN="/home/was/.nvm/versions/node/v22.22.2/bin"
