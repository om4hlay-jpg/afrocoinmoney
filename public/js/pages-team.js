// Team page renderer.
(function () {
  'use strict';
  var App = window.App;
  var U = App.Util;
  var E = App.escapeHTML;
  var M = App.money;

  async function renderTeam(container) {
    container.innerHTML = App.spinnerHTML();
    var data = await App.api('/team');
    var rules = data.rules || {};
    var signupBonus = rules.signup_bonus_usd != null ? rules.signup_bonus_usd : 0.01;
    var confirmedBonus = rules.confirmed_bonus_usd != null ? rules.confirmed_bonus_usd : 2;
    var claimMin = rules.claim_min_usd != null ? rules.claim_min_usd : 30;
    var claimable = Number(data.claimable_usd) || 0;
    var progress = Math.max(0, Math.min(100, Number(data.claim_progress) || 0));
    var canClaim = !!data.can_claim;

    // Shareable join link (the register form pre-fills the code from ?ref).
    var refLink = window.location.origin + '/login.html?ref=' + encodeURIComponent(data.referral_code);
    var shareMsg = 'Join me on AfrocoinMoney - earn daily crypto returns on investment terminals. Your invite: ' + refLink;
    var canShare = typeof navigator.share === 'function';

    container.innerHTML =
      '<div class="card">' +
        '<h3>Referral Earnings to Claim</h3>' +
        '<p class="sub">You can claim your referral earnings once they reach <strong>' + M(claimMin) + '</strong>.</p>' +
        '<div class="claim-summary">' +
          '<div><span class="label">Ready to claim</span><strong class="value ' + (canClaim ? 'green' : '') + '">' + M(claimable) + '</strong></div>' +
          '<div class="right"><span class="label">Goal</span><strong class="value">' + M(claimMin) + '</strong></div>' +
        '</div>' +
        '<div class="bar bar-lg' + (canClaim ? ' bar-full' : '') + '"><div style="width:' + progress + '%;"></div></div>' +
        '<div class="bar-caption"><span>' + progress + '% done</span><span>' +
          (canClaim ? 'You can claim now' : M(Math.max(0, claimMin - claimable)) + ' to go') +
        '</span></div>' +
        '<button class="btn btn-primary btn-block" id="claimBtn" style="margin-top:12px;"' + (canClaim ? '' : ' disabled') + '>' +
          (canClaim ? 'Claim ' + M(claimable) + ' to Wallet' : 'Claim unlocks at ' + M(claimMin)) +
        '</button>' +
      '</div>' +

      '<div class="stats-grid">' +
        U.stat('Team Income', M(data.team_income), 'green') +
        U.stat('Referrals', data.referral_count, 'blue') +
        U.stat('Confirmed Referrals', data.valid_referral_count, 'blue') +
        U.stat('Bonus Per Referral', M(confirmedBonus), 'green') +
      '</div>' +

      '<div class="card">' +
        '<h3>Invite Friends & Earn</h3>' +
        '<p class="sub">Share your code or link. You earn <strong>' + M(signupBonus) + '</strong> when they join, and it goes up to <strong>' + M(confirmedBonus) + '</strong> once they make their first deposit.</p>' +
        '<div class="field" style="margin-top:12px;"><input id="refCode" type="text" readonly value="' + E(data.referral_code) + '" /></div>' +
        '<button class="btn btn-ghost btn-block" id="copyCodeBtn" style="margin-top:4px;">Copy Referral Code</button>' +
        '<div class="field" style="margin-top:10px;"><input id="refLink" type="text" readonly value="' + E(refLink) + '" /></div>' +
        '<div class="share-row">' +
          (canShare ? '<button class="btn btn-primary" id="shareBtn">Share</button>' : '') +
          '<a class="btn btn-outline" href="https://wa.me/?text=' + encodeURIComponent(shareMsg) + '" target="_blank" rel="noopener">WhatsApp</a>' +
          '<a class="btn btn-outline" href="https://t.me/share/url?url=' + encodeURIComponent(refLink) + '&text=' + encodeURIComponent('Join me on AfrocoinMoney and earn daily crypto returns on investment terminals.') + '" target="_blank" rel="noopener">Telegram</a>' +
          '<button class="btn btn-ghost" id="copyLinkBtn">Copy Link</button>' +
        '</div>' +
      '</div>' +

      '<div class="card"><h3>Your Referrals</h3><div id="referralList">' + App.spinnerHTML() + '</div></div>' +
      '<div class="card"><h3>How Referral Earnings Work</h3>' +
        '<div class="list">' +
          '<li><div class="lead">When they join</div><strong>' + M(signupBonus) + ' per referral</strong></li>' +
          '<li><div class="lead">When they deposit</div><strong>' + M(confirmedBonus) + ' per referral</strong></li>' +
          '<li><div class="lead">When you get paid</div><div class="desc">Claim your earnings once they reach ' + M(claimMin) + ' - the money goes straight to your wallet</div></li>' +
          '<li><div class="lead">No limits</div><div class="desc">Invite as many friends as you want</div></li>' +
          '<li><div class="lead">Confirmed referral</div><div class="desc">A referral who has made a deposit</div></li>' +
        '</div>' +
      '</div>';

    container.querySelector('#copyCodeBtn').addEventListener('click', function () {
      copyText(container.querySelector('#refCode').value, 'Referral code copied.');
    });

    var copyLinkBtn = container.querySelector('#copyLinkBtn');
    if (copyLinkBtn) {
      copyLinkBtn.addEventListener('click', function () {
        copyText(refLink, 'Referral link copied.');
      });
    }
    var shareBtn = container.querySelector('#shareBtn');
    if (shareBtn) {
      // Native OS share sheet (mobile-first); falls back to the deep links.
      shareBtn.addEventListener('click', function () {
        navigator.share({ title: 'AfrocoinMoney', text: shareMsg, url: refLink })
          .catch(function () { /* user dismissed the sheet */ });
      });
    }

    var claimBtn = container.querySelector('#claimBtn');
    if (claimBtn && canClaim) {
      claimBtn.addEventListener('click', async function () {
        claimBtn.disabled = true;
        claimBtn.textContent = 'Claiming...';
        try {
          var res = await App.api('/team/claim', { method: 'POST', body: {} });
          App.toast(res.message || 'Referral earnings added to your wallet.', 'success');
          renderTeam(container);
        } catch (err) {
          App.toast(err.message || 'Could not claim right now.', 'error');
          claimBtn.disabled = false;
          claimBtn.textContent = 'Claim ' + M(claimable) + ' to Wallet';
        }
      });
    }

    var listEl = container.querySelector('#referralList');
    if (!data.referrals.length) {
      listEl.innerHTML = '<p class="sub">You have not invited anyone yet. Share your code to start building your team.</p>';
    } else {
      listEl.innerHTML = '<ul class="list">' + data.referrals.map(function (r) {
        return '<li>' +
          '<div><div class="lead">' + E(r.identifier) + '</div><div class="desc">Joined ' + E(String(r.joined_at).slice(0, 10)) + '</div></div>' +
          (r.is_valid ? '<span class="badge green">Valid</span>' : '<span class="badge grey">No deposit</span>') +
          '</li>';
      }).join('') + '</ul>';
    }
  }

  function copyText(text, msg) {
    if (!text) { App.toast('Nothing to copy yet.', 'error'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { App.toast(msg, 'success'); }, function () {
        fallbackCopy(text, msg);
      });
    } else {
      fallbackCopy(text, msg);
    }
  }

  function fallbackCopy(text, msg) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); App.toast(msg, 'success'); }
    catch (e) { App.toast('Could not copy. Please copy manually.', 'error'); }
    document.body.removeChild(ta);
  }

  U.renderers.team = renderTeam;
})();
