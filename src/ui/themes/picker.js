/*
 * LLM Proxy · theme picker
 *
 * Usage: include this script in <head> BEFORE the theme stylesheet link so
 * it can set the right href synchronously and avoid a flash of unstyled
 * content. The script also injects the picker widget into the DOM on
 * DOMContentLoaded.
 *
 * The picker lives in localStorage under `llm-proxy-theme`. Switching a theme
 * swaps the stylesheet href; no reload is needed (except for Chart.js colors,
 * which read CSS variables at render time — admin UI re-inits charts when
 * the theme changes).
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'llm-proxy-theme';
  var DEFAULT_THEME = 'paper';
  var THEMES = [
    { id: 'pop',        name: 'Classic Pop',      swatch: '#ffc8dd', note: 'Pastel cards · chunky offset shadows' },
    { id: 'crt',        name: 'CRT Terminal',     swatch: '#f3b341', note: 'Amber phosphor · scanlines' },
    { id: 'swiss',      name: 'Swiss Editorial',  swatch: '#e63946', note: 'Massive type · red rules' },
    { id: 'memphis',    name: 'Memphis Arcade',   swatch: '#ff3d7f', note: 'Primary colors · geometric confetti' },
    { id: 'industrial', name: 'Industrial',       swatch: '#ffb84a', note: 'Brushed metal · physical toggles' },
    { id: 'paper',      name: 'Paper Punch',      swatch: '#1240ff', note: 'Off-white paper · electric blue' }
  ];

  function resolveTheme(id) {
    return THEMES.find(function (t) { return t.id === id; }) || THEMES.find(function (t) { return t.id === DEFAULT_THEME; });
  }

  function currentThemeId() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && THEMES.some(function (t) { return t.id === saved; })) return saved;
    } catch (_) { /* no localStorage */ }
    return DEFAULT_THEME;
  }

  function themeHref(id) {
    return '/themes/theme-' + id + '.css';
  }

  /* Part 1: synchronous boot — runs immediately to prevent FOUC.
   * The document should contain <link rel="stylesheet" id="theme-css"> which
   * we rewrite to point at the chosen theme. If the link doesn't exist yet
   * (e.g. this script ran before the link tag), create one. */
  function boot() {
    var id = currentThemeId();
    var link = document.getElementById('theme-css');
    if (!link) {
      link = document.createElement('link');
      link.id = 'theme-css';
      link.rel = 'stylesheet';
      (document.head || document.documentElement).appendChild(link);
    }
    var desired = themeHref(id);
    if (link.getAttribute('href') !== desired) link.setAttribute('href', desired);
    document.documentElement.setAttribute('data-theme', id);
  }
  boot();

  /* Part 2: the picker widget — injects on DOMContentLoaded. */
  function switchTheme(id) {
    if (!resolveTheme(id)) return;
    try { localStorage.setItem(STORAGE_KEY, id); } catch (_) {}
    var link = document.getElementById('theme-css');
    if (link) link.setAttribute('href', themeHref(id));
    document.documentElement.setAttribute('data-theme', id);
    // Let the page react (e.g. re-render Chart.js with new colors)
    window.dispatchEvent(new CustomEvent('theme:change', { detail: { theme: id } }));
  }

  function buildWidget() {
    if (document.querySelector('.theme-picker')) return;

    var active = currentThemeId();
    var root = document.createElement('div');
    root.className = 'theme-picker';

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'theme-picker__toggle btn btn-secondary btn-sm';
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    var activeTheme = resolveTheme(active);
    var swatch = document.createElement('span');
    swatch.className = 'theme-picker__swatch';
    swatch.style.background = activeTheme.swatch;
    toggle.appendChild(swatch);
    var label = document.createElement('span');
    label.textContent = activeTheme.name;
    toggle.appendChild(label);
    var caret = document.createElement('span');
    caret.textContent = '▾';
    caret.style.opacity = '0.6';
    caret.style.marginLeft = '2px';
    toggle.appendChild(caret);

    var menu = document.createElement('div');
    menu.className = 'theme-picker__menu card';
    var menuLabel = document.createElement('div');
    menuLabel.className = 'theme-picker__label';
    menuLabel.textContent = 'Theme';
    menu.appendChild(menuLabel);

    THEMES.forEach(function (t) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'theme-picker__item';
      if (t.id === active) item.classList.add('active');
      var sw = document.createElement('span');
      sw.className = 'theme-picker__swatch';
      sw.style.background = t.swatch;
      item.appendChild(sw);
      item.appendChild(document.createTextNode(t.name));
      item.addEventListener('click', function () {
        switchTheme(t.id);
        // Update UI
        root.querySelectorAll('.theme-picker__item').forEach(function (n) { n.classList.remove('active'); });
        item.classList.add('active');
        label.textContent = t.name;
        swatch.style.background = t.swatch;
        root.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      });
      menu.appendChild(item);
    });

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = root.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (!root.contains(e.target)) { root.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); }
    });

    root.appendChild(toggle);
    root.appendChild(menu);
    document.body.appendChild(root);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildWidget);
  } else {
    buildWidget();
  }

  // Expose for pages that want to refresh after a theme change
  window.LlmProxyTheme = { current: currentThemeId, set: switchTheme, list: THEMES };
})();
