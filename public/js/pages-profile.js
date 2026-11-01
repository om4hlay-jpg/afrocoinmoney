// Profile page renderer - crypto wallet, deposits/withdrawals, settings.
(function () {
  'use strict';
  var App = window.App;
  var U = App.Util;
  var E = App.escapeHTML;
  var M = App.money;

  // Remembers the current profile identity between renders (for delete confirm).
  var _loginInfo = { method: null, id: null }; 
  function loginInfo() { return _loginInfo; }

  async function renderProfile(container) {
    container.innerHTML = App.spinnerHTML();
    var me = await App.api('/auth/me');
    var user = me.user;
    var txns = (await App.api('/wallet/transactions')).transactions;

    // Identify how this account logs in so the profile is clearly individual.
    var loginMethod = user.email ? 'email' : 'phone';
    var accountId = loginMethod === 'email' ? user.email : user.phone;
    _loginInfo = { method: loginMethod, id: accountId };
    var accountLabel = loginMethod === 'email' ? 'E-mail' : 'Phone number';
    var txnHtml = txns.length
      ? txns.map(function (t) {
          var status = String(t.status || 'pending');
          var settled = status === 'success';
          var failed = status === 'failed' || status === 'cancelled';
          var isIn = t.type === 'deposit' || t.type === 'referral_bonus' || t.type === 'referral_claim' || t.type === 'bonus' || t.type === 'earnings';
          // A deposit is only marked complete once our payment check confirms
          // it - never from client data.
          var up = isIn && settled;
          var down = t.type === 'withdrawal';
          var name =
            t.type === 'deposit' ? 'Deposit &middot; ' + t.method :
            t.type === 'withdrawal' ? 'Withdrawal &middot; ' + t.method :
            t.type === 'referral_bonus' ? 'Referral Bonus' :
            t.type === 'referral_claim' ? 'Referral Earnings Claimed' :
            t.type === 'bonus' ? 'Welcome Bonus' :
            t.type === 'earnings' ? 'Level Earnings (' + (t.method || '') + ')' :
            t.type;
          var badge = settled ? '<span class="badge green">Completed</span>'
            : failed ? '<span class="badge red">Failed</span>'
            : '<span class="badge amber">Pending</span>';
          var sign = up ? '+' : down ? '&#8722;' : '&middot;';
          var amountText = (up || down) ? sign + M(t.amount) : M(t.amount);
          var amountClass = up ? 'plus' : down ? 'minus' : 'muted';
          return '<div class="txn">' +
            '<div class="txn-icon ' + (down ? 'withdraw' : isIn ? 'bonus' : 'deposit') + '">' + sign + '</div>' +
            '<div class="txn-info"><div class="txn-name">' + E(name) + '</div><div class="txn-meta">' + badge + ' ' + E(t.reference) + ' - ' + E(U.formatDate(t.created_at)) + '</div></div>' +
            '<div class="txn-amount ' + amountClass + '">' + amountText + '</div>' +
          '</div>';
        }).join('')
      : '<p class="sub">No transactions yet. Make a crypto deposit to get started.</p>';

    // Currency picker options (current selection preselected).
    var currencies = await App.getCurrencies();
    var curOptions = currencies.map(function (c) {
      return '<option value="' + c.code + '"' + (c.code === user.currency ? ' selected' : '') + '>' + c.code + ' - ' + c.name + '</option>';
    }).join('');

    container.innerHTML =
      '<div class="profile-tabs">' +
        '<button class="profile-tab active" data-tab="wallet">Wallet</button>' +
        '<button class="profile-tab" data-tab="tickets">Tickets</button>' +
      '</div>' +
      '<div id="profileWallet">' +

      '<div class="wallet">' +
        '<div class="label">Wallet Balance</div>' +
        '<div class="balance">' + M(user.wallet_balance) + '</div>' +
        '<div class="row"><span>' + E(accountLabel) + '</span><strong>' + E(accountId) + '</strong></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">' +
        '<button class="btn btn-success" id="depositBtn">Deposit</button>' +
        '<button class="btn btn-outline" id="withdrawBtn">Withdraw</button>' +
      '</div>' +

      '<div class="card">' +
        '<h3>Wallet</h3>' +
        '<div class="list"><li><div class="lead">Total Deposited</div><strong>' + M(user.total_deposited) + '</strong></li>' +
        '<li><div class="lead">Total Withdrawn</div><strong>' + M(user.total_withdrawn) + '</strong></li>' +
        '<li><div class="lead">Terminal Income</div><strong>' + M(user.bot_income) + '</strong></li>' +
        '<li><div class="lead">Locked Earnings</div><strong>' + M(user.pending_earnings) + '</strong></li>' +
        '<li><div class="lead">Team Income</div><strong>' + M(user.team_income) + '</strong></li></div>' +
        '<p class="sub" style="margin-top:8px;">Terminal earnings unlock into your wallet when your terminal&#39;s time period matures.</p>' +
      '</div>' +

      '<div class="card"><h3>Transaction History</h3><div id="txnList">' + txnHtml + '</div></div>' +

      '<div class="card">' +
        '<button class="collapse-toggle" id="settingsToggle" type="button">' +
          '<h3>Account Settings</h3><span class="caret"></span>' +
        '</button>' +
        '<div class="collapse" id="settingsBody">' +
          '<div class="divider"></div>' +
          '<div class="field"><label>Your name</label><input id="setName" type="text" value="' + E(user.name || '') + '" placeholder="Enter your name" /></div>' +
          '<button class="btn btn-ghost btn-block" id="saveNameBtn">Save Name</button>' +
          '<div class="divider"></div>' +
          '<div class="field"><label>Display currency (used everywhere)</label><select id="setCurrency">' + curOptions + '</select></div>' +
          '<button class="btn btn-ghost btn-block" id="saveCurrencyBtn">Change Currency</button>' +
          '<div class="divider"></div>' +
          '<div class="field"><label>Current password</label><input id="curPass" type="password" placeholder="Current password" /></div>' +
          '<div class="field"><label>New password</label><input id="newPass" type="password" placeholder="New password" /></div>' +
          '<button class="btn btn-ghost btn-block" id="changePassBtn">Change Password</button>' +
          '<div class="divider"></div>' +
          '<button class="btn btn-danger-outline btn-block" id="deleteAccountBtn">Delete Account</button>' +
        '</div>' +
      '</div>' +

'<div class="card">' +
        '<button class="collapse-toggle" id="addrToggle" type="button">' +
          '<h3>Saved Withdrawal Addresses</h3><span class="caret"></span>' +
        '</button>' +
        '<div class="collapse" id="addrBody">' +
          '<div class="divider"></div>' +
          '<p class="sub" style="margin-bottom:10px;">Save the crypto wallets you withdraw to. One can be your default - it is used when you file a withdrawal without choosing an address.</p>' +
          '<div id="addrList" class="space-y-2"></div>' +
          '<button class="btn btn-ghost btn-block" id="addAddrBtn" style="margin-top:10px;">+ Add a new address</button>' +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<a class="btn btn-ghost btn-block" href="about.html" style="margin-bottom:8px;">About Us</a>' +
        '<button class="btn btn-outline btn-block" id="signoutBtn">Sign Out</button>' +
      '</div>' +
      '</div>' +

      '<div id="profileTickets" style="display:none;">' +
        '<div id="profileTicketList">Loading...</div>' +
      '</div>' +
    '</div>';

    wireProfile(container);
  }

  // ---- Support tickets -----------------------------------------------------
  // Shared list markup (used by the Profile tab and the Tickets page).
  function ticketListHtml(tickets) {
    if (!tickets || !tickets.length) {
      return '<p class="sub text-center py-6">No support tickets yet. Create one above.</p>';
    }
    var html = '<div class="space-y-2">';
    tickets.forEach(function (t) {
      var statusClass = t.status === 'open' ? 'text-yellow-400' : t.status === 'resolved' ? 'text-green-400' : 'text-red-400';
      html += '<div class="p-3 rounded-lg border ' + (t.status === 'open' ? 'border-yellow-500/20' : t.status === 'resolved' ? 'border-green-500/20' : 'border-red-500/20') + ' mb-2">';
      html += '<div class="flex justify-between items-start" style="min-height: 24px;">';
      html += '<div>';
      html += '<p class="text-sm font-medium" style="color: ' + statusClass + '">' + E(t.subject) + '</p>';
      html += '<p class="text-xs opacity-60" style="color: ' + statusClass + '">' + E(U.formatDate(t.created_at)) + '</p>';
      html += '</div>';
      html += '<span class="text-xs opacity-80" style="color: ' + statusClass + '">' + String(t.status || '').toUpperCase() + '</span>';
      html += '</div>';
      html += '<p class="text-sm mt-1" style="color: #e2e8f0">' + E(t.message) + '</p>';
      html += '</div>';
    });
    return html + '</div>';
  }

  // Shared "new ticket" form markup. `id` namespaced so both surfaces can
  // coexist in the DOM without clashing ids.
  function ticketComposerHtml(p) {
    return '<div class="card"><h3>New Support Ticket</h3>' +
      '<div class="field"><label for="' + p + 'Subject">Subject</label>' +
      '<input id="' + p + 'Subject" type="text" maxlength="140" placeholder="e.g. My deposit has not arrived" /></div>' +
      '<div class="field"><label for="' + p + 'Message">Message</label>' +
      '<textarea id="' + p + 'Message" rows="4" maxlength="4000" placeholder="Describe the issue, and include references or dates that help us trace it."></textarea></div>' +
      '<button class="btn btn-primary btn-block" id="' + p + 'Submit" style="margin-top:8px;">Submit Ticket</button>' +
      '<p class="sub" style="margin-top:8px;" id="' + p + 'Hint"></p>' +
    '</div>';
  }

  async function wireTicketComposer(container, p, ticketsPath) {
    var submit = container.querySelector('#' + p + 'Submit');
    if (!submit) return;
    submit.addEventListener('click', async function () {
      var subject = container.querySelector('#' + p + 'Subject');
      var message = container.querySelector('#' + p + 'Message');
      var hint = container.querySelector('#' + p + 'Hint');
      var s = subject.value.trim();
      var m = message.value.trim();
      if (!s) { App.toast('Add a subject so support can route your ticket.', 'error'); subject.focus(); return; }
      if (s.length < 4) { App.toast('Subject is too short - describe the issue briefly.', 'error'); return; }
      if (m.length < 10) { App.toast('Add a few more details to the message (at least 10 characters).', 'error'); message.focus(); return; }
      submit.disabled = true; submit.textContent = 'Submitting...';
      try {
        var r = await App.api('/settings/tickets', { method: 'POST', body: { subject: s, message: m } });
        App.toast(r.message || 'Ticket submitted. Support will reply to your notifications.', 'success');
        subject.value = '';
        message.value = '';
        submit.disabled = false; submit.textContent = 'Submit Another Ticket';
        if (hint) hint.textContent = '';
        // Refresh the list (or re-render payload for the whole page case).
        var data = await App.api('/settings/tickets');
        var listEl = container.querySelector(ticketsPath || '#' + p + 'List');
        if (listEl) listEl.innerHTML = ticketListHtml(data.tickets || []);
      } catch (err) {
        submit.disabled = false; submit.textContent = 'Submit Ticket';
        App.toast(err.message || 'Could not submit your ticket. Please try again.', 'error');
      }
    });
  }

  async function renderProfileTickets(container) {
    var prest = container.querySelector('#profileTicketList');
    if (!prest) return;
    try {
      var data = await App.api('/settings/tickets');
      prest.innerHTML =
        ticketComposerHtml('profTicket') +
        '<div class="card"><h3>Your Tickets</h3><div id="profTicketListInner">' + ticketListHtml(data.tickets) + '</div></div>';
      await wireTicketComposer(container, 'profTicket', '#profTicketListInner');
    } catch (err) {
      prest.innerHTML = '<p class="sub text-red-500">Error loading tickets: ' + err.message + '</p>';
    }
  }

  function wireProfile(container) {
    // Profile tabs: Wallet / Tickets
    container.querySelectorAll('.profile-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        container.querySelectorAll('.profile-tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
        var wallet = container.querySelector('#profileWallet');
        var tickets = container.querySelector('#profileTickets');
        if (tab.getAttribute('data-tab') === 'tickets') {
          wallet.style.display = 'none';
          tickets.style.display = 'block';
          renderProfileTickets(container);
        } else {
          wallet.style.display = 'block';
          tickets.style.display = 'none';
        }
      });
    });

    container.querySelector('#depositBtn').addEventListener('click', function () { openMoneyModal('deposit'); });
    container.querySelector('#withdrawBtn').addEventListener('click', function () { openMoneyModal('withdraw'); });
    container.querySelector('#signoutBtn').addEventListener('click', signOut);
    container.querySelector('#saveNameBtn').addEventListener('click', saveName);
    container.querySelector('#saveCurrencyBtn').addEventListener('click', saveCurrency);
    container.querySelector('#changePassBtn').addEventListener('click', changePassword);
    container.querySelector('#settingsToggle').addEventListener('click', function () {
      var body = container.querySelector('#settingsBody');
      var open = body.classList.toggle('open');
      container.querySelector('#settingsToggle').classList.toggle('open', open);
    });
    container.querySelector('#deleteAccountBtn').addEventListener('click', function () {
      var li = loginInfo();
      deleteAccount(li.method, li.id);
    });
    // Address book
    var addrToggle = container.querySelector('#addrToggle');
    if (addrToggle) {
      addrToggle.addEventListener('click', function () {
        var body = container.querySelector('#addrBody');
        var open = body.classList.toggle('open');
        addrToggle.classList.toggle('open', open);
        if (open) loadAddrList(container);
      });
    }
    var addBtn = container.querySelector('#addAddrBtn');
    if (addBtn) addBtn.addEventListener('click', function () { openAddrModal(container); });
    loadAddrList(container);
  }
  // --- Saved withdrawal addresses -------------------------------------------
  async function loadAddrList(container) {
    var list = container ? container.querySelector('#addrList') : document.getElementById('addrList');
    if (!list) return;
    list.innerHTML = '<p class="sub">Loading saved addresses...</p>';
    try {
      var data = await App.api('/settings/addresses');
      var rows = data.addresses || [];
      if (!rows.length) {
        list.innerHTML = '<p class="sub">No saved addresses yet. Add one when you withdraw, or click below.</p>';
        return;
      }
      list.innerHTML = rows.map(function (a) {
        return '<div class="addr-row" style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--white);border:1px solid var(--border);border-radius:10px">' +
          '<div style="flex:1;min-width:0;"><div style="font-weight:700;">' + E(a.coin.toUpperCase()) + (a.is_default ? ' <span class="badge green">Default</span>' : '') + '</div>' +
          '<div class="sub" style="word-break:break-all;">' + E(a.address) + (a.label ? ' &middot; ' + E(a.label) : '') + '</div></div>' +
          '<button data-addr-edit="' + a.id + '" class="btn btn-ghost btn-sm">Edit</button>' +
          '<button data-addr-del="' + a.id + '" class="btn btn-danger-outline btn-sm">Delete</button>' +
          '</div>';
      }).join('');
      list.querySelectorAll('[data-addr-edit]').forEach(function (b) {
        b.addEventListener('click', function () { openAddrModal(container, parseInt(b.getAttribute('data-addr-edit'), 10)); });
      });
      list.querySelectorAll('[data-addr-del]').forEach(function (b) {
        b.addEventListener('click', async function () {
          var id = parseInt(b.getAttribute('data-addr-del'), 10);
          if (!window.confirm('Delete this saved address?')) return;
          try {
            await App.api('/settings/addresses/' + id, { method: 'DELETE' });
            App.toast('Address deleted.', 'success');
            loadAddrList(container);
          } catch (e) { App.toast(e.message, 'error'); }
        });
      });
    } catch (e) {
      list.innerHTML = '<p class="sub text-danger">Could not load addresses.</p>';
    }
  }

  function openAddrModal(container, id) {
    var editing = !!id;
    U.openModal(
      '<h3>' + (editing ? 'Edit Address' : 'Add Withdrawal Address') + '</h3><button class="modal-close" data-close>&times;</button><div class="divider"></div>' +
      '<div class="field"><label>Cryptocurrency</label><select id="addrCoin">' +
        '<option value="btc">Bitcoin (BTC)</option><option value="eth">Ethereum (ETH)</option>' +
        '<option value="trc20_usdt">USDT (TRC20)</option><option value="erc20_usdt">USDT (ERC20)</option>' +
        '<option value="sol_usdt">USDT (SOL)</option><option value="erc20_usdc">USDC (ERC20)</option>' +
        '<option value="sol_usdc">USDC (SOL)</option><option value="ltc">Litecoin (LTC)</option>' +
        '<option value="doge">Dogecoin (DOGE)</option><option value="bch">Bitcoin Cash (BCH)</option>' +
        '<option value="trx">TRON (TRX)</option>' +
      '</select></div>' +
      '<div class="field"><label>Wallet address</label><input id="addrAddress" type="text" placeholder="Paste your crypto wallet address" /></div>' +
      '<div class="field"><label>Label (optional)</label><input id="addrLabel" type="text" placeholder="e.g. My Binance wallet" maxlength="60" /></div>' +
      '<label class="sub" style="display:flex;align-items:center;gap:6px;margin-top:8px;"><input type="checkbox" id="addrDefault" /> Make this my default address</label>' +
      '<button class="btn btn-primary btn-block" id="addrSave" style="margin-top:14px;">' + (editing ? 'Save Changes' : 'Save Address') + '</button>'
    );
    if (editing) {
      (async function () {
        try {
          var data = await App.api('/settings/addresses');
          var a = (data.addresses || []).find(function (x) { return x.id === id; });
          if (a) {
            document.getElementById('addrCoin').value = a.coin;
            document.getElementById('addrAddress').value = a.address;
            document.getElementById('addrLabel').value = a.label || '';
            document.getElementById('addrDefault').checked = !!a.is_default;
          }
        } catch (e) { App.toast(e.message, 'error'); }
      })();
    }
    document.getElementById('addrSave').addEventListener('click', async function () {
      var btn = document.getElementById('addrSave');
      btn.disabled = true; btn.textContent = 'Saving...';
      try {
        var body = {
          coin: document.getElementById('addrCoin').value,
          address: document.getElementById('addrAddress').value.trim(),
          label: document.getElementById('addrLabel').value.trim(),
          is_default: document.getElementById('addrDefault').checked
        };
        if (editing) {
          await App.api('/settings/addresses/' + id, { method: 'PUT', body: body });
        } else {
          await App.api('/settings/addresses', { method: 'POST', body: body });
        }
        App.toast(editing ? 'Address updated.' : 'Address saved.', 'success');
        U.closeModal();
        loadAddrList(container);
      } catch (e) { App.toast(e.message, 'error'); }
      btn.disabled = false; btn.textContent = editing ? 'Save Changes' : 'Save Address';
    });
  }

  // Deposit / Withdraw modal - crypto only.
  function openMoneyModal(kind) {
    var isDeposit = kind === 'deposit';
    var cur = App.getCurrency();
    U.openModal(
      '<h3>' + (isDeposit ? 'Deposit Crypto' : 'Withdraw Crypto') + '</h3><button class="modal-close" data-close>&times;</button><div class="divider"></div>' +
      '<div class="field"><label>Amount (' + E(cur.code) + ')</label><input id="moneyAmount" type="number" min="1" step="any" placeholder="' + (isDeposit ? 'Minimum deposit ' + M(10) : 'Minimum withdrawal ' + M(30)) + '" /></div>' +
      '<div class="field"><label>Cryptocurrency</label><select id="moneyCoin"><option value="">Loading coins...</option></select></div>' +
      (isDeposit
        ? '<p class="sub">You will pay on a secure payment page with BTC, USDT or another coin.</p>'
        : '<div class="field"><label>Your wallet address</label><input id="moneyAddress" type="text" placeholder="Paste your personal wallet address" /></div>' +
          '<div class="field"><label>Saved addresses</label><select id="moneySaved" class="input"><option value="">-- Choose a saved address --</option></select></div>' +
          '<label class="sub" style="display:flex;align-items:center;gap:6px;margin-top:-6px;margin-bottom:8px;"><input type="checkbox" id="saveThisAddr" /> Save this address for next time</label>' +
          '<div class="reassure-panel">' +
            '<h4><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg> Your payout is safe</h4>' +
            '<ul>' +
              '<li>Paid directly to your personal crypto wallet</li>' +
              '<li>Processed within 24 hours, usually instantly</li>' +
              '<li>No hidden fees - just the flat 10% processing fee</li>' +
              '<li>End-to-end encrypted and fully secure</li>' +
            '</ul>' +
          '</div>' +
          '<p class="sub">A flat 10% withdrawal fee is deducted from the amount. Paid to your own crypto wallet.</p>') +
      '<p class="sub" id="feePreview"></p>' +
      '<button class="btn btn-primary btn-block" id="moneySubmit">' + (isDeposit ? 'Continue to Payment' : 'Request Withdrawal') + '</button>'
    );

    var coinSel = document.getElementById('moneyCoin');
    var amtInput = document.getElementById('moneyAmount');
    var feePreview = document.getElementById('feePreview');
    var submitBtn = document.getElementById('moneySubmit');

    // Populate the coin list from the live coin catalogue. Both deposit and
    // withdrawal use the SAME list, so a member can only ever pick a coin the
    // platform really supports (and can pay out).
    (async function () {
      var FALLBACK = [{ coin: 'btc', label: 'Bitcoin' }, { coin: 'ltc', label: 'Litecoin' }, { coin: 'trc20_usdt', label: 'USDT (TRC20)' }];
      var coins = [];
      try {
        var r = await App.api('/wallet/coins');
        coins = r.coins || [];
      } catch (e) { /* fall through to the built-in shortlist */ }
      if (!coins.length) coins = FALLBACK;
      coinSel.innerHTML = coins.map(function (c) {
        return '<option value="' + E(c.coin) + '">' + E(c.label || c.name || c.coin.toUpperCase()) + '</option>';
      }).join('');
      submitBtn.disabled = false;
    })();
    // Populate the saved-address dropdown for withdrawals.
    if (!isDeposit) {
      (async function () {
        var savedSel = document.getElementById('moneySaved');
        if (!savedSel) return;
        try {
          var data = await App.api('/settings/addresses');
          var rows = data.addresses || [];
          savedSel.innerHTML = '<option value="">-- Choose a saved address --</option>' +
            rows.map(function (a) {
              return '<option value="' + E(a.address) + '" data-coin="' + E(a.coin) + '">' + E(a.coin.toUpperCase()) + ' &middot; ' + E(a.address.slice(0, 12) + '...') + (a.is_default ? ' (default)' : '') + '</option>';
            }).join('');
          savedSel.addEventListener('change', function () {
            var opt = savedSel.options[savedSel.selectedIndex];
            if (opt && opt.value) {
              document.getElementById('moneyAddress').value = opt.value;
              if (opt.getAttribute('data-coin')) coinSel.value = opt.getAttribute('data-coin');
            }
          });
        } catch (e) { /* leave the dropdown empty - member can still type */ }
      })();
    }
    // Keep the member from submitting before the real coin list arrives.
    submitBtn.disabled = true;

    // Live net preview for withdrawals.
    if (!isDeposit) {
      amtInput.addEventListener('input', function () {
        var v = parseFloat(amtInput.value);
        if (!v || v <= 0) { feePreview.textContent = ''; return; }
        var grossUsd = v / cur.rate;
        var net = grossUsd * 0.9;
        feePreview.innerHTML = 'You receive about <strong>' + M(net) + '</strong> after the 10% fee.';
      });
    }

    document.getElementById('moneySubmit').addEventListener('click', async function () {
      var amount = parseFloat(document.getElementById('moneyAmount').value);
      if (!amount || amount <= 0) { App.toast('Enter an amount.', 'error'); return; }

      var btn = document.getElementById('moneySubmit');
      btn.disabled = true; btn.textContent = 'Processing...';
      try {
        if (isDeposit) {
          var dep = await App.api('/wallet/deposit', {
            method: 'POST',
            body: { amount: amount, coin: coinSel.value }
          });
          if (dep.payment_url) {
            window.open(dep.payment_url, '_blank');
            App.toast('Complete your crypto payment on the opened payment page.', 'info');
            pollDeposit(dep.reference);
          } else if (dep.coin_address) {
            // No hosted payment page - show the deposit address + exact crypto amount
            // so the member can pay from their own wallet.
            function fmtCoin(n) {
              var s = Number(n || 0).toFixed(8);
              // Trim trailing zeros (keep at least one decimal).
              return s.replace(/\.?0+$/, function (m) { return m.indexOf('.') === -1 ? m : ''; }) || '0';
            }
            function copyAddr() {
              var ok = false;
              var fail = function () {
                var ta = document.createElement('textarea');
                ta.value = dep.coin_address || '';
                ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                try { document.execCommand('copy'); ok = true; } catch (e) { ok = false; }
                document.body.removeChild(ta);
                return ok;
              };
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(dep.coin_address || '').then(function () { App.toast('Address copied.', 'success'); }, function () { App.toast(fail() ? 'Address copied.' : 'Copy failed - please copy manually.', 'error'); });
              } else {
                App.toast(fail() ? 'Address copied.' : 'Copy failed - please copy manually.', fail() ? 'success' : 'error');
              }
            }
            var payHtml =
              '<div class="pay-box" id="payBox">' +
                '<h3 style="margin-bottom:4px;">Complete Your Deposit</h3>' +
                '<p class="sub">Send the exact amount below from your own crypto wallet. Copy the address carefully.</p>' +
                '<div class="field"><label>Amount</label><div class="pay-amount">' + fmtCoin(dep.coin_amount) + ' ' + String(dep.coin || 'CRYPTO').toUpperCase() + '</div>' +
                  '<div class="sub" style="margin-top:4px;">(about ' + M(dep.amount_usd || 0) + ')</div></div>' +
                '<div class="field"><label>Deposit address</label><div class="pay-address">' + App.escapeHTML(dep.coin_address || '') +
                  ' <button class="btn btn-outline btn-sm" id="copyAddrBtn" type="button">Copy</button></div></div>' +
                '<div class="field"><label>Expires</label><div>' + App.escapeHTML(dep.expires_at || '') + '</div></div>' +
                '<p class="sub" style="margin-top:8px;">Your wallet is credited automatically after the payment is confirmed on the blockchain.</p>' +
                '<button class="btn btn-primary btn-block" id="copyAddrMain" style="margin-top:12px;">Copy Deposit Address</button>' +
                '<button class="btn btn-ghost btn-block" id="closePayBox" style="margin-top:8px;">Close</button>' +
              '</div>';
            U.openModal(payHtml);
            document.getElementById('copyAddrBtn').addEventListener('click', copyAddr);
            document.getElementById('copyAddrMain').addEventListener('click', copyAddr);
            document.getElementById('closePayBox').addEventListener('click', function () {
              // Warn before closing so the investor does not lose the address.
              U.openModal(
                '<h3>Leave the deposit page?</h3><button class="modal-close" data-close>&times;</button><div class="divider"></div>' +
                '<p class="sub">If you close now, make sure you have copied the deposit address and amount. You can always find this deposit in your transaction history as <strong>Pending</strong>, and it will still be credited once paid.</p>' +
                '<button class="btn btn-danger btn-block" id="confirmClosePay" style="margin-top:12px;">Yes, close it</button>' +
                '<button class="btn btn-ghost btn-block" style="margin-top:8px;" data-close>Keep the address open</button>'
              );
              document.getElementById('confirmClosePay').addEventListener('click', function () {
                U.closeModal();
              });
            });
            pollDeposit(dep.reference);
          } else {
            App.toast(dep.message || 'Deposit pending.', 'info');
          }
          // The deposit panel must stay open so the member can copy the address
          // and complete the payment. pollDeposit() re-renders the profile the
          // moment the payment is confirmed - do NOT close/reload here.
          return;
        } else {
          var savedSel = document.getElementById('moneySaved');
          var address = savedSel && savedSel.value
            ? savedSel.value
            : document.getElementById('moneyAddress').value.trim();
          if (!address) { App.toast('Paste your wallet address or choose a saved one.', 'error'); btn.disabled = false; btn.textContent = 'Request Withdrawal'; return; }
          var wd = await App.api('/wallet/withdraw', {
            method: 'POST',
            body: { amount: amount, coin: coinSel.value, address: address }
          });
          // Persist the address if the member opted in (and it is not already saved).
          var saveBox = document.getElementById('saveThisAddr');
          if (saveBox && saveBox.checked && !savedSel.value) {
            try {
              await App.api('/settings/addresses', {
                method: 'POST',
                body: { coin: coinSel.value, address: address, is_default: false }
              });
            } catch (e) { /* non-fatal - the withdrawal still went through */ }
          }
          App.toast('Withdrawal request submitted. Your payout is being processed.', 'success');
        }
        U.closeModal();
        renderProfile(document.getElementById('page-profile'));
      } catch (err) {
        App.toast(err.message, 'error');
        btn.disabled = false; btn.textContent = isDeposit ? 'Continue to Payment' : 'Request Withdrawal';
      }
    });
  }

  // Poll a deposit until it is confirmed (or gives up after ~5 minutes).
  function pollDeposit(reference) {
    var tries = 0;
    var timer = setInterval(async function () {
      tries++;
      try {
        var r = await App.api('/wallet/deposit/' + encodeURIComponent(reference) + '/status');
        if (r.status === 'success') {
          clearInterval(timer);
          App.toast('Deposit confirmed. Your wallet has been credited.', 'success');
          renderProfile(document.getElementById('page-profile'));
        } else if (r.status === 'failed') {
          clearInterval(timer);
          App.toast('That deposit could not be completed. You can try again.', 'error');
        }
      } catch (e) { /* keep polling */ }
      if (tries >= 60) clearInterval(timer);
    }, 5000);
  }

  async function saveName() {
    var name = document.getElementById('setName').value;
    try {
      await App.api('/settings/profile', { method: 'PUT', body: { name: name } });
      App.toast('Name saved.', 'success');
    } catch (err) { App.toast(err.message, 'error'); }
  }

  // Change the display currency. Re-renders everything in the new currency.
  async function saveCurrency() {
    var code = document.getElementById('setCurrency').value;
    try {
      await App.api('/settings/currency', { method: 'PUT', body: { currency: code } });
      App.setCurrency(code);
      App.toast('Currency updated. All amounts now show in ' + code + '.', 'success');
      renderProfile(document.getElementById('page-profile'));
    } catch (err) { App.toast(err.message, 'error'); }
  }

  async function changePassword() {
    var cur = document.getElementById('curPass').value;
    var nw = document.getElementById('newPass').value;
    try {
      var r = await App.api('/settings/password', { method: 'PUT', body: { current_password: cur, new_password: nw } });
      App.toast(r.message, 'success');
      document.getElementById('curPass').value = '';
      document.getElementById('newPass').value = '';
    } catch (err) { App.toast(err.message, 'error'); }
  }

  function signOut() {
    App.clearToken();
    window.location.href = 'login.html';
  }

  // Confirm account deletion by typing the phone number or e-mail on the account.
  function deleteAccount(method, accountId) {
    var kind = method === 'email' ? 'e-mail' : 'phone number';
    U.openModal(
      '<h3>Delete Account</h3><button class="modal-close" data-close>&times;</button><div class="divider"></div>' +
      '<p class="sub">This permanently deletes your account, wallet and history. It cannot be undone.</p>' +
      '<div class="field" style="margin-top:10px;"><label>Confirm by typing your ' + kind + '</label>' +
      '<input id="delConfirm" type="text" autocomplete="off" placeholder="' + E(accountId || '') + '" /></div>' +
      '<button class="btn btn-danger btn-block" id="delConfirmBtn">Delete My Account</button>'
    );

    document.getElementById('delConfirmBtn').addEventListener('click', async function () {
      var btn = document.getElementById('delConfirmBtn');
      btn.disabled = true; btn.textContent = 'Deleting...';
      try {
        await App.api('/settings/account', { method: 'DELETE', body: { identifier: document.getElementById('delConfirm').value } });
        App.clearToken();
        window.location.href = 'login.html';
      } catch (err) {
        App.toast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Delete My Account';
      }
    });
  }

  // Render the tickets/support page.
  async function renderTickets(container) {
    container.innerHTML = App.spinnerHTML();
    try {
      var tickets = (await App.api('/settings/tickets')).tickets;
      container.innerHTML =
        '<section class="p-6">' +
          ticketComposerHtml('pageTicket') +
          '<div class="card"><h3 class="font-bold text-white mb-3">Support Tickets</h3>' +
          '<div id="pageTicketList">' + ticketListHtml(tickets) + '</div>' +
          '</div>' +
        '</section>';
      await wireTicketComposer(container, 'pageTicket', '#pageTicketList');
    } catch (err) {
      container.innerHTML = '<p class="text-red-500">Error loading tickets: ' + err.message + '</p>';
    }
  }

  U.renderers.profile = renderProfile;
  U.renderers.tickets = renderTickets;
})();

