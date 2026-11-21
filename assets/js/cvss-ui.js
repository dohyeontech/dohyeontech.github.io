// CVSS v3.1 calculator UI — wires the metric radios to cvss-core.js.
(function () {
  'use strict';

  var T = window.T;
  var C = window.CVSS31;
  var vectorInput = T.qs('#cvss-vector');
  if (!vectorInput || !C) return;

  var scoreEl = T.qs('#cvss-score');
  var sevEl = T.qs('#cvss-sev');
  var expEl = T.qs('#cvss-exp');
  var impEl = T.qs('#cvss-imp');
  var issEl = T.qs('#cvss-iss');
  var errEl = T.qs('#cvss-err');
  var copyBtn = T.qs('#cvss-copy');
  var comboEl = T.qs('#cvss-combo');

  var DEFAULTS = { AV: 'N', AC: 'L', PR: 'L', UI: 'N', S: 'U', C: 'H', I: 'N', A: 'N' };

  function radio(key) {
    return T.qs('.metrics input[name="' + key + '"]:checked') ||
      T.qs('.metrics input[name="' + key + '"]');
  }

  function current() {
    var m = {};
    for (var i = 0; i < C.ORDER.length; i++) {
      var k = C.ORDER[i];
      var el = radio(k);
      m[k] = el ? el.value : DEFAULTS[k];
    }
    return m;
  }

  function setMetrics(m) {
    for (var i = 0; i < C.ORDER.length; i++) {
      var k = C.ORDER[i];
      var el = T.qs('.metrics input[name="' + k + '"][value="' + m[k] + '"]');
      if (el) el.checked = true;
    }
  }

  function fmt(x) {
    return (Math.round(x * 10) / 10).toFixed(1);
  }

  function setError(msg, isNote) {
    if (!errEl) return;
    errEl.textContent = msg || '';
    errEl.classList.toggle('is-note', !!isNote);
  }

  function paint(r, vector) {
    scoreEl.textContent = r.base.toFixed(1);
    sevEl.textContent = r.severity;
    sevEl.className = 'scorecard__sev sev--' + r.severity.toLowerCase();
    expEl.textContent = fmt(r.exploitability);
    impEl.textContent = fmt(r.impact);
    issEl.textContent = fmt(r.iss);
    try {
      history.replaceState(null, '', '#' + vector);
    } catch (e) { /* file:// or sandboxed contexts */ }
  }

  function refresh(syncVector) {
    var m = current();
    var vector = C.buildVector(m);
    paint(C.calc(m), vector);
    if (syncVector !== false) vectorInput.value = vector;
  }

  var onChange = function () { setError(''); refresh(true); };

  T.qsa('.metrics input[type="radio"]').forEach(function (el) {
    el.addEventListener('change', onChange);
  });

  T.on(vectorInput, 'input', function () {
    var res = C.parseVector(vectorInput.value);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMetrics(res.metrics);
    var vector = C.buildVector(res.metrics);
    paint(C.calc(res.metrics), vector);
    if (res.ignored.length) {
      setError('Temporal·Environmental 메트릭(' + res.ignored.join(', ') + ')은 무시하고 Base만 계산했습니다.', true);
    } else {
      setError('');
    }
  });

  T.on(vectorInput, 'blur', function () {
    var res = C.parseVector(vectorInput.value);
    if (res.ok) {
      vectorInput.value = C.buildVector(res.metrics);
      setError('');
    }
  });

  T.on(copyBtn, 'click', function () {
    T.copy(vectorInput.value, function () { T.flash(copyBtn, 'COPIED'); });
  });

  T.on(T.qs('#cvss-reset'), 'click', function () {
    setMetrics(DEFAULTS);
    setError('');
    refresh(true);
  });

  if (comboEl) {
    var n = 1;
    for (var i = 0; i < C.ORDER.length; i++) n *= C.VALID[C.ORDER[i]].length;
    comboEl.textContent = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' COMBINATIONS';
  }

  // 주소 뒤쪽 해시로 들어온 벡터를 우선 적용한다 (공유 링크).
  var fromHash = '';
  try {
    fromHash = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  } catch (e) { fromHash = ''; }
  if (/^CVSS:3\./i.test(fromHash)) {
    var parsed = C.parseVector(fromHash);
    if (parsed.ok) {
      setMetrics(parsed.metrics);
      refresh(true);
      return;
    }
  }
  refresh(true);
})();
