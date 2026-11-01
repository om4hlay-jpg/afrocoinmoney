// Levels page renderer - fixed-price investment levels.
(function () {
  'use strict';
  var App = window.App;
  var U = App.Util;
  var E = App.escapeHTML;
  var M = App.money;

  // Terminal icon (server rack / terminal) - inline SVG, no emoji.
  var TERMINAL_ICON = '<svg class="term-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/></svg>';

  var selectedBot = null;
  var pendingBot = null;

  async function renderBots(container) {
    container.innerHTML = App.spinnerHTML();
    var me = await App.api('/auth/me');
    var balance = me.user.wallet_balance;
    var bots = await U.getBots(true);
    var active = (await App.api('/bots/active')).active;

    // Hide any legacy rows from the picker.
    bots = (bots || []).filter(function (b) { return String(b.tier).indexOf('LEGACY') !== 0; });

    var html =
      '<div class="wallet">' +
        '<div class="label">Wallet Balance</div>' +
        '<div class="balance">' + M(balance) + '</div>' +
      '</div>';

    if (active) {
      // Shared active-terminal card: progress bar + live per-second earned line.
      html += U.activeBotCard(active);
    }

    html += '<div class="section-title">Choose Your Terminal</div>' +
      bots.map(function (b, i) {
        var isHot = i === 1;        // Terminal 2 - most popular
        var dailyUsd = Number(b.min_amount) * (Number(b.daily_percent) / 100);
        var totalUsd = Number(b.min_amount) + dailyUsd * Number(b.lock_days);
        var badgeCls = isHot ? 'pop-badge hot' : 'pop-badge';
        var badgeText = 'MOST POPULAR';
        var termNo = i + 1;
        return '<div class="bot bot-tap' + (isHot ? ' popular' : '') + '" role="button" tabindex="0" data-bot="' + b.id + '" data-price="' + b.min_amount + '" data-pct="' + b.daily_percent + '" data-lock="' + b.lock_days + '" data-name="' + E(b.name) + '">' +
          (isHot ? '<span class="' + badgeCls + '">' + badgeText + '</span>' : '') +
          '<div class="bot-head"><span class="bot-name">' + TERMINAL_ICON + E(b.name) + '</span><span class="bot-percent">' + E(b.daily_percent) + '% daily</span></div>' +
          '<p class="sub">Price: <strong>' + M(b.min_amount) + '</strong> for ' + E(b.lock_days) + ' days</p>' +
          '<div class="bot-meta">' +
            '<div>Daily payout<strong>' + M(dailyUsd) + '</strong></div>' +
            '<div>Total payout<strong>' + M(totalUsd) + '</strong></div>' +
          '</div>' +
          '<div class="bot-activate-veil"><span class="bot-activate-btn">Open Session</span></div>' +
        '</div>';
      }).join('');

    container.innerHTML = html;

    // Animate the "earned so far" line on the active-terminal card.
    U.startLiveEarnings();

    // Tapping a card arms it: an animated veil covers the card with a centered
    // "Open Session" button. Tapping that button opens the confirm popup.
    container.querySelectorAll('.bot').forEach(function (card, idx) {
      card.addEventListener('click', function (ev) {
        if (ev.target.closest('.bot-activate-btn')) return;
        container.querySelectorAll('.bot.armed').forEach(function (c) { if (c !== card) c.classList.remove('armed'); });
        card.classList.toggle('armed');
      });
      card.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); card.click(); }
      });
      var actBtn = card.querySelector('.bot-activate-btn');
      if (actBtn) actBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openConfirm(card, idx + 1);
      });
    });

    function openConfirm(card, termNo) {
      var name = card.getAttribute('data-name');
        var price = card.getAttribute('data-price');
        var pct = card.getAttribute('data-pct');
        var lock = card.getAttribute('data-lock');
        var id = card.getAttribute('data-bot');
        var dailyUsd = Number(price) * (Number(pct) / 100);
        var totalUsd = Number(price) + dailyUsd * Number(lock);
        pendingBot = { id: id, price: price, pct: pct, lock: lock, name: name };
        U.openModal(
          '<h3>' + TERMINAL_ICON + ' ' + E(name) + ' (Terminal ' + termNo + ')</h3><button class="modal-close" data-close>&times;</button><div class="divider"></div>' +
          '<p class="sub">A terminal is a plan that earns money for you. It locks your money for the time period and pays you every day.</p>' +
          '<div class="bot-meta" style="margin-top:12px;">' +
            '<div>Session price<strong>' + M(price) + '</strong></div>' +
            '<div>Daily rate<strong>' + E(pct) + '%</strong></div>' +
            '<div>Time period<strong>' + E(lock) + ' days</strong></div>' +
            '<div>Daily payout<strong>' + M(dailyUsd) + '</strong></div>' +
            '<div>Total payout<strong>' + M(totalUsd) + '</strong></div>' +
          '</div>' +
          '<button class="btn btn-primary btn-block" id="rentSessionBtn" style="margin-top:12px;">Open Session</button>' +
          '<button class="btn btn-ghost btn-block" style="margin-top:8px;" data-close>Cancel</button>'
        );
        document.getElementById('rentSessionBtn').addEventListener('click', rentSession);
    }

    // Confirm and execute the terminal activation.
    async function rentSession() {
      if (!pendingBot) return;
      var btn = document.getElementById('rentSessionBtn');
      if (btn) { btn.disabled = true; btn.textContent = 'Processing...'; }
      try {
        // The member's balance and the level price are both in their display
        // currency, so send the local-currency amount - the server converts it
        // back to USD base and validates it matches the level exactly.
        var me = await App.api('/auth/me');
        var cur = (me.user && me.user.currency) || 'USD';
        var rate = 1;
        var c = App.getCurrency ? App.getCurrency() : null;
        if (c && c.code === cur) rate = c.rate;
        else {
          var list = await App.getCurrencies(true);
          for (var i = 0; i < list.length; i++) {
            if (list[i].code === cur) { rate = list[i].rate; break; }
          }
        }
        var priceLocal = Number(pendingBot.price) * (rate || 1);
        await App.api('/bots/purchase', {
          method: 'POST',
          body: { bot_id: Number(pendingBot.id), amount: priceLocal }
        });
        U.closeModal();
        App.toast('Session opened. Daily earnings start today.', 'success');
        renderBots(document.getElementById('page-bots'));
      } catch (err) {
        App.toast(err.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Open Session'; }
      }
    }
  }

  U.renderers.bots = renderBots;
})();

