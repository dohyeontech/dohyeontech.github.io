/* ============================================================
   DOHYEON TECH BRIEF — /radar/ live kimp + funding radar
   100% client-side. No server, no storage, no cookies, no keys.

   Upbit  : 실시간 스트림(wss)으로 원화 시세 수신.
            REST /v1/ticker 는 브라우저(Origin) 요청을 1회/초 수준으로
            조여 429(too_many_requests)를 돌려주고 그 응답에는
            Access-Control-Allow-Origin 이 없어 fetch 가 CORS 오류가 된다.
            그래서 300종을 3번에 나눠 15초마다 폴링하는 방식은 성립하지 않는다.
            REST 는 마켓 목록(/v1/market/all)만 쓰고, 실패 시에만 분당 3회
            간격으로 ticker 를 보조 수집한다.
   Bithumb: public/ticker/ALL_KRW 한 번으로 KRW 마켓 전체 현재가·24h 거래대금·
            등락률을 받아 업비트와 교차 확인한다(응답 헤더 Access-Control-Allow-Origin: *).
   Binance: 현물 ticker/price + 선물 premiumIndex 를 15초마다.
   FX     : 공개 환율 API 3곳을 순서대로.
   ============================================================ */
(function () {
  'use strict';

  var API = {
    upbitMarkets: 'https://api.upbit.com/v1/market/all',
    upbitTicker: 'https://api.upbit.com/v1/ticker?markets=',
    bithumbAll: 'https://api.bithumb.com/public/ticker/ALL_KRW',
    bithumbV1: 'https://api.bithumb.com/v1/ticker?markets=',
    binanceSpot: 'https://api.binance.com/api/v3/ticker/price',
    binanceSpotMirror: 'https://data-api.binance.vision/api/v3/ticker/price',
    binanceFutures: 'https://fapi.binance.com/fapi/v1/premiumIndex',
    gateFutures: 'https://api.gateio.ws/api/v4/futures/usdt/contracts'
  };
  var WS_URL = 'wss://api.upbit.com/websocket/v1';

  var FX_SOURCES = [
    { id: 'open.er-api.com', url: 'https://open.er-api.com/v6/latest/USD',
      parse: function (d) { return { rate: d && d.rates && d.rates.KRW, date: (d && d.time_last_update_utc) || '' }; } },
    { id: 'currency-api.pages.dev', url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
      parse: function (d) { return { rate: d && d.usd && d.usd.krw, date: (d && d.date) || '' }; } },
    { id: 'fawazahmed0/currency-api', url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      parse: function (d) { return { rate: d && d.usd && d.usd.krw, date: (d && d.date) || '' }; } },
    { id: 'frankfurter.dev', url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW',
      parse: function (d) { return { rate: d && d.rates && d.rates.KRW, date: (d && d.date) || '' }; } }
  ];

  var POLL_MS = 15000;        // 바이낸스 현물·선물·환율 갱신 주기
  var MARKETS_TTL = 600000;   // 업비트 마켓 목록 캐시 10분
  var FX_TTL = 300000;        // 환율 캐시 5분
  var BITHUMB_TTL = 20000;    // 빗썸 전체 시세 캐시 20초
  var REST_SWEEP_MS = 60000;  // 스트림 실패 시 보조 수집 시작 간격 (3청크 = 분당 3회)
  var UPBIT_GAP = 10000;      // 업비트 교차 출처 REST는 분당 6회 수준이라 호출 사이를 10초 띄운다
  var VOL_FLOOR = 1e8;        // 최고/최저 김프 집계: 24h 거래대금 1억 원
  var COLLISION_PCT = 30;     // |김프| 30% 초과는 티커 충돌(다른 자산) 의심값으로 본다

  // 급변 포착 기준
  var SPIKE_CHG_24H = 5;      // 24시간 등락률 절대값 %
  var SPIKE_FAST_PCT = 1.2;   // 체류 중 약 1분 가격 변동 %
  var SPIKE_PREM_PP = 0.8;    // 체류 중 약 1분 김프 변동 %p
  var FAST_MIN_AGE = 45000;   // 단기 변동을 재는 최소 경과 시간 (ms)

  var VOL_TAB = 1e10;         // 거래대금 100억
  var FUND_TAB = 0.01;        // 펀딩비 0.01%

  var S = {
    markets: null, marketsAt: 0,
    tickers: {},                    // base -> {trade_price, signed_change_rate, acc_trade_price_24h}
    spot: null, spotSource: '',
    fut: null, futSource: '',
    bithumb: null, bithumbAt: 0, bithumbTrying: false, bithumbErr: '', bithumbSource: '',
    fx: null, fxAt: 0,
    hist: {},                       // base -> { p: [[ts, price]], prem: [[ts, prem]] }
    rows: [], compared: 0, unmatched: 0,
    sort: 'premium-desc', query: '', tab: 'all', paused: false,
    polling: false, lastPollAt: 0, nextAt: 0,
    req: [], polls: 0, dirty: false,
    ws: null, wsState: 'idle', wsMsgs: 0, wsLastAt: 0, wsAttempts: 0, wsFallback: false, wsErr: '',
    marketsTries: 0, marketsErr: '', marketsTrying: false, marketsLastTry: 0, sweeping: false, wsTriedAt: 0, wsFailAt: 0,
    upbitAt: 0, upbitQueue: Promise.resolve(),
    restSweepAt: 0, windowErrors: []
  };

  var el = {};
  var BTC_NEXT = 0;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------------------------------------------------------- numbers */
  function nf(v, dp) {
    if (v == null || !isFinite(v)) return '--';
    return v.toLocaleString('ko-KR', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function fmtKrw(v) {
    if (!(v > 0)) return '--';
    var dp = v >= 100 ? 0 : v >= 10 ? 1 : v >= 1 ? 2 : v >= 0.1 ? 3 : v >= 0.01 ? 4 : 8;
    return nf(v, dp);
  }
  function fmtUsd(v) {
    if (!(v > 0)) return '--';
    var dp = v >= 100 ? 2 : v >= 1 ? 3 : v >= 0.01 ? 5 : 8;
    return nf(v, dp);
  }
  function fmtRate(v) { return v == null ? '--' : nf(v, 2); }
  function pct(v, dp) {
    if (v == null || !isFinite(v)) return '--';
    if (Math.abs(v) < Math.pow(10, -dp) / 2) v = 0;
    var s = Math.abs(v).toFixed(dp);
    if (v > 0) return '+' + s + '%';
    if (v < 0) return '-' + s + '%';
    return s + '%';
  }
  function signCls(v) {
    if (v == null || !isFinite(v)) return 'dim';
    if (v > 1e-9) return 'pos';
    if (v < -1e-9) return 'neg';
    return 'zero';
  }
  function fmtVol(v) { return (v > 0) ? nf(v / 1e8, 1) : '--'; }
  function countdown(ms) {
    if (!(ms > 0)) return '--';
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return h + '시간 ' + m + '분 후';
    if (m > 0) return m + '분 ' + sec + '초 후';
    return sec + '초 후';
  }
  function clockOf(ts) {
    if (!ts) return '--';
    try {
      return new Date(ts).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }) + ' KST';
    } catch (e) { return '--'; }
  }
  function stamp(ts) {
    if (!ts) return '--';
    try {
      return new Date(ts).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Seoul' });
    } catch (e) { return '--'; }
  }

  /* ---------------------------------------------------------- fetch */
  function request(url, timeout) {
    var started = (window.performance && performance.now) ? performance.now() : Date.now();
    return new Promise(function (resolve, reject) {
      var done = false;
      var ctrl = window.AbortController ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (ctrl) { try { ctrl.abort(); } catch (e) {} }
        reject(new Error('timeout'));
      }, timeout || 12000);

      var opts = { cache: 'no-store' };
      if (ctrl) opts.signal = ctrl.signal;

      fetch(url, opts).then(function (res) {
        if (!res.ok) {
          var err = new Error('HTTP ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.json();
      }).then(function (data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ data: data, ms: Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - started) });
      }).catch(function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function track(name, url, promise) {
    return promise.then(function (r) {
      S.req.push({ name: name, url: url, ok: true, status: 200, ms: r.ms, at: Date.now() });
      if (S.req.length > 40) S.req = S.req.slice(-40);
      return r.data;
    }, function (err) {
      S.req.push({ name: name, url: url, ok: false, error: String((err && err.message) || err), at: Date.now() });
      if (S.req.length > 40) S.req = S.req.slice(-40);
      throw err;
    });
  }

  /* ---------------------------------------------------------- upbit: REST queue */
  /* 같은 오리진에서 온 요청은 업비트가 분당 6회 수준으로 제한하고, 초과분 429에는
     Access-Control-Allow-Origin 이 없어 fetch 가 CORS 오류가 된다. 그래서 업비트로 가는
     REST 호출을 한 줄로 세우고 10초 간격을 지킨다. */
  function upbitSlot() {
    S.upbitQueue = S.upbitQueue.then(function () {
      var wait = Math.max(0, UPBIT_GAP - (Date.now() - S.upbitAt));
      return sleep(wait).then(function () { S.upbitAt = Date.now(); });
    });
    return S.upbitQueue;
  }

  function upbitFetch(name, url, timeout) {
    return upbitSlot().then(function () { return track(name, url, request(url, timeout)); });
  }

  /* ---------------------------------------------------------- upbit: markets */
  function loadMarkets() {
    return upbitFetch('upbit-markets', API.upbitMarkets, 15000).then(function (list) {
      var out = [];
      (list || []).forEach(function (x) {
        if (!x || typeof x.market !== 'string' || x.market.indexOf('KRW-') !== 0) return;
        out.push({ base: x.market.slice(4), code: x.market, korean: x.korean_name || x.market.slice(4), english: x.english_name || '' });
      });
      S.marketsAt = Date.now();
      return out;
    });
  }

  /* 업비트 마켓 목록은 브라우저(Origin) 요청 할당량이 빠듯해 실패가 나기 쉽다.
     실패하면 8초 간격으로 다시 시도하고, 성공해야 스트림을 연결한다. */
  function ensureMarkets(force) {
    if (S.marketsTrying) return Promise.resolve(S.markets);
    if (!force && S.markets && (Date.now() - S.marketsAt) < MARKETS_TTL) return Promise.resolve(S.markets);
    S.marketsTrying = true;
    S.marketsTries++;
    S.marketsLastTry = Date.now();
    return loadMarkets().then(function (list) {
      S.marketsTrying = false;
      if (!list || !list.length) {
        S.marketsErr = 'empty list';
        return S.markets;
      }
      S.markets = list;
      S.marketsErr = '';
      connectUpbit();
      updateStatus();
      return S.markets;
    }, function (err) {
      S.marketsTrying = false;
      S.marketsErr = String((err && err.message) || err);
      updateStatus();
      return S.markets;
    });
  }

  /* ---------------------------------------------------------- upbit: live stream */
  function wsAlive() {
    return S.ws && S.ws.readyState === 1;
  }

  function connectUpbit() {
    if (!S.markets || !S.markets.length) return;
    if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;

    S.wsState = 'connecting';
    var ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      S.wsState = 'failed';
      scheduleWsRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    S.ws = ws;

    ws.onopen = function () {
      S.wsState = 'open';
      S.wsAttempts = 0;
      S.wsFallback = false;
      S.wsFailAt = 0;
      // 같은 type 구독 요청은 마지막 것만 유효하므로 300종을 한 메시지로 보낸다.
      var codes = S.markets.map(function (m) { return m.code; });
      try {
        ws.send(JSON.stringify([{ ticket: 'dohyeon-radar' }, { type: 'ticker', codes: codes }]));
      } catch (e) {}
      updateStatus();
      publishDiag();
    };

    ws.onmessage = function (ev) {
      var text = ev.data;
      if (typeof text !== 'string') {
        try { text = new TextDecoder('utf-8').decode(new Uint8Array(ev.data)); } catch (e) { return; }
      }
      var d;
      try { d = JSON.parse(text); } catch (e) { return; }
      if (!d || d.type !== 'ticker' || typeof d.code !== 'string') return;
      var base = d.code.slice(4);
      S.tickers[base] = {
        market: d.code,
        trade_price: d.trade_price,
        signed_change_rate: d.signed_change_rate,
        acc_trade_price_24h: d.acc_trade_price_24h
      };
      recordTick(base, parseFloat(d.trade_price));
      S.wsMsgs++;
      S.wsLastAt = Date.now();
      S.dirty = true;
    };

    ws.onerror = function () {
      if (S.wsState !== 'open') { S.wsState = 'failed'; S.wsErr = S.wsErr || 'error event'; }
    };

    ws.onclose = function (ev) {
      S.wsState = S.wsMsgs ? 'closed' : 'failed';
      S.wsErr = 'close ' + ((ev && ev.code) || '?') + ((ev && ev.reason) ? ' ' + ev.reason : '');
      S.ws = null;
      if (!wsAlive()) scheduleWsRetry();
      updateStatus();
    };
  }

  function scheduleWsRetry() {
    S.wsAttempts++;
    S.wsTriedAt = Date.now();
    S.wsFailAt = S.wsFailAt || Date.now();
    if (S.wsAttempts >= 3) S.wsFallback = true;   // 3회 실패하면 REST 보조 수집으로 내려간다
    var wait = Math.min(30000, 2000 * Math.pow(2, Math.min(S.wsAttempts - 1, 4)));
    if (S.wsAttempts === 1) wait = 2000;
    updateStatus();
    setTimeout(function () {
      if (!wsAlive()) connectUpbit();
    }, wait);
  }

  var PRIORITY = ['BTC', 'ETH', 'XRP', 'USDT', 'SOL', 'DOGE', 'ADA', 'TRX', 'LINK', 'AVAX', 'BCH', 'SUI', 'HYPE', 'ENA', 'XLM', 'DOT'];

  function priorityCodes() {
    // 주요 코인이 첫 청크에 오도록 앞으로 당긴다 — 첫 요청이 성공하면 요약 카드가 바로 채워진다.
    var byBase = {};
    S.markets.forEach(function (m) { byBase[m.base] = m.code; });
    var head = [];
    PRIORITY.forEach(function (b) { if (byBase[b]) { head.push(byBase[b]); delete byBase[b]; } });
    var rest = S.markets.filter(function (m) { return byBase[m.base]; }).map(function (m) { return m.code; });
    return head.concat(rest);
  }

  function restSweep() {
    if (!S.markets || !S.markets.length) return;
    if (S.wsFailAt && Date.now() - S.wsFailAt < 20000) return;   // 스트림 첫 실패 직후엔 업비트 REST 할당량을 건드리지 않는다
    if (S.sweeping) return;
    if (Date.now() - S.restSweepAt < REST_SWEEP_MS) return;
    S.sweeping = true;
    S.restSweepAt = Date.now();

    var codes = priorityCodes();
    var chunks = [];
    for (var i = 0; i < codes.length; i += 100) chunks.push(codes.slice(i, i + 100));

    var chain = Promise.resolve();
    chunks.forEach(function (chunk, idx) {
      chain = chain.then(function () {
        if (wsAlive()) return null;   // 그새 스트림이 살아나면 REST는 건너뛴다
        var url = API.upbitTicker + chunk.join(',');
        return upbitFetch('upbit-rest-' + (idx + 1), url, 15000).then(function (list) {
          (list || []).forEach(function (t) {
            if (!t || !t.market) return;
            S.tickers[t.market.slice(4)] = {
              market: t.market, trade_price: t.trade_price,
              signed_change_rate: t.signed_change_rate,
              acc_trade_price_24h: t.acc_trade_price_24h
            };
            recordTick(t.market.slice(4), parseFloat(t.trade_price));
          });
          S.dirty = true;
        }).catch(function () { return null; });
      });
    });
    chain.then(function () {
      S.sweeping = false;
      computeRows(); renderKpis(); renderTable(); updateStatus(); publishDiag();
    });
  }

  /* ---------------------------------------------------------- bithumb */
  /* 빗썸은 KRW 마켓 전체를 한 번에 주는 public/ticker/ALL_KRW 가 가볍고 빠르다.
     실패하면 v1/ticker 로 주요 종목만이라도 받아 교차 확인을 이어 간다. */
  function toBithumbMap(payload) {
    var out = {};
    var data = payload && payload.data;
    if (!data) return out;
    Object.keys(data).forEach(function (k) {
      if (k === 'date') return;
      var r = data[k];
      if (!r) return;
      var p = parseFloat(r.closing_price);
      if (!(p > 0)) return;
      out[k] = {
        price: p,
        chg: isFinite(parseFloat(r.fluctate_rate_24H)) ? parseFloat(r.fluctate_rate_24H) : null,
        vol: parseFloat(r.acc_trade_value_24H) || 0
      };
    });
    return out;
  }

  function loadBithumb() {
    return track('bithumb-all', API.bithumbAll, request(API.bithumbAll, 12000)).then(function (payload) {
      if (!payload || payload.status !== '0000') throw new Error('status ' + (payload && payload.status));
      var map = toBithumbMap(payload);
      if (!Object.keys(map).length) throw new Error('empty');
      S.bithumbSource = 'BITHUMB ALL_KRW';
      return map;
    }).catch(function () {
      var codes = PRIORITY.map(function (b) { return 'KRW-' + b; }).join(',');
      return track('bithumb-v1', API.bithumbV1 + codes, request(API.bithumbV1 + codes, 12000)).then(function (list) {
        var map = {};
        (list || []).forEach(function (t) {
          if (!t || typeof t.market !== 'string') return;
          var p = parseFloat(t.trade_price);
          if (!(p > 0)) return;
          map[t.market.slice(4)] = {
            price: p,
            chg: parseFloat(t.signed_change_rate) * 100,
            vol: parseFloat(t.acc_trade_price_24h) || 0
          };
        });
        if (!Object.keys(map).length) throw new Error('empty');
        S.bithumbSource = 'BITHUMB v1 (주요 종목)';
        return map;
      }).catch(function () { return null; });
    });
  }

  function ensureBithumb() {
    if (S.bithumbTrying) return Promise.resolve(S.bithumb);
    if (S.bithumb && (Date.now() - S.bithumbAt) < BITHUMB_TTL) return Promise.resolve(S.bithumb);
    S.bithumbTrying = true;
    return loadBithumb().then(function (map) {
      S.bithumbTrying = false;
      if (map) {
        S.bithumb = map;
        S.bithumbAt = Date.now();
        S.bithumbErr = '';
        return S.bithumb;
      }
      S.bithumbErr = 'fetch failed';
      return S.bithumb;
    }, function (err) {
      S.bithumbTrying = false;
      S.bithumbErr = String((err && err.message) || err);
      return S.bithumb;
    });
  }

  /* ---------------------------------------------------------- binance */
  function toSpotMap(list) {
    var m = {};
    (list || []).forEach(function (t) {
      if (!t || typeof t.symbol !== 'string') return;
      if (t.symbol.slice(-4) !== 'USDT') return;
      var p = parseFloat(t.price);
      if (p > 0) m[t.symbol.slice(0, -4)] = p;
    });
    return m;
  }

  function loadSpot() {
    return track('binance-spot', API.binanceSpot, request(API.binanceSpot, 12000)).then(function (list) {
      S.spotSource = 'api.binance.com';
      return toSpotMap(list);
    }).catch(function () {
      return track('binance-spot-mirror', API.binanceSpotMirror, request(API.binanceSpotMirror, 12000)).then(function (list) {
        S.spotSource = 'data-api.binance.vision';
        return toSpotMap(list);
      }).catch(function () { return null; });
    });
  }

  function addFuture(map, base, rate, next, intervalH, mark) {
    if (!base || !isFinite(rate)) return;
    var rec = { rate: rate, next: next || 0, intervalH: intervalH || 8, mark: mark || null };
    if (map.exact[base]) return;
    map.exact[base] = rec;
    var p = /^(1000000|100000|10000|1000)([A-Z0-9]{2,})$/.exec(base);
    if (p && !map.alias[p[2]]) map.alias[p[2]] = rec;
  }

  function loadFutures() {
    return track('binance-futures', API.binanceFutures, request(API.binanceFutures, 12000)).then(function (list) {
      var map = { exact: {}, alias: {} };
      (list || []).forEach(function (f) {
        if (!f || typeof f.symbol !== 'string' || f.symbol.slice(-4) !== 'USDT') return;
        addFuture(map, f.symbol.slice(0, -4), parseFloat(f.lastFundingRate), f.nextFundingTime, 8, parseFloat(f.markPrice));
      });
      S.futSource = 'Binance Futures';
      return map;
    }).catch(function () {
      // 지역 제한(HTTP 451) 등으로 Binance 선물이 막히면 Gate.io 공개 API로 대체한다.
      return track('gate-futures', API.gateFutures, request(API.gateFutures, 12000)).then(function (list) {
        var map = { exact: {}, alias: {} };
        (list || []).forEach(function (c) {
          if (!c || typeof c.name !== 'string') return;
          var m = /^(.+)_USDT$/.exec(c.name);
          if (!m) return;
          var interval = parseFloat(c.funding_interval);
          addFuture(map, m[1], parseFloat(c.funding_rate), parseFloat(c.funding_next_apply) * 1000,
            interval > 0 ? interval / 3600 : 8, parseFloat(c.mark_price));
        });
        S.futSource = 'Gate.io Futures (대체)';
        return map;
      }).catch(function () { return null; });
    });
  }

  function loadFx() {
    // 네 곳을 동시에 불러 가장 최근 고시 날짜의 값을 쓴다 — 하루 늦은 고시값이 김프를 통째로 밀어 버리기 때문.
    var picks = FX_SOURCES.map(function (src, order) {
      return track('fx:' + src.id, src.url, request(src.url, 10000)).then(function (data) {
        var out = src.parse(data);
        var rate = parseFloat(out && out.rate);
        if (!(rate > 500 && rate < 3000)) throw new Error('unexpected rate');
        return { rate: rate, date: out.date || '', source: src.id, ts: Date.parse(out.date || '') || 0, order: order };
      }).catch(function () { return null; });
    });
    return Promise.all(picks).then(function (list) {
      var ok = list.filter(Boolean);
      if (!ok.length) throw new Error('no fx source');
      ok.sort(function (a, b) { return (b.ts - a.ts) || (a.order - b.order); });
      return { rate: ok[0].rate, date: ok[0].date, source: ok[0].source };
    });
  }

  /* ---------------------------------------------------------- short-term history */
  function histOf(base) {
    var h = S.hist[base];
    if (!h) h = S.hist[base] = { p: [], prem: [] };
    return h;
  }

  function recordTick(base, price) {
    if (!(price > 0)) return;
    var now = Date.now();
    var h = histOf(base);
    var last = h.p[h.p.length - 1];
    if (!last || now - last[0] >= 3000) h.p.push([now, price]);
    while (h.p.length > 2 && now - h.p[0][0] > 150000) h.p.shift();
    if (h.p.length > 60) h.p.shift();
  }

  function recordPrem(base, prem) {
    if (prem == null || !isFinite(prem)) return;
    var now = Date.now();
    var h = histOf(base);
    var last = h.prem[h.prem.length - 1];
    if (last && now - last[0] < 10000) return;
    h.prem.push([now, prem]);
    while (h.prem.length > 2 && now - h.prem[0][0] > 300000) h.prem.shift();
    if (h.prem.length > 40) h.prem.shift();
  }

  /* minAge 이전의 표본과 지금 값을 비교한다 — 체류 중 단기 변동 판정용. */
  function deltaSince(items, minAge) {
    if (!items || items.length < 2) return null;
    var now = Date.now();
    var cur = items[items.length - 1];
    var old = null;
    for (var i = items.length - 1; i >= 0; i--) {
      if (now - items[i][0] >= minAge) { old = items[i]; break; }
    }
    if (!old) return null;
    return { d: cur[1] - old[1], from: old[1], to: cur[1], dt: Math.round((cur[0] - old[0]) / 1000) };
  }

  function spikeTags(row) {
    var tags = [];
    if (row.chg != null && Math.abs(row.chg) >= SPIKE_CHG_24H) {
      tags.push(row.chg > 0
        ? { k: 'hot', label: '🔥 급등', title: '24시간 등락 ' + pct(row.chg, 2) }
        : { k: 'cold', label: '❄️ 급락', title: '24시간 등락 ' + pct(row.chg, 2) });
    }
    var h = S.hist[row.base];
    if (h && h.p.length > 2) {
      var mv = deltaSince(h.p, FAST_MIN_AGE);
      if (mv && mv.from > 0) {
        var rel = (mv.to / mv.from - 1) * 100;
        if (Math.abs(rel) >= SPIKE_FAST_PCT) {
          tags.push({
            k: rel > 0 ? 'hot' : 'cold',
            label: (rel > 0 ? '🔥' : '❄️') + ' ' + pct(rel, 1) + '/' + Math.max(1, Math.round(mv.dt / 60)) + '분',
            title: '체류 중 단기 가격 변동 ' + pct(rel, 2) + ' · ' + mv.dt + '초'
          });
        }
      }
    }
    if (h && h.prem.length > 2) {
      var pm = deltaSince(h.prem, FAST_MIN_AGE);
      if (pm && Math.abs(pm.d) >= SPIKE_PREM_PP) {
        tags.push({
          k: 'kimp',
          label: '⚡ 김프급변',
          title: '김프 ' + pct(pm.from, 2) + ' → ' + pct(pm.to, 2) + ' · ' + pm.dt + '초'
        });
      }
    }
    return tags;
  }

  /* ---------------------------------------------------------- compute */
  function computeRows() {
    var fx = S.fx && S.fx.rate;
    var spot = S.spot || {};
    var fut = S.fut || { exact: {}, alias: {} };
    var bith = S.bithumb || {};
    var rows = [];
    var unmatched = 0;

    (S.markets || []).forEach(function (m) {
      var t = S.tickers[m.base];
      if (!t) return;
      var binance = spot[m.base];
      if (!(binance > 0)) { unmatched++; return; }
      var price = parseFloat(t.trade_price);
      if (!(price > 0)) { unmatched++; return; }
      var prem = (fx > 0) ? ((price / (binance * fx)) - 1) * 100 : null;
      var b = bith[m.base];
      var bPrice = (b && b.price > 0) ? b.price : null;
      var gap = (bPrice && price > 0) ? ((price / bPrice) - 1) * 100 : null;
      var f = fut.exact[m.base] || fut.alias[m.base] || null;
      var row = {
        base: m.base, korean: m.korean, english: m.english,
        price: price, binance: binance, bithumb: bPrice, gap: gap, prem: prem,
        funding: f && isFinite(f.rate) ? f.rate * 100 : null,
        ann: f && isFinite(f.rate) && f.intervalH ? (f.rate * 100) * (24 / f.intervalH) * 365 : null,
        next: f ? f.next : 0,
        vol: parseFloat(t.acc_trade_price_24h) || 0,
        chg: isFinite(parseFloat(t.signed_change_rate)) ? parseFloat(t.signed_change_rate) * 100 : null,
        tags: []
      };
      recordPrem(row.base, prem);
      row.tags = spikeTags(row);
      rows.push(row);
    });

    S.rows = rows;
    S.unmatched = unmatched;
  }

  /* ---------------------------------------------------------- filters */
  var TABS = [
    { id: 'all', label: '전체', test: function () { return true; } },
    { id: 'kimp', label: '고김프 +2%↑', test: function (r) { return r.prem != null && r.prem >= 2; } },
    { id: 'reverse', label: '역프 0%↓', test: function (r) { return r.prem != null && r.prem < 0; } },
    { id: 'funding', label: '고펀딩비 ±0.01%↑', test: function (r) { return r.funding != null && Math.abs(r.funding) >= FUND_TAB; } },
    { id: 'volume', label: '거래대금 100억↑', test: function (r) { return r.vol >= VOL_TAB; } },
    { id: 'spike', label: '⚡ 급변 포착', test: function (r) { return r.tags && r.tags.length > 0; } }
  ];

  function tabOf(id) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return TABS[i];
    return TABS[0];
  }

  /* ---------------------------------------------------------- KPI */
  function renderKpis() {
    var fx = S.fx;
    var rate = fx ? fx.rate : null;

    var usdtT = S.tickers['USDT'];
    var usdt = usdtT ? parseFloat(usdtT.trade_price) : null;
    var tetherPrem = (rate > 0 && usdt > 0) ? ((usdt / rate) - 1) * 100 : null;

    el['fx-rate'].innerHTML = rate ? fmtRate(rate) + '<small>원/USD</small>' : '--';
    var fxLabel = fx ? String(fx.source).replace('currency-api.pages.dev', 'pages.dev').replace('fawazahmed0/currency-api', 'fawazahmed0').replace('open.er-api.com', 'er-api.com') : '';
    var fxWhen = '';
    if (fx && fx.date) {
      var dt = new Date(fx.date);
      fxWhen = isNaN(dt.getTime()) ? String(fx.date).slice(5, 10) : (dt.getMonth() + 1) + '-' + dt.getDate();
    }
    el['fx-meta'].textContent = fx ? (fxLabel + (fxWhen ? ' · ' + fxWhen + ' 고시' : '')) : '환율 API 응답 없음';
    el['fx-tether'].textContent = usdt > 0
      ? '테더 환산 ' + fmtRate(usdt) + '원 ' + (tetherPrem == null ? '' : '(' + pct(tetherPrem, 2) + ')')
      : '테더 환산 --';

    el['usdt-price'].innerHTML = usdt > 0 ? fmtKrw(usdt) + '<small>원</small>' : '--';
    el['usdt-prem'].innerHTML = (usdt > 0 && tetherPrem != null)
      ? '테더 김프 <b class="' + signCls(tetherPrem) + '">' + pct(tetherPrem, 2) + '</b>'
      : '테더 김프 --';

    var btc = null, i;
    for (i = 0; i < S.rows.length; i++) { if (S.rows[i].base === 'BTC') { btc = S.rows[i]; break; } }
    var btcFut = S.fut ? (S.fut.exact['BTC'] || S.fut.alias['BTC']) : null;
    BTC_NEXT = btcFut ? btcFut.next : 0;

    if (btc) {
      el['btc-prem'].innerHTML = btc.prem == null ? '--' : '<span class="' + signCls(btc.prem) + '">' + pct(btc.prem, 2) + '</span>';
      el['btc-meta'].textContent = fmtKrw(btc.price) + '원 / $' + fmtUsd(btc.binance);
      if (usdt > 0) {
        var premT = ((btc.price / (btc.binance * usdt)) - 1) * 100;
        el['btc-tether'].textContent = '테더 시세 기준 김프 ' + pct(premT, 2);
      } else {
        el['btc-tether'].textContent = '테더 시세 기준 김프 --';
      }
    } else {
      el['btc-prem'].innerHTML = '--';
      el['btc-meta'].textContent = '업비트 -- / 바이낸스 --';
      el['btc-tether'].textContent = '테더 시세 기준 김프 --';
    }

    if (btcFut && isFinite(btcFut.rate)) {
      var fr = btcFut.rate * 100;
      el['btc-funding'].innerHTML = '<span class="' + signCls(fr) + '">' + pct(fr, 4) + '</span><small>/8h</small>';
      el['btc-funding-ann'].innerHTML = '연환산 <b class="' + signCls(fr * (24 / (btcFut.intervalH || 8)) * 365) + '">' + pct(fr * (24 / (btcFut.intervalH || 8)) * 365, 1) + '</b>';
      el['btc-next'].textContent = '다음 펀딩 ' + clockOf(btcFut.next) + ' · ' + countdown(btcFut.next - Date.now());
    } else {
      el['btc-funding'].innerHTML = '--';
      el['btc-funding-ann'].textContent = '연환산 --';
      el['btc-next'].textContent = '다음 펀딩 --';
    }

    var top = null, low = null, bgap = null, bcount = 0;
    for (var j = 0; j < S.rows.length; j++) {
      var r = S.rows[j];
      if (r.bithumb) bcount++;
      if (r.prem == null || r.vol < VOL_FLOOR) continue;
      if (Math.abs(r.prem) >= COLLISION_PCT) continue;   // 같은 티커의 다른 자산으로 보이는 값은 집계에서 뺀다
      if (!top || r.prem > top.prem) top = r;
      if (!low || r.prem < low.prem) low = r;
      if (r.gap != null && Math.abs(r.gap) < COLLISION_PCT && (!bgap || Math.abs(r.gap) > Math.abs(bgap.gap))) bgap = r;
    }
    el['top-sym'].textContent = top ? top.korean + ' ' + top.base : '--';
    el['top-val'].innerHTML = top ? '<span class="' + signCls(top.prem) + '">' + pct(top.prem, 2) + '</span>' : '--';
    el['low-sym'].textContent = low ? low.korean + ' ' + low.base : '--';
    el['low-val'].innerHTML = low ? '<span class="' + signCls(low.prem) + '">' + pct(low.prem, 2) + '</span>' : '--';
    el['gap-sym'].textContent = bgap ? bgap.korean + ' ' + bgap.base : '--';
    el['gap-val'].innerHTML = bgap ? '<span class="' + signCls(bgap.gap) + '">' + pct(bgap.gap, 2) + '</span>' : '--';
    el['rank-foot'].textContent = '빗썸 동시 상장 ' + bcount + '종 · 거래대금 1억↑ 기준'
      + (bgap ? (bgap.gap > 0 ? ' · 업비트가 비쌈' : ' · 빗썸이 비쌈') : '');
  }

  /* ---------------------------------------------------------- table */
  function flagged(r) {
    return r.prem != null && Math.abs(r.prem) >= COLLISION_PCT;
  }

  var SORTS = {
    // 같은 티커의 다른 자산으로 보이는 값(?)은 비교 대상이 아니므로 정렬에서 맨 뒤로 보낸다.
    'premium-desc': function (a, b) { return (flagged(a) - flagged(b)) || cmp(a.prem, b.prem, -1) || cmp(a.vol, b.vol, -1); },
    'premium-asc': function (a, b) { return (flagged(a) - flagged(b)) || cmp(a.prem, b.prem, 1) || cmp(a.vol, b.vol, -1); },
    'funding-abs': function (a, b) {
      return cmp(a.funding == null ? null : Math.abs(a.funding), b.funding == null ? null : Math.abs(b.funding), -1) || cmp(a.vol, b.vol, -1);
    },
    'volume-desc': function (a, b) { return cmp(a.vol, b.vol, -1); },
    'gap-abs': function (a, b) {
      return (flagged(a) - flagged(b)) ||
        cmp(a.gap == null ? null : Math.abs(a.gap), b.gap == null ? null : Math.abs(b.gap), -1) || cmp(a.vol, b.vol, -1);
    }
  };

  function cmp(a, b, dir) {
    var an = (a == null || !isFinite(a)), bn = (b == null || !isFinite(b));
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (a === b) return 0;
    return dir * (a < b ? -1 : 1);
  }

  function tagsHtml(r) {
    if (!r.tags || !r.tags.length) return '';
    var out = ['<span class="rowtags">'];
    for (var i = 0; i < r.tags.length && i < 2; i++) {
      var t = r.tags[i];
      out.push('<span class="tag tag--' + t.k + '" title="' + esc(t.title) + '">' + esc(t.label) + '</span>');
    }
    out.push('</span>');
    return out.join('');
  }

  function rowHtml(r) {
    var chgCls = r.chg == null ? 'flat' : r.chg > 1e-6 ? 'up' : r.chg < -1e-6 ? 'down' : 'flat';
    var gapFlag = (r.gap != null && Math.abs(r.gap) >= COLLISION_PCT);
    return '<tr>' +
      '<th scope="row" class="rt__sym c-sym">' +
        '<span class="sym-kr">' + esc(r.korean) + '</span>' +
        '<span class="sym-code">' + esc(r.base) + '</span>' +
        tagsHtml(r) +
      '</th>' +
      '<td class="c-upbit" data-label="업비트">' + fmtKrw(r.price) + '</td>' +
      '<td class="c-bin" data-label="바이낸스 USDT">' + fmtUsd(r.binance) + '</td>' +
      '<td class="c-bith" data-label="빗썸">' + (r.bithumb ? fmtKrw(r.bithumb) : '<span class="dim">--</span>') + '</td>' +
      '<td class="c-prem ' + signCls(r.prem) + '" data-label="김프">' + pct(r.prem, 2) +
        (r.prem != null && Math.abs(r.prem) >= COLLISION_PCT ? '<span class="rt__flag" title="같은 티커의 다른 자산일 수 있습니다">?</span>' : '') + '</td>' +
      '<td class="c-gap ' + (gapFlag ? 'dim' : signCls(r.gap)) + '" data-label="업-빗 괴리">' + (r.gap == null ? '<span class="dim">--</span>' : pct(r.gap, 2)) +
        (gapFlag ? '<span class="rt__flag" title="단위·자산이 다른 시세일 수 있습니다">?</span>' : '') + '</td>' +
      '<td class="c-fund" data-label="펀딩비 8h">' + (r.funding == null
        ? '<span class="dim">--</span>'
        : '<span class="f-main ' + signCls(r.funding) + '">' + pct(r.funding, 4) + '</span>' +
          '<span class="f-ann ' + signCls(r.ann) + '">' + pct(r.ann, 1) + '/yr</span>') + '</td>' +
      '<td class="c-vol" data-label="24h 거래대금(억)">' + fmtVol(r.vol) + '</td>' +
      '<td class="c-chg chg ' + chgCls + '" data-label="24h 등락">' + pct(r.chg, 2) + '</td>' +
      '</tr>';
  }

  function visibleRows() {
    var q = S.query.trim().toLowerCase();
    var tab = tabOf(S.tab);
    var rows = S.rows.filter(function (r) { return tab.test(r); });
    if (q) {
      rows = rows.filter(function (r) {
        return r.base.toLowerCase().indexOf(q) >= 0 ||
          r.korean.toLowerCase().indexOf(q) >= 0 ||
          (r.english && r.english.toLowerCase().indexOf(q) >= 0);
      });
    }
    return rows.slice().sort(SORTS[S.sort] || SORTS['premium-desc']);
  }

  function renderTabs() {
    var btns = el.tabs.querySelectorAll('.rtab');
    for (var i = 0; i < btns.length; i++) {
      var id = btns[i].getAttribute('data-tab');
      var t = tabOf(id);
      var n = 0;
      for (var k = 0; k < S.rows.length; k++) if (t.test(S.rows[k])) n++;
      var num = btns[i].querySelector('.rtab__n');
      if (num) num.textContent = n;
      var on = (id === S.tab);
      btns[i].classList.toggle('is-on', on);
      btns[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var spikeBtn = el.tabs.querySelector('[data-tab="spike"]');
    if (spikeBtn) spikeBtn.classList.toggle('is-hot', true);
  }

  function renderSpikes() {
    var list = [];
    for (var i = 0; i < S.rows.length; i++) {
      var r = S.rows[i];
      if (!r.tags || !r.tags.length) continue;
      var live = 0, lab = '';
      for (var k = 0; k < r.tags.length; k++) {
        if (r.tags[k].k === 'kimp' || r.tags[k].label.indexOf('/분') > 0) { live = 1; lab = r.tags[k].label; }
      }
      if (!lab) lab = r.tags[0].label;
      list.push({ base: r.base, label: lab, live: live, chg: Math.abs(r.chg || 0) });
    }
    if (!list.length) {
      el.spikes.hidden = true;
      el.spikes.innerHTML = '';
      return;
    }
    list.sort(function (a, b) { return (b.live - a.live) || (b.chg - a.chg); });
    var head = '<span class="spike-lead">⚡ 급변 포착 <b>' + listAll().length + '종</b></span>';
    var chips = list.slice(0, 5).map(function (x) {
      return '<button type="button" class="spike' + (x.live ? ' is-live' : '') + '" data-base="' + esc(x.base) + '" title="이 종목만 보기">' +
        esc(x.base) + ' <b>' + esc(x.label) + '</b></button>';
    });
    el.spikes.innerHTML = head + chips.join('');
    el.spikes.hidden = false;
  }

  function listAll() {
    return S.rows.filter(function (r) { return r.tags && r.tags.length; });
  }

  function renderTable() {
    var rows = visibleRows();
    var body = el.body;

    renderTabs();
    renderSpikes();

    if (!S.rows.length) {
      if (S.polls > 0) {
        body.innerHTML = '<tr class="rt__placeholder rt__placeholder--empty"><td colspan="9">시세를 받지 못했습니다. 잠시 후 <b>새로고침</b>을 눌러 주세요. (광고 차단 확장이나 네트워크가 거래소·환율 API를 막는 경우가 있습니다)</td></tr>';
        el['table-foot'].textContent = '요청 실패: ' + S.req.filter(function (r) { return !r.ok; }).map(function (r) { return r.name + '(' + (r.error || 'error') + ')'; }).join(', ');
      } else {
        body.innerHTML = '<tr class="rt__placeholder"><td colspan="9">거래소 공개 API에서 시세를 받아오는 중입니다…</td></tr>';
        el['table-foot'].textContent = '초기 로딩 중입니다.';
      }
      el['row-count'].textContent = '—';
      return;
    }

    if (!rows.length) {
      body.innerHTML = '<tr class="rt__placeholder rt__placeholder--empty"><td colspan="9">' +
        (S.query ? '검색어와 ' : '') + '조건에 맞는 종목이 없습니다. 다른 필터를 눌러 보세요.</td></tr>';
    } else {
      var html = [];
      for (var i = 0; i < rows.length; i++) html.push(rowHtml(rows[i]));
      body.innerHTML = html.join('');
    }

    var futures = 0, volSum = 0, collisions = 0, withBith = 0;
    for (var k = 0; k < S.rows.length; k++) {
      if (S.rows[k].funding != null) futures++;
      if (S.rows[k].prem != null && Math.abs(S.rows[k].prem) >= COLLISION_PCT) collisions++;
      if (S.rows[k].bithumb) withBith++;
      volSum += S.rows[k].vol;
    }

    el['row-count'].textContent = '표시 ' + rows.length + '종 / 김프 ' + S.rows.length + '종';
    el['table-foot'].textContent =
      '업비트 KRW ' + ((S.markets && S.markets.length) || 0) + '종 중 바이낸스 USDT 현물 페어가 있는 ' +
      S.rows.length + '종을 비교합니다(업비트 단독 상장 ' + S.unmatched + '종 제외). ' +
      '이 중 빗썸에서도 거래되는 ' + withBith + '종은 업-빗 괴리율을 함께 표시하고, 펀딩비가 확인된 종목은 ' + futures + '종. ' +
      '비교 종목의 업비트 24시간 거래대금 합계는 ' + nf(volSum / 1e8, 0) + '억 원.' +
      (collisions ? ' 김프가 ±' + COLLISION_PCT + '%를 넘는 ' + collisions + '종은 같은 티커의 다른 자산일 수 있어 ?로 표시하고 최고·최저 집계에서 뺐습니다.' : '') +
      (S.wsFallback ? ' · 업비트 스트림이 막혀 REST 보조 수집으로 표시 중입니다.' : '');
  }

  /* ---------------------------------------------------------- status */
  function upbitChip() {
    if (wsAlive() && S.wsMsgs > 0) return { label: 'UPBIT STREAM', state: 'ok', note: S.wsMsgs + ' msg' };
    if (wsAlive()) return { label: 'UPBIT STREAM', state: 'ok', note: 'snapshot' };
    if (S.wsFallback) return { label: 'UPBIT REST (제한적)', state: 'warn', note: '60s' };
    return { label: 'UPBIT STREAM', state: 'fail', note: S.wsState };
  }

  function sourceChips() {
    var up = upbitChip();
    var spotLabel = S.spotSource === 'data-api.binance.vision' ? 'BINANCE SPOT (mirror)' : 'BINANCE SPOT';
    var bithLabel = S.bithumb ? (S.bithumbSource || 'BITHUMB') : 'BITHUMB';
    var chips = [
      up,
      { label: spotLabel, state: S.spot ? 'ok' : 'fail' },
      { label: S.futSource || 'FUNDING', state: S.fut ? 'ok' : 'fail' },
      { label: bithLabel, state: S.bithumb ? 'ok' : 'fail', note: S.bithumb ? Object.keys(S.bithumb).length + '종' : '' },
      { label: 'FX · ' + (S.fx ? S.fx.source : '없음'), state: S.fx ? 'ok' : 'fail' }
    ];
    el.chips.innerHTML = chips.map(function (c) {
      var cls = c.state === 'ok' ? 'is-ok' : c.state === 'warn' ? 'is-warn' : 'is-fail';
      return '<span class="src ' + cls + '"><span class="src__dot"></span>' + esc(c.label) + (c.note ? ' ' + esc(c.note) : '') + '</span>';
    }).join('');
  }

  function updateStatus() {
    var recent = S.req.slice(-8);
    var fail = recent.filter(function (r) { return !r.ok; });
    if (S.paused) {
      el.dot.className = 'dot is-stale';
      el['status-text'].textContent = '일시정지 — 화면 갱신 멈춤 (연결은 유지)';
    } else if (!S.markets) {
      el.dot.className = 'dot is-stale';
      el['status-text'].textContent = '업비트 마켓 목록 요청 중' + (S.marketsTries > 1 ? ' (재시도 ' + S.marketsTries + ')' : '') + (S.marketsErr ? ' · ' + S.marketsErr : '');
    } else if (wsAlive() && S.wsMsgs > 0) {
      el.dot.className = 'dot is-live';
      el['status-text'].textContent = '업비트 스트림 수신 중 · 바이낸스·펀딩 ' + stamp(S.lastPollAt) + ' 갱신';
    } else if (S.wsFallback) {
      el.dot.className = 'dot is-stale';
      el['status-text'].textContent = '스트림 연결 실패 — REST 보조 수집으로 표시 중';
    } else if (S.polling && !S.polls) {
      el.dot.className = 'dot is-live';
      el['status-text'].textContent = '거래소 API 연결 중…';
    } else if (fail.length && fail.length === recent.length) {
      el.dot.className = 'dot is-stale';
      el['status-text'].textContent = '모든 요청 실패 — 네트워크를 확인하세요';
    } else {
      el.dot.className = 'dot is-wait';
      el['status-text'].textContent = '업비트 스트림 연결 중… (' + S.wsState + ')';
    }
    sourceChips();
  }

  /* ---------------------------------------------------------- poll cycle */
  function loadCycle() {
    if (S.polling) return;
    S.polling = true;
    S.cycleStart = S.req.length;
    updateStatus();

    var fxP = (S.fx && (Date.now() - S.fxAt) < FX_TTL) ? Promise.resolve(S.fx) : loadFx().catch(function () { return S.fx; });
    var spotP = loadSpot();
    var futP = loadFutures();
    var bithP = ensureBithumb();

    Promise.all([fxP, spotP, futP, bithP]).then(function (res) {
      if (res[0]) { S.fx = res[0]; S.fxAt = Date.now(); }
      if (res[1]) S.spot = res[1];
      if (res[2]) S.fut = res[2];
      if (res[3]) S.bithumb = res[3];

      computeRows();
      renderKpis();
      renderTable();
      S.polling = false;
      S.polls++;
      S.lastPollAt = Date.now();
      S.nextAt = Date.now() + POLL_MS;
      updateStatus();
      publishDiag();
    }).catch(function (err) {
      S.polling = false;
      S.windowErrors.push('poll: ' + String((err && err.message) || err));
      updateStatus();
      publishDiag();
    });
  }

  function publishDiag() {
    var sample = {};
    ['BTC', 'ETH', 'XRP'].forEach(function (b) {
      for (var i = 0; i < S.rows.length; i++) {
        if (S.rows[i].base === b) {
          var r = S.rows[i];
          sample[b] = { upbit: r.price, binance: r.binance, bithumb: r.bithumb, gap: r.gap, prem: r.prem, funding: r.funding, tags: r.tags.map(function (t) { return t.label; }) };
          break;
        }
      }
    });
    window.__radarDiag = {
      polls: S.polls,
      lastPollAt: S.lastPollAt || null,
      paused: S.paused,
      tab: S.tab,
      requests: S.req.slice(),
      failures: S.req.filter(function (r) { return !r.ok; }),
      fx: S.fx,
      spotSource: S.spotSource,
      futuresSource: S.futSource,
      bithumb: {
        source: S.bithumbSource,
        err: S.bithumbErr,
        at: S.bithumbAt || null,
        count: S.bithumb ? Object.keys(S.bithumb).length : 0
      },
      upbit: { state: S.wsState, messages: S.wsMsgs, lastAt: S.wsLastAt, fallback: S.wsFallback, err: S.wsErr, tickers: Object.keys(S.tickers).length },
      markets: { tries: S.marketsTries, err: S.marketsErr, count: (S.markets && S.markets.length) || 0 },
      restSweepAt: S.restSweepAt || null,
      counts: {
        krwMarkets: (S.markets && S.markets.length) || 0,
        compared: S.rows.length,
        unmatched: S.unmatched,
        withFunding: S.rows.filter(function (r) { return r.funding != null; }).length,
        withBithumb: S.rows.filter(function (r) { return r.bithumb; }).length,
        spikes: S.rows.filter(function (r) { return r.tags.length; }).length,
        rendered: document.querySelectorAll('#radar-body tr').length,
        tabs: (function () { var o = {}; TABS.forEach(function (t) { o[t.id] = S.rows.filter(t.test).length; }); return o; })()
      },
      sample: sample,
      windowErrors: S.windowErrors.slice()
    };
  }

  /* ---------------------------------------------------------- timers */
  function tick() {
    var now = Date.now();

    if (S.dirty && !S.paused) {
      S.dirty = false;
      computeRows();
      renderKpis();
      renderTable();
      updateStatus();
    }

    if (!S.markets && !S.marketsTrying && now - S.marketsLastTry > 12000 && !document.hidden) {
      ensureMarkets(true);
    }

    if (!S.paused) {
      el.timer.textContent = S.nextAt ? '바이낸스 갱신 ' + Math.max(0, Math.round((S.nextAt - now) / 1000)) + 's' : '연결 중';
      if (!S.polling && S.nextAt && now >= S.nextAt && !document.hidden) loadCycle();
      if (S.wsFallback && !wsAlive() && now - S.restSweepAt > REST_SWEEP_MS && !document.hidden) restSweep();
      if (!wsAlive() && !S.wsFallback && S.markets && now - (S.wsLastAt || 0) > 45000 && S.wsAttempts < 2) connectUpbit();
      if (S.wsFallback && !wsAlive() && now - (S.wsTriedAt || 0) > 120000 && S.markets) { S.wsAttempts = 0; connectUpbit(); }
    } else {
      el.timer.textContent = '일시정지됨';
    }
    if (BTC_NEXT) el['btc-next'].textContent = '다음 펀딩 ' + clockOf(BTC_NEXT) + ' · ' + countdown(BTC_NEXT - now);
  }

  function setPaused(p) {
    S.paused = p;
    el.pause.setAttribute('aria-pressed', p ? 'true' : 'false');
    el.pause.textContent = p ? '재개' : '일시정지';
    if (!p) { S.nextAt = Date.now() + POLL_MS; if (!wsAlive() && !S.wsFallback) connectUpbit(); }
    updateStatus();
    tick();
  }

  function setTab(id) {
    S.tab = id;
    renderTabs();
    if (S.rows.length) renderTable();
  }

  /* ---------------------------------------------------------- init */
  function init() {
    el.dot = $('live-dot');
    el.pause = $('btn-pause');
    el.timer = $('refresh-timer');
    el.chips = $('source-chips');
    el.body = $('radar-body');
    el.tabs = $('radar-tabs');
    el.spikes = $('spike-strip');
    el['table-foot'] = $('table-foot');
    el['row-count'] = $('row-count');
    el['status-text'] = $('status-text');
    ['fx-rate', 'fx-meta', 'fx-tether', 'usdt-price', 'usdt-prem', 'btc-prem', 'btc-meta',
      'btc-funding', 'btc-funding-ann', 'btc-next', 'btc-tether', 'top-sym', 'top-val', 'low-sym', 'low-val',
      'gap-sym', 'gap-val', 'rank-foot'].forEach(function (id) {
      el[id] = $(id);
    });

    window.addEventListener('error', function (e) {
      S.windowErrors.push('error: ' + String((e && e.message) || 'unknown'));
    });
    window.addEventListener('unhandledrejection', function (e) {
      S.windowErrors.push('rejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || 'unknown'));
    });

    $('btn-refresh').addEventListener('click', function () {
      if (!S.markets) ensureMarkets(true);
      if (!wsAlive() && S.markets) connectUpbit();
      loadCycle();
      if (S.wsFallback) restSweep();
    });
    el.pause.addEventListener('click', function () { setPaused(!S.paused); });

    var input = $('filter-input');
    var delay = null;
    input.addEventListener('input', function () {
      clearTimeout(delay);
      var v = input.value;
      delay = setTimeout(function () { S.query = v; if (S.rows.length) renderTable(); }, 90);
    });

    el.tabs.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.rtab') : null;
      if (!btn) return;
      setTab(btn.getAttribute('data-tab'));
    });

    el.spikes.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.spike') : null;
      if (!btn) return;
      var base = btn.getAttribute('data-base') || '';
      input.value = base;
      S.query = base;
      setTab('all');
      renderTable();
      var wrap = $('table-wrap');
      if (wrap && wrap.scrollIntoView) wrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.rc__sort'), function (btn) {
      btn.addEventListener('click', function () {
        S.sort = btn.getAttribute('data-sort');
        Array.prototype.forEach.call(document.querySelectorAll('.rc__sort'), function (b) {
          var on = b === btn;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        if (S.rows.length) renderTable();
      });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (!wsAlive() && !S.wsFallback) connectUpbit();
      if (!S.paused && S.polling === false && S.lastPollAt && (Date.now() - S.lastPollAt) > POLL_MS) loadCycle();
    });

    setInterval(tick, 1000);
    publishDiag();

    // 1) 마켓 목록 → 2) 업비트 스트림 연결 → 3) 바이낸스·빗썸·환율 폴링
    ensureMarkets(true).then(function () {
      loadCycle();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
