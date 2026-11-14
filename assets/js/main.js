// Copy-to-clipboard for code blocks + lightweight reading behaviour.
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.codeblock').forEach(function (block) {
    var btn = block.querySelector('.copy');
    var code = block.querySelector('pre code');
    if (!btn || !code) return;
    btn.addEventListener('click', function () {
      var text = code.innerText;
      var done = function () {
        btn.textContent = 'COPIED';
        btn.classList.add('is-done');
        setTimeout(function () {
          btn.textContent = 'COPY';
          btn.classList.remove('is-done');
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () { fallback(text); done(); });
      } else {
        fallback(text);
        done();
      }
    });
  });

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
});
