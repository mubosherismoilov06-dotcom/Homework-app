if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

// ---- Install prompt banner ----
// Shows a small "Install App" banner so the PWA is actually discoverable,
// instead of relying on students/teachers to find the browser's own menu.
(function () {
  const DISMISS_KEY = 'pwaInstallDismissedAt';
  const DISMISS_DAYS = 7;
  let deferredPrompt = null;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true; // iOS Safari
  }

  function recentlyDismissed() {
    // Guarded: localStorage can throw (e.g. Safari private browsing, or
    // storage quota/permissions issues) — that shouldn't ever crash the
    // install-banner logic, so just treat it as "not dismissed".
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      if (!raw) return false;
      const elapsedDays = (Date.now() - Number(raw)) / (1000 * 60 * 60 * 24);
      return elapsedDays < DISMISS_DAYS;
    } catch (e) {
      return false;
    }
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
  }

  function showBanner(html, onInstall) {
    if (document.getElementById('pwaInstallBanner')) return;
    const el = document.createElement('div');
    el.id = 'pwaInstallBanner';
    el.innerHTML = html;
    document.body.appendChild(el);
    const installBtn = el.querySelector('.doInstall');
    if (installBtn && onInstall) installBtn.addEventListener('click', onInstall);
    const dismissBtn = el.querySelector('.dismiss');
    dismissBtn.addEventListener('click', () => {
      try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {}
      el.remove();
    });
  }

  // Chrome/Edge/Android: browser fires this when the app is installable;
  // we capture it and trigger it ourselves from our own button.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (isStandalone() || recentlyDismissed()) return;
    showBanner(
      '<p>📲 Install this app on your device for quick, full-screen access.</p>' +
      '<button class="doInstall">Install</button>' +
      '<button class="dismiss">✕</button>',
      async () => {
        const banner = document.getElementById('pwaInstallBanner');
        if (banner) banner.remove();
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
      }
    );
  });

  window.addEventListener('appinstalled', () => {
    const banner = document.getElementById('pwaInstallBanner');
    if (banner) banner.remove();
  });

  // iOS Safari never fires beforeinstallprompt — show manual instructions instead.
  if (isIos() && !isStandalone() && !recentlyDismissed()) {
    window.addEventListener('load', () => {
      showBanner(
        '<p>📲 Install this app: tap the Share icon, then "Add to Home Screen".</p>' +
        '<button class="dismiss">Got it</button>'
      );
    });
  }
})();
