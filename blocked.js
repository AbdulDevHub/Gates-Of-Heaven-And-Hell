// blocked.js — runs on the extension-hosted blocked.html page.
// This is an extension page (chrome-extension:// origin), so it has direct
// access to chrome.tabs — no messaging to the background worker needed.

const MESSAGES = [
  "🕌 Remember Allah in your time.",
  "⏳ Time is a man\u2019s amanah (trust).",
  "📖 Replace scrolling with dhikr.",
  "🌙 Let go of distractions.",
  "🧠 Use time before it uses you.",
  "📈 Small halal efforts compound.",
  "🔥 Stay firm against temptation.",
  "🌱 Invest in your akhirah.",
  "⛔ Leave what leads to sin.",
  "🕌 Fear Allah and protect your time.",
  "⏳ You will be accounted for every minute.",
  "📵 Close it before it opens your heart to distraction.",
  "🛑 Stop before the scroll becomes an addiction.",
  "📖 Replace this with Qur\u2019an or knowledge.",
  "🤲 Ask Allah to save you from wasteful desires.",
  "🚫 No more delay \u2014 this is your wake-up call.",
  "💀 Time lost will not return.",
  "⚠️ One scroll leads to hours lost.",
  "🌙 Don\u2019t trade akhirah for dopamine.",
  "🧨 Break the cycle, not your willpower.",
  "📵 If it does not benefit you, leave it.",
  "⛔ This is not harmless \u2014 it steals your life."
];

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

document.getElementById('message').textContent = pick(MESSAGES);

const gate = document.querySelector('.gate');
const content = document.querySelector('.content');

// Trigger the closing animation shortly after paint so the transition runs.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    gate.classList.add('is-closed');
    content.classList.add('is-visible');
  });
});

const closeBtn = document.getElementById('closeTabBtn');
const toast = document.getElementById('toast');

closeBtn.addEventListener('click', () => {
  closeBtn.disabled = true;
  closeBtn.textContent = 'Closing…';

  toast.textContent = pick(AFFIRMATIONS);
  toast.classList.add('show');

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
