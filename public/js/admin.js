// public/js/admin.js
// afrocoinmoney admin console (Tailwind dashboard).
// Desktop-first layout that collapses to an off-canvas sidebar on mobile.
//
// Security model: the token is only stored after GET /api/admin/overview
// succeeds, which is where the server enforces is_admin. A 401/403 at any point
// drops back to the login gate, so a revoked admin loses access immediately.
(function () {
  'use strict';

  var TOKEN_KEY = 'afrocoin_admin_token';
  var token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { token = null; }

  // --- Tiny helpers --------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function usd(n) {
    var v = Number(n) || 0;
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function num(n) { return (Number(n) || 0).toLocaleString('en-US'); }
  function shortDate(s) {
    if (!s) return '-';
    var d = new Date(s);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function shortTime(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // --- API -----------------------------------------------------------------
  async function api(path, opts) {
    var o = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    var res = await fetch(path, {
      method: o.method || 'GET',
      headers: headers,
      body: o.body ? JSON.stringify(o.body) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON body */ }
    if (res.status === 401 || res.status === 403) {
      // Session expired or admin rights revoked - force the gate back up.
      signOut(true);
      throw new Error((data && data.error) || 'Administrator session ended.');
    }
    if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ').');
    return data;
  }

  // --- Toast ---------------------------------------------------------------
  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('toast');
    if (!el) return;
    var tone = kind === 'error'
      ? 'bg-danger/15 border-danger/50 text-white'
      : kind === 'info'
        ? 'bg-brand-500 border-brand-300 text-white'
        : 'bg-success/15 border-success/50 text-white';
    el.className = 'fixed bottom-5 right-5 z-[60] max-w-sm rounded-xl px-4 py-3 text-sm font-semibold shadow-panel border ' + tone;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 4000);
  }

  // --- Auth gate -----------------------------------------------------------
  // Proof-of-work challenge (same 16-bit scheme as the member login) so bots
  // cannot hammer the console. Solved in WebCrypto before every submit.
  var currentChallenge = null;

  async function refreshChallenge() {
    try {
      var c = await fetch('/api/auth/challenge', { headers: { 'Content-Type': 'application/json' } });
      currentChallenge = await c.json();
    } catch (e) { currentChallenge = null; }
  }

  async function solveChallenge(c) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('Your browser is too old to log in securely. Please update it.');
    }
    var enc = new TextEncoder();
    var prefix = c.prefix + ':';
    for (var nonce = 0; nonce < 500000; nonce++) {
      var buf = await window.crypto.subtle.digest('SHA-256', enc.encode(prefix + nonce));
      var bytes = new Uint8Array(buf);
      var hex = '';
      for (var i = 0; i < bytes.length; i++) hex += (bytes[i] >> 4).toString(16) + (bytes[i] & 0xF).toString(16);
      if (hex.indexOf(c.difficulty) === 0) return { challenge_id: c.challenge_id, pow: String(nonce) };
    }
    throw new Error('Could not solve the security check. Please refresh and try again.');
  }

  function signOut(silent) {
    token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    $('console').classList.add('hidden');
    $('console').classList.remove('lg:flex');
    $('gate').classList.remove('hidden');
    $('gateBtn').disabled = false;
    $('gateBtn').textContent = 'Sign in to console';
    if (!silent) toast('Signed out.', 'info');
  }

  function enterConsole() {
    $('gate').classList.add('hidden');
    var c = $('console');
    c.classList.remove('hidden');
    c.classList.add('lg:flex');
    showView('dashboard');
    loadDashboard();
  }

  // Verify a stored token really is an admin before revealing anything.
  async function tryStoredSession() {
    if (!token) return;
    try {
      await api('/api/admin/overview');
      enterConsole();
    } catch (e) { /* gate stays visible */ }
  }

  // Fetch a fresh proof-of-work challenge as soon as the gate is shown so the
  // member never has to wait for it when they submit.
  refreshChallenge();

  $('gateForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('gateBtn');
    var err = $('gateError');
    err.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Checking...';
    try {
      var identifier = $('gIdentifier').value.trim();
      var password = $('gPassword').value;
      // Bot prevention: solve a lightweight proof-of-work challenge first.
      if (!currentChallenge) await refreshChallenge();
      var sol = await solveChallenge(currentChallenge);
      // Reuse the member login endpoint, then confirm admin rights on an
      // admin-only endpoint so a normal member token can never open the console.
      var login = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: identifier,
          password: password,
          challenge_id: sol.challenge_id,
          pow: sol.pow,
          website: ''
        })
      });
      var body = null;
      try { body = await login.json(); } catch (e) { /* ignore */ }
      if (!login.ok || !body || !body.token) {
        throw new Error((body && body.error) || 'Those credentials are not correct.');
      }
      token = body.token;
      await api('/api/admin/overview'); // throws 403 for non-admins
      try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* ignore */ }
      $('gPassword').value = '';
      toast('Welcome back.', 'success');
      enterConsole();
    } catch (e) {
      token = null;
      err.textContent = e.message;
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Sign in to console';
      // Refresh the challenge so the next attempt has a fresh one.
      refreshChallenge();
    }
  });

  $('signOutBtn').addEventListener('click', function () { signOut(); });

  // --- Navigation ----------------------------------------------------------
  var TITLES = {
    dashboard: 'Dashboard',
    payouts: 'Payout Queue',
    members: 'Members',
    transactions: 'Transactions',
    wallets: 'Manage Crypto Wallets',
    rates: 'FX Rates',
    credentials: 'Admin Credentials',
    profile: 'My Profile',
    logs: 'System Logs'
  };
  var LOADERS = {
    dashboard: loadDashboard,
    payouts: loadPayouts,
    members: loadMembers,
    transactions: loadTransactions,
    wallets: loadWallets,
    rates: loadRates,
    credentials: loadCredentials,
    profile: loadProfile,
    logs: loadLogs
  };

  function showView(name) {
    document.querySelectorAll('[data-panel]').forEach(function (p) {
      p.classList.toggle('hidden', p.getAttribute('data-panel') !== name);
    });
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      var active = b.getAttribute('data-view') === name;
      b.classList.toggle('bg-brand-400', active);
      b.classList.toggle('text-white', active);
      b.classList.toggle('text-brand-200', !active);
    });
    $('viewTitle').textContent = TITLES[name] || 'Dashboard';
    closeSidebar();
    if (LOADERS[name]) LOADERS[name]();
  }

  document.querySelectorAll('.nav-btn').forEach(function (b) {
    b.addEventListener('click', function () { showView(b.getAttribute('data-view')); });
  });

  $('refreshBtn').addEventListener('click', function () {
    var active = $('viewTitle').textContent;
    var name = Object.keys(TITLES).find(function (k) { return TITLES[k] === active; }) || 'dashboard';
    if (LOADERS[name]) LOADERS[name]();
  });

  // Mobile drawer
  function openSidebar() {
    $('sidebar').classList.remove('-translate-x-full');
    $('sidebarOverlay').classList.remove('hidden');
  }
  function closeSidebar() {
    $('sidebar').classList.add('-translate-x-full');
    $('sidebarOverlay').classList.add('hidden');
  }
  $('sidebarOpen').addEventListener('click', openSidebar);
  $('sidebarClose').addEventListener('click', closeSidebar);
  $('sidebarOverlay').addEventListener('click', closeSidebar);

  // --- Dashboard -----------------------------------------------------------
  function kpiCard(label, value, sub, accent) {
    return '<div class="bg-brand-600 border border-brand-400 rounded-2xl shadow-card p-5">' +
      '<div class="text-[11px] font-semibold uppercase tracking-wide text-brand-200">' + esc(label) + '</div>' +
      '<div class="mt-2 text-2xl font-extrabold ' + accent + ' tabular">' + value + '</div>' +
      '<div class="mt-1 text-xs text-brand-200">' + sub + '</div>' +
      '</div>';
  }

  function moneyRow(label, value, tone) {
    return '<div class="flex items-center justify-between py-2.5 border-b border-brand-400/60 last:border-0">' +
      '<span class="text-sm text-brand-200">' + esc(label) + '</span>' +
      '<strong class="text-sm ' + tone + ' tabular">' + value + '</strong></div>';
  }

  async function loadDashboard() {
    try {
      var o = await api('/api/admin/overview');
      $('kpiGrid').innerHTML =
        kpiCard('Total Members', num(o.members), '+' + num(o.new_members_7d) + ' in the last 7 days', 'text-white') +
        kpiCard('Wallet Liability', usd(o.wallets_usd), 'Sum of member wallet balances', 'text-gold') +
        kpiCard('Total Deposited', usd(o.total_deposited_usd), num(o.deposits) + ' successful deposits', 'text-success') +
        kpiCard('Total Withdrawn', usd(o.total_withdrawn_usd), num(o.payouts) + ' completed payouts', 'text-danger') +
        kpiCard('Platform Earnings', usd(o.platform_earnings_usd), 'Bot + team income paid out', 'text-success') +
        kpiCard('Active Terminals', num(o.active_bots), num(o.active_bots) + ' running', 'text-white');

      $('dashMoney').innerHTML =
        moneyRow('Wallet balances', usd(o.wallets_usd), 'text-gold') +
        moneyRow('Total deposited', usd(o.total_deposited_usd), 'text-success') +
        moneyRow('Total withdrawn', usd(o.total_withdrawn_usd), 'text-danger') +
        moneyRow('Platform earnings', usd(o.platform_earnings_usd), 'text-success') +
        moneyRow('Terminal income paid', usd(o.bot_income_usd), 'text-white') +
        moneyRow('Team income paid', usd(o.team_income_usd), 'text-white') +
        moneyRow('Active terminals', num(o.active_bots), 'text-white');

      // Pending payout badge in the sidebar.
      var badge = $('navPayoutBadge');
      if (o.pending_payouts > 0) {
        badge.textContent = num(o.pending_payouts);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }

      var recent = (await api('/api/admin/transactions?limit=8')).transactions || [];
      $('dashTxns').innerHTML = recent.length
        ? recent.map(function (t) {
            var tone = t.status === 'success' ? 'text-success'
              : t.status === 'failed' ? 'text-danger' : 'text-gold';
            return '<div class="flex items-center justify-between gap-3 py-2 border-b border-brand-400/60 last:border-0">' +
              '<div class="min-w-0"><div class="text-sm text-white truncate">' + esc(t.who) + '</div>' +
              '<div class="text-[11px] text-brand-200">' + esc(t.type) + ' &middot; ' + esc(t.method || '-') + '</div></div>' +
              '<div class="text-right shrink-0"><div class="text-sm font-bold ' + tone + ' tabular">' + usd(t.amount_usd) + '</div>' +
              '<div class="text-[11px] text-brand-200">' + shortDate(t.created_at) + '</div></div></div>';
          }).join('')
        : '<p class="text-sm text-brand-200">No transactions yet.</p>';
    } catch (e) {
      toast(e.message, 'error');
    }
    // Wire the "Buy a Terminal" button on the dashboard.
    var btn = $('buyTerminalBtn');
    if (btn) btn.addEventListener('click', openBuyTerminalModal);
    // Wire the "Fund my wallet" button.
    var fundBtn = $('fundMyWalletBtn');
    if (fundBtn) fundBtn.addEventListener('click', openFundModal);
  }

  // --- Admin self-fund ------------------------------------------------------
  // Top up the admin's own wallet from the console so they can invest without
  // going through the member deposit flow. Recorded as an admin_adjustment.
  function openFundModal() {
    U.openModal(
      '<h3 class="font-bold text-white">Fund My Wallet</h3><button class="modal-close" data-close>&times;</button><div class="divider"></div>' +
      '<p class="text-sm text-brand-200">Credit your own wallet. This is a self-adjustment - it is recorded in the ledger.</p>' +
      '<div class="field"><label>Amount (USD)</label><input id="fundAmount" type="number" min="1" step="any" placeholder="e.g. 100" class="w-full rounded-lg bg-brand-700 border border-brand-400 text-white placeholder-brand-200/60 px-3.5 py-2.5 text-sm outline-none focus:border-gold" /></div>' +
      '<button class="btn btn-primary btn-block" id="fundSubmit" style="margin-top:14px;">Fund wallet</button>'
    );
    document.getElementById('fundSubmit').addEventListener('click', async function () {
      var btn = document.getElementById('fundSubmit');
      var amount = parseFloat(document.getElementById('fundAmount').value);
      if (!amount || amount <= 0) { toast('Enter a positive amount.', 'error'); return; }
      btn.disabled = true; btn.textContent = 'Funding...';
      try {
        var r = await api('/api/admin/self-fund', { method: 'POST', body: { amount: amount } });
        U.closeModal();
        toast('Wallet funded. New balance: USD ' + num(r.new_balance), 'success');
        loadDashboard();
      } catch (e) { toast(e.message, 'error'); }
      btn.disabled = false; btn.textContent = 'Fund wallet';
    });
  }

  // --- Admin self-investment -----------------------------------------------
  // The admin is a normal user account, so they can invest their own money
  // straight from the console. Deducts from the admin's own wallet balance.
  function openBuyTerminalModal() {
    U.openModal(
      '<h3 class="font-bold text-white">Buy a Terminal</h3><button class="modal-close" data-close>&times;</button><div class="divider"></div>' +
      '<p class="text-sm text-brand-200">Purchases a terminal with your own wallet balance, exactly like a member would.</p>' +
      '<div id="adminBotGrid" class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3"></div>' +
      '<button class="btn btn-ghost btn-block" data-close style="margin-top:12px;">Cancel</button>'
    );
    (async function () {
      try {
        var bots = (await api('/api/bots')).bots || [];
        var me = (await api('/api/admin/me'));
        var balance = Number(me.wallet_balance || 0);
        var host = document.getElementById('adminBotGrid');
        host.innerHTML = bots.map(function (b) {
          var price = Number(b.min_amount);
          var can = balance >= price;
          return '<div class="bg-brand-700 border border-brand-400 rounded-xl p-3 cursor-pointer hover:border-gold" data-bot-id="' + b.id + '" data-bot-price="' + price + '">' +
            '<div class="text-sm font-bold text-white">' + esc(b.name) + '</div>' +
            '<div class="text-[11px] text-brand-200">' + esc(b.tier) + ' &middot; ' + esc(b.daily_percent) + '% daily &middot; ' + esc(b.lock_days) + ' days</div>' +
            '<div class="mt-1 text-sm font-bold text-gold tabular">USD ' + num(price) + '</div>' +
            (can ? '<div class="text-[11px] text-success mt-1">You can afford this</div>' : '<div class="text-[11px] text-danger mt-1">Insufficient balance</div>') +
            '</div>';
        }).join('');
        host.querySelectorAll('[data-bot-id]').forEach(function (card) {
          card.addEventListener('click', async function () {
            var id = parseInt(card.getAttribute('data-bot-id'), 10);
            var price = parseFloat(card.getAttribute('data-bot-price'));
            if (balance < price) { toast('Not enough balance. USD ' + price + ' required.', 'error'); return; }
            try {
              var r = await api('/api/admin/purchase-bot', { method: 'POST', body: { bot_id: id, amount: price } });
              U.closeModal();
              toast('Terminal purchased. USD ' + price + ' deducted from your wallet.', 'success');
              loadDashboard();
            } catch (e) { toast(e.message, 'error'); }
          });
        });
      } catch (e) { toast(e.message, 'error'); }
    })();
  }

  // --- Payouts queue -------------------------------------------------------
  async function loadPayouts() {
    var host = $('payoutList');
    host.innerHTML = '<p class="text-sm text-brand-200">Loading queue...</p>';
    try {
      var data = await api('/api/admin/payouts?limit=100');
      var list = data.payouts || [];
      $('payoutCount').textContent = num(data.total || list.length);
      var badge = $('navPayoutBadge');
      if (data.total > 0) { badge.textContent = num(data.total); badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }

      if (!list.length) {
        host.innerHTML = '<p class="text-sm text-brand-200">No pending payouts. The treasury queue is clear.</p>';
        return;
      }
      host.innerHTML = list.map(function (p) {
        return '<div class="bg-brand-700 border border-brand-400 rounded-xl p-4" data-payout="' + p.id + '">' +
          '<div class="flex flex-wrap items-start gap-3">' +
            '<div class="min-w-0 flex-1">' +
              '<div class="flex items-center gap-2 flex-wrap">' +
                '<span class="text-sm font-bold text-white">' + esc(p.who) + '</span>' +
                '<span class="text-[11px] font-bold bg-gold text-brand-700 rounded px-2 py-0.5">' + esc(p.coin) + '</span>' +
                '<span class="text-[11px] text-brand-200 tabular">#' + esc(p.reference) + '</span>' +
              '</div>' +
              '<div class="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-xs text-brand-200">' +
                '<span>Pay out <strong class="text-white tabular">' + usd(p.net_usd) + '</strong></span>' +
                '<span>Fee <strong class="text-danger tabular">' + usd(p.fee_usd) + '</strong></span>' +
                '<span>Debited <strong class="text-gold tabular">' + usd(p.gross_usd) + '</strong></span>' +
                '<span>Requested ' + esc(shortDate(p.created_at)) + '</span>' +
              '</div>' +
              '<div class="mt-2 text-[11px] text-brand-200 break-all">Address: ' + esc(p.address) + '</div>' +
              '<div class="mt-1 text-[11px] text-gold font-semibold">WolvPay only handles deposits. You send the crypto yourself, then click "Mark paid" to settle the ledger.</div>' +
              '<div class="mt-2 flex items-center gap-2">' +
                '<input type="text" maxlength="120" placeholder="Optional note (recorded in the ledger)" ' +
                'data-note="' + p.id + '" class="flex-1 rounded-lg bg-brand-600 border border-brand-400 text-white placeholder-brand-200/50 px-2.5 py-1.5 text-xs outline-none focus:border-gold" />' +
              '</div>' +
            '</div>' +
            '<div class="flex gap-2 shrink-0">' +
              '<button class="act-settle text-xs font-bold rounded-lg bg-success/20 border border-success/50 text-success px-3 py-2 hover:bg-success/30" data-id="' + p.id + '">Mark paid</button>' +
              '<button class="act-refund text-xs font-bold rounded-lg bg-danger/20 border border-danger/50 text-danger px-3 py-2 hover:bg-danger/30" data-id="' + p.id + '">Refund</button>' +
            '</div>' +
          '</div></div>';
      }).join('');

      host.querySelectorAll('.act-settle').forEach(function (b) {
        b.addEventListener('click', function () { settlePayout(b.getAttribute('data-id'), b); });
      });
      host.querySelectorAll('.act-refund').forEach(function (b) {
        b.addEventListener('click', function () { refundPayout(b.getAttribute('data-id'), b); });
      });
    } catch (e) {
      host.innerHTML = '<p class="text-sm text-danger">Could not load the payout queue.</p>';
      toast(e.message, 'error');
    }
  }

  function payoutNote(id) {
    var el = document.querySelector('[data-note="' + id + '"]');
    return el ? String(el.value || '').trim() : '';
  }

  async function settlePayout(id, btn) {
    if (!window.confirm('Confirm the crypto has been sent for payout #' + id + '?')) return;
    btn.disabled = true;
    btn.textContent = 'Working...';
    try {
      var r = await api('/api/admin/payouts/' + id + '/settle', { method: 'POST', body: { note: payoutNote(id) } });
      toast('Payout settled. ' + usd(r.payout.net_usd) + ' marked paid.', 'success');
      loadPayouts();
      loadDashboard();
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Mark paid';
    }
  }

  async function refundPayout(id, btn) {
    if (!window.confirm('Refund payout #' + id + '? The gross amount returns to the member wallet.')) return;
    btn.disabled = true;
    btn.textContent = 'Working...';
    try {
      var r = await api('/api/admin/payouts/' + id + '/refund', { method: 'POST' });
      toast('Refunded ' + usd(r.refunded_usd) + ' to the member wallet.', 'success');
      loadPayouts();
      loadDashboard();
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Refund';
    }
  }

  // --- Members -------------------------------------------------------------
  var memberState = { offset: 0, limit: 25, q: '' };

  function statusPill(s) {
    var tone = s === 'success' ? 'bg-success/20 text-success'
      : s === 'failed' ? 'bg-danger/20 text-danger'
        : 'bg-gold/20 text-gold';
    return '<span class="text-[11px] font-bold rounded-full px-2 py-0.5 ' + tone + '">' + esc(s) + '</span>';
  }

  async function loadMembers() {
    var tbody = $('memberRows');
    tbody.innerHTML = '<tr><td colspan="8" class="py-6 text-center text-sm text-brand-200">Loading members...</td></tr>';
    try {
      var qs = '?limit=' + memberState.limit + '&offset=' + memberState.offset;
      if (memberState.q) qs += '&q=' + encodeURIComponent(memberState.q);
      var data = await api('/api/admin/members' + qs);
      var list = data.members || [];
      $('memberTotal').textContent = num(data.total) + ' members';
      $('memberPrev').disabled = memberState.offset === 0;
      $('memberNext').disabled = memberState.offset + list.length >= data.total;

      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="py-6 text-center text-sm text-brand-200">No members matched.</td></tr>';
        return;
      }
      tbody.innerHTML = list.map(function (m) {
        var banned = m.banned_until && new Date(m.banned_until).getTime() > Date.now();
        return '<tr class="hover:bg-brand-500/40 ' + (banned ? 'bg-danger/5' : '') + '">' +
          '<td class="py-2.5 pr-3"><div class="text-white font-semibold">' + esc(m.identifier) + '</div>' +
            '<div class="text-[11px] text-brand-200">' + (m.display_name ? esc(m.display_name) + ' &middot; ' : '') + esc(m.currency) +
            (banned ? ' <span class="text-danger font-bold">SUSPENDED</span>' : '') + '</div></td>' +
          '<td class="py-2.5 pr-3 text-brand-200">' + esc(m.country || '-') + '</td>' +
          '<td class="py-2.5 pr-3 text-right font-bold text-gold tabular">' + usd(m.wallet_balance_usd) + '</td>' +
          '<td class="py-2.5 pr-3 text-right text-success tabular">' + usd(m.total_deposited_usd) + '</td>' +
          '<td class="py-2.5 pr-3 text-right text-danger tabular">' + usd(m.total_withdrawn_usd) + '</td>' +
          '<td class="py-2.5 pr-3 text-right text-brand-200 tabular">' + num(m.referrals) + '</td>' +
          '<td class="py-2.5 pr-3 text-brand-200 whitespace-nowrap">' + esc(shortDate(m.joined_at)) + '</td>' +
          '<td class="py-2.5 text-right flex justify-end gap-1">' +
            '<button class="act-adjust text-xs font-bold rounded-lg border border-brand-300 text-brand-200 hover:text-white px-2 py-1.5" ' +
            'data-id="' + m.id + '" data-who="' + esc(m.identifier) + '">Adjust</button>' +
            '<button class="act-ban text-xs font-bold rounded-lg border px-2 py-1.5 ' +
            (banned ? 'border-success text-success hover:bg-success/10' : 'border-warning text-warning hover:bg-warning/10') + '" ' +
            'data-id="' + m.id + '">' + (banned ? 'Reinstate' : 'Suspend') + '</button>' +
            '<button class="act-reset text-xs font-bold rounded-lg border border-brand-300 text-brand-200 hover:text-white px-2 py-1.5" ' +
            'data-id="' + m.id + '" data-who="' + esc(m.identifier) + '">Reset pw</button>' +
            '<button class="act-delete text-xs font-bold rounded-lg border border-danger/40 text-danger hover:bg-danger/10 px-2 py-1.5" ' +
            'data-id="' + m.id + '" data-who="' + esc(m.identifier) + '">Delete</button>' +
          '</td>' +
          '</tr>';
      }).join('');

      tbody.querySelectorAll('.act-adjust').forEach(function (b) {
        b.addEventListener('click', function () {
          openAdjust(b.getAttribute('data-id'), b.getAttribute('data-who'));
        });
      });
      tbody.querySelectorAll('.act-ban').forEach(function (b) {
        b.addEventListener('click', function () {
          openBan(b.getAttribute('data-id'), b.getAttribute('data-who'), b.textContent.trim() === 'Reinstate');
        });
      });
      tbody.querySelectorAll('.act-reset').forEach(function (b) {
        b.addEventListener('click', function () {
          openReset(b.getAttribute('data-id'), b.getAttribute('data-who'));
        });
      });
      tbody.querySelectorAll('.act-delete').forEach(function (b) {
        b.addEventListener('click', function () {
          openDelete(b.getAttribute('data-id'), b.getAttribute('data-who'));
        });
      });
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="8" class="py-6 text-center text-sm text-danger">Could not load members.</td></tr>';
      toast(e.message, 'error');
    }
  }

  $('memberSearchBtn').addEventListener('click', function () {
    memberState.q = $('memberSearch').value.trim();
    memberState.offset = 0;
    loadMembers();
  });
  $('memberSearch').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('memberSearchBtn').click();
  });
  $('memberPrev').addEventListener('click', function () {
    memberState.offset = Math.max(0, memberState.offset - memberState.limit);
    loadMembers();
  });
  $('memberNext').addEventListener('click', function () {
    memberState.offset += memberState.limit;
    loadMembers();
  });

  // --- Wallet adjustment modal --------------------------------------------
  var adjustTarget = null;
  function openAdjust(id, who) {
    adjustTarget = id;
    $('adjustWho').textContent = who + ' (ID ' + id + ')';
    $('adjustAmount').value = '';
    $('adjustNote').value = '';
    $('adjustConfirm').disabled = false;
    $('adjustModal').classList.remove('hidden');
    $('adjustAmount').focus();
  }
  function closeAdjust() {
    $('adjustModal').classList.add('hidden');
    adjustTarget = null;
  }
  $('adjustCancel').addEventListener('click', closeAdjust);
  $('adjustModal').addEventListener('click', function (e) {
    if (e.target === $('adjustModal')) closeAdjust();
  });
  $('adjustConfirm').addEventListener('click', async function () {
    if (!adjustTarget) return;
    var amount = parseFloat($('adjustAmount').value);
    if (!amount || isNaN(amount)) { toast('Enter a non-zero amount.', 'error'); return; }
    var btn = $('adjustConfirm');
    btn.disabled = true;
    btn.textContent = 'Applying...';
    try {
      var r = await api('/api/admin/members/' + adjustTarget + '/adjust', {
        method: 'POST',
        body: { amount_usd: amount, note: $('adjustNote').value }
      });
      toast('Adjustment applied. New balance ' + usd(r.new_balance_usd) + '.', 'success');
      closeAdjust();
      loadMembers();
      loadDashboard();
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Apply';
    }
  });

  // --- Super-user actions: suspend / reset password / delete ----------------
  var actionTarget = null;

  function openBan(id, who, reinstate) {
    actionTarget = { id: id, who: who, kind: 'ban', reinstate: reinstate };
    var title = reinstate ? 'Reinstate account' : 'Suspend account';
    var body = reinstate
      ? 'Lift the suspension on ' + who + ' (ID ' + id + ')? They can log in again immediately.'
      : 'Suspend ' + who + ' (ID ' + id + ')? They will be locked out until you reinstate them.';
    var confirmText = reinstate ? 'Reinstate' : 'Suspend';
    showActionModal(title, body, confirmText, function () {
      return api('/api/admin/members/' + id + '/ban', {
        method: 'PUT',
        body: { banned_until: reinstate ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() }
      });
    }, reinstate ? 'success' : 'warning');
  }

  function openReset(id, who) {
    actionTarget = { id: id, who: who, kind: 'reset' };
    showActionModal(
      'Reset password for ' + who,
      'Set a new password for ' + who + ' (ID ' + id + ')? They will need it to log in next time.',
      'Reset password',
      function () {
        var pw = String($('actionInput').value || '');
        if (pw.length < 4) throw new Error('Password must be at least 4 characters.');
        return api('/api/admin/members/' + id + '/reset-password', {
          method: 'POST',
          body: { new_password: pw }
        });
      },
      'warning'
    );
  }

  function openDelete(id, who) {
    actionTarget = { id: id, who: who, kind: 'delete' };
    showActionModal(
      'Delete ' + who,
      'Soft-delete ' + who + ' (ID ' + id + ')? Their wallet, bots and history stay in the ledger but they can no longer log in. This cannot be undone.',
      'Delete account',
      function () {
        return api('/api/admin/members/' + id, { method: 'DELETE' });
      },
      'danger'
    );
  }

  function showActionModal(title, body, confirmText, run, kind) {
    var overlay = $('actionModal');
    var h3 = $('actionTitle');
    var p = $('actionBody');
    var input = $('actionInput');
    var confirm = $('actionConfirm');
    h3.textContent = title;
    p.innerHTML = body;
    input.value = '';
    input.type = kind === 'reset' ? 'password' : 'text';
    input.placeholder = kind === 'reset' ? 'New password (min 4 chars)' : kind === 'delete' ? 'Type DELETE to confirm' : '';
    confirm.textContent = confirmText;
    confirm.className = 'flex-1 rounded-lg text-sm font-bold py-2.5 ' +
      (kind === 'danger' ? 'bg-danger hover:bg-danger/90 text-white'
        : kind === 'warning' ? 'bg-gold hover:bg-gold-dark text-brand-700'
        : 'bg-success hover:bg-success/90 text-white');
    overlay.classList.remove('hidden');
    if (kind === 'delete') input.focus();
    else if (kind === 'reset') input.focus();
    else confirm.focus();
  }

  function closeAction() {
    $('actionModal').classList.add('hidden');
    actionTarget = null;
  }

  $('actionCancel').addEventListener('click', closeAction);
  $('actionModal').addEventListener('click', function (e) {
    if (e.target === $('actionModal')) closeAction();
  });
  $('actionConfirm').addEventListener('click', async function () {
    if (!actionTarget) return;
    if (actionTarget.kind === 'delete') {
      var typed = String($('actionInput').value || '').trim();
      if (typed !== 'DELETE') { toast('Type DELETE to confirm.', 'error'); return; }
    }
    var btn = $('actionConfirm');
    btn.disabled = true;
    btn.textContent = 'Working...';
    try {
      await actionTarget.run();
      toast(actionTarget.kind === 'ban' ? (actionTarget.reinstate ? 'Account reinstated.' : 'Account suspended.')
        : actionTarget.kind === 'reset' ? 'Password reset.' : 'Account deleted.', 'success');
      closeAction();
      loadMembers();
      if (actionTarget.kind === 'delete') loadDashboard();
    } catch (e) { toast(e.message, 'error'); }
    btn.disabled = false;
    btn.textContent = actionTarget.kind === 'delete' ? 'Delete account'
      : actionTarget.kind === 'reset' ? 'Reset password'
      : actionTarget.reinstate ? 'Reinstate' : 'Suspend';
  });

  // --- Transactions --------------------------------------------------------
  var txnState = { offset: 0, limit: 25 };

  async function loadTransactions() {
    var tbody = $('txnRows');
    tbody.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-sm text-brand-200">Loading ledger...</td></tr>';
    try {
      var qs = '?limit=' + txnState.limit + '&offset=' + txnState.offset;
      var type = $('txnType').value;
      var status = $('txnStatus').value;
      if (type) qs += '&type=' + encodeURIComponent(type);
      if (status) qs += '&status=' + encodeURIComponent(status);

      var data = await api('/api/admin/transactions' + qs);
      var list = data.transactions || [];
      $('txnTotal').textContent = num(data.total) + ' records';
      $('txnPrev').disabled = txnState.offset === 0;
      $('txnNext').disabled = txnState.offset + list.length >= data.total;

      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-sm text-brand-200">No transactions matched.</td></tr>';
        return;
      }
      tbody.innerHTML = list.map(function (t) {
        return '<tr class="hover:bg-brand-500/40">' +
          '<td class="py-2.5 pr-3 text-brand-200 tabular">#' + esc(t.id) + '</td>' +
          '<td class="py-2.5 pr-3 text-white">' + esc(t.who) + '</td>' +
          '<td class="py-2.5 pr-3 text-brand-200 whitespace-nowrap">' + esc(t.type) + '</td>' +
          '<td class="py-2.5 pr-3 text-brand-200">' + esc(t.method || '-') + '</td>' +
          '<td class="py-2.5 pr-3 text-right font-bold text-white tabular">' + usd(t.amount_usd) + '</td>' +
          '<td class="py-2.5 pr-3">' + statusPill(t.status) + '</td>' +
          '<td class="py-2.5 text-brand-200 whitespace-nowrap">' + esc(shortDate(t.created_at)) + '</td>' +
          '</tr>';
      }).join('');
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-sm text-danger">Could not load the ledger.</td></tr>';
      toast(e.message, 'error');
    }
  }

  $('txnType').addEventListener('change', function () { txnState.offset = 0; loadTransactions(); });
  $('txnStatus').addEventListener('change', function () { txnState.offset = 0; loadTransactions(); });
  $('txnPrev').addEventListener('click', function () {
    txnState.offset = Math.max(0, txnState.offset - txnState.limit);
    loadTransactions();
  });
  $('txnNext').addEventListener('click', function () {
    txnState.offset += txnState.limit;
    loadTransactions();
  });

  // --- FX rates ------------------------------------------------------------
  async function loadRates() {
    var grid = $('rateGrid');
    var pill = $('rateSource');
    var myCur = $('rateMyCur');
    grid.innerHTML = '<p class="col-span-full text-sm text-brand-200">Loading rates...</p>';
    try {
      var data = await api('/api/admin/rates');
      var me = await api('/api/admin/me');
      var cur = me.currency || 'USD';
      if (myCur) myCur.textContent = 'Your currency: ' + cur;
      var live = !data.stale;
      pill.textContent = live ? 'Live - ' + data.source : 'Static fallback';
      pill.className = 'ml-auto text-xs font-bold rounded-full px-3 py-1 ' +
        (live ? 'bg-success/20 text-success' : 'bg-gold/20 text-gold');
      grid.innerHTML = (data.rates || []).map(function (r) {
        var overridden = data.overrides && data.overrides[r.code] !== undefined;
        var rate = Number(r.rate);
        var isMine = r.code === cur;
        // How much 1 USD is worth in the admin's own currency.
        var mineRate = cur === 'USD' ? 1 : (data.rates.find(function (x) { return x.code === cur; }) || {}).rate || 1;
        var mineText = isMine ? '1 USD = 1 ' + cur
          : (rate ? '1 USD = ' + num(Math.round(rate * 100) / 100) + ' ' + r.code : '');
        return '<div class="bg-brand-700 border border-brand-400 rounded-xl px-3 py-2.5 relative ' + (isMine ? 'ring-1 ring-gold' : '') + '">' +
          (overridden ? '<span class="absolute top-1.5 right-1.5 text-[9px] font-bold bg-gold text-brand-700 rounded px-1.5 py-0.5">OVERRIDE</span>' : '') +
          '<div class="text-[11px] font-bold text-gold pr-10">' + esc(r.code) + (isMine ? ' <span class="text-[9px] text-white/60">(yours)</span>' : '') + '</div>' +
          '<div class="text-sm text-white tabular">' + num(Math.round(rate * 100) / 100) + '</div>' +
          '<div class="text-[10px] text-brand-200 mt-0.5">' + esc(mineText) + '</div>' +
          '<div class="mt-2 flex items-center gap-1.5">' +
            '<input type="number" step="any" placeholder="override rate" data-rate-code="' + esc(r.code) + '" ' +
            'class="w-full rounded bg-brand-600 border border-brand-400 text-white text-xs px-2 py-1 outline-none focus:border-gold" />' +
            '<button data-set-rate="' + esc(r.code) + '" class="text-[11px] font-bold text-brand-700 bg-gold hover:bg-gold-dark rounded px-2 py-1">Set</button>' +
            (overridden ? '<button data-del-rate="' + esc(r.code) + '" class="text-[11px] font-bold text-danger hover:bg-danger/10 rounded px-2 py-1">x</button>' : '') +
          '</div>' +
          '</div>';
      }).join('');
      grid.querySelectorAll('[data-set-rate]').forEach(function (b) {
        b.addEventListener('click', async function () {
          var code = b.getAttribute('data-set-rate');
          var input = grid.querySelector('[data-rate-code="' + code + '"]');
          var val = parseFloat(input.value);
          if (!val || val <= 0) { toast('Enter a positive rate.', 'error'); return; }
          try {
            await api('/api/admin/rates/' + code, { method: 'PUT', body: { rate: val } });
            toast(code + ' rate overridden to ' + val, 'success');
            loadRates();
          } catch (e) { toast(e.message, 'error'); }
        });
      });
      grid.querySelectorAll('[data-del-rate]').forEach(function (b) {
        b.addEventListener('click', async function () {
          var code = b.getAttribute('data-del-rate');
          try {
            await api('/api/admin/rates/' + code, { method: 'DELETE' });
            toast(code + ' override removed.', 'success');
            loadRates();
          } catch (e) { toast(e.message, 'error'); }
        });
      });
    } catch (e) {
      grid.innerHTML = '<p class="col-span-full text-sm text-danger">Could not load rates.</p>';
      toast(e.message, 'error');
    }
  }

  // --- Crypto wallets ------------------------------------------------------
  async function loadWallets() {
    var list = $('walletList');
    var status = $('walletStatus');
    list.innerHTML = '<p class="col-span-full text-sm text-brand-200">Loading wallets...</p>';
    try {
      var data = await api('/api/admin/wallets');
      var enabled = new Set((data.enabled || []).map((s) => String(s).toLowerCase()));
      var envList = data.env_whitelist || [];
      if (data.env_narrower) {
        status.textContent = 'Env whitelist hides ' + (data.coins.length - envList.length) + ' wallets';
        status.className = 'text-[11px] font-semibold text-gold';
      } else {
        status.textContent = data.enabled.length + ' wallets enabled';
        status.className = 'text-[11px] font-semibold text-success';
      }
      list.innerHTML = (data.coins || []).map(function (c) {
        var on = enabled.has(c.coin);
        return '<label class="flex items-center gap-3 bg-brand-700 border border-brand-400 rounded-xl px-3 py-2.5 cursor-pointer hover:border-gold">' +
          '<input type="checkbox" data-wallet="' + esc(c.coin) + '" ' + (on ? 'checked' : '') + ' class="w-4 h-4 accent-gold" />' +
          '<div class="min-w-0"><div class="text-sm font-semibold text-white truncate">' + esc(c.label) + '</div>' +
          '<div class="text-[11px] text-brand-200">' + esc(c.coin) + '</div></div>' +
          '</label>';
      }).join('');
    } catch (e) {
      list.innerHTML = '<p class="col-span-full text-sm text-danger">Could not load wallets.</p>';
      toast(e.message, 'error');
    }
  }

  $('syncWalletsBtn').addEventListener('click', async function () {
    var btn = $('syncWalletsBtn');
    btn.disabled = true;
    btn.textContent = 'Syncing...';
    try {
      var data = await api('/api/admin/wallets');
      var coins = (data.coins || []).map((c) => c.coin);
      var r = await api('/api/admin/wallets', { method: 'PUT', body: { coins: coins } });
      toast('Synced ' + r.enabled.length + ' wallets from WolvPay.', 'success');
      loadWallets();
    } catch (e) { toast(e.message, 'error'); }
    btn.disabled = false;
    btn.textContent = 'Sync from WolvPay';
  });

  $('saveWalletsBtn').addEventListener('click', async function () {
    var btn = $('saveWalletsBtn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      var checked = [];
      $('walletList').querySelectorAll('input[type=checkbox]:checked').forEach(function (c) {
        checked.push(c.getAttribute('data-wallet'));
      });
      var r = await api('/api/admin/wallets', { method: 'PUT', body: { coins: checked } });
      toast('Saved ' + r.enabled.length + ' enabled wallets.', 'success');
      loadWallets();
    } catch (e) { toast(e.message, 'error'); }
    btn.disabled = false;
    btn.textContent = 'Save selection';
  });

  // --- Admin credentials + own profile --------------------------------------
  async function loadCredentials() {
    var tbody = $('credRows');
    tbody.innerHTML = '<tr><td colspan="5" class="py-6 text-center text-sm text-brand-200">Loading...</td></tr>';
    try {
      var data = await api('/api/admin/credentials');
      var list = data.credentials || [];
      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="py-6 text-center text-sm text-brand-200">No administrator accounts found.</td></tr>';
        return;
      }
      tbody.innerHTML = list.map(function (c) {
        return '<tr class="hover:bg-brand-500/40">' +
          '<td class="py-2.5 pr-3 text-white">' + esc(c.identifier) + '</td>' +
          '<td class="py-2.5 pr-3 text-brand-200">' + esc(c.currency || '-') + '</td>' +
          '<td class="py-2.5 pr-3 text-right text-brand-200 tabular">' + esc(shortDate(c.joined_at)) + '</td>' +
          '<td class="py-2.5 pr-3 text-right text-white tabular">' + num(c.referrals) + '</td>' +
          '<td class="py-2.5 text-right">' +
            '<button data-toggle-cred="' + esc(c.id) + '" class="text-xs font-bold rounded-lg border border-brand-400 px-3 py-1.5 ' +
            (c.is_admin ? 'text-danger hover:bg-danger/10' : 'text-success hover:bg-success/10') + '">' +
            (c.is_admin ? 'Revoke' : 'Grant') + '</button>' +
          '</td>' +
          '</tr>';
      }).join('');
      tbody.querySelectorAll('[data-toggle-cred]').forEach(function (b) {
        b.addEventListener('click', async function () {
          var id = b.getAttribute('data-toggle-cred');
          var revoke = b.textContent.trim() === 'Revoke';
          try {
            await api('/api/admin/credentials/' + id + '/toggle', {
              method: 'PUT',
              body: { is_admin: !revoke }
            });
            toast(revoke ? 'Administrator access revoked.' : 'Administrator access granted.', 'success');
            loadCredentials();
          } catch (e) { toast(e.message, 'error'); }
        });
      });
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="5" class="py-6 text-center text-sm text-danger">Could not load credentials.</td></tr>';
      toast(e.message, 'error');
    }
  }

  async function loadProfile() {
    try {
      var data = await api('/api/admin/me');
      var cur = data.currency || 'USD';
      $('myDisplayName').value = data.display_name || '';
      // Populate the currency picker from the catalogue.
      try {
        var cat = await api('/api/currencies');
        var opts = (cat.currencies || []).map(function (c) {
          return '<option value="' + esc(c.code) + '"' + (c.code === cur ? ' selected' : '') + '>' + esc(c.code) + ' - ' + esc(c.name) + '</option>';
        }).join('');
        $('myCurrency').innerHTML = opts;
      } catch (e) { /* keep whatever is there */ }
    } catch (e) { toast(e.message, 'error'); }
  }

  $('saveMyName').addEventListener('click', async function () {
    try {
      await api('/api/admin/me', { method: 'PUT', body: { display_name: $('myDisplayName').value } });
      toast('Display name saved.', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  $('saveMyCurrency').addEventListener('click', async function () {
    try {
      await api('/api/admin/me', { method: 'PUT', body: { currency: $('myCurrency').value } });
      toast('Currency updated.', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  $('saveMyPass').addEventListener('click', async function () {
    var cur = $('myCurPass').value;
    var nw = $('myNewPass').value;
    if (!cur || !nw || nw.length < 4) { toast('Enter your current password and a new one (min 4 characters).', 'error'); return; }
    try {
      await api('/api/admin/me/password', { method: 'PUT', body: { current_password: cur, new_password: nw } });
      toast('Password updated.', 'success');
      $('myCurPass').value = '';
      $('myNewPass').value = '';
    } catch (e) { toast(e.message, 'error'); }
  });

  // --- System logs ----------------------------------------------------------
  function openLogs() {
    $('logsPanel').classList.remove('hidden');
    loadLogs();
  }
  function closeLogs() { $('logsPanel').classList.add('hidden'); }

  async function loadLogs() {
    var body = $('logBody');
    var level = $('logLevel').value;
    body.innerHTML = '<p class="text-sm text-brand-200">Loading logs...</p>';
    try {
      var data = await api('/api/admin/logs?level=' + encodeURIComponent(level) + '&limit=100');
      var rows = data.logs || [];
      if (!rows.length) {
        body.innerHTML = '<p class="text-sm text-brand-200">No log entries at this level.</p>';
        return;
      }
      body.innerHTML = rows.map(function (r) {
        var tone = r.level === 'error' ? 'text-danger'
          : r.level === 'warn' ? 'text-gold'
          : r.level === 'info' ? 'text-success'
          : 'text-brand-200';
        var ts = r.created_at ? esc(shortDate(r.created_at) + ' ' + esc(shortTime(r.created_at))) : '';
        var ctx = r.context ? ' <span class="text-brand-200">' + esc(String(r.context).slice(0, 200)) + '</span>' : '';
        return '<div class="flex gap-2 py-1 border-b border-brand-400/40"><span class="text-brand-200 shrink-0">' + ts + '</span>' +
          '<span class="shrink-0 font-bold ' + tone + '[' + esc(r.level) + ']</span>' +
          '<span class="text-brand-200 shrink-0">' + esc(r.source) + '</span>' +
          '<span class="text-white break-words">' + esc(r.message) + ctx + '</span></div>';
      }).join('');
    } catch (e) {
      body.innerHTML = '<p class="text-sm text-danger">Could not load logs.</p>';
    }
  }

  // --- Boot ----------------------------------------------------------------
  tryStoredSession();

  // Wire the System Logs panel (opened from the sidebar).
  document.querySelectorAll('.nav-btn[data-view="logs"]').forEach(function (b) {
    b.addEventListener('click', openLogs);
  });
  var logRefresh = $('logRefresh');
  if (logRefresh) logRefresh.addEventListener('click', loadLogs);
  var logClear = $('logClear');
  if (logClear) logClear.addEventListener('click', async function () {
    if (!window.confirm('Delete all system log entries?')) return;
    try {
      await api('/api/admin/logs', { method: 'DELETE' });
      toast('Logs cleared.', 'success');
      loadLogs();
    } catch (e) { toast(e.message, 'error'); }
  });
  var logClose = $('logClose');
  if (logClose) logClose.addEventListener('click', closeLogs);
  var logsPanel = $('logsPanel');
  if (logsPanel) logsPanel.addEventListener('click', function (e) {
    if (e.target === logsPanel) closeLogs();
  });

  // Expose a tiny surface so the browser console / smoke tests can drive it.
  window.__admin = { signOut: signOut, showView: showView, reload: loadDashboard, openLogs: openLogs };
})();

