// Copy-to-clipboard for code blocks, tip addresses, and lightweight reading behaviour.
document.addEventListener('DOMContentLoaded', function () {
  function fallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  function copyText(text, onDone) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onDone).catch(function () { fallback(text); onDone(); });
    } else {
      fallback(text);
      onDone();
    }
  }

  function flash(btn, original) {
    btn.textContent = 'COPIED';
    btn.classList.add('is-done');
    setTimeout(function () {
      btn.textContent = original;
      btn.classList.remove('is-done');
    }, 1600);
  }

  document.querySelectorAll('.codeblock').forEach(function (block) {
    var btn = block.querySelector('.copy');
    var code = block.querySelector('pre code');
    if (!btn || !code) return;
    btn.addEventListener('click', function () {
      copyText(code.innerText, function () { flash(btn, 'COPY'); });
    });
  });

  // 후원 지갑 주소 복사 (.tip__copy)
  document.querySelectorAll('.tip__copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var value = btn.getAttribute('data-copy') || '';
      if (!value) return;
      copyText(value, function () { flash(btn, 'COPY'); });
    });
  });
});
