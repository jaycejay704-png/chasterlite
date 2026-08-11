/**
 * Chaster Lite – frontend with shareable session codes
 * Works with the local Node server (server.js)
 */

const API = ''; // same origin

// ---------- State ----------
let state = {
  mode: 'home',          // 'home' | 'wearer' | 'keyholder'
  sessionCode: null,
  session: null,
  keyholderAuthenticated: false,
  _pendingPin: null,
  pollTimer: null
};

// ---------- DOM helpers ----------
function $(sel) { return document.querySelector(sel); }
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else if (c) e.appendChild(c);
  });
  return e;
}

function toast(msg, ms = 2800) {
  let t = $('.toast');
  if (!t) {
    t = el('div', { class: 'toast' });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

function formatDuration(ms) {
  if (ms <= 0) return '00:00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

function parseDurationInput(hours, minutes) {
  return (Number(hours) || 0) * 3600 * 1000 + (Number(minutes) || 0) * 60 * 1000;
}

// ---------- API ----------
async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function fetchSession(code) {
  const data = await api(`/api/session/${code}`);
  return data.session;
}

// ---------- Polling ----------
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.sessionCode) return;
    try {
      const session = await fetchSession(state.sessionCode);
      state.session = session;
      render();
    } catch (e) {
      if (e.message.toLowerCase().includes('not found')) {
        toast('Session no longer exists');
        state.sessionCode = null;
        state.session = null;
        state.mode = 'home';
        stopPolling();
        render();
      }
    }
  }, 3000);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// ---------- Screens ----------
function renderHome() {
  const main = $('#main');
  main.innerHTML = '';

  // Create lock card
  const createCard = el('div', { class: 'card' }, [
    el('h2', { text: 'Create a lock (Wearer)' }),
    el('p', { class: 'text-muted text-sm', text: 'You will get a session code to share with your keyholder.' })
  ]);

  const durGroup = el('div', {}, [
    el('label', { text: 'Duration' }),
    el('div', { style: 'display:flex;gap:0.5rem' }, [
      el('input', { type: 'number', id: 'hours', placeholder: 'Hours', min: '0', value: '1', style: 'flex:1' }),
      el('input', { type: 'number', id: 'minutes', placeholder: 'Minutes', min: '0', max: '59', value: '0', style: 'flex:1' })
    ])
  ]);

  const pinGroup = el('div', {}, [
    el('label', { text: 'Keyholder PIN (optional but recommended)' }),
    el('input', { type: 'password', id: 'kh-pin', placeholder: '4–8 characters', maxlength: '12' }),
    el('p', { class: 'text-muted text-sm', text: 'Keyholder must enter this PIN to control the lock.' })
  ]);

  const fileLabel = el('label', { class: 'file-label', for: 'combo-file' }, [
    el('div', { text: '📷  Upload combination photo' }),
    el('div', { class: 'text-muted text-sm mt-1', text: 'or leave empty for a random 6-digit code' }),
    el('input', { type: 'file', id: 'combo-file', accept: 'image/*' })
  ]);

  const preview = el('img', { class: 'combo-preview', id: 'combo-preview', alt: 'Preview' });
  let selectedFile = null;

  fileLabel.querySelector('input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    selectedFile = file;
    preview.src = URL.createObjectURL(file);
    preview.classList.add('visible');
  });

  const startBtn = el('button', {
    class: 'btn btn-primary mt-2',
    text: '🔒 Create lock & get session code',
    onClick: async () => {
      const durationMs = parseDurationInput($('#hours').value, $('#minutes').value);
      if (durationMs < 60 * 1000) {
        toast('Minimum 1 minute');
        return;
      }
      const pin = $('#kh-pin').value.trim();
      if (pin && pin.length < 4) {
        toast('PIN should be at least 4 characters');
        return;
      }

      startBtn.disabled = true;
      startBtn.textContent = 'Creating…';

      try {
        let imageBase64 = null;
        if (selectedFile) {
          imageBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(selectedFile);
          });
        }

        const data = await api('/api/create', {
          method: 'POST',
          body: JSON.stringify({
            durationMs,
            pin: pin || null,
            imageBase64
          })
        });

        state.sessionCode = data.code;
        state.session = data.session;
        state.mode = 'wearer';
        state.keyholderAuthenticated = false;
        state._pendingPin = null;
        startPolling();
        render();
        toast('Lock created! Share the code.');
      } catch (e) {
        toast(e.message || 'Failed to create lock');
        startBtn.disabled = false;
        startBtn.textContent = '🔒 Create lock & get session code';
      }
    }
  });

  createCard.append(durGroup, pinGroup, fileLabel, preview, startBtn);
  main.appendChild(createCard);

  // Join as keyholder
  const joinCard = el('div', { class: 'card' }, [
    el('h2', { text: 'Join as Keyholder' }),
    el('p', { class: 'text-muted text-sm', text: 'Enter the session code your partner shared with you.' }),
    el('label', { text: 'Session code' }),
    el('input', { type: 'text', id: 'join-code', placeholder: 'e.g. ABCD-1234', style: 'text-transform:uppercase' }),
    el('button', {
      class: 'btn btn-secondary mt-1',
      text: 'Open session',
      onClick: async () => {
        const code = ($('#join-code').value || '').trim().toUpperCase();
        if (!code || code.length < 8) {
          toast('Enter a valid session code');
          return;
        }
        try {
          const session = await fetchSession(code);
          state.sessionCode = code;
          state.session = session;
          state.mode = 'keyholder';
          state.keyholderAuthenticated = false;
          state._pendingPin = null;
          startPolling();
          render();
        } catch (e) {
          toast(e.message || 'Session not found');
        }
      }
    })
  ]);
  main.appendChild(joinCard);

  // Info
  main.appendChild(el('div', { class: 'card' }, [
    el('h2', { text: 'How shareable sessions work' }),
    el('ol', { class: 'text-sm text-muted', style: 'padding-left:1.2rem' }, [
      el('li', { text: 'Wearer creates a lock and receives a short session code (e.g. KX7M-4821).' }),
      el('li', { text: 'Wearer shares the code (and optional PIN) with the keyholder.' }),
      el('li', { text: 'Keyholder opens this same app on any device, enters the code, and can control the lock.' }),
      el('li', { text: 'Both sides see live updates (timer, freeze, unlock).' }),
      el('li', { text: 'Combination photo stays hidden until the timer ends or keyholder unlocks.' })
    ])
  ]));
}

function renderSession() {
  const main = $('#main');
  main.innerHTML = '';
  const s = state.session;
  if (!s) {
    state.mode = 'home';
    return renderHome();
  }

  const isWearer = state.mode === 'wearer';
  const remaining = s.remainingMs || 0;

  // Header / status
  const statusCard = el('div', { class: 'card text-center' });

  // Session code (prominent for sharing)
  statusCard.append(
    el('div', { class: 'text-muted text-sm', text: 'Session code' }),
    el('div', {
      style: 'font-size:1.6rem;font-weight:700;letter-spacing:0.12em;margin:0.3rem 0 0.8rem;user-select:all',
      text: state.sessionCode
    })
  );

  let badgeClass = 'status-locked';
  let badgeText = 'Locked';
  if (s.status === 'unlocked') {
    badgeClass = 'status-unlocked';
    badgeText = 'Unlocked';
  } else if (s.frozen) {
    badgeClass = 'status-frozen';
    badgeText = 'Frozen';
  }

  statusCard.append(el('div', { class: `status-badge ${badgeClass}`, text: badgeText }));

  if (s.status === 'locked') {
    statusCard.append(
      el('div', {
        class: `timer ${s.frozen ? 'frozen' : ''}`,
        id: 'timer-display',
        text: formatDuration(remaining)
      }),
      el('p', {
        class: 'text-muted text-sm',
        text: s.frozen ? 'Timer is frozen' : 'Time remaining'
      })
    );
  } else {
    statusCard.append(
      el('p', { class: 'mt-2 text-muted text-sm', text: `Unlocked via ${s.unlockReason === 'keyholder' ? 'keyholder' : 'timer'}` })
    );
  }

  main.appendChild(statusCard);

  // Combination area
  const comboCard = el('div', { class: 'card' }, [el('h2', { text: 'Combination' })]);

  if (s.status === 'unlocked') {
    if (s.hasImage) {
      const img = el('img', {
        class: 'combo-preview visible',
        alt: 'Combination photo',
        src: `/api/session/${state.sessionCode}/image?t=${Date.now()}`
      });
      comboCard.append(img);
    } else if (s.fallbackCode) {
      comboCard.append(el('div', {
        style: 'font-size:2rem;font-weight:700;letter-spacing:0.25em;text-align:center;margin:1rem 0',
        text: s.fallbackCode
      }));
    } else {
      comboCard.append(el('p', { class: 'text-muted', text: 'No combination data' }));
    }
  } else {
    comboCard.append(el('div', { class: 'combo-hidden' }, [
      el('div', { text: '🔐 Combination is locked' }),
      el('div', { class: 'text-sm mt-1', text: s.hasImage ? 'Photo will appear when unlocked' : 'Code will appear when unlocked' })
    ]));
  }
  main.appendChild(comboCard);

  // Keyholder controls
  if (s.status === 'locked') {
    const khCard = el('div', { class: 'card kh-panel' }, [
      el('h2', { text: isWearer ? 'Keyholder controls' : 'Keyholder controls' })
    ]);

    if (!state.keyholderAuthenticated) {
      khCard.append(
        el('p', { class: 'text-muted text-sm', text: 'Enter the keyholder PIN (leave empty if none was set).' }),
        el('input', { type: 'password', id: 'kh-auth', placeholder: 'Keyholder PIN', autocomplete: 'off' }),
        el('button', {
          class: 'btn btn-secondary mt-1',
          text: 'Authenticate',
          onClick: () => {
            state.keyholderAuthenticated = true;
            state._pendingPin = $('#kh-auth').value;
            render();
          }
        })
      );
    } else {
      khCard.append(el('p', { class: 'text-muted text-sm', text: 'Authenticated. Changes sync to the other device within a few seconds.' }));

      const addGroup = el('div', { class: 'mt-2' }, [
        el('label', { text: 'Adjust time (minutes)' }),
        el('div', { style: 'display:flex;gap:0.5rem' }, [
          el('input', { type: 'number', id: 'adjust-min', value: '30', style: 'flex:1' }),
          el('button', {
            class: 'btn btn-secondary',
            text: '+ Add',
            style: 'width:auto;padding:0.7rem 1rem',
            onClick: () => doAction('add_time', Number($('#adjust-min').value) || 0)
          }),
          el('button', {
            class: 'btn btn-secondary',
            text: '− Remove',
            style: 'width:auto;padding:0.7rem 1rem',
            onClick: () => doAction('add_time', -(Number($('#adjust-min').value) || 0))
          })
        ])
      ]);

      const freezeBtn = el('button', {
        class: 'btn btn-secondary mt-2',
        text: s.frozen ? 'Unfreeze timer' : 'Freeze timer',
        onClick: () => doAction(s.frozen ? 'unfreeze' : 'freeze')
      });

      const unlockBtn = el('button', {
        class: 'btn btn-success mt-2',
        text: '🔓 Unlock & reveal combination',
        onClick: () => {
          if (confirm('Reveal the combination and end the lock for both of you?')) {
            doAction('unlock');
          }
        }
      });

      khCard.append(addGroup, freezeBtn, unlockBtn);
    }
    main.appendChild(khCard);
  }

  // Wearer / shared actions
  const actionsCard = el('div', { class: 'card' });
  if (isWearer && s.status === 'locked') {
    actionsCard.append(
      el('h2', { text: 'Wearer options' }),
      el('p', { class: 'text-muted text-sm', text: 'Share the session code above with your keyholder. They open this same app and enter the code.' }),
      el('button', {
        class: 'btn btn-secondary mt-1',
        text: 'Copy session code',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(state.sessionCode);
            toast('Code copied');
          } catch {
            toast('Copy failed – select the code manually');
          }
        }
      }),
      el('button', {
        class: 'btn btn-danger mt-2',
        text: 'Discard lock (emergency)',
        onClick: async () => {
          if (!confirm('Permanently delete this session and the stored photo?')) return;
          try {
            await api(`/api/session/${state.sessionCode}/discard`, { method: 'POST', body: '{}' });
            stopPolling();
            state.sessionCode = null;
            state.session = null;
            state.mode = 'home';
            render();
            toast('Session discarded');
          } catch (e) {
            toast(e.message);
          }
        }
      })
    );
  } else {
    actionsCard.append(
      el('button', {
        class: 'btn btn-secondary',
        text: 'Leave session / Back to home',
        onClick: () => {
          stopPolling();
          state.sessionCode = null;
          state.session = null;
          state.mode = 'home';
          state.keyholderAuthenticated = false;
          state._pendingPin = null;
          render();
        }
      })
    );
    if (s.status === 'unlocked') {
      actionsCard.append(el('p', { class: 'text-muted text-sm mt-2', text: 'You can safely leave. The combination has been revealed.' }));
    }
  }
  main.appendChild(actionsCard);
}

async function doAction(action, minutes = 0) {
  try {
    const body = {
      action,
      minutes,
      pin: state._pendingPin || undefined
    };
    const data = await api(`/api/session/${state.sessionCode}`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    state.session = data.session;
    render();
    const msgs = {
      add_time: minutes >= 0 ? `Added ${minutes} min` : `Removed ${Math.abs(minutes)} min`,
      freeze: 'Timer frozen',
      unfreeze: 'Timer unfrozen',
      unlock: 'Unlocked – combination revealed'
    };
    toast(msgs[action] || 'Updated');
  } catch (e) {
    if (e.message.toLowerCase().includes('pin') || e.message.toLowerCase().includes('invalid')) {
      state.keyholderAuthenticated = false;
      state._pendingPin = null;
      toast('Wrong PIN – try again');
      render();
    } else {
      toast(e.message || 'Action failed');
    }
  }
}

// ---------- Main render + live timer ----------
let localTick = null;

function render() {
  if (localTick) {
    clearInterval(localTick);
    localTick = null;
  }

  if (state.mode === 'home' || !state.sessionCode) {
    stopPolling();
    renderHome();
    return;
  }

  renderSession();

  // Local smooth countdown between polls
  if (state.session && state.session.status === 'locked' && !state.session.frozen) {
    localTick = setInterval(() => {
      const display = $('#timer-display');
      if (!display || !state.session) return;
      if (state.session.remainingMs > 0) {
        state.session.remainingMs = Math.max(0, state.session.remainingMs - 1000);
        display.textContent = formatDuration(state.session.remainingMs);
        if (state.session.remainingMs <= 0) {
          fetchSession(state.sessionCode).then(s => {
            state.session = s;
            render();
          }).catch(() => {});
        }
      }
    }, 1000);
  }
}

// ---------- Boot ----------
render();
