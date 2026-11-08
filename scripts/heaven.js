// heaven.js — the reward for walking away, shared by both gate pages.
// HeavenGate.ascend() floods the page with light, opens a pair of pearl gates,
// shows an affirmation and then closes the tab. Also exposes closeTab().

(function (root) {
  'use strict';

  const reduceMotion = () => root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function closeTab() {
    try {
      if (chrome && chrome.tabs && chrome.tabs.getCurrent) {
        chrome.tabs.getCurrent((tab) => {
          if (tab && tab.id !== undefined) chrome.tabs.remove(tab.id);
          else root.close();
        });
        return;
      }
    } catch {}
    root.close();
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ascend({ message, sub, delay } = {}) {
    if (document.querySelector('.heaven')) return;
    const wait = delay != null ? delay : reduceMotion() ? 1800 : 3000;

    const overlay = el('div', 'heaven');
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'assertive');

    overlay.appendChild(el('div', 'heaven-light'));
    overlay.appendChild(el('div', 'heaven-rays'));

    const gate = el('div', 'heaven-gate');
    gate.appendChild(el('div', 'hg-glow'));
    const left = el('div', 'hg-leaf hg-left');
    const right = el('div', 'hg-leaf hg-right');
    for (const leaf of [left, right]) {
      for (let i = 0; i < 5; i++) leaf.appendChild(el('span', 'hg-bar'));
      leaf.appendChild(el('span', 'hg-ring'));
    }
    gate.appendChild(left);
    gate.appendChild(right);
    gate.appendChild(el('div', 'hg-arch'));
    overlay.appendChild(gate);

    const motes = el('div', 'heaven-motes');
    for (let i = 0; i < 26; i++) {
      const m = el('i');
      m.style.left = `${Math.random() * 100}%`;
      m.style.animationDelay = `${(Math.random() * 2.4).toFixed(2)}s`;
      m.style.animationDuration = `${(3 + Math.random() * 3).toFixed(2)}s`;
      motes.appendChild(m);
    }
    overlay.appendChild(motes);

    const text = el('div', 'heaven-text');
    text.appendChild(el('p', 'heaven-eyebrow', 'Gate held'));
    text.appendChild(el('h2', 'heaven-title', message || 'Walking away is the win.'));
    if (sub) text.appendChild(el('p', 'heaven-sub', sub));
    text.appendChild(el('p', 'heaven-closing', 'Closing this tab…'));
    overlay.appendChild(text);

    document.body.appendChild(overlay);
    document.body.classList.add('is-ascending');
    if (root.Sfx) root.Sfx.play('heaven');
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('is-open')));

    setTimeout(closeTab, wait);
  }

  root.HeavenGate = { ascend, closeTab, reduceMotion };
})(typeof self !== 'undefined' ? self : this);
