// pause.js — Pause & Think reflection gate.
// Runs as an extension page (chrome-extension:// origin).

const REQUIRED_CONFIRMATION = 'Yes I Am Sure';
const PAUSE_DURATION_MS = 15 * 1000; // 15 seconds

const AFFIRMATIONS = [
  "Good deed logged. Your scale just got heavier. 🤲",
  "You just avoided wasting hours you\u2019ll never get back. ⏳",
  "That\u2019s a rank raised, in sha\u2019 Allah.",
  "Walking away is the win. Well done.",
  "Small win. They compound.",
  "That took strength. Noted."
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const params = new URLSearchParams(location.search);
const ruleId = params.get('ruleId');
const targetUrl = params.get('url');

const gate = document.querySelector('.gate');
const content = document.querySelector('.content');
const inputWrapper = document.getElementById('inputWrapper');
const confirmInput = document.getElementById('confirmInput');
const continueBtn = document.getElementById('continueBtn');
const closeTabBtn = document.getElementById('closeTabBtn');
const toastEl = document.getElementById('toast');

// Trigger gate entrance animation
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    gate.classList.add('is-closed');
    content.classList.add('is-visible');
  });
});

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
}

// 15-second reflection timer
const timerStart = Date.now();
const timer = setTimeout(() => {
  unlockInput();
}, PAUSE_DURATION_MS);

function unlockInput() {
  inputWrapper.classList.remove('is-locked');
  inputWrapper.classList.add('is-unlocked');
  confirmInput.disabled = false;
  confirmInput.placeholder = 'Type "Yes I Am Sure" to proceed…';
  confirmInput.focus();
}

confirmInput.addEventListener('input', () => {
  const val = confirmInput.value.trim();
  const isMatch = val === REQUIRED_CONFIRMATION;

  continueBtn.disabled = !isMatch;
  if (isMatch) {
    continueBtn.classList.add('is-ready');
  } else {
    continueBtn.classList.remove('is-ready');
  }
});

document.getElementById('pauseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const val = confirmInput.value.trim();
  if (val !== REQUIRED_CONFIRMATION) return;

  confirmInput.disabled = true;
  continueBtn.disabled = true;
  continueBtn.textContent = 'Opening…';

  try {
    const res = await chrome.runtime.sendMessage({
      action: 'ACTIVATE_PAUSE_SESSION',
      ruleId,
      url: targetUrl
    });

    if (targetUrl) {
      // Small pause to let DNR dynamic rules apply before navigation
      setTimeout(() => {
        location.replace(targetUrl);
      }, 100);
    } else {
      showToast("Access granted.");
    }
  } catch (err) {
    console.error('[GatesOfHeavenAndHell] Failed to activate pause session:', err);
    if (targetUrl) {
      location.replace(targetUrl);
    }
  }
});

closeTabBtn.addEventListener('click', () => {
  clearTimeout(timer);
  closeTabBtn.disabled = true;
  closeTabBtn.textContent = 'Closing…';

  showToast(pick(AFFIRMATIONS));

  setTimeout(() => {
    if (chrome?.tabs?.getCurrent) {
      chrome.tabs.getCurrent((tab) => {
        if (tab && tab.id !== undefined) {
          chrome.tabs.remove(tab.id);
        } else {
          window.close();
        }
      });
    } else {
      window.close();
    }
  }, 1600);
});
