// IOC extractor & defanger — runs entirely in the page.
(function () {
  'use strict';

  var T = window.T;
  var input = T.qs('#ioc-in');
  if (!input) return;

  var resBox = T.qs('#ioc-res');
  var statsBox = T.qs('#ioc-stats');
  var countBox = T.qs('#ioc-count');
  var copyBtn = T.qs('#ioc-copy');
  var segBtns = T.qsa('.seg [data-mode]');

  var state = { mode: 'defang', groups: [], total: 0 };

  var TYPES = [
    { key: 'url', label: 'URL' },
    { key: 'domain', label: 'DOMAIN' },
    { key: 'ipv4', label: 'IPv4' },
    { key: 'email', label: 'EMAIL' },
    { key: 'sha256', label: 'SHA256' },
    { key: 'sha1', label: 'SHA1' },
    { key: 'md5', label: 'MD5' },
    { key: 'cve', label: 'CVE' }
  ];

  // 파일 확장자처럼 보이는 조각을 도메인으로 잡지 않기 위한 제외 목록
  var BLOCK_TLD = ('js json html htm css md txt php asp aspx jsp py rb go rs ts tsx jsx ' +
    'yml yaml xml csv log conf ini cfg exe dll so zip tar gz tgz pdf png jpg jpeg gif svg ' +
    'sh bat ps1 lock min map woff woff2 ttf eot ico bin dat db sql bak tmp old new out err ' +
    'apk msi dmg pkg deb rpm jar war class pyc swp').split(' ');

  var NO_CHANGE = { cve: 1, md5: 1, sha1: 1, sha256: 1 };

  function refang(s) {
    return s
      .replace(/hxxps/gi, 'https')
      .replace(/hxxp/gi, 'http')
      .replace(/\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}/g, '.')
      .replace(/\[\s*:\s*\]|\(\s*:\s*\)/g, ':')
      .replace(/\[\s*@\s*\]|\(\s*@\s*\)|\[\s*at\s*\]|\(\s*at\s*\)/gi, '@')
      .replace(/\[\s*dot\s*\]|\(\s*dot\s*\)/gi, '.');
  }

  function defangOne(value, type) {
    if (NO_CHANGE[type]) return value;
    var out = value;
    if (type === 'url') {
      out = out.replace(/^https:/i, 'hxxps:').replace(/^http:/i, 'hxxp:');
    }
    return out.replace(/@/g, '[@]').replace(/\./g, '[.]');
  }

  function blank(str, start, end) {
    var pad = '';
    for (var i = 0; i < end - start; i++) pad += ' ';
    return str.slice(0, start) + pad + str.slice(end);
  }

  function trimUnbalanced(v) {
    var pairs = { ')': '(', ']': '[', '}': '{' };
    var guard = 0;
    while (v.length && guard < 40) {
      var last = v.charAt(v.length - 1);
      var open = pairs[last];
      if (!open) break;
      var opens = v.split(open).length - 1;
      var closes = v.split(last).length - 1;
      if (closes <= opens) break;
      v = v.slice(0, -1);
      guard += 1;
    }
    return v;
  }

  function runPass(stateText, re, type, validate) {
    var hits = [];
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(stateText)) !== null) {
      if (!m[0]) { re.lastIndex += 1; continue; }
      var raw = m[0];
      var value = trimUnbalanced(raw.replace(/[.,;:!?'"`]+$/, ''));
      if (value.length < 3) continue;
      if (validate && !validate(value)) continue;
      hits.push({ value: value, start: m.index, end: m.index + raw.length });
    }
    for (var i = hits.length - 1; i >= 0; i--) {
      stateText = blank(stateText, hits[i].start, hits[i].end);
    }
    return { hits: hits, text: stateText };
  }

  function validIPv4(v) {
    var parts = v.split('.');
    if (parts.length !== 4) return false;
    for (var i = 0; i < 4; i++) {
      if (!/^\d{1,3}$/.test(parts[i])) return false;
      if (parts[i].length > 1 && parts[i].charAt(0) === '0') return false;
      var n = parseInt(parts[i], 10);
      if (n < 0 || n > 255) return false;
    }
    return true;
  }

  function validDomain(v) {
    if (v.length > 253) return false;
    if (v.indexOf('_') !== -1) return false;
    var labels = v.split('.');
    if (labels.length < 2) return false;
    var tld = labels[labels.length - 1].toLowerCase();
    if (tld.length < 2 || !/^[a-z]+$/.test(tld)) return false;
    if (BLOCK_TLD.indexOf(tld) !== -1) return false;
    for (var i = 0; i < labels.length; i++) {
      if (!labels[i] || labels[i].length > 63) return false;
    }
    return true;
  }

  function validEmail(v) {
    if (v.length > 254) return false;
    var at = v.lastIndexOf('@');
    if (at < 1) return false;
    var domain = v.slice(at + 1);
    return validDomain(domain);
  }

  function extract(text) {
    var current = refang(text);
    var found = [];
    var pass;

    pass = runPass(current, /\bhttps?:\/\/[^\s<>"'`]+/gi, 'url');
    found = found.concat(markAll(pass.hits, 'url')); current = pass.text;

    pass = runPass(current, /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}\b/g, 'email', validEmail);
    found = found.concat(markAll(pass.hits, 'email')); current = pass.text;

    pass = runPass(current, /\b[a-fA-F0-9]{64}\b/g, 'sha256');
    found = found.concat(markAll(pass.hits, 'sha256')); current = pass.text;

    pass = runPass(current, /\b[a-fA-F0-9]{40}\b/g, 'sha1');
    found = found.concat(markAll(pass.hits, 'sha1')); current = pass.text;

    pass = runPass(current, /\b[a-fA-F0-9]{32}\b/g, 'md5');
    found = found.concat(markAll(pass.hits, 'md5')); current = pass.text;

    pass = runPass(current, /\bCVE-\d{4}-\d{4,7}\b/gi, 'cve');
    found = found.concat(markAll(pass.hits, 'cve')); current = pass.text;

    pass = runPass(current, /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, 'ipv4', validIPv4);
    found = found.concat(markAll(pass.hits, 'ipv4')); current = pass.text;

    pass = runPass(current, /\b(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi, 'domain', validDomain);
    found = found.concat(markAll(pass.hits, 'domain'));

    return dedupe(found);
  }

  function markAll(hits, type) {
    return hits.map(function (h) { return { type: type, value: h.value }; });
  }

  function dedupe(items) {
    var seen = {}, order = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var key = it.type + '|' + it.value.toLowerCase();
      if (!seen[key]) {
        seen[key] = { type: it.type, value: it.value, count: 1 };
        order.push(seen[key]);
      } else {
        seen[key].count += 1;
      }
    }
    return order;
  }

  function groupOf(items, type) {
    return items.filter(function (it) { return it.type === type; });
  }

  function displayValue(item) {
    return state.mode === 'defang' ? defangOne(item.value, item.type) : item.value;
  }

  function renderStats(items) {
    if (!statsBox) return;
    var html = '';
    for (var i = 0; i < TYPES.length; i++) {
      var t = TYPES[i];
      var n = groupOf(items, t.key).length;
      html += '<div class="stat' + (n ? '' : ' is-zero') + '">' +
        '<div class="stat__n">' + n + '</div>' +
        '<div class="stat__k">' + t.label + '</div></div>';
    }
    statsBox.innerHTML = html;
    if (countBox) countBox.textContent = String(items.length);
  }

  function render() {
    if (!resBox) return;
    var items = state.items || [];
    renderStats(items);
    if (!items.length) {
      resBox.innerHTML = '<p class="emptyline">추출된 지표가 없습니다. 로그나 리포트 원문을 붙여넣어 보세요.</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < TYPES.length; i++) {
      var t = TYPES[i];
      var list = groupOf(items, t.key);
      if (!list.length) continue;
      html += '<div class="res-group"><div class="res-group__head"><span>' + t.label +
        '</span><span>' + list.length + '</span></div>';
      for (var j = 0; j < list.length; j++) {
        var v = displayValue(list[j]);
        html += '<div class="res-item"><span class="res-val">' + T.esc(v) + '</span>' +
          (list[j].count > 1 ? '<span class="res-count">×' + list[j].count + '</span>' : '') +
          '<button class="res-copy" type="button" data-value="' + T.esc(v) + '">COPY</button></div>';
      }
      html += '</div>';
    }
    resBox.innerHTML = html;
  }

  function copyAll() {
    var items = state.items || [];
    if (!items.length) return '';
    var lines = ['# IOC list (' + (state.mode === 'defang' ? 'defanged' : 'refanged') + ')'];
    for (var i = 0; i < TYPES.length; i++) {
      var t = TYPES[i];
      var list = groupOf(items, t.key);
      if (!list.length) continue;
      lines.push('');
      lines.push('# ' + t.label + ' (' + list.length + ')');
      for (var j = 0; j < list.length; j++) {
        lines.push(displayValue(list[j]));
      }
    }
    return lines.join('\n');
  }

  var update = T.debounce(function () {
    state.items = extract(input.value || '');
    render();
  }, 180);

  T.on(input, 'input', update);

  T.qsa('[data-mode]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.mode = btn.getAttribute('data-mode');
      segBtns.forEach(function (b) { b.classList.toggle('is-on', b === btn); });
      render();
    });
  });

  T.on(resBox, 'click', function (e) {
    var btn = e.target.closest ? e.target.closest('.res-copy') : null;
    if (!btn) return;
    var value = btn.getAttribute('data-value') || '';
    T.copy(value, function () { T.flash(btn); });
  });

  T.on(copyBtn, 'click', function () {
    var text = copyAll();
    if (!text) return;
    T.copy(text, function () { T.flash(copyBtn, 'COPIED'); });
  });

  T.on(T.qs('#ioc-clear'), 'click', function () {
    input.value = '';
    state.items = [];
    render();
    input.focus();
  });

  T.on(T.qs('#ioc-sample'), 'click', function () {
    input.value = [
      '2026-11-19T04:12:31Z edge-waf id=TX-8812 rule=beacon',
      'src=185.220.101.47 dst=10.20.4.18:443 bytes=1822',
      'GET hxxps://cdn-update-sync[.]top/payload/dropper.ps1 HTTP/1.1',
      'dns q=telemetry.badcdn-metrics.io a=45.133.1.89',
      'beacon 60s to update-check.cdn-update-sync.top (x3)',
      'sha256 275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f',
      'md5 44d88612fea8a8f36de82e1278abb02f',
      'sha1 3395856ce81f2b7382dee72602f798b642f14140',
      'ref CVE-2021-44228 and CVE-2026-31337',
      'contact ops-team@corp-example[.]co[.]kr',
      'config path /opt/app/config.json (확인 필요)'
    ].join('\n');
    state.items = extract(input.value);
    render();
  });

  render();
})();
