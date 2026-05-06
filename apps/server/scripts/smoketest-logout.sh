#!/usr/bin/env bash
set -euo pipefail
cd /tmp
rm -f cookie.jar body.json
cat > body.json <<'EOF'
{"identifier":"NavSmoke","password":"hunter2hunter2"}
EOF

echo "--- login ---"
curl -sS -c cookie.jar -X POST http://127.0.0.1:3001/auth/login \
  -H 'Content-Type: application/json' \
  --data-binary @body.json
echo

echo "--- /auth/me (logged in) ---"
curl -sS -b cookie.jar http://127.0.0.1:3001/auth/me
echo

echo "--- /auth/logout ---"
curl -sS -b cookie.jar -c cookie.jar -X POST http://127.0.0.1:3001/auth/logout
echo

echo "--- /auth/me (after logout, should be 401) ---"
curl -sS -b cookie.jar -o /dev/null -w 'status=%{http_code}\n' http://127.0.0.1:3001/auth/me
