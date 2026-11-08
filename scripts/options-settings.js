// options-settings.js — the Settings tab (a bento grid of small cards). Uses
// globals from options.js (settings, state, toast, formatDate, escapeHtml,
// ruleLabel, jumpToRule, SH). Saves on change; the Blocked cooldown goes
// through SH.requestCooldownChange so shortening it is always delayed.

(function () {
  const grid = document.getElementById('settingsGrid');
  const cooldownInput = document.getElementById('cooldownInput');
  const cooldownStatus = document.getElementById('cooldownStatus');
  const FIELDS = ['pauseWaitSeconds', 'passMode', 'passGraceMinutes', 'passFixedMinutes', 'minutesPerGate'];
  const field = (name) => grid.querySelector(`[name="${name}"]`);

  function fill() {
    renderCustomTimings();
    if (grid.contains(document.activeElement) && document.activeElement.matches('input, select')) {
      // Don't overwrite a field while it's being typed in.
      updateVisibility();
      updateCooldownStatus();
      return;
    }
    grid.querySelectorAll('input[name="reminderStyle"]').forEach((r) => { r.checked = r.value === settings.reminderStyle; });
    for (const name of FIELDS) field(name).value = settings[name];
    field('soundEffects').checked = settings.soundEffects;
    cooldownInput.value = settings.pendingCooldown ? settings.pendingCooldown.minutes : settings.blockedCooldownMinutes;
    updateVisibility();
    updateCooldownStatus();
  }

  function updateVisibility() {
    const mode = field('passMode').value;
    grid.querySelectorAll('[data-show-for]').forEach((el) => { el.hidden = el.dataset.showFor !== mode; });
  }

  function updateCooldownStatus() {
    const now = Date.now();
    const current = SH.effectiveCooldownMinutes(settings, now);
    const p = settings.pendingCooldown;
    cooldownStatus.textContent = p && p.effectiveAt > now
      ? `Now ${SH.formatMinutes(current)}. Changes to ${SH.formatMinutes(p.minutes)} at ${formatDate(p.effectiveAt)}.`
      : `Now ${SH.formatMinutes(current)}.`;
  }

  async function persist(next, message) {
    settings = SH.mergeSettings(next);
    await chrome.storage.local.set({ settings });
    if (message) toast(message);
  }

  grid.addEventListener('change', async (e) => {
    const t = e.target;
    if (t === cooldownInput || t.id === 'importFile' || t.id === 'testerUrl') return;
    const next = Object.assign({}, settings);
    if (t.name === 'reminderStyle') next.reminderStyle = t.value;
    else if (t.name === 'soundEffects') { next.soundEffects = t.checked; if (t.checked) Sfx.play('chime', { force: true }); }
    else if (FIELDS.includes(t.name)) next[t.name] = t.type === 'number' ? Number(t.value) : t.value;
    else return;
    updateVisibility();
    await persist(next, 'Settings saved.');
    t.blur();
    fill();
  });

  document.getElementById('cooldownApply').addEventListener('click', async () => {
    const now = Date.now();
    const target = SH.clamp(cooldownInput.value, SH.LIMITS.blockedCooldownMinutes);
    const before = SH.effectiveCooldownMinutes(settings, now);
    const next = SH.requestCooldownChange(settings, target, now);
    await persist(next, target >= before
      ? `Cooldown set to ${SH.formatMinutes(target)}.`
      : `Shorter cooldown scheduled for ${formatDate(next.pendingCooldown.effectiveAt)}.`);
    cooldownInput.blur();
    fill();
  });

  // Every rule with its own timing, so overrides never hide in an Edit form.
  function renderCustomTimings() {
    const el = document.getElementById('customTimings');
    const now = Date.now();
    const rows = [];
    for (const r of state.pauseAndThink) {
      if (r.waitSeconds == null && !r.passMode && r.passMinutes == null) continue;
      rows.push({ list: 'pauseAndThink', rule: r, text: `Wait ${SH.resolveWaitSeconds(r, settings)} s · access lasts ${SH.describePass(r, settings)}` });
    }
    for (const r of state.blocked) {
      if (r.cooldownMinutes == null && !r.pendingCooldown) continue;
      const cur = SH.ruleCooldownMinutes(r, settings, now);
      const p = r.pendingCooldown && r.pendingCooldown.effectiveAt > now ? r.pendingCooldown : null;
      const next = p ? ` (changes to ${p.minutes == null ? 'the default' : SH.formatMinutes(p.minutes)} at ${formatDate(p.effectiveAt)})` : '';
      rows.push({ list: 'blocked', rule: r, text: `Pause cooldown ${SH.formatMinutes(cur)}${next}` });
    }
    el.innerHTML = rows.length
      ? `<ul class="timing-list">${rows.map((x) => `<li><span class="dot ${x.list === 'blocked' ? 'dot-hell' : 'dot-pause'}" aria-hidden="true"></span><span class="timing-rule">${escapeHtml(ruleLabel(x.list, x.rule))}</span><span class="timing-text">${escapeHtml(x.text)}</span><button class="link-btn" type="button" data-action="jump" data-id="${x.rule.id}">Edit</button></li>`).join('')}</ul>`
      : '<p class="hint">No rule has its own timing yet. Open a rule’s Edit form to give one site a longer wait, a shorter pass or (for Blocked rules) a longer cooldown.</p>';
  }

  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action="jump"]');
    if (!btn) return;
    jumpToRule(btn.dataset.id, btn.closest('#customTimings') ? 'edit' : null);
  });

  document.addEventListener('gohh:data', fill);
  fill();
})();
