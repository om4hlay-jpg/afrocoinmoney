// Home page renderer - clean dashboard, no marketing content from the landing.
(function () {
  'use strict';
  var App = window.App;
  var U = App.Util;
  var E = App.escapeHTML;
  var M = App.money;

  var chartInstances = {};
  function destroyCharts() {
    Object.keys(chartInstances).forEach(function (k) {
      try { chartInstances[k].destroy(); } catch (e) { /* ignore */ }
    });
    chartInstances = {};
  }

  async function renderHome(container) {
    container.innerHTML = App.spinnerHTML();
    var data;
    try {
      data = await App.api('/home');
    } catch (err) {
      container.innerHTML = '<div class="card"><p class="sub">' + E(err.message) + '</p></div>';
      return;
    }
    var user = data.user;
    var activeBot = data.active_bot;

    var earnPayload = activeBot ? E(JSON.stringify({
      amount: Number(activeBot.amount),
      daily_percent: Number(activeBot.daily_percent),
      lock_days: Number(activeBot.lock_days),
      started_at_ts: activeBot.started_at_ts || null,
      started_at: activeBot.started_at || null
    })) : '';

    var progressPct = 0;
    if (activeBot) {
      var startTs = Date.parse(activeBot.started_at_ts || activeBot.started_at);
      if (startTs) {
        var elapsed = Math.max(0, Date.now() - startTs);
        progressPct = Math.min(100, Math.round(elapsed / (Number(activeBot.lock_days) * 86400000) * 100));
      }
    }

    container.innerHTML =
      '<div class="dash-row">' +
        '<div class="card wallet">' +
          '<div class="label">Wallet Balance</div>' +
          '<div class="balance">' + M(user.wallet_balance) + '</div>' +
          '<div class="row"><span>Pending earnings</span><strong>' + M(user.pending_earnings) + '</strong></div>' +
          '<div class="row"><span>Today\'s income</span><strong>' + M(user.today_income) + '</strong></div>' +
          '<div class="quick-actions">' +
            '<button class="btn btn-primary btn-sm" data-goto="profile">Deposit</button>' +
            '<button class="btn btn-ghost btn-sm" data-goto="profile">Withdraw</button>' +
            '<button class="btn btn-ghost btn-sm" data-goto="bots">Terminals</button>' +
          '</div>' +
        '</div>' +
        '<div class="card chart-card">' +
          '<div class="chart-head"><h3>Earnings</h3><span class="sub">Projected through lock</span></div>' +
          '<div class="chart-wrap"><canvas id="earnChart"></canvas></div>' +
        '</div>' +
      '</div>' +

      '<div class="stats-grid">' +
        U.stat('Deposited', M(user.total_deposited), 'blue') +
        U.stat('Withdrawn', M(user.total_withdrawn), 'green') +
        U.stat('Terminal income', M(user.bot_income), 'green') +
        U.stat('Team income', M(user.team_income), 'blue') +
      '</div>' +

      '<div class="dash-row">' +
        '<div class="card">' +
          '<div class="card-head"><h3>Quick Links</h3></div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
            '<button class="btn btn-outline btn-block" id="howItWorksBtn">' +
              '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>' +
              ' How It Works' +
            '</button>' +
            '<button class="btn btn-outline btn-block" id="telegramBtn">' +
              '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4 20-11z"/><path d="M22 2 11 13"/></svg>' +
              ' Telegram' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="dash-row">' +
        (activeBot
          ? '<div class="card"><div class="card-head"><h3>' + E(activeBot.tier) + ' Terminal</h3><span class="badge green">Active</span></div>' +
            '<div class="bot-meta">' +
              '<div>Invested<strong>' + M(activeBot.amount) + '</strong></div>' +
              '<div>Daily rate<strong>' + E(activeBot.daily_percent) + '%</strong></div>' +
              '<div>Lock<strong>' + E(activeBot.lock_days) + ' days</strong></div>' +
              '<div>Ends<strong>' + E(activeBot.ends_at) + '</strong></div>' +
            '</div>' +
            '<div class="bar bar-lg"><div style="width:' + progressPct + '%"></div></div>' +
            '<div class="bar-caption"><span>' + progressPct + '% through lock</span><span id="dashCountdown">--</span></div>' +
            '<div class="stat-big" style="margin-top:12px;">' +
              '<div class="stat-label">Live earned this session</div>' +
              '<div class="stat-value green" data-live-earned=\'' + earnPayload + '\'>--</div>' +
            '</div>' +
            '</div>'
          : '<div class="card"><h3>No active terminal</h3><p class="sub">Open a terminal to start earning daily returns.</p>' +
            '<button class="btn btn-primary btn-block" data-goto="bots" style="margin-top:12px;">View terminals</button></div>') +
        '<div class="card chart-card">' +
          '<div class="chart-head"><h3>Allocation</h3></div>' +
          '<div class="chart-wrap"><canvas id="allocChart"></canvas></div>' +
        '</div>' +
      '</div>' +      '<div class="card">' +
        '<div class="card-head"><h3>Tasks</h3></div>' +
        '<div id="dashTasks">' + App.spinnerHTML() + '</div>' +
      '</div>';

    wireHome(container, user, activeBot, data.bonus_credits || []);
  }

  function wireHome(container, user, activeBot, bonusCredits) {
    container.querySelectorAll('[data-goto]').forEach(function (b) {
      b.addEventListener('click', function () { U.nav(b.getAttribute('data-goto')); });
    });

    var howBtn = container.querySelector('#howItWorksBtn');
    if (howBtn) {
      // Deep-link to the full "How it works" explainer on the landing page.
      howBtn.addEventListener('click', function () {
        window.location.href = '/#how';
      });
    }
    var tgBtn = container.querySelector('#telegramBtn');
    if (tgBtn) {
      tgBtn.addEventListener('click', function () {
        window.open('https://t.me/afrocoinmoney', '_blank', 'noopener');
      });
    }

    // Tasks - horizontal rows. The whole row is the action: a link to the
    // Telegram channel, a claim row, or a nudge to the panel that unblocks it.
    App.api('/tasks').then(function (r) {
      var el = container.querySelector('#dashTasks');
      if (!el) return;
      var tasks = (r.tasks || []).slice(0, 4);
      if (!tasks.length) { el.innerHTML = '<p class="sub">No tasks right now.</p>'; return; }

      function rowHtml(t) {
        var done = !!t.done;
        var side = '<span class="task-reward">+' + M(t.reward) + '</span>';
        var waiting = t.condition === 'telegram' && t.started_at && !t.claim_ready;
        var state;
        if (done) state = '<span class="badge grey">Done</span>';
        else if (t.condition === 'telegram' && t.claim_ready) state = '<span class="badge green">Claim ready</span>';
        else if (waiting) state = '<span class="badge amber task-timer" data-task="tg' + t.id + '" data-start="' + E(String(t.started_at)) + '">Reward in 15s</span>';
        else if (t.condition === 'telegram') state = '<span class="badge blue">Open</span>';
        else if (t.condition_met) state = '<span class="badge green">Claim ready</span>';
        else if (t.condition === 'has_username') state = '<span class="badge amber">Set name</span>';
        else if (t.condition === 'has_currency') state = '<span class="badge amber">Change</span>';
        else state = '<span class="badge amber">Go</span>';
        var cls = 'task-row' + (done ? ' task-done' : '') + (t.condition === 'telegram' && !done ? ' task-row-link' : '');
        var href = t.condition === 'telegram' ? '"https://t.me/afrocoinmoney" target="_blank" rel="noopener"' : '"#"';
        var tag = (t.condition === 'telegram' && !done) ? 'a' : 'button';
        return '<' + tag + (tag === 'a' ? ' href=' + href : ' type="button"') + ' class="' + cls + '" data-task-row="' + t.id + '" data-cond="' + E(t.condition) + '"' + (done ? ' disabled' : '') + '>' +
          '<div class="task-info"><div class="task-title">' + E(t.title) + '</div>' +
          '<div class="task-desc">' + E(t.description || '') + '</div></div>' +
          '<div class="task-side">' + state + side + '</div>' +
        '</' + tag + '>';
      }
      el.innerHTML = '<div class="task-list">' + tasks.map(rowHtml).join('') + '</div>';

      function claim(taskId) {
        App.api('/tasks/' + taskId + '/claim', { method: 'POST', body: {} }).then(function () {
          App.toast('Task reward added to your wallet.', 'success');
          renderHome(container);
        }).catch(function (err) {
          App.toast(err.message, 'error');
          renderHome(container);
        });
      }
      function startTimer(slot) {
        var t = tasks.filter(function (x) { return 'tg' + x.id === slot.getAttribute('data-task') || String(x.id) === slot.getAttribute('data-task'); })[0];
        if (!t) return;
        var startMs = Date.parse(slot.getAttribute('data-start'));
        var tick = 15 - Math.floor((Date.now() - startMs) / 1000);
        var timer = setInterval(function () {
          var live = document.querySelector('[data-task="tg' + t.id + '"]');
          if (!live) { clearInterval(timer); return; }
          tick -= 1;
          if (tick <= 0) {
            clearInterval(timer);
            claim(t.id);
            return;
          }
          live.textContent = 'Reward in ' + tick + 's';
        }, 1000);
      }

      // One delegated click handler: claim / nudge-to-panel / join.
      el.addEventListener('click', function (ev) {
        var row = ev.target.closest('[data-task-row]');
        if (!row || row.disabled) return;
        var id = row.getAttribute('data-task-row');
        var cond = row.getAttribute('data-cond');
        var t = tasks.filter(function (x) { return String(x.id) === String(id); })[0];
        if (!t) return;
        if (t.condition === 'telegram') {
          if (t.claim_ready) { claim(t.id); return; }
          if (t.started_at) return;
          App.api('/tasks/' + t.id + '/start', { method: 'POST', body: {} }).then(function (s) {
            t.started_at = s.started_at || new Date(Date.now()).toISOString();
            row.innerHTML =
              '<div class="task-info"><div class="task-title">' + E(t.title) + '</div>' +
              '<div class="task-desc">' + E(t.description || '') + '</div></div>' +
              '<div class="task-side"><span class="badge amber task-timer" data-task="tg' + t.id + '" data-start="' + E(String(t.started_at)) + '">Reward in 15s</span><span class="task-reward">+' + M(t.reward) + '</span></div>';
            startTimer(row.querySelector('.task-timer'));
          }).catch(function (err) {
            App.toast(err.message, 'error');
          });
          return;
        }
        if (t.condition_met) { claim(t.id); return; }
        if (cond === 'has_referral') U.nav('team');
        else if (cond === 'has_deposit') U.nav('profile');
        else if (cond === 'has_bot') U.nav('bots');
        else if (cond === 'has_username') U.nav('profile');
        else if (cond === 'has_currency') U.nav('profile');
        else U.nav('team');
      });

      // Resume any in-flight timer after a re-render mid-wait.
      el.querySelectorAll('.task-timer').forEach(startTimer);
    }).catch(function () {
      var el = container.querySelector('#dashTasks');
      if (el) el.innerHTML = '<p class="sub">Could not load tasks.</p>';
    });

    U.startLiveEarnings();
    if (activeBot) U.startCountdown(container.querySelector('#dashCountdown'), activeBot.ends_at);

    if (typeof Chart !== 'undefined') {
      drawEarningsChart(container, user, activeBot, bonusCredits);
      drawAllocChart(container, user);
    }
  }

  // ---- Animated charts (Chart.js) ---------------------------------------
  function drawEarningsChart(container, user, activeBot, credits) {
    var el = container.querySelector('#earnChart');
    if (!el || !el.getContext) return;
    var lockDays = activeBot ? Math.max(1, Number(activeBot.lock_days)) : 7;
    var daily = activeBot ? Number(activeBot.amount) * (Number(activeBot.daily_percent) / 100) : 0;
    var startTs = activeBot
      ? Date.parse(activeBot.started_at_ts || activeBot.started_at) || Date.now()
      : Date.now() - lockDays * 86400000;
    var labels = [], values = [], cum = 0;
    for (var i = 0; i <= lockDays; i++) {
      var d = new Date(startTs + i * 86400000);
      labels.push((d.getMonth() + 1) + '/' + d.getDate());
      cum += daily;
      values.push(Math.round(cum * 100) / 100);
    }
    if (values.length < 2) { labels.push(''); values.push(0); }

    // Second series: signup bonus + claimed referral income + task rewards,
    // accumulated over the same window. Credits earned before the window
    // start form the day-0 baseline so nothing shown is ever wrong.
    var byDay = {};
    var baseline = 0;
    credits.forEach(function (c) {
      var di = Math.floor((c.ts - startTs) / 86400000);
      if (di < 0) baseline += Number(c.amount) || 0;
      else byDay[di] = (byDay[di] || 0) + (Number(c.amount) || 0);
    });
    var creditValues = [];
    var creditCum = baseline;
    for (var j = 0; j <= lockDays; j++) {
      creditCum += byDay[j] || 0;
      creditValues.push(Math.round(creditCum * 100) / 100);
    }
    if (creditValues.length < 2) { creditValues.push(creditValues[0] || 0); }

    chartInstances.earn = new Chart(el.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Terminal earnings',
          data: values,
          borderColor: '#155239',
          backgroundColor: 'rgba(21,82,57,.10)',
          borderWidth: 2.5,
          fill: true,
          tension: .35,
          pointRadius: 0,
          pointHoverRadius: 4
        }, {
          label: 'Bonus & referrals',
          data: creditValues,
          borderColor: '#c79a1b',
          backgroundColor: 'rgba(199,154,27,.12)',
          borderWidth: 2,
          borderDash: [6, 4],
          fill: false,
          tension: .3,
          pointRadius: 0,
          pointHoverRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 1400, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: true, position: 'bottom', labels: { color: '#55796a', boxWidth: 10, font: { size: 11 }, padding: 10, usePointStyle: true } },
          tooltip: {
            callbacks: {
              label: function (c) { return c.dataset.label + ': ' + M(c.parsed.y); }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#55796a', maxTicksLimit: 7, font: { size: 11 } } },
          y: { beginAtZero: true, grid: { color: 'rgba(7,33,26,.06)' },
               ticks: { color: '#55796a', font: { size: 11 }, callback: function (v) { return M(v); } } }
        }
      }
    });
  }

  function drawAllocChart(container, user) {
    var el = container.querySelector('#allocChart');
    if (!el || !el.getContext) return;
    var wallet = Number(user.wallet_balance) || 0;
    var pending = Number(user.pending_earnings) || 0;
    var invested = Math.max(Number(user.total_deposited) - wallet, 0);
    chartInstances.alloc = new Chart(el.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['Wallet', 'Pending', 'In terminals'],
        datasets: [{
          data: [wallet, pending, invested],
          backgroundColor: ['#155239', '#ffc94d', '#dcefe4'],
          borderWidth: 0,
          hoverOffset: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        animation: { animateRotate: true, duration: 1400, easing: 'easeOutQuart' },
        plugins: {
          legend: { position: 'bottom', labels: { color: '#55796a', boxWidth: 10, font: { size: 11 }, padding: 12 } },
          tooltip: { callbacks: { label: function (c) { return c.label + ': ' + M(c.raw); } } }
        }
      }
    });
  }

  // Destroy charts when navigating away so detached canvases do not leak.
  var _nav = U.nav;
  U.nav = function (page) { destroyCharts(); _nav(page); };

  U.renderers.home = renderHome;
})();
