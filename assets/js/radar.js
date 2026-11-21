/* ============================================================
   DOHYEON TECH BRIEF — /radar/ live kimp + funding radar
   100% client-side. Fetches public exchange APIs directly.
   No storage, no cookies, no keys, no third-party SDK.
   ============================================================ */
(function () {
  'use strict';

  var API = {
    upbitMarkets: 'https://api.upbit.com/v1/market/all',
    upbitTicker: 'https://api.upbit.com/v1/ticker?markets=',
    binanceSpot: 'https://api.binance.com/api/v3/ticker/price',
    binanceSpotMirror: 'https://data-api.binance.vision/api/v3/ticker/price',
    binanceFutures: 'https://fapi.binance.com/fapi/v1/premiumIndex',
    gateFutures: 'https://api.gateio.ws/api/v4/futures/usdt/contracts'
  };

  var FX_SOURCES = [
    {
      id: 'open.er-api.com',
      url: 'https://open.er-api.com/v6/latest/USD',
      parse: function (d) {
        return { rate: d && d.rates && d.rates.KRW, date: (d && d.time_last_update_utc) || '' };
      }
    },
    {
      id: 'fawazahmed0/currency-api',
      url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      parse: function (d) { return { rate: d && d.usd && d.usd.krw, date: (d && d.date) || '' }; }
    },
    {
      id: 'frankfurter.dev',
      url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW',
      parse: function (d) { return { rate: d && d.rates && d.rates.KRW, date: (d && d.date) || '' }; }
    }
  ];

  var REFRESH_MS = 15000;
  var MARKETS_TTL = 600000;
  var VOL_FLOOR = 1e8;          // 최고/최저 김프 집계 기준: 24h 거래대금 1억 원

  var S = {
    markets: null,
    marketsAt: 0,
    tickers: {},
    spot: null,
    spotSource: '',
    fut: null,
    futSource: '',
    fx: null,
    rows: [],
    kinds: 0,
    unmatched: 0,
    sort: 'premium-desc',
    query: '',
    paused: false,
    loading: false,
    lastUpdated: null,
    nextAt: 0,
    req: [],
    cycles: 0,
    windowErrors: []
  };

  var el = {};
  var BTC_NEXT = 0;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

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
    var zero = Math.pow(10, -dp) / 2;
    if (Math.abs(v) < zero) v = 0;
    var s = Math.abs(v).toFixed(dp);
    if (v > 0) return '+' + s + '%';
    if (v < 0) return '-' + s + '%';
    return s + '%';
  }
  function signCls(v) {
    if (v == null || !isFinite(v)) return 'dim';
    if (v > 0.0000001) return 'pos';
    if (v < -0.0000001) return 'neg';
    return 'zero';
  }
  function fmtVol(v) {
    if (!(v > 0)) return '--';
    return nf(v / 1e8, 1);
  }
  function countdown(ms) {
    if (!(ms > 0)) return '--';
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
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
  function stamp(d) {
    if (!d) return '--';
    try {
      return d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Seoul' });
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
      S.req.push({ name: name, url: url, ok: true, status: 200, ms: r.ms });
      return r.data;
    }, function (err) {
      S.req.push({ name: name, url: url, ok: false, error: String((err && err.message) || err) });
      throw err;
    });
  }

  /* ---------------------------------------------------------- loaders */
  function loadMarkets() {
    return track('upbit-markets', API.upbitMarkets, request(API.upbitMarkets, 15000)).then(function (list) {
      var out = [];
      (list || []).forEach(function (x) {
        if (!x || typeof x.market !== 'string' || x.market.indexOf('KRW-') !== 0) return;
        out.push({
          base: x.market.slice(4),
          korean: x.korean_name || x.market.slice(4),
          english: x.english_name || ''
        });
      });
      S.marketsAt = Date.now();
      return out;
    });
  }

  function loadTickers(markets) {
    var codes = markets.map(function (m) { return 'KRW-' + m.base; });
    var groups = [];
    for (var i = 0; i < codes.length; i += 100) groups.push(codes.slice(i, i + 100));
    return Promise.all(groups.map(function (g, idx) {
      var url = API.upbitTicker + g.join(',');
      return track('upbit-ticker-' + (idx + 1), url, request(url, 15000)).catch(function () { return []; });
    })).then(function (parts) {
      var out = [];
      parts.forEach(function (p) { if (p && p.length) out = out.concat(p); });
      return out;
    });
  }

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
        addFuture(map, f.symbol.slice(0, -4), parseFloat(f.lastFundingRate),
          f.nextFundingTime, 8, parseFloat(f.markPrice));
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
          addFuture(map, m[1], parseFloat(c.funding_rate),
            parseFloat(c.funding_next_apply) * 1000,
            interval > 0 ? interval / 3600 : 8,
            parseFloat(c.mark_price));
        });
        S.futSource = 'Gate.io Futures (대체)';
        return map;
      }).catch(function () { return null; });
    });
  }

  function loadFx() {
    var i = 0;
    function next() {
      if (i >= FX_SOURCES.length) return Promise.reject(new Error('no fx source'));
      var src = FX_SOURCES[i++];
      return track('fx:' + src.id, src.url, request(src.url, 10000)).then(function (data) {
        var out = src.parse(data);
        var rate = parseFloat(out && out.rate);
        if (!(rate > 500 && rate < 3000)) throw new Error('unexpected rate');
        return { rate: rate, date: out.date || '', source: src.id };
      }).catch(function () { return next(); });
    }
    return next();
  }

  /* ---------------------------------------------------------- compute */
  function indexTickers(list) {
    var m = {};
    (list || []).forEach(function (t) {
      if (!t || typeof t.market !== 'string') return;
      m[t.market.slice(4)] = t;
    });
    return m;
  }

  function computeRows() {
    var fx = S.fx && S.fx.rate;
    var spot = S.spot || {};
    var fut = S.fut || { exact: {}, alias: {} };
    var rows = [];
    var unmatched = 0;

    (S.markets || []).forEach(function (m) {
      var t = S.tickers[m.base];
      if (!t) return;
      var binance = spot[m.base];
      if (!(binance > 0)) { unmatched++; return; }
      var price = parseFloat(t.trade_price);
      var prem = (fx > 0 && price > 0) ? ((price / (binance * fx)) - 1) * 100 : null;
      var f = fut.exact[m.base] || fut.alias[m.base] || null;
      rows.push({
        base: m.base,
        korean: m.korean,
        english: m.english,
        price: price,
        binance: binance,
        prem: prem,
        funding: f && isFinite(f.rate) ? f.rate * 100 : null,
        ann: f && isFinite(f.rate) && f.intervalH ? (f.rate * 100) * (24 / f.intervalH) * 365 : null,
        next: f ? f.next : 0,
        vol: parseFloat(t.acc_trade_price_24h) || 0,
        chg: isFinite(parseFloat(t.signed_change_rate)) ? parseFloat(t.signed_change_rate) * 100 : null
      });
    });

    S.rows = rows;
    S.unmatched = unmatched;
  }

  /* ---------------------------------------------------------- KPI */
  function renderKpis() {
    var fx = S.fx;
    var rate = fx ? fx.rate : null;

    var usdt = S.tickers['USDT'] ? parseFloat(S.tickers['USDT'].trade_price) : null;
    var tetherPrem = (rate > 0 && usdt > 0) ? ((usdt / rate) - 1) * 100 : null;

    // 기준 환율
    el['fx-rate'].innerHTML = rate ? fmtRate(rate) + '<small>원/USD</small>' : '--';
    el['fx-meta'].textContent = fx
      ? fx.source + (fx.date ? ' · ' + fx.date.slice(0, 22) + ' 고시' : '')
      : '환율 API 응답 없음';
    el['fx-tether'].textContent = usdt > 0
      ? '테더 환산 ' + fmtRate(usdt) + '원 ' + (tetherPrem == null ? '' : '(' + pct(tetherPrem, 2) + ')')
      : '테더 환산 --';

    // 업비트 테더
    el['usdt-price'].innerHTML = usdt > 0 ? fmtKrw(usdt) + '<small>원</small>' : '--';
    el['usdt-prem'].innerHTML = (usdt > 0 && tetherPrem != null)
      ? '테더 김프 <b class="' + signCls(tetherPrem) + '">' + pct(tetherPrem, 2) + '</b>'
      : '테더 김프 --';

    // BTC
    var btc = null;
    for (var i = 0; i < S.rows.length; i++) { if (S.rows[i].base === 'BTC') { btc = S.rows[i]; break; } }
    var btcFut = S.fut ? (S.fut.exact['BTC'] || S.fut.alias['BTC']) : null;
    BTC_NEXT = btcFut ? btcFut.next : 0;

    if (btc) {
      el['btc-prem'].innerHTML = btc.prem == null ? '--' : '<span class="' + signCls(btc.prem) + '">' + pct(btc.prem, 2) + '</span>';
      el['btc-meta'].textContent = fmtKrw(btc.price) + '원 / $' + fmtUsd(btc.binance);
    } else {
      el['btc-prem'].innerHTML = '--';
      el['btc-meta'].textContent = '업비트 -- / 바이낸스 --';
    }

    if (btcFut && isFinite(btcFut.rate)) {
      var fr = btcFut.rate * 100;
      el['btc-funding'].innerHTML = '<span class="' + signCls(fr) + '">' + pct(fr, 4) + '</span><small>/8h</small>';
      var ann = fr * (24 / (btcFut.intervalH || 8)) * 365;
      el['btc-funding-ann'].innerHTML = '연환산 <b class="' + signCls(ann) + '">' + pct(ann, 1) + '</b>';
      el['btc-next'].textContent = '다음 펀딩 ' + clockOf(btcFut.next) + ' · ' + countdown(btcFut.next - Date.now());
    } else {
      el['btc-funding'].innerHTML = '--';
      el['btc-funding-ann'].textContent = '연환산 --';
      el['btc-next'].textContent = '다음 펀딩 --';
    }

    // 최고/최저 김프
    var top = null, low = null;
    for (var j = 0; j < S.rows.length; j++) {
      var r = S.rows[j];
      if (r.prem == null || r.vol < VOL_FLOOR) continue;
      if (!top || r.prem > top.prem) top = r;
      if (!low || r.prem < low.prem) low = r;
    }
    el['top-sym'].textContent = top ? top.korean + ' ' + top.base : '--';
    el['top-val'].innerHTML = top ? '<span class="' + signCls(top.prem) + '">' + pct(top.prem, 2) + '</span>' : '--';
    el['low-sym'].textContent = low ? low.korean + ' ' + low.base : '--';
    el['low-val'].innerHTML = low ? '<span class="' + signCls(low.prem) + '">' + pct(low.prem, 2) + '</span>' : '--';
  }

  /* ---------------------------------------------------------- table */
  var SORTS = {
    'premium-desc': function (a, b) { return cmp(a.prem, b.prem, -1) || cmp(a.vol, b.vol, -1); },
    'premium-asc': function (a, b) { return cmp(a.prem, b.prem, 1) || cmp(a.vol, b.vol, -1); },
    'funding-abs': function (a, b) {
      var av = a.funding == null ? null : Math.abs(a.funding);
      var bv = b.funding == null ? null : Math.abs(b.funding);
      return cmp(av, bv, -1) || cmp(a.vol, b.vol, -1);
    },
    'volume-desc': function (a, b) { return cmp(a.vol, b.vol, -1); }
  };

  function cmp(a, b, dir) {
    var an = (a == null || !isFinite(a)), bn = (b == null || !isFinite(b));
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (a === b) return 0;
    return dir * (a < b ? -1 : 1);
  }

  function rowHtml(r) {
    var chgCls = r.chg == null ? 'flat' : r.chg > 0.0001 ? 'up' : r.chg < -0.0001 ? 'down' : 'flat';
    return '<tr>' +
      '<th scope="row" class="rt__sym"><span class="sym-kr">' + esc(r.korean) + '</span><span class="sym-code">' + esc(r.base) + '</span></th>' +
      '<td>' + fmtKrw(r.price) + '</td>' +
      '<td>' + fmtUsd(r.binance) + '</td>' +
      '<td class="' + signCls(r.prem) + '">' + pct(r.prem, 2) + '</td>' +
      '<td>' + (r.funding == null
        ? '<span class="dim">--</span>'
        : '<span class="f-main ' + signCls(r.funding) + '">' + pct(r.funding, 4) + '</span>' +
          '<span class="f-ann ' + signCls(r.ann) + '">' + pct(r.ann, 1) + '/yr</span>') + '</td>' +
      '<td>' + fmtVol(r.vol) + '</td>' +
      '<td class="chg ' + chgCls + '">' + pct(r.chg, 2) + '</td>' +
      '</tr>';
  }

  function visibleRows() {
    var q = S.query.trim().toLowerCase();
    var rows = S.rows;
    if (q) {
      rows = rows.filter(function (r) {
        return r.base.toLowerCase().indexOf(q) >= 0 ||
          r.korean.toLowerCase().indexOf(q) >= 0 ||
          (r.english && r.english.toLowerCase().indexOf(q) >= 0);
      });
    }
    return rows.slice().sort(SORTS[S.sort] || SORTS['premium-desc']);
  }

  function renderTable() {
    var rows = visibleRows();
    var body = el.body;

    if (!S.rows.length) {
      if (S.cycles > 0) {
        body.innerHTML = '<tr class="rt__placeholder rt__placeholder--empty"><td colspan="7">시세를 받지 못했습니다. 잠시 후 <b>새로고침</b>을 눌러 주세요. (광고 차단 확장이나 네트워크가 거래소·환율 API를 막는 경우가 있습니다)</td></tr>';
        el['table-foot'].textContent = '요청 실패: ' + S.req.filter(function (r) { return !r.ok; }).map(function (r) { return r.name + '(' + (r.error || 'error') + ')'; }).join(', ');
      } else {
        body.innerHTML = '<tr class="rt__placeholder"><td colspan="7">거래소 공개 API에서 시세를 받아오는 중입니다…</td></tr>';
        el['table-foot'].textContent = '초기 로딩 중입니다. 15초마다 자동으로 갱신됩니다.';
      }
      el['row-count'].textContent = '—';
      return;
    }

    if (!rows.length) {
      body.innerHTML = '<tr class="rt__placeholder rt__placeholder--empty"><td colspan="7">검색어와 일치하는 심볼이 없습니다.</td></tr>';
    } else {
      var html = [];
      for (var i = 0; i < rows.length; i++) html.push(rowHtml(rows[i]));
      body.innerHTML = html.join('');
    }

    var futures = 0;
    for (var k = 0; k < S.rows.length; k++) if (S.rows[k].funding != null) futures++;
    var volSum = 0;
    for (var v = 0; v < S.rows.length; v++) volSum += S.rows[v].vol;

    el['row-count'].textContent = '표시 ' + rows.length + '종 / 김프 ' + S.rows.length + '종';
    el['table-foot'].textContent =
      '업비트 KRW ' + ((S.markets && S.markets.length) || 0) + '종 중 바이낸스 USDT 현물 페어가 있는 ' +
      S.rows.length + '종을 비교합니다(업비트 단독 상장 ' + S.unmatched + '종 제외). ' +
      '이 중 펀딩비가 확인된 종목은 ' + futures + '종입니다. ' +
      '비교 종목의 업비트 24시간 거래대금 합계는 ' + nf(volSum / 1e8, 0) + '억 원.';
  }

  /* ---------------------------------------------------------- status */
  function sourceChips() {
    var byName = {};
    S.req.forEach(function (r) { byName[r.name] = r; });

    var upbitOk = S.req.filter(function (r) { return r.name.indexOf('upbit') === 0 && r.ok; }).length;
    var upbitAll = S.req.filter(function (r) { return r.name.indexOf('upbit') === 0; }).length;

    var spotLabel = S.spotSource === 'api.binance.com' ? 'BINANCE SPOT'
      : S.spotSource === 'data-api.binance.vision' ? 'BINANCE SPOT (mirror)' : 'BINANCE SPOT';
    var chips = [
      { label: 'UPBIT', state: upbitOk ? 'ok' : 'fail', note: upbitOk + '/' + upbitAll },
      { label: spotLabel, state: S.spotSource ? 'ok' : 'fail' },
      { label: S.futSource || 'FUNDING', state: S.futSource ? 'ok' : 'fail' },
      { label: 'FX · ' + (S.fx ? S.fx.source : '없음'), state: S.fx ? 'ok' : 'fail' }
    ];

    el.chips.innerHTML = chips.map(function (c) {
      return '<span class="src ' + (c.state === 'ok' ? 'is-ok' : c.state === 'fail' ? 'is-fail' : 'is-wait') + '">' +
        '<span class="src__dot"></span>' + esc(c.label) + (c.note ? ' ' + esc(c.note) : '') + '</span>';
    }).join('');
  }

  function updateStatus() {
    var fail = S.req.filter(function (r) { return !r.ok; });
    if (S.paused) {
      el.dot.className = 'dot is-stale';
      el['status-text'].textContent = '일시정지 — 자동 갱신 멈춤';
    } else if (S.loading) {
      el.dot.className = 'dot is-live';
      el['status-text'].textContent = '거래소 API 갱신 중…';
    } else if (fail.length === S.req.length && S.req.length) {
      el.dot.className = 'dot is-stale';
      el['status-text'].textContent = '모든 요청 실패 — 네트워크를 확인하세요';
    } else if (fail.length) {
      el.dot.className = 'dot is-stale';
      el['status-text'].textContent = '일부 소스 응답 없음 (' + fail.length + '/' + S.req.length + ')';
    } else {
      el.dot.className = 'dot is-live';
      el['status-text'].textContent = '실시간 연결 · 마지막 갱신 ' + stamp(S.lastUpdated);
    }
    sourceChips();
  }

  /* ---------------------------------------------------------- cycle */
  function loadCycle() {
    if (S.loading) return;
    S.loading = true;
    S.req = [];
    updateStatus();

    var fxP = loadFx().catch(function () { return null; });
    var spotP = loadSpot();
    var futP = loadFutures();

    var marketsP;
    if (S.markets && (Date.now() - S.marketsAt) < MARKETS_TTL) {
      marketsP = Promise.resolve(S.markets);
    } else {
      marketsP = loadMarkets().catch(function () { return S.markets || []; });
    }

    var tickP = marketsP.then(function (mk) {
      if (!mk || !mk.length) return [];
      return loadTickers(mk);
    }).catch(function () { return []; });

    Promise.all([fxP, spotP, futP, marketsP, tickP]).then(function (res) {
      var fx = res[0], spot = res[1], fut = res[2], markets = res[3], tickers = res[4];

      if (fx) S.fx = fx;
      if (spot) S.spot = spot;
      if (fut) S.fut = fut;
      if (markets && markets.length) S.markets = markets;
      if (tickers && tickers.length) S.tickers = indexTickers(tickers);

      computeRows();
      renderKpis();
      renderTable();
      S.loading = false;
      S.cycles++;
      S.lastUpdated = new Date();
      S.nextAt = Date.now() + REFRESH_MS;
      updateStatus();
      publishDiag();
    }).catch(function (err) {
      S.loading = false;
      S.windowErrors.push('cycle: ' + String(err && err.message || err));
      updateStatus();
      publishDiag();
    });
  }

  function publishDiag() {
    var sample = {};
    ['BTC', 'ETH', 'XRP'].forEach(function (b) {
      var r = null;
      for (var i = 0; i < S.rows.length; i++) if (S.rows[i].base === b) { r = S.rows[i]; break; }
      if (r) sample[b] = { upbit: r.price, binance: r.binance, prem: r.prem, funding: r.funding };
    });
    window.__radarDiag = {
      cycles: S.cycles,
      lastUpdated: S.lastUpdated ? S.lastUpdated.toISOString() : null,
      paused: S.paused,
      requests: S.req.slice(),
      failures: S.req.filter(function (r) { return !r.ok; }),
      fx: S.fx,
      spotSource: S.spotSource,
      futuresSource: S.futSource,
      counts: {
        krwMarkets: (S.markets && S.markets.length) || 0,
        compared: S.rows.length,
        unmatched: S.unmatched,
        withFunding: S.rows.filter(function (r) { return r.funding != null; }).length,
        rendered: document.querySelectorAll('#radar-body tr').length
      },
      sample: sample,
      windowErrors: S.windowErrors.slice()
    };
  }

  /* ---------------------------------------------------------- timers */
  function tick() {
    var now = Date.now();
    if (!S.paused) {
      el.timer.textContent = S.nextAt ? '다음 갱신 ' + Math.max(0, Math.round((S.nextAt - now) / 1000)) + 's' : '다음 갱신 --';
      if (!S.loading && S.nextAt && now >= S.nextAt && !document.hidden) loadCycle();
    } else {
      el.timer.textContent = '일시정지됨';
    }
    if (BTC_NEXT) el['btc-next'].textContent = '다음 펀딩 ' + clockOf(BTC_NEXT) + ' · ' + countdown(BTC_NEXT - now);
  }

  function setPaused(p) {
    S.paused = p;
    el.pause.setAttribute('aria-pressed', p ? 'true' : 'false');
    el.pause.textContent = p ? '재개' : '일시정지';
    if (!p) S.nextAt = Date.now() + REFRESH_MS;
    updateStatus();
    tick();
  }

  /* ---------------------------------------------------------- init */
  function init() {
    el.dot = $('live-dot');
    el.pause = $('btn-pause');
    el.timer = $('refresh-timer');
    el.chips = $('source-chips');
    el.body = $('radar-body');
    el['table-foot'] = $('table-foot');
    el['row-count'] = $('row-count');
    el['status-text'] = $('status-text');
    ['fx-rate', 'fx-meta', 'fx-tether', 'usdt-price', 'usdt-prem', 'btc-prem', 'btc-meta',
      'btc-funding', 'btc-funding-ann', 'btc-next', 'top-sym', 'top-val', 'low-sym', 'low-val'].forEach(function (id) {
      el[id] = $(id);
    });

    window.addEventListener('error', function (e) {
      S.windowErrors.push('error: ' + String((e && e.message) || 'unknown'));
    });
    window.addEventListener('unhandledrejection', function (e) {
      S.windowErrors.push('rejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || 'unknown'));
    });

    $('btn-refresh').addEventListener('click', function () { loadCycle(); });
    el.pause.addEventListener('click', function () { setPaused(!S.paused); });

    var input = $('filter-input');
    var timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var v = input.value;
      timer = setTimeout(function () {
        S.query = v;
        if (S.rows.length) renderTable();
      }, 90);
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
      if (!document.hidden && !S.paused && S.lastUpdated && (Date.now() - S.nextAt) > 0) loadCycle();
    });

    setInterval(tick, 1000);
    publishDiag();
    loadCycle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
