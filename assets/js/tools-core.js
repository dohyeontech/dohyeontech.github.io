// Shared helpers for the /tools/ pages. No network calls, no storage.
(function () {
  'use strict';

  var errors = window.__toolErrors = window.__toolErrors || [];
  window.addEventListener('error', function (e) {
    errors.push(String((e && e.message) || e));
  });
  window.addEventListener('unhandledrejection', function (e) {
    errors.push('unhandledrejection: ' + String(e && e.reason));
  });

  var T = window.T = {};

  T.qs = function (sel, root) { return (root || document).querySelector(sel); };
  T.qsa = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };
  T.on = function (el, ev, fn) { if (el) el.addEventListener(ev, fn); };

  T.debounce = function (fn, ms) {
    var timer = null;
    return function () {
      var self = this, args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  };

  T.esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (err) { /* clipboard unavailable */ }
    document.body.removeChild(ta);
  }

  T.copy = function (text, done) {
    var finish = function () { if (typeof done === 'function') done(); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(finish, function () { fallbackCopy(text); finish(); });
    } else {
      fallbackCopy(text);
      finish();
    }
  };

  T.flash = function (btn, temp) {
    if (!btn) return;
    if (!btn.getAttribute('data-label')) btn.setAttribute('data-label', btn.textContent);
    var original = btn.getAttribute('data-label');
    btn.textContent = temp || 'COPIED';
    btn.classList.add('is-done');
    setTimeout(function () {
      btn.textContent = original;
      btn.classList.remove('is-done');
    }, 1500);
  };

  // Tab strip: <div class="tabs"> buttons[data-pane] + .tabpane[data-pane]
  T.initTabs = function (scope) {
    var root = scope || document;
    var buttons = T.qsa('.tabs [data-pane]', root);
    var panes = T.qsa('.tabpane[data-pane]', root);
    if (!buttons.length) return;
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-pane');
        buttons.forEach(function (b) {
          var on = b === btn;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        panes.forEach(function (p) {
          p.classList.toggle('is-on', p.getAttribute('data-pane') === name);
        });
      });
    });
  };

  document.addEventListener('DOMContentLoaded', function () {
    T.initTabs(document);

    // Pair helpers used by the base64 / url panes: <button id="x-encode">, <button id="x-decode">
    T.qsa('[data-alpha]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        T.qsa('[data-alpha]').forEach(function (b) { b.classList.toggle('is-on', b === btn); });
      });
    });

    // Copy from any element: <button data-copy-from="element-id">
    T.qsa('[data-copy-from]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var src = document.getElementById(btn.getAttribute('data-copy-from'));
        if (!src) return;
        var text = src.textContent || '';
        T.copy(text, function () { T.flash(btn); });
      });
    });
  });
})();
