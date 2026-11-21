// CVSS v3.1 base score — formulas from the FIRST.org v3.1 specification (section 7.1, appendix A).
// Pure functions; no DOM access so the same code can be exercised from a test harness.
(function (global) {
  'use strict';

  var AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.20 };
  var AC = { L: 0.77, H: 0.44 };
  var UI = { N: 0.85, R: 0.62 };
  var CIA = { H: 0.56, L: 0.22, N: 0.00 };
  var PR_U = { N: 0.85, L: 0.62, H: 0.27 };
  var PR_C = { N: 0.85, L: 0.68, H: 0.50 };

  var ORDER = ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'];
  var VALID = { AV: 'NALP', AC: 'LH', PR: 'NLH', UI: 'NR', S: 'UC', C: 'HLN', I: 'HLN', A: 'HLN' };
  var TEMPORAL_ENV = { E: 1, RL: 1, RC: 1, CR: 1, IR: 1, AR: 1,
    MAV: 1, MAC: 1, MPR: 1, MUI: 1, MS: 1, MC: 1, MI: 1, MA: 1 };

  // Appendix A: multiply by 100000, do integer arithmetic, never trust raw floats.
  function roundUp(input) {
    var i = Math.round(input * 100000);
    if (i % 10000 === 0) return i / 100000;
    return (Math.floor(i / 10000) + 1) / 10;
  }

  function severity(score) {
    if (score === 0) return 'NONE';
    if (score < 4.0) return 'LOW';
    if (score < 7.0) return 'MEDIUM';
    if (score < 9.0) return 'HIGH';
    return 'CRITICAL';
  }

  function calc(m) {
    var iss = 1 - (1 - CIA[m.C]) * (1 - CIA[m.I]) * (1 - CIA[m.A]);
    var impact;
    var prWeight;
    if (m.S === 'U') {
      impact = 6.42 * iss;
      prWeight = PR_U[m.PR];
    } else {
      impact = 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
      prWeight = PR_C[m.PR];
    }
    var exploitability = 8.22 * AV[m.AV] * AC[m.AC] * prWeight * UI[m.UI];
    var base = 0;
    if (impact > 0) {
      base = m.S === 'U'
        ? roundUp(Math.min(impact + exploitability, 10))
        : roundUp(Math.min(1.08 * (impact + exploitability), 10));
    }
    return {
      base: base,
      severity: severity(base),
      impact: impact,
      exploitability: exploitability,
      iss: iss
    };
  }

  function buildVector(m) {
    var out = 'CVSS:3.1';
    for (var i = 0; i < ORDER.length; i++) {
      out += '/' + ORDER[i] + ':' + m[ORDER[i]];
    }
    return out;
  }

  function parseVector(input) {
    if (!input || !String(input).trim()) {
      return { ok: false, error: '벡터가 비어 있습니다.' };
    }
    var s = String(input).trim().replace(/\s+/g, '');
    if (/^CVSS:4/i.test(s)) {
      return { ok: false, error: 'CVSS v4.0 벡터는 이 계산기에서 계산하지 않습니다. v3.1 전용입니다.' };
    }
    s = s.replace(/^CVSS:3\.1\//i, '').replace(/^CVSS:3\.0\//i, '');
    var parts = s.split('/');
    var metrics = {};
    var ignored = [];
    for (var i = 0; i < parts.length; i++) {
      var piece = parts[i];
      if (!piece) continue;
      var kv = piece.split(':');
      if (kv.length !== 2) {
        return { ok: false, error: '메트릭 표기를 읽을 수 없습니다: ' + piece };
      }
      var key = kv[0].toUpperCase();
      var val = kv[1].toUpperCase();
      if (TEMPORAL_ENV[key]) { ignored.push(key); continue; }
      if (!VALID[key]) {
        return { ok: false, error: '알 수 없는 메트릭입니다: ' + key };
      }
      if (VALID[key].indexOf(val) === -1) {
        return { ok: false, error: key + ' 값이 올바르지 않습니다: ' + val };
      }
      if (Object.prototype.hasOwnProperty.call(metrics, key)) {
        return { ok: false, error: '같은 메트릭이 두 번 나옵니다: ' + key };
      }
      metrics[key] = val;
    }
    for (var j = 0; j < ORDER.length; j++) {
      if (!metrics[ORDER[j]]) {
        return { ok: false, error: '기본 메트릭이 빠졌습니다: ' + ORDER[j] };
      }
    }
    return { ok: true, metrics: metrics, ignored: ignored };
  }

  global.CVSS31 = {
    ORDER: ORDER,
    VALID: VALID,
    roundUp: roundUp,
    severity: severity,
    calc: calc,
    buildVector: buildVector,
    parseVector: parseVector
  };
})(window);
