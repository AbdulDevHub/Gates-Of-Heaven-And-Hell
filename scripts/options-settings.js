// options-settings.js — the Settings tab. Uses globals from options.js
// (settings, toast, formatDate, SH). Saves on change; the Blocked cooldown
// goes through SH.requestCooldownChange so shortening it is always delayed.

(function () {
  const form = document.getElementById('settingsForm');
  const cooldownInput = document.getElementById('cooldownInput');
  const cooldownStatus = document.getElementById('cooldownStatus');
  const FIELDS = ['pauseWaitSeconds', 'passMode', 'passGraceMinutes', 'passFixedMinutes', 'minutesPerGate'];

  function fill() {
    if (form.contains(document.activeElement) && document.activeElement !== document.body) {
      // Don't overwrite a field while it's being typed in.
      updateVisibility();
      updateCooldownStatus();
      return;
    }
    form.querySelectorAll('input[name="reminderStyle"]').forEach((r) => { r.checked = r.value === settings.reminderStyle; });
    for (const name of FIELDS) form.elements[name].value = settings[name];
    cooldownInput.value = settings.pendingCooldown ? settings.pendingCooldown.minutes : settings.blockedCooldownMinutes;
    updateVisibility();
    updateCooldownStatus();
  }

  function updateVisibility() {
    const mode = form.elements.passMode.value;
    form.querySelectorAll('[data-show-for]').forEach((el) => { el.hidden = el.dataset.showFor !== mode; });
  }

  function updateCooldownStatus() {
    const now = Date.now();
    const current = SH.effectiveCooldownMinutes(settings, now);
    const p = settings.pendingCooldown;
    cooldownStatus.textContent = p && p.effectiveAt > now
      ? `Current cooldown: ${SH.formatMinutes(current)}. Changes to ${SH.formatMinutes(p.minutes)} at ${formatDate(p.effectiveAt)}.`
      : `Current cooldown: ${SH.formatMinutes(current)}.`;
  }

  async function persist(next, message) {
    settings = SH.mergeSettings(next);
    await chrome.storage.local.set({ settings });
    if (message) toast(message);
  }

  form.addEventListener('change', async (e) => {
    const t = e.target;
    if (t === cooldownInput) return;
    const next = Object.assign({}, settings);
    if (t.name === 'reminderStyle') next.reminderStyle = t.value;
    else if (FIELDS.includes(t.name)) next[t.name] = t.type === 'number' ? Number(t.value) : t.value;
    else return;
    updateVisibility();
    await persist(next, 'Settings saved.');
    fill();
  });

  form.addEventListener('submit', (e) => e.preventDefault());

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

  document.addEventListener('gohh:data', fill);
  fill();
})();
