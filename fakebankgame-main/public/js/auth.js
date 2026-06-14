// ============================================================
// public/js/auth.js
// Logique des pages login.html et register.html.
// ============================================================
(function () {
  'use strict';

  // ----------------------------------------------------------
  // Utilitaires UI
  // ----------------------------------------------------------
  function showError(elementId, message) {
    const el = document.getElementById(elementId);
    if (el) { el.textContent = message; el.style.display = message ? 'block' : 'none'; }
  }

  function setLoading(btn, loading) {
    if (!btn) return;
    btn.disabled = loading;
    btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
    btn.textContent = loading ? 'Chargement…' : btn.dataset.originalText;
  }

  // ----------------------------------------------------------
  // Toggle visibilite mot de passe
  // ----------------------------------------------------------
  window.togglePassword = function () {
    const el = document.getElementById('password');
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
  };

  // ----------------------------------------------------------
  // Indicateur force mot de passe
  // ----------------------------------------------------------
  function passwordStrength(pwd) {
    let score = 0;
    if (pwd.length >= 8)  score++;
    if (pwd.length >= 12) score++;
    if (/[A-Z]/.test(pwd)) score++;
    if (/[0-9]/.test(pwd)) score++;
    if (/[^A-Za-z0-9]/.test(pwd)) score++;
    if (score <= 1) return 'weak';
    if (score <= 3) return 'medium';
    return 'strong';
  }

  // ----------------------------------------------------------
  // LOGIN
  // ----------------------------------------------------------
  function initLogin() {
    const form = document.getElementById('loginForm');
    if (!form) return;

    // Redirect si deja connecte
    API.auth.me().then(({ data }) => {
      if (data && data.user) window.location.href = '/dashboard.html';
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('loginError', '');

      const identifier = form.querySelector('[name="identifier"]')?.value?.trim();
      const password   = form.querySelector('[name="password"]')?.value;
      const btn        = form.querySelector('[type="submit"]');

      if (!identifier || !password) {
        showError('loginError', 'Veuillez remplir tous les champs.');
        return;
      }

      setLoading(btn, true);
      const { data, error } = await API.auth.login(identifier, password);
      setLoading(btn, false);

      if (error) {
        showError('loginError', error);
        return;
      }

      // Redirect apres connexion (support ?redirect=)
      const params   = new URLSearchParams(window.location.search);
      const redirect = params.get('redirect');
      window.location.href = redirect && redirect.startsWith('/') ? redirect : '/dashboard.html';
    });
  }

  // ----------------------------------------------------------
  // REGISTER
  // ----------------------------------------------------------
  window.register = async function () {
    showError('error', '');

    const username        = document.getElementById('username')?.value?.trim();
    const email           = document.getElementById('email')?.value?.trim();
    const displayName     = document.getElementById('displayName')?.value?.trim();
    const password        = document.getElementById('password')?.value;
    const confirmPassword = document.getElementById('confirmPassword')?.value;

    // Validations cote client
    if (!username || !email || !displayName || !password || !confirmPassword) {
      showError('error', 'Tous les champs sont obligatoires.');
      return;
    }
    if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) {
      showError('error', 'Nom d\'utilisateur : 3-30 caractères, lettres/chiffres/._- uniquement.');
      return;
    }
    if (password.length < 8) {
      showError('error', 'Le mot de passe doit contenir au moins 8 caractères.');
      return;
    }
    if (password !== confirmPassword) {
      showError('error', 'Les mots de passe ne correspondent pas.');
      return;
    }

    const btn = document.querySelector('button[onclick="register()"]');
    setLoading(btn, true);

    const { data, error } = await API.auth.register({
      username, email, displayName, password, confirmPassword,
    });

    setLoading(btn, false);

    if (error) {
      showError('error', error);
      return;
    }

    window.location.href = '/dashboard.html';
  };

  // Indicateur de force en temps reel
  function initPasswordStrength() {
    const pwdInput  = document.getElementById('password');
    const strengthBar = document.getElementById('strengthBar');
    if (!pwdInput || !strengthBar) return;

    pwdInput.addEventListener('input', () => {
      const strength = passwordStrength(pwdInput.value);
      const colors   = { weak: '#dc2626', medium: '#d97706', strong: '#16a34a' };
      const widths   = { weak: '33%', medium: '66%', strong: '100%' };
      strengthBar.style.height     = '4px';
      strengthBar.style.borderRadius = '9999px';
      strengthBar.style.transition = 'width 0.2s, background 0.2s';
      strengthBar.style.background = colors[strength];
      strengthBar.style.width      = widths[strength];
    });
  }

  // ----------------------------------------------------------
  // Init
  // ----------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    initLogin();
    initPasswordStrength();
  });
})();