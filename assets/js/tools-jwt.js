// JWT inspector, base64 and URL encoders — all client-side.
(function () {
  'use strict';

  var T = window.T;
  var input = T.qs('#jwt-in');
  if (!input) return;

  var headEl = T.qs('#jwt-header');
  var payEl = T.qs('#jwt-payload');
  var sigEl = T.qs('#jwt-signature');
  var timesEl = T.qs('#jwt-times');
  var checksEl = T.qs('#jwt-checks');
  var errEl = T.qs('#jwt-err');

  var SAMPLE_VALID = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImstMjAyNi0xMSJ9.eyJzdWIiOiJzdmMtZGVwbG95IiwiaXNzIjoiaHR0cHM6Ly9zc28uY29ycC1leGFtcGxlLmNvLmtyIiwiYXVkIjoiZGVwbG95LWFwaSIsImlhdCI6MTc5NTI2NzE2MywiZXhwIjoxODYxOTIwMDAwLCJzY29wZSI6ImRlcGxveTp3cml0ZSIsImp0aSI6IjhmNGMyYSJ9.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
  var SAMPLE_NONE = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJzdXBlcmFkbWluIiwicGFzc3dvcmQiOiJjaGFuZ2VtZS1wbGVhc2UiLCJleHAiOjE3MzU2ODk2MDAsImlhdCI6MTczNTY4NjAwMH0.';

  function b64ToBytes(s) {
    var str = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4 !== 0) str += '=';
    var bin = atob(str);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToText(bytes) {
    if (window.TextDecoder) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (e) {
        return new TextDecoder('utf-8').decode(bytes);
      }
    }
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch (e2) { return s; }
  }

  function textToBytes(text) {
    if (window.TextEncoder) return new TextEncoder().encode(text);
    var utf8 = unescape(encodeURIComponent(text));
    var out = new Uint8Array(utf8.length);
    for (var i = 0; i < utf8.length; i++) out[i] = utf8.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes, urlSafe) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var b = btoa(bin);
    if (urlSafe) b = b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return b;
  }

  function highlightJson(src) {
    var re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}\[\],:])|(\s+)/g;
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) out += T.esc(src.slice(last, m.index));
      if (m[1] && m[2] !== undefined) {
        out += '<span class="j-key">' + T.esc(m[1]) + '</span>' + m[2];
      } else if (m[1]) {
        out += '<span class="j-str">' + T.esc(m[1]) + '</span>';
      } else if (m[3]) {
        out += '<span class="j-num">' + T.esc(m[3]) + '</span>';
      } else if (m[4]) {
        out += '<span class="j-bool">' + T.esc(m[4]) + '</span>';
      } else if (m[5]) {
        out += '<span class="j-null">' + T.esc(m[5]) + '</span>';
      } else {
        out += T.esc(m[0]);
      }
      last = m.index + m[0].length;
    }
    out += T.esc(src.slice(last));
    return out;
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function fmtTime(ms, offsetMin) {
    var d = new Date(ms + offsetMin * 60000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
      ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
  }

  function span(sec) {
    var s = Math.abs(sec);
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var mi = Math.floor((s % 3600) / 60);
    if (d > 0) return d + '일 ' + h + '시간';
    if (h > 0) return h + '시간 ' + mi + '분';
    if (mi > 0) return mi + '분';
    return Math.max(1, Math.round(s)) + '초';
  }

  function badge(text, kind) {
    return '<span class="badge-state state--' + kind + '">' + T.esc(text) + '</span>';
  }

  function collectSensitive(obj, path, hits) {
    if (!obj || typeof obj !== 'object') return;
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = obj[k];
      var here = path ? path + '.' + k : k;
      if (/(pass(word|wd)?|pwd|secret|api[_-]?key|private[_-]?key|credential|ssn|social[_-]?security|credit|card[_-]?number|bank[_-]?account|token)/i.test(k) && v !== null && typeof v !== 'object') {
        hits.push(here);
      }
      if (v && typeof v === 'object' && path.split('.').length < 3) {
        collectSensitive(v, here, hits);
      }
    }
  }

  function reset() {
    headEl.innerHTML = '—';
    payEl.innerHTML = '—';
    sigEl.innerHTML = '—';
    timesEl.querySelector('tbody').innerHTML = '<tr><td colspan="5" style="color:#5d6b7a">토큰을 넣으면 시각 클레임을 여기에서 변환합니다.</td></tr>';
    checksEl.innerHTML = '<div class="warn warn--info"><span class="warn__tag">INFO</span><span>이 검사기는 서명을 검증하지 않습니다. 디코딩 결과는 누구나 만들 수 있으니, 신뢰 판단은 서버의 키 검증으로 하세요.</span></div>';
    if (errEl) errEl.textContent = '';
  }

  function inspect(raw) {
    var token = String(raw || '').trim().replace(/\s+/g, '');
    if (!token) { reset(); return; }
    if (errEl) errEl.textContent = '';

    var parts = token.split('.');
    if (parts.length === 5) {
      if (errEl) errEl.textContent = 'JWE(암호화된 토큰)로 보입니다. 이 검사기는 JWS 형식(3개 구간)만 다룹니다.';
      reset();
      return;
    }
    if (parts.length < 2) {
      if (errEl) errEl.textContent = 'JWT 형식이 아닙니다. 점(.)으로 구분된 구간이 2개 이상 필요합니다.';
      reset();
      return;
    }

    var header = null, payload = null, headerText = '', payloadText = '';
    try {
      headerText = bytesToText(b64ToBytes(parts[0]));
      header = JSON.parse(headerText);
    } catch (e) {
      if (errEl) errEl.textContent = '헤더를 해석할 수 없습니다. 토큰이 잘렸거나 Base64URL 형식이 아닙니다.';
      headEl.innerHTML = '<span class="j-str">' + T.esc(headerText || parts[0]) + '</span>';
      payEl.innerHTML = '—';
      sigEl.innerHTML = '—';
      return;
    }

    try {
      payloadText = bytesToText(b64ToBytes(parts[1]));
      payload = JSON.parse(payloadText);
    } catch (e2) {
      payload = null;
    }

    headEl.innerHTML = highlightJson(JSON.stringify(header, null, 2));
    if (payload) {
      payEl.innerHTML = highlightJson(JSON.stringify(payload, null, 2));
    } else {
      payEl.innerHTML = '<span class="j-str">' + T.esc(payloadText || parts[1]) + '</span>';
    }

    var sigRaw = parts[2] || '';
    var sigBytes = 0;
    try { sigBytes = sigRaw ? b64ToBytes(sigRaw).length : 0; } catch (e3) { sigBytes = 0; }
    sigEl.innerHTML = sigRaw
      ? highlightJson(JSON.stringify({ bytes: sigBytes, base64url: sigRaw }, null, 2))
      : '<span class="j-null">(서명 없음)</span>';

    renderTimes(payload || {});
    renderChecks(header, payload, sigBytes, payloadText);
  }

  function renderTimes(payload) {
    var rows = [];
    var now = Math.floor(Date.now() / 1000);
    var defs = [
      { key: 'exp', label: 'exp · 만료' },
      { key: 'nbf', label: 'nbf · 유효 시작' },
      { key: 'iat', label: 'iat · 발급' }
    ];
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      var v = payload[d.key];
      if (typeof v !== 'number') {
        rows.push('<tr><td>' + d.key + '</td><td>—</td><td>—</td><td>—</td><td>' + badge('없음', 'none') + '</td></tr>');
        continue;
      }
      var sec = v;
      var ms = v * 1000;
      if (v > 1e12) ms = v; // 밀리초로 들어온 경우 보정
      var status;
      if (d.key === 'exp') {
        status = sec > now ? badge('유효 · ' + span(sec - now) + ' 남음', 'ok') : badge('만료 · ' + span(now - sec) + ' 전', 'bad');
      } else if (d.key === 'nbf') {
        status = sec > now ? badge('아직 이전 · ' + span(sec - now) + ' 후', 'wait') : badge('통과', 'ok');
      } else {
        status = sec > now ? badge('미래 시각', 'wait') : badge(span(now - sec) + ' 전', 'ok');
      }
      rows.push('<tr><td>' + d.key + '</td><td>' + v + '</td><td>' + fmtTime(ms, 0) +
        '</td><td>' + fmtTime(ms, 540) + '</td><td>' + status + '</td></tr>');
    }
    timesEl.querySelector('tbody').innerHTML = rows.join('');
  }

  function renderChecks(header, payload, sigBytes, payloadText) {
    var items = [];
    var now = Math.floor(Date.now() / 1000);
    var alg = header && header.alg ? String(header.alg) : '';

    if (!alg) {
      items.push(['crit', '서명 알고리즘(alg)이 헤더에 없습니다. 검증 구현이 어떤 키로 확인할지 결정하지 못해 통과시키는 경우가 있습니다.']);
    } else if (alg.toLowerCase() === 'none') {
      items.push(['crit', '<code>alg=none</code> — 서명이 없는 토큰입니다. 검증을 건너뛰는 구현에 들어가면 누구나 내용을 위조해 만들 수 있습니다.']);
    } else if (/^HS/i.test(alg)) {
      items.push(['info', '<code>' + T.esc(alg) + '</code> — 대칭키 서명입니다. 비밀키가 짧거나 재사용되면 오프라인 대입으로 뚫리고, 공개키 검증에서 alg를 그대로 믿으면 RS256→HS256 혼동 공격에 쓰입니다.']);
    }

    if (sigBytes === 0) {
      items.push(['warn', '서명 구간이 비어 있습니다. 형식만 보면 정상처럼 보이므로 서버 검증 설정을 확인하세요.']);
    } else if (sigBytes < 32) {
      items.push(['warn', '서명이 ' + sigBytes + '바이트로 짧습니다. HS256은 보통 32바이트 이상, RS256은 256바이트 이상입니다.']);
    }

    if (header && (header.jku || header.x5u || header.jwk)) {
      items.push(['warn', '헤더가 외부 키 주소(<code>jku</code>·<code>x5u</code>·<code>jwk</code>)를 참조합니다. 신뢰 목록에 있는 도메인인지 확인하지 않으면 키 주입으로 서명을 통과시킬 수 있습니다.']);
    }

    if (payload) {
      if (typeof payload.exp !== 'number') {
        items.push(['warn', '만료 시각(<code>exp</code>)이 없습니다. 한 번 발급되면 계속 유효한 토큰이 되어 탈취 시 피해가 커집니다.']);
      } else if (payload.exp <= now) {
        items.push(['warn', '이 토큰은 이미 만료됐습니다(<code>exp</code> ' + fmtTime(payload.exp * 1000, 540) + ' KST). 만료 토큰이 통과한다면 서버가 exp를 검사하지 않는 것입니다.']);
      }
      if (typeof payload.nbf === 'number' && payload.nbf > now) {
        items.push(['warn', '유효 시작 시각(<code>nbf</code>)이 미래입니다. 서버 시계와 발급자 시계가 어긋났는지 확인하세요.']);
      }
      var sensitive = [];
      collectSensitive(payload, '', sensitive);
      if (sensitive.length) {
        items.push(['warn', '민감해 보이는 클레임: <code>' + T.esc(sensitive.join(', ')) + '</code>. JWT 페이로드는 암호화가 아니라 인코딩이라, 토큰을 가진 사람은 모두 읽습니다.']);
      }
    } else if (payloadText) {
      items.push(['warn', '페이로드가 JSON이 아닙니다. JWE이거나 인코딩이 깨진 경우일 수 있습니다.']);
    }

    if (!items.length) {
      items.push(['ok', '형식과 시각에서 눈에 띄는 문제는 없습니다. 다만 서명 검증은 이 도구가 하지 않으므로 서버에서 따로 확인해야 합니다.']);
    }

    var tag = { crit: 'CRIT', warn: 'WARN', info: 'INFO', ok: 'PASS' };
    checksEl.innerHTML = items.map(function (it) {
      return '<div class="warn warn--' + it[0] + '"><span class="warn__tag">' + tag[it[0]] +
        '</span><span>' + it[1] + '</span></div>';
    }).join('');
  }

  var update = T.debounce(function () { inspect(input.value); }, 150);
  T.on(input, 'input', update);

  T.on(T.qs('#jwt-sample-valid'), 'click', function () {
    input.value = SAMPLE_VALID;
    inspect(input.value);
  });
  T.on(T.qs('#jwt-sample-none'), 'click', function () {
    input.value = SAMPLE_NONE;
    inspect(input.value);
  });
  T.on(T.qs('#jwt-clear'), 'click', function () {
    input.value = '';
    reset();
    input.focus();
  });

  // ---------------------------------------------------------------- base64 pane
  var b64in = T.qs('#b64-in');
  var b64out = T.qs('#b64-out');
  var b64err = T.qs('#b64-err');

  function b64Set(text) {
    if (b64out) b64out.textContent = text;
    if (b64err) b64err.textContent = '';
  }

  function alphabetIsUrl() {
    var on = T.qs('#b64-alphabet .is-on');
    return on ? on.getAttribute('data-alpha') === 'url' : false;
  }

  T.on(T.qs('#b64-encode'), 'click', function () {
    if (!b64in) return;
    b64Set(bytesToB64(textToBytes(b64in.value), alphabetIsUrl()));
  });

  T.on(T.qs('#b64-decode'), 'click', function () {
    if (!b64in) return;
    var raw = b64in.value.trim().replace(/\s+/g, '');
    if (!raw) { b64Set(''); return; }
    try {
      b64Set(bytesToText(b64ToBytes(raw)));
    } catch (e) {
      if (b64err) b64err.textContent = 'Base64로 해석할 수 없습니다. 문자 집합(+/ 와 -_)과 패딩을 확인하세요.';
      if (b64out) b64out.textContent = '—';
    }
  });

  T.on(T.qs('#b64-swap'), 'click', function () {
    if (!b64in || !b64out) return;
    var text = b64out.textContent || '';
    if (text === '—') return;
    b64in.value = text;
    b64out.textContent = '—';
  });

  // ---------------------------------------------------------------- url pane
  var urlIn = T.qs('#url-in');
  var urlOut = T.qs('#url-out');
  var urlErr = T.qs('#url-err');
  var urlForm = T.qs('#url-form');

  function urlSet(text) {
    if (urlOut) urlOut.textContent = text;
    if (urlErr) urlErr.textContent = '';
  }

  T.on(T.qs('#url-encode'), 'click', function () {
    if (!urlIn) return;
    var out = encodeURIComponent(urlIn.value);
    if (urlForm && urlForm.checked) out = out.replace(/%20/g, '+');
    urlSet(out);
  });

  T.on(T.qs('#url-decode'), 'click', function () {
    if (!urlIn) return;
    var raw = urlIn.value;
    if (urlForm && urlForm.checked) raw = raw.replace(/\+/g, ' ');
    try {
      urlSet(decodeURIComponent(raw));
    } catch (e) {
      if (urlErr) urlErr.textContent = '잘못된 퍼센트 인코딩입니다. % 뒤에 두 자리 16진수가 오는지 확인하세요.';
      if (urlOut) urlOut.textContent = '—';
    }
  });

  T.on(T.qs('#url-swap'), 'click', function () {
    if (!urlIn || !urlOut) return;
    var text = urlOut.textContent || '';
    if (text === '—') return;
    urlIn.value = text;
    urlOut.textContent = '—';
  });

  reset();
})();
