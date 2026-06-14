// ============================================================
// public/js/theme.js
// Gestion du theme clair/sombre.
// DOIT etre charge en premier dans <head> (avant les CSS)
// pour eviter le flash de mauvais theme.
//
// Expose window.Theme ET window.toggleTheme() (appele inline
// dans les HTML via onclick="toggleTheme()").
// ============================================================
(function () {
  'use strict';

  const STORAGE_KEY = 'theme';
  const DARK  = 'dark';
  const LIGHT = 'light';
  const HTML  = document.documentElement;

  // ----------------------------------------------------------
  // Detection et application immediate
  // ----------------------------------------------------------
  function getStoredTheme() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === DARK || stored === LIGHT) return stored;
    } catch (_) {}
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return DARK;
    }
    return LIGHT;
  }

  function applyTheme(theme) {
    if (theme === DARK) {
      HTML.setAttribute('data-theme', DARK);
    } else {
      HTML.removeAttribute('data-theme');
    }
    updateButtons(theme);
  }

  function saveTheme(theme) {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (_) {}
  }

  // Application immediate (avant rendu)
  applyTheme(getStoredTheme());

  // ----------------------------------------------------------
  // Boutons de toggle
  // ----------------------------------------------------------
  const SUN  = '☀️';
  const MOON = '🌙';

  function updateButtons(theme) {
    document.querySelectorAll('[data-theme-toggle], .theme-btn').forEach((btn) => {
      btn.textContent = theme === DARK ? SUN : MOON;
      btn.title = theme === DARK ? 'Passer au thème clair' : 'Passer au thème sombre';
    });
    // Boutons avec emoji 🌓 (statique dans les HTML)
    document.querySelectorAll('button').forEach((btn) => {
      if (btn.textContent.trim() === '🌓') {
        btn.textContent = theme === DARK ? SUN : MOON;
      }
    });
  }

  // ----------------------------------------------------------
  // API publique
  // ----------------------------------------------------------
  function getCurrentTheme() {
    return HTML.getAttribute('data-theme') === DARK ? DARK : LIGHT;
  }

  function toggleTheme() {
    const next = getCurrentTheme() === DARK ? LIGHT : DARK;
    applyTheme(next);
    saveTheme(next);
  }

  function setTheme(theme) {
    if (theme !== DARK && theme !== LIGHT) return;
    applyTheme(theme);
    saveTheme(theme);
  }

  function initThemeToggle(elementOrId) {
    const btn = typeof elementOrId === 'string'
      ? document.getElementById(elementOrId)
      : elementOrId;
    if (!btn) return null;
    btn.addEventListener('click', toggleTheme);
    updateButtons(getCurrentTheme());
    return btn;
  }

  // Ecoute preference systeme si pas de choix explicite
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      try {
        if (!localStorage.getItem(STORAGE_KEY)) {
          applyTheme(e.matches ? DARK : LIGHT);
        }
      } catch (_) {}
    });
  }

  // ----------------------------------------------------------
  // Expositions globales
  // ----------------------------------------------------------
  window.Theme = { toggle: toggleTheme, set: setTheme, get: getCurrentTheme, init: initThemeToggle };

  // toggleTheme() est appele directement en onclick="toggleTheme()" dans les HTML
  window.toggleTheme = toggleTheme;

  // Init automatique apres chargement DOM
  document.addEventListener('DOMContentLoaded', () => {
    updateButtons(getCurrentTheme());
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      if (!btn.dataset.themeToggleInit) {
        btn.dataset.themeToggleInit = '1';
        btn.addEventListener('click', toggleTheme);
      }
    });
  });
})();