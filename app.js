// ===== STATE =====
const S = { socket: null, user: null, friends: [], chatTarget: null, audioCtx: null, mediaStream: null, audioProcessor: null, audioSource: null, talkingTo: null, isTalking: false, voiceTimeout: null, toastTimer: null };
const $ = s => document.querySelector(s);

// ===== ELEMENTS =====
const el = {
  regScreen: $('#screen-register'), appScreen: $('#screen-app'),
  regName: $('#reg-name'), regBtn: $('#reg-btn'), loginPin: $('#login-pin'), loginBtn: $('#login-btn'),
  myAvatar: $('#my-avatar'), myName: $('#my-name'), myPinDisplay: $('#my-pin-display'),
  bigPin: $('#big-pin'), copyPin: $('#copy-pin'), pinBanner: $('#pin-banner'),
  btnAdd: $('#btn-add'), modalAdd: $('#modal-add'), inputPin: $('#input-pin'),
  cancelAdd: $('#cancel-add'), confirmAdd: $('#confirm-add'),
  noFriends: $('#no-friends'), friendsList: $('#friends-list'),
  speakingBar: $('#speaking-bar'), speakAvatar: $('#speak-avatar'), speakName: $('#speak-name'),
  toast: $('#toast'), toastText: $('#toast-text'), pokeAnim: $('#poke-anim'),
};

// ===== SOCKET =====
function initSocket() {
  S.socket = io(window.location.origin, {
    transports: ['polling', 'websocket'], reconnection: true, reconnectionAttempts: 20,
    reconnectionDelay: 1000, secure: window.location.protocol === 'https:', rejectUnauthorized: false,
  });
  const sk = S.socket;

  sk.on('connect', () => { if (S.user) sk.emit('login', { userId: S.user.id }); });

  sk.on('registered', ({ user }) => {
    S.user = user;
    localStorage.setItem('tenten_user', JSON.stringify(user));
    showScreen('app');
    updateMyInfo();
    sk.emit('get-friends');
    showToast(`Welcome, ${user.name}!`);
  });

  sk.on('login-failed', () => { localStorage.removeItem('tenten_user'); showScreen('register'); });
  sk.on('save-user', ({ user }) => { S.user = user; localStorage.setItem('tenten_user', JSON.stringify(user)); });

  sk.on('friends-list', ({ friends }) => { S.friends = friends; renderFriends(); });

  sk.on('friend-added', ({ friend }) => {
    if (!S.friends.find(f => f.id === friend.id)) S.friends.push(friend);
    renderFriends();
    showToast(`${friend.name} added! 👋`);
  });

  sk.on('friend-status', ({ friendId, online }) => {
    const f = S.friends.find(f => f.id === friendId);
    if (f) { f.online = online; renderFriends(); }
  });

  sk.on('friend-removed', ({ friendId }) => {
    S.friends = S.friends.filter(f => f.id !== friendId);
    renderFriends();
  });

  // ===== DIRECT VOICE (Walkie-Talkie) =====
  sk.on('voice-incoming', ({ fromId, fromName, fromAvatar }) => {
    // Show speaking indicator - no acceptance needed!
    el.speakAvatar.src = fromAvatar;
    el.speakName.textContent = fromName;
    el.speakBar.classList.remove('hidden');
    // Highlight the friend card
    const card = document.querySelector(`[data-fid="${fromId}"]`);
    if (card) card.classList.add('speaking');
  });

  sk.on('voice-chunk', ({ fromId, audioData }) => {
    // Play audio immediately - no questions asked!
    playAudio(audioData);
    // Reset timeout for speaking indicator
    clearTimeout(S.voiceTimeout);
    S.voiceTimeout = setTimeout(() => {
      el.speakBar.classList.add('hidden');
      document.querySelectorAll('.friend-card.speaking').forEach(c => c.classList.remove('speaking'));
    }, 500);
  });

  sk.on('voice-ended', ({ fromId }) => {
    el.speakBar.classList.add('hidden');
    const card = document.querySelector(`[data-fid="${fromId}"]`);
    if (card) card.classList.remove('speaking');
  });

  sk.on('voice-failed', ({ message }) => { showToast(message); });

  // POKE
  sk.on('poke-received', ({ fromName, type }) => {
    showPokeAnim(type);
    showToast(`${fromName} poked you ${type}`);
    if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);
  });

  // CHAT
  sk.on('chat-message', ({ fromId, fromName, fromAvatar, message, timestamp }) => {
    showToast(`${fromName}: ${message}`);
  });

  sk.on('error', ({ message }) => showToast(message));
  sk.on('notification', ({ message }) => showToast(message));
}

// ===== SCREENS =====
function showScreen(name) {
  [el.regScreen, el.appScreen].forEach(s => s.classList.remove('active'));
  if (name === 'register') el.regScreen.classList.add('active');
  if (name === 'app') el.appScreen.classList.add('active');
}

// ===== UI =====
function updateMyInfo() {
  if (!S.user) return;
  el.myAvatar.src = S.user.avatar;
  el.myName.textContent = S.user.name;
  el.myPinDisplay.textContent = `PIN: ${S.user.pin}`;
  el.bigPin.textContent = S.user.pin;
}

function renderFriends() {
  if (S.friends.length === 0) {
    el.noFriends.classList.remove('hidden');
    el.friendsList.innerHTML = '';
    return;
  }
  el.noFriends.classList.add('hidden');
  el.friendsList.innerHTML = '';

  const sorted = [...S.friends].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));

  sorted.forEach(friend => {
    const card = document.createElement('div');
    card.className = `friend-card ${friend.online ? 'online' : ''}`;
    card.dataset.fid = friend.id;
    card.innerHTML = `
      <div class="f-avatar-wrap">
        <img class="f-avatar" src="${friend.avatar}" alt="${friend.name}">
        <div class="f-status ${friend.online ? 'on' : ''}"></div>
      </div>
      <div class="f-info">
        <div class="f-name">${friend.name}</div>
        <div class="f-state">${friend.online ? '🟢 Online — Hold to talk' : '⚫ Offline'}</div>
      </div>
      <div class="f-actions">
        <button class="f-btn poke-btn" title="Poke">👋</button>
        <button class="f-btn chat-btn" title="Chat">💬</button>
      </div>
      <div class="htt-overlay">
        <span class="htt-icon">🎤</span>
        <span class="htt-text">HOLD TO TALK</span>
      </div>
    `;

    // Poke
    card.querySelector('.poke-btn').addEventListener('click', e => {
      e.stopPropagation();
      S.socket.emit('poke', { friendId: friend.id, pokeType: '👋' });
    });

    // Chat
    card.querySelector('.chat-btn').addEventListener('click', e => {
      e.stopPropagation();
      showToast('Chat coming soon!');
    });

    // ===== HOLD TO TALK (Walkie-Talkie) =====
    if (friend.online) {
      const htt = card.querySelector('.htt-overlay');
      let talking = false;

      const startTalk = async (e) => {
        e.preventDefault();
        if (talking) return;
        talking = true;
        htt.classList.add('active');
        card.classList.add('talking');
        S.talkingTo = friend.id;
        S.isTalking = true;

        // Get microphone
        try {
          if (!S.mediaStream) {
            S.mediaStream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
          }

          // Tell server we started talking
          S.socket.emit('voice-start', { friendId: friend.id });

          // Start sending audio chunks
          if (!S.audioCtx) S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const source = S.audioCtx.createMediaStreamSource(S.mediaStream);
          const processor = S.audioCtx.createScriptProcessor(4096, 1, 1);

          source.connect(processor);
          processor.connect(S.audioCtx.destination);

          processor.onaudioprocess = (e) => {
            if (!S.isTalking || S.talkingTo !== friend.id) return;
            const data = e.inputBuffer.getChannelData(0);
            const pcm = new Int16Array(data.length);
            for (let i = 0; i < data.length; i++) pcm[i] = data[i] * 0x7FFF;
            S.socket.emit('voice-chunk', { friendId: friend.id, audioData: Array.from(pcm) });
          };

          S.audioProcessor = processor;
          S.audioSource = source;
        } catch (err) {
          showToast('Microphone access denied!');
          stopTalk();
        }
      };

      const stopTalk = (e) => {
        if (e) e.preventDefault();
        if (!talking) return;
        talking = false;
        htt.classList.remove('active');
        card.classList.remove('talking');
        S.isTalking = false;

        // Stop sending
        if (S.audioProcessor) {
          S.audioProcessor.disconnect();
          S.audioProcessor = null;
        }
        if (S.audioSource) {
          S.audioSource.disconnect();
          S.audioSource = null;
        }

        // Tell server we stopped
        if (S.talkingTo) {
          S.socket.emit('voice-stop', { friendId: S.talkingTo });
        }
        S.talkingTo = null;
      };

      // Mouse events
      htt.addEventListener('mousedown', startTalk);
      htt.addEventListener('mouseup', stopTalk);
      htt.addEventListener('mouseleave', stopTalk);

      // Touch events
      htt.addEventListener('touchstart', startTalk, { passive: false });
      htt.addEventListener('touchend', stopTalk, { passive: false });
      htt.addEventListener('touchcancel', stopTalk, { passive: false });
    }

    el.friendsList.appendChild(card);
  });
}

// ===== AUDIO PLAYBACK =====
function playAudio(audioData) {
  if (!S.audioCtx) S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // Resume audio context if suspended (needed for background)
  if (S.audioCtx.state === 'suspended') S.audioCtx.resume();

  const float32 = new Float32Array(audioData.length);
  for (let i = 0; i < audioData.length; i++) float32[i] = audioData[i] / 0x7FFF;
  const buffer = S.audioCtx.createBuffer(1, float32.length, S.audioCtx.sampleRate);
  buffer.copyToChannel(float32, 0);
  const source = S.audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(S.audioCtx.destination);
  source.start();
}

// ===== UTILS =====
function showToast(msg) {
  el.toastText.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 3000);
}

function showPokeAnim(type) {
  el.pokeAnim.textContent = type;
  el.pokeAnim.classList.remove('hidden');
  setTimeout(() => el.pokeAnim.classList.add('hidden'), 1500);
}

// ===== EVENTS =====
function setupEvents() {
  // Register
  el.regBtn.addEventListener('click', () => {
    const name = el.regName.value.trim();
    if (!name) { el.regName.focus(); return; }
    initSocket();
    S.socket.emit('register', { name });
  });
  el.regName.addEventListener('keypress', e => { if (e.key === 'Enter') el.regBtn.click(); });

  // Login
  el.loginBtn.addEventListener('click', () => {
    const pin = el.loginPin.value.trim();
    if (pin.length !== 6) { showToast('Enter 6-digit PIN!'); return; }
    initSocket();
    S.socket.emit('login-pin', { pin });
  });
  el.loginPin.addEventListener('keypress', e => { if (e.key === 'Enter') el.loginBtn.click(); });

  // Copy PIN
  el.copyPin.addEventListener('click', () => {
    navigator.clipboard.writeText(S.user.pin).then(() => showToast('PIN copied! 📋'));
  });
  el.myPinDisplay.addEventListener('click', () => {
    navigator.clipboard.writeText(S.user.pin).then(() => showToast('PIN copied! 📋'));
  });

  // Add friend
  el.btnAdd.addEventListener('click', () => { el.modalAdd.classList.remove('hidden'); el.inputPin.value = ''; el.inputPin.focus(); });
  el.cancelAdd.addEventListener('click', () => el.modalAdd.classList.add('hidden'));
  el.confirmAdd.addEventListener('click', () => {
    const pin = el.inputPin.value.trim();
    if (pin.length !== 6) { showToast('Enter 6-digit PIN!'); return; }
    S.socket.emit('add-friend', { pin });
    el.modalAdd.classList.add('hidden');
  });
  el.inputPin.addEventListener('keypress', e => { if (e.key === 'Enter') el.confirmAdd.click(); });
  el.modalAdd.addEventListener('click', e => { if (e.target === el.modalAdd) el.modalAdd.classList.add('hidden'); });

  // Keep audio context alive in background
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.audioCtx && S.audioCtx.state === 'suspended') {
      S.audioCtx.resume();
    }
  });
}

// ===== INIT =====
function init() {
  setupEvents();
  const saved = localStorage.getItem('tenten_user');
  if (saved) {
    try { S.user = JSON.parse(saved); el.regName.value = S.user.name; } catch (e) {}
  }
  el.regName.focus();
}

document.addEventListener('DOMContentLoaded', init);
