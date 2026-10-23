# US Futures Live Dashboard

미국 선물(ES·NQ·YM·VIX 등)과 코스피200·원/달러를 한 화면에서 보는 실시간 대시보드.
페이지는 **GitHub Pages 고정 주소**에서 열리고, 데이터는 Attacca Computer에서 도는
수집 서버가 Cloudflare 터널로 내보낸다.

- 고정 주소: <https://moojunp.github.io/futures-dashboard/>
- 데이터 소스: Sina Finance(CME 미니선물·S&P500 현물), Naver(KOSPI·KOSPI200·USD/KRW)
- 의존성 없음: 서버는 파이썬 표준 라이브러리만, 페이지는 CDN 없는 vanilla JS

## 구조

```
index.html  app.js  style.css     ← GitHub Pages가 서빙하는 화면 (고정 주소)
endpoint.json                     ← 지금 살아 있는 백엔드 주소 (run.sh가 자동 갱신)
server.py                         ← 수집·캐시·API 서버 (Attacca Computer에서 실행)
run.sh                            ← start / stop / status / sync / ensure
guard.sh                          ← 60초마다 ensure (자동 복구 + 주소 전파)
```

`app.js`는 페이지를 열 때 `endpoint.json`을 먼저 읽어 백엔드 주소를 알아내고,
`/healthz`로 살아 있는지 확인한 뒤 `/api/quotes`·`/api/chart`를 그 주소로 부른다.
백엔드는 CORS(`Access-Control-Allow-Origin: *`)를 허용하므로 Pages에서 바로 부를 수 있다.
로컬에서 `python3 server.py 8770`으로 페이지를 직접 열 때는 같은 오리진을 쓴다.

## 운영

```bash
~/futures-dashboard/run.sh start     # 서버 + 터널 기동, 주소를 Pages에 전파
~/futures-dashboard/run.sh status    # 로컬 헬스체크 + 현재 공개 주소
~/futures-dashboard/run.sh sync      # 터널 주소가 바뀌었을 때 endpoint.json 갱신·푸시
~/futures-dashboard/run.sh stop
setsid nohup ~/futures-dashboard/guard.sh > ~/futures-dashboard/guard.log 2>&1 &   # 자동 복구
```

퀵터널 주소는 재시작할 때마다 바뀌지만, `guard.sh`가 60초마다 확인해서 바뀐 주소를
`endpoint.json`에 커밋·푸시하므로 고정 주소는 그대로 쓸 수 있다. Pages 반영까지 1분 안팎.

## 한계

- Cloudflare 퀵터널은 SLA가 없는 실험용이라 언젠가 막힐 수 있다. 그때는 네임드 터널 +
  자체 도메인(예: `futures.cscshpg.com`)으로 옮기는 것이 정공법이다.
- Attacca Computer(VM)가 재부팅되면 `guard.sh`도 함께 죽는다. 재부팅 후 한 번
  `guard.sh`를 다시 띄우거나, VM 쪽에 systemd 유닛을 두어야 완전 무인 운용이 된다.
- 인증은 없다. 공개 시세만 있는 읽기 전용 화면이다.
