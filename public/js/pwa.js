// PWA runtime: service worker registration, update flow, offline awareness and
// the install prompt. Loaded on every page so the app is installable and shows
// up-to-date code without a manual cache hunt.
(function () {
  'use strict';

  var INSTALL_DISMISS_KEY = 'acm_install_dismissed_at';
  var SW_URL = '/sw.js';

  // --- Offline / online indicator ------------------------------------------
  // The app is money-sensitive: while offline every API call fails, so we show
  // a persistent banner rather than letting members think their tap did nothing.
  var offlineBanner = null;
  function ensureBanner() {
    if (offlineBanner) return offlineBanner;
    offlineBanner = document.createElement('div');
    offlineBanner.id = 'offlineBanner';
    offlineBanner.setAttribute('role', 'status');
    offlineBanner.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:120',
      'background:#ff5b6a', 'color:#fff', 'padding:12px 16px',
      'font-size:13px', 'font-weight:700', 'text-align:center',
      'display:none', 'box-shadow:0 -4px 16px rgba(0,0,0,0.2)'
    ].join(';');
    offlineBanner.textContent = 'You are offline. Reconnect to continue.';
    document.body.appendChild(offlineBanner);
    return offlineBanner;
  }

  function syncNetworkState() {
    if (!document.body) return;
    var banner = ensureBanner();
    banner.style.display = navigator.onLine ? 'none' : 'block';
    document.documentElement.style.paddingBottom = navigator.onLine ? '' : '44px';
  }

  window.addEventListener('online', function () {
    syncNetworkState();
    if (window.App && App.toast) App.toast('Back online.', 'success');
  });
  window.addEventListener('offline', function () {
    syncNetworkState();
    if (window.App && App.toast) App.toast('You are offline. Balances will refresh when you reconnect.', 'error');
  });

  // --- Service worker -------------------------------------------------------
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    window.addEventListener('load', function () {
      navigator.serviceWorker.register(SW_URL).then(
        function (registration) {
          // A new worker is waiting - offer it rather than swapping under the
          // member mid-session (they may be halfway through a form).
          registration.onupdatefound = function () {
            var installing = registration.installing;
            if (!installing) return;
            installing.onstatechange = function () {
              if (installing.state !== 'installed') return;
              if (navigator.serviceWorker.controller) {
                showUpdateBar(registration);
              }
              // No controller => first install, nothing to announce.
            };
          };
        },
        function (err) {
          // Registration failing (e.g. plain HTTP) must never break the app.
          console.warn('[pwa] service worker registration failed:', err && err.message);
        }
      );
    });
  }

  function showUpdateBar(registration) {
    var bar = document.createElement('div');
    bar.id = 'swUpdateBar';
    bar.style.cssText = [
      'position:fixed', 'left:12px', 'right:12px', 'bottom:calc(12px + env(safe-area-inset-bottom))',
      'z-index:130', 'background:#07211a', 'color:#fff', 'border-radius:14px',
      'padding:14px 16px', 'display:flex', 'align-items:center', 'gap:12px',
      'box-shadow:0 10px 30px rgba(0,0,0,0.3)', 'font-size:13px', 'font-weight:600'
    ].join(';');
    bar.innerHTML =
      '<span style="flex:1">A new version is ready.</span>' +
      '<button data-sw-update style="background:#ffc94d;color:#07211a;border:none;border-radius:9px;padding:8px 14px;font-weight:800;font-size:13px;cursor:pointer;">Update</button>';
    document.body.appendChild(bar);

    bar.querySelector('[data-sw-update]').addEventListener('click', function () {
      var waiting = registration.waiting;
      if (!waiting) return location.reload();
      waiting.postMessage({ type: 'SKIP_WAITING' });
      // Reload once the new worker has taken control.
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        location.reload();
      });
    });
  }

  // --- Install prompt -------------------------------------------------------
  var deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    maybeShowInstallPrompt();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
    if (window.App && App.toast) App.toast('afrocoinmoney installed.', 'success');
  });

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  // Don't nag: already installed, or the member dismissed it in the last week.
  function recentlyDismissed() {
    var raw = localStorage.getItem(INSTALL_DISMISS_KEY);
    if (!raw) return false;
    var at = parseInt(raw, 10);
    return isFinite(at) && Date.now() - at < 7 * 24 * 60 * 60 * 1000;
  }

  function maybeShowInstallPrompt() {
    if (!deferredPrompt || isStandalone() || recentlyDismissed()) return;
    // Only on the landing page and the auth page - never over the dashboard.
    var path = window.location.pathname;
    if (path !== '/' && path !== '/index.html' && path.indexOf('login') === -1) return;
    renderInstallBar();
  }

  function renderInstallBar() {
    if (document.getElementById('installBar')) return;
    var bar = document.createElement('div');
    bar.id = 'installBar';
    bar.style.cssText = [
      'position:fixed', 'left:12px', 'right:12px', 'bottom:calc(12px + env(safe-area-inset-bottom))',
      'z-index:125', 'background:#ffffff', 'border-radius:16px', 'border:1px solid #dcefe4',
      'padding:14px 16px', 'display:flex', 'align-items:center', 'gap:12px',
      'box-shadow:0 10px 30px rgba(7,33,26,0.2)', 'font-size:13px', 'color:#07211a'
    ].join(';');
    bar.innerHTML =
      '<img src="/icons/icon-192.png" alt="" width="40" height="40" style="border-radius:11px;flex-shrink:0">' +
      '<span style="flex:1;line-height:1.4"><strong>Install afrocoinmoney</strong><br>' +
      '<span style="color:#55796a">Add it to your home screen for instant access.</span></span>' +
      '<button data-install-dismiss aria-label="Dismiss" style="background:none;border:none;color:#55796a;font-size:20px;cursor:pointer;padding:0 4px;">&times;</button>' +
      '<button data-install-go style="background:#22c55e;color:#fff;border:none;border-radius:9px;padding:9px 14px;font-weight:800;font-size:13px;cursor:pointer;flex-shrink:0;">Install</button>';
    document.body.appendChild(bar);

    bar.querySelector('[data-install-go]').addEventListener('click', function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () {
        deferredPrompt = null;
        bar.remove();
      });
    });
    bar.querySelector('[data-install-dismiss]').addEventListener('click', function () {
      localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
      deferredPrompt = null;
      bar.remove();
    });
  }

  // --- Boot -----------------------------------------------------------------
  function boot() {
    syncNetworkState();
    registerServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.PWA = { showInstall: renderInstallBar };
})();