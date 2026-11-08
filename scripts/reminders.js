// reminders.js
// Text packs for the gate pages. "universal" is the default for new installs;
// "faith" keeps the original Islamic reminders. Chosen in Settings.

(function (root) {
  'use strict';

  const PACKS = {
    universal: {
      blocked: [
        'You closed this door for a reason. Trust the version of you who did.',
        'The urge passes. The hours you lose don’t come back.',
        'Not this. Not now.',
        'What would you rather have done with the next hour?',
        'Discipline is remembering what you want most.',
        'One scroll becomes an evening. Walk away.',
        'You are not missing out. You are opting in to your life.',
        'Every time you turn back, the next time gets easier.',
        'The best version of today doesn’t include this page.',
        'Attention is your life. Spend it on purpose.',
        'Break the loop, not your word.',
        'Future you is watching. Make them proud.'
      ],
      pause: [
        'What are you hoping to find here?',
        'Is this a choice, or a habit?',
        'How will you feel in an hour if you go through?',
        'Is there something you’re avoiding right now?',
        'Name the reason before you open the door.'
      ],
      affirmations: [
        'Gate held. That was a real win.',
        'You just bought back time you’d never get back.',
        'Walking away is the win. Well done.',
        'Small win. They compound.',
        'That took strength. Noted.',
        'Your future self says thank you.'
      ]
    },
    faith: {
      blocked: [
        '🕌 Remember Allah in your time.',
        '⏳ Time is a man’s amanah (trust).',
        '📖 Replace scrolling with dhikr.',
        '🌙 Let go of distractions.',
        '🧠 Use time before it uses you.',
        '📈 Small halal efforts compound.',
        '🔥 Stay firm against temptation.',
        '🌱 Invest in your akhirah.',
        '⛔ Leave what leads to sin.',
        '🕌 Fear Allah and protect your time.',
        '⏳ You will be accounted for every minute.',
        '📵 Close it before it opens your heart to distraction.',
        '🛑 Stop before the scroll becomes an addiction.',
        '📖 Replace this with Qur’an or knowledge.',
        '🤲 Ask Allah to save you from wasteful desires.',
        '🚫 No more delay — this is your wake-up call.',
        '💀 Time lost will not return.',
        '⚠️ One scroll leads to hours lost.',
        '🌙 Don’t trade akhirah for dopamine.',
        '🧨 Break the cycle, not your willpower.',
        '📵 If it does not benefit you, leave it.',
        '⛔ This is not harmless — it steals your life.'
      ],
      pause: [
        'Will this bring you closer to Allah, or further?',
        'Is this how you want to spend your amanah of time?',
        'Pause. Say bismillah, or walk away.',
        'Would you be at ease if this were your last hour?'
      ],
      affirmations: [
        'Good deed logged. Your scale just got heavier. 🤲',
        'You just avoided wasting hours you’ll never get back. ⏳',
        'That’s a rank raised, in sha’ Allah.',
        'Walking away is the win. Well done.',
        'Small win. They compound.',
        'That took strength. Noted.'
      ]
    }
  };

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function pack(style) {
    return PACKS[style] || PACKS.universal;
  }

  root.Reminders = {
    pick,
    blocked: (style) => pick(pack(style).blocked),
    pause: (style) => pick(pack(style).pause),
    affirmation: (style) => pick(pack(style).affirmations)
  };
})(typeof self !== 'undefined' ? self : this);
