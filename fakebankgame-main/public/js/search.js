// ============================================================
// public/js/search.js
// Recherche d'utilisateurs
// ============================================================

(function () {
  'use strict';

  let timeout = null;

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ----------------------------------------------------------
  // Adaptation sidebar selon rôle
  // ----------------------------------------------------------
  async function adaptSidebar() {
    const res = await window.API.auth.me();
    if (res.error || !res.data) {
      window.location.href = '/login.html';
      return;
    }

    const user         = res.data.user;
    const tpeLink      = document.getElementById('tpeLink');
    const employeeLink = document.getElementById('employeeLink');
    const adminLink    = document.getElementById('adminLink');

    if (tpeLink)      tpeLink.style.display      = user.hasTpe || user.role === 'admin' ? '' : 'none';
    if (employeeLink) employeeLink.style.display  = (user.role === 'employee' || user.role === 'admin') ? '' : 'none';
    if (adminLink)    adminLink.style.display     = user.role === 'admin' ? '' : 'none';
  }

  // ----------------------------------------------------------
  // Recherche utilisateurs
  // API retourne { results: [...] } (pas { users: [...] })
  // ----------------------------------------------------------
  function initSearch() {
    const input      = document.getElementById('searchInput');
    // search.html utilise #resultsContainer (pas #results)
    const container  = document.getElementById('resultsContainer');
    const emptyState = document.getElementById('emptyState');

    if (!input || !container) return;

    input.addEventListener('input', () => {
      clearTimeout(timeout);

      const q = input.value.trim();

      container.innerHTML = '';

      if (q.length < 2) {
        if (emptyState) emptyState.style.display = '';
        return;
      }

      if (emptyState) emptyState.style.display = 'none';

      timeout = setTimeout(async () => {
        const res = await window.API.users.search(q);
        if (res.error || !res.data) {
          container.innerHTML = '<p style="color:var(--color-error);">Erreur de recherche.</p>';
          return;
        }

        // L'API /api/users/search retourne { results: [] }
        const users = res.data.results || [];

        if (users.length === 0) {
          container.innerHTML = '<p style="color:var(--color-text-muted); text-align:center;">Aucun résultat</p>';
          return;
        }

        container.innerHTML = '';

        users.forEach((user) => {
          const div = document.createElement('div');
          div.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            background: var(--color-bg-elevated);
            border: 1px solid var(--color-border);
            border-radius: 8px;
            margin-bottom: 8px;
          `;

          div.innerHTML = `
            <div>
              <strong>${escHtml(user.displayName)}</strong>
              <span style="color:var(--color-text-muted); margin-left:6px;">@${escHtml(user.username)}</span>
              <div style="font-size:0.8rem; color:var(--color-text-muted);">${escHtml(user.ibanMasked || '')}</div>
            </div>
            <button
              style="
                padding: 6px 14px;
                background: var(--color-primary);
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 0.85rem;
                white-space: nowrap;
              "
            >Envoyer</button>
          `;

          div.querySelector('button').addEventListener('click', () => {
            window.location.href = `/transfer.html?to=${user.id}`;
          });

          container.appendChild(div);
        });
      }, 400);
    });
  }

  // ----------------------------------------------------------
  // Init
  // ----------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    await adaptSidebar();
    initSearch();
  });
})();
