#!/bin/sh
set -eu
: "${OPENCODE_PASSWORD:?请设置 OPENCODE_PASSWORD}"
export OPENCODE_URL=http://127.0.0.1:4096
/app/node_modules/.bin/opencode serve --hostname 127.0.0.1 --port 4096 >/data/opencode.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT INT TERM
attempt=0
until node -e 'fetch("http://127.0.0.1:4096/api/info",{headers:{authorization:"Basic "+Buffer.from("opencode:"+process.env.OPENCODE_PASSWORD).toString("base64")}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; do
  attempt=$((attempt+1))
  if [ "$attempt" -ge 30 ]; then echo 'OpenCode 启动失败，请查看 /data/opencode.log' >&2; exit 1; fi
  sleep 1
done
node /app/dist/cli.js "$@"
