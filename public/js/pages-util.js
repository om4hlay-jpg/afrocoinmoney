// Shared page utilities used by all renderers.
(function () {
  'use strict';
  var App = window.App;
  var E = App.escapeHTML;
  var M = App.money;

  // Switch the active tab (called from main.js too).
  function nav(page) {
    document.querySelectorAll('.bottom-nav .nav-item').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-page') === page);
    });
    document.querySelectorAll('.content .page').forEach(function (sec) {
      sec.classList.toggle('active', sec.id === 'page-' + page);
    });
    var render = App.Util.renderers[page];
    if (render) {
      var container = document.getElementById('page-' + page);
      // Never leave a permanent spinner: show an error card with retry instead.
      Promise.resolve(render(container)).catch(function (err) {
        container.innerHTML =
          '<div class="card"><h3>Something went wrong</h3>' +
          '<p class="sub">' + E(err && err.message ? err.message : 'Please try again.') + '</p>' +
          '<button class="btn btn-primary btn-block" data-retry="' + page + '" style="margin-top:12px;">Try Again</button></div>';
        var rb = container.querySelector('[data-retry]');
        if (rb) rb.addEventListener('click', function () { nav(page); });
      });
    }
    window.scrollTo(0, 0);
  }

  function openModal(html) {
    var backdrop = document.getElementById('modalBackdrop');
    var box = document.getElementById('modalBox');
    box.innerHTML = html;
    backdrop.classList.add('show');
  }
  function closeModal() {
    document.getElementById('modalBackdrop').classList.remove('show');
  }

  function stat(label, value, cls) {
    return '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-value ' + (cls || '') + '">' + value + '</div></div>';
  }

  // Live accrual math: earnings since purchase, second by second.
  // b needs: amount (USD), daily_percent, lock_days, started_at_ts (or started_at).
  function liveEarned(b) {
    if (!b) return 0;
    var start = Date.parse(b.started_at_ts || b.started_at);
    if (!start) return 0;
    var dailyAmount = Number(b.amount) * (Number(b.daily_percent) / 100);
    var elapsedDays = Math.max(0, (Date.now() - start) / 86400000);
    var capped = Math.min(elapsedDays, Number(b.lock_days));
    return dailyAmount * capped;
  }

  // Attach a per-second ticker to every [data-live-earned] element.
  function startLiveEarnings() {
    var els = document.querySelectorAll('[data-live-earned]');
    if (!els.length) return;
    function tick() {
      els.forEach(function (el) {
        var src = el.getAttribute('data-live-earned');
        try {
          var b = JSON.parse(src);
          el.textContent = App.money(liveEarned(b));
        } catch (e) { /* ignore malformed payloads */ }
      });
    }
    tick();
    clearInterval(startLiveEarnings._timer);
    startLiveEarnings._timer = setInterval(tick, 1000);
  }

  // Days elapsed / total days for a terminal, as whole numbers + a percent.
  function botProgress(b) {
    var start = Date.parse(b.started_at_ts || b.started_at);
    var total = Math.max(1, Number(b.lock_days) || 1);
    if (!start) return { day: 0, total: total, percent: 0 };
    var elapsed = Math.max(0, (Date.now() - start) / 86400000);
    var day = Math.min(total, Math.floor(elapsed));
    var percent = Math.min(100, Math.round((elapsed / total) * 100));
    return { day: day, total: total, percent: percent };
  }

  function activeBotCard(b) {
    var payload = E(JSON.stringify({
      amount: Number(b.amount),
      daily_percent: Number(b.daily_percent),
      lock_days: Number(b.lock_days),
      started_at_ts: b.started_at_ts || null,
      started_at: b.started_at || null
    }));
    // Progress through the terminal's time period, plus how much of the full
    // return has been earned so far.
    var prog = botProgress(b);
    return '<div class="card"><h3>Your Active Terminal (' + E(b.tier) + ')</h3>' +
      '<div class="bot-meta">' +
        '<div>Daily rate<strong>' + E(b.daily_percent) + '%</strong></div>' +
        '<div>Invested<strong>' + M(b.amount) + '</strong></div>' +
        '<div>Started<strong>' + E(String(b.started_at).slice(0, 10)) + '</strong></div>' +
        '<div>Ends<strong>' + E(b.ends_at) + '</strong></div>' +
      '</div>' +
      '<div class="live-line"><span class="live-dot"></span>Earned so far: <span class="live-value" data-live-earned=\'' + payload + '\'></span></div>' +
      // Earnings progress bar: % of the time period that has passed.
      '<div class="bar bar-lg"><div style="width:' + prog.percent + '%"></div></div>' +
      '<div class="bar-caption">' +
        '<span>Day ' + prog.day + ' of ' + prog.total + '</span>' +
        '<span>' + prog.percent + '% of your earnings period done</span>' +
      '</div>' +
      '</div>';
  }

  // Store the bots list in a cache for quick reuse.
  var botsCache = null;
  async function getBots(force) {
    if (botsCache && !force) return botsCache;
    var data = await App.api('/bots');
    botsCache = data.bots;
    return botsCache;
  }

  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var yyyy = d.getFullYear();
    var hh = String(d.getHours()).padStart(2, '0');
    var mi = String(d.getMinutes()).padStart(2, '0');
    return dd + '/' + mm + '/' + yyyy + ' ' + hh + ':' + mi;
  }

  // Time-of-day greeting for the top navigation (no name).
  function getGreeting() {
    var h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  // Per-second countdown to a target date (e.g. terminal end / lock expiry).
  // Renders "X days Y hrs Z min left" into the element; stops at 0.
  function startCountdown(el, targetIso) {
    if (!el) return;
    function render() {
      var ms = Date.parse(targetIso) - Date.now();
      if (ms <= 0) { el.textContent = 'Completed'; return; }
      var s = Math.floor(ms / 1000);
      var d = Math.floor(s / 86400); s -= d * 86400;
      var h = Math.floor(s / 3600); s -= h * 3600;
      var m = Math.floor(s / 60);
      el.textContent = d + 'd ' + h + 'h ' + m + 'm left';
    }
    render();
    clearInterval(startCountdown._t);
    startCountdown._t = setInterval(render, 1000);
  }
  var Util = {
    nav: nav,
    openModal: openModal,
    closeModal: closeModal,
    stat: stat,
    activeBotCard: activeBotCard,
    botProgress: botProgress,
    liveEarned: liveEarned,
    startLiveEarnings: startLiveEarnings,
    getBots: getBots,
    formatDate: formatDate,
    getGreeting: getGreeting,
    startCountdown: startCountdown
  };

  // Wire global modal close buttons.
  // The backdrop click is intentionally NOT wired to close so that the
  // deposit-address modal can never be dismissed by an accidental click.
  document.addEventListener('click', function (e) {
    if (e.target.getAttribute('data-close') != null) closeModal();
  });

  App.Util = Util;
  App.Util.renderers = App.Util.renderers || {};
})();