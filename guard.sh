#!/usr/bin/env bash
# 60초마다 run.sh ensure 를 돌린다. 세션과 분리해서 띄운다:
#   setsid nohup ~/futures-dashboard/guard.sh > ~/futures-dashboard/guard.log 2>&1 &
# 하는 일: 서버/터널이 죽으면 다시 올리고, 터널 주소가 바뀌면 endpoint.json 을
#         GitHub에 올려 고정 주소(moojunp.github.io/futures-dashboard/)가 따라가게 한다.
DIR="$(cd "$(dirname "$0")" && pwd)"
while true; do
  echo "── $(date -u +%FT%TZ)" >> "$DIR/guard.log"
  "$DIR/run.sh" ensure >> "$DIR/guard.log" 2>&1
  sleep 60
done
