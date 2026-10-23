#!/usr/bin/env bash
# US futures live dashboard — start / stop / status / sync / ensure
#   ./run.sh start      서버 + Cloudflare 퀵터널을 백그라운드로 올리고 URL을 출력
#   ./run.sh stop       둘 다 내린다
#   ./run.sh status     로컬 헬스체크 + 현재 공개 URL
#   ./run.sh sync       현재 터널 URL을 endpoint.json 에 써서 GitHub Pages로 올린다
#   ./run.sh ensure     죽어 있으면 다시 올리고, 주소가 바뀌었으면 endpoint.json 을 갱신한다
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8770}"
BIN="${CLOUDFLARED:-$HOME/bin/cloudflared}"
SITE_URL="https://moojunp.github.io/futures-dashboard/"

current_url() {
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$DIR/tunnel.log" 2>/dev/null | tail -1
}

# endpoint.json 을 갱신하고, 바뀐 경우에만 커밋·푸시한다.
publish() {
  url="$1"
  [ -n "$url" ] || return 1
  old=""
  [ -f "$DIR/endpoint.json" ] && old="$(sed -n 's/.*"apiBase": *"\([^"]*\)".*/\1/p' "$DIR/endpoint.json")"
  [ "$old" = "$url" ] && return 0
  printf '{\n  "apiBase": "%s",\n  "updated": "%s"\n}\n' \
    "$url" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/endpoint.json"
  echo "$url" > "$DIR/url.txt"
  if git -C "$DIR" rev-parse --git-dir > /dev/null 2>&1; then
    git -C "$DIR" add endpoint.json > /dev/null 2>&1
    git -C "$DIR" -c user.name=steve -c user.email=moojunp@gmail.com \
      commit -q -m "chore: point endpoint.json at $url" \
      -m "Co-authored-by: Attacca <attacca@walruslab.org>" > /dev/null 2>&1
    if git -C "$DIR" push -q origin HEAD:main > /dev/null 2>&1; then
      echo "published $url -> $SITE_URL"
    else
      echo "warn: endpoint.json updated locally, push failed"
    fi
  fi
}

case "${1:-status}" in
  start)
    cd "$DIR" || exit 1
    if pgrep -f "python3 server.py $PORT" > /dev/null; then
      echo "server already running on :$PORT"
    else
      setsid nohup python3 server.py "$PORT" > server.log 2>&1 &
      echo $! > server.pid
    fi
    if pgrep -f "cloudflared tunnel --url http://127.0.0.1:$PORT" > /dev/null; then
      echo "tunnel already running"
    else
      setsid nohup "$BIN" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate > tunnel.log 2>&1 &
      echo $! > tunnel.pid
    fi
    url=""
    for _ in $(seq 1 60); do
      url="$(current_url)"
      [ -n "$url" ] && break
      sleep 0.5
    done
    if [ -n "$url" ]; then
      echo "$url" > url.txt
      publish "$url"
      echo "UP  $url"
      echo "    $SITE_URL"
    else
      echo "tunnel URL not found yet — check $DIR/tunnel.log"
    fi
    ;;
  stop)
    for f in server.pid tunnel.pid; do
      [ -f "$DIR/$f" ] && kill "$(cat "$DIR/$f")" 2>/dev/null
      rm -f "$DIR/$f"
    done
    pkill -f "cloudflared tunnel --url http://127.0.0.1:$PORT" 2>/dev/null
    pkill -f "python3 server.py $PORT" 2>/dev/null
    echo "stopped"
    ;;
  sync)
    url="$(current_url)"
    [ -n "$url" ] || { echo "no tunnel url in $DIR/tunnel.log"; exit 1; }
    publish "$url"
    echo "sync: $url"
    ;;
  ensure)
    need=0
    curl -sf -m 5 "http://127.0.0.1:$PORT/healthz" > /dev/null 2>&1 || need=1
    pgrep -f "cloudflared tunnel --url http://127.0.0.1:$PORT" > /dev/null 2>&1 || need=1
    if [ "$need" = 1 ]; then
      echo "$(date -u +%FT%TZ) ensure: restarting"
      "$0" start
    else
      publish "$(current_url)"
    fi
    ;;
  status)
    echo -n "local: "; curl -s -m 5 "http://127.0.0.1:$PORT/healthz" || echo "down"
    echo
    [ -f "$DIR/url.txt" ] && echo "public: $(cat "$DIR/url.txt")" || echo "public: (none)"
    echo "site:   $SITE_URL"
    ;;
  *)
    echo "usage: $0 {start|stop|status|sync|ensure}"
    exit 1
    ;;
esac
