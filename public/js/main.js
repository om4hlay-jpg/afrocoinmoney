// Main app controller: auth gate, navigation, boot.
(function () {
  'use strict';
  var App = window.App;
  var U = App.Util;
  var E = App.escapeHTML;
  var M = App.money;

  if (!App.getToken()) {
    window.location.href = 'login.html';
    return;
  }

  App.getCurrencies().then(function (list) {
    try {
      if (!localStorage.getItem('afrocoin_currency') && list && list.length) {
        App.setCurrency('USD');
      }
    } catch (e) { }
  });

  async function renderTopGreeting() {
    var el = document.getElementById('topGreet');
    if (!el) return;
    var user = null;
    try { user = (await App.api('/auth/me')).user; } catch (e) { }
    var displayName = user ? (user.display_name || user.name || (user.email ? String(user.email).split('@')[0] : '') || (user.phone || 'Investor')) : 'Investor';
    el.innerHTML = '<div class="greeting">' + E(U.getGreeting()) + ', ' + E(displayName) + '!</div>';
  }

  renderTopGreeting();

  document.querySelectorAll('.bottom-nav .nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      U.nav(btn.getAttribute('data-page'));
    });
  });

  var notifBadge = document.getElementById('notifBadge');

  async function loadNotifBadge() {
    if (!notifBadge) return;
    try {
      var r = await App.api('/notifications/unread-count');
      var c = Number(r.count) || 0;
      notifBadge.textContent = c > 9 ? '9+' : c;
      notifBadge.style.display = c > 0 ? '' : 'none';
    } catch (e) { }
  }

  loadNotifBadge();
  setInterval(loadNotifBadge, 30000);

  // Transaction marquee - scrolls recent successful transactions.
  var marqueeTrack = document.getElementById('txnMarqueeTrack');
  function renderMarquee(txns) {
    if (!marqueeTrack) return;
    if (!txns.length) {
      marqueeTrack.innerHTML = '<span class="txn-marquee-content muted">No transactions yet.</span>';
      marqueeTrack.style.animation = 'none';
      return;
    }
    var items = txns.map(function (t) {
      var sign = t.type === 'deposit' || t.type === 'referral_bonus' || t.type === 'bonus' || t.type === 'earnings' ? '+' : '&#8722;';
      var cls = t.type === 'deposit' || t.type === 'referral_bonus' || t.type === 'bonus' || t.type === 'earnings' ? 'green' : 'muted';
      var label = String(t.type || 'txn').replace(/_/g, ' ');
      // Amounts render in the member's selected currency only - no crypto
      // asset names in the ticker.
      return '<span class="txn-marquee-content ' + cls + '">' + sign + ' ' + M(t.amount) + ' &middot; ' + E(label) + '</span>';
    }).join('<span class="txn-marquee-sep">|</span>');
    // Two identical halves so the translateX(-50%) keyframe loops seamlessly.
    marqueeTrack.innerHTML = items + items;
  }
  async function loadMarquee() {
    try {
      var r = await App.api('/marquee');
      renderMarquee(r.transactions || []);
    } catch (e) {
      if (marqueeTrack) marqueeTrack.innerHTML = '<span class="txn-marquee-content muted">Transactions loading...</span>';
    }
  }
  loadMarquee();
  setInterval(loadMarquee, 10000);

  async function boot() {
    try {
      try {
        var me = await App.api('/auth/me');
        var user = me.user;
        if (user && user.currency) App.setCurrency(user.currency);
        // The USD 1 signup bonus is credited automatically at registration,
        // so first login confirms it with a toast - exactly once per device.
        if (user && user.joined_at && !localStorage.getItem('afrocoin_wb_toast')) {
          var age = Date.now() - Date.parse(user.joined_at);
          if (age >= 0 && age < 24 * 3600 * 1000) {
            App.toast('Your USD 1.00 welcome bonus has been credited to your wallet.', 'success');
            localStorage.setItem('afrocoin_wb_toast', String(Date.now()));
          }
        }
      } catch (e) { }
      await U.nav('home');
      await handleLaunchIntent();
    } finally {
      App.showLoader(false);
    }
  }

  // Manifest shortcuts (PWA long-press) launch the app with an intent:
  //   ?page=team   -> open the Team tab
  //   ?action=deposit -> open the deposit sheet on Profile
  // Runs after the first paint so the deep link never blocks boot.
  async function handleLaunchIntent() {
    var params = new URLSearchParams(window.location.search);
    var page = params.get('page');
    var action = params.get('action');

    if (page === 'team' || page === 'bots' || page === 'profile' || page === 'home') {
      await U.nav(page);
    }
    if (action === 'deposit') {
      await U.nav('profile');
      var btn = document.getElementById('depositBtn');
      if (btn) btn.click();
    }
    // Clean the query string so a refresh does not replay the intent.
    if (page || action) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }

  boot();
})();
