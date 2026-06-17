/* =================================================================
   WatchFriend — İstemci mantığı
   HLS.js + Socket.IO ile senkron izleme
   ================================================================= */

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);

const screens = {
  landing: $('landing'),
  room: $('room'),
};

const els = {
  // landing
  nameInput: $('nameInput'),
  createRoomBtn: $('createRoomBtn'),
  joinInput: $('joinInput'),
  joinBtn: $('joinBtn'),
  landingError: $('landingError'),
  // room topbar
  roomName: $('roomName'),
  roomCode: $('roomCode'),
  hostBadge: $('hostBadge'),
  togglePanelBtn: $('togglePanelBtn'),
  // player
  video: $('video'),
  loader: $('loader'),
  connectingMsg: $('connectingMsg'),
  controls: $('controls'),
  playPauseBtn: $('playPauseBtn'),
  liveBtn: $('liveBtn'),
  muteBtn: $('muteBtn'),
  volumeSlider: $('volumeSlider'),
  qualitySelect: $('qualitySelect'),
  viewerHint: $('viewerHint'),
  // panel
  panel: $('panel'),
  participantList: $('participantList'),
  participantCount: $('participantCount'),
  inviteLink: $('inviteLink'),
  copyInviteBtn: $('copyInviteBtn'),
  leaveBtn: $('leaveBtn'),
  // cinema
  cinemaBtn: $('cinemaBtn'),
  cinemaExitBtn: $('cinemaExitBtn'),
  // toast
  toast: $('toast'),
};

/* ---------- Durum ---------- */
const state = {
  isHost: false,
  roomId: null,
  name: '',
  hls: null,
  socket: null,
  // izleyici iken sunucudan gelen komutları uyguluyoruz; kendi user action'ları değil
  applyingRemoteCommand: false,
  syncTimer: null,
  // sinema modu
  cinemaMode: false,
  idleTimer: null,
};

/* ---------- Kaynaklar ----------
   TRT CDN tarayıcıdan direkt erişime açık (CORS: *).
   Her ortamda (localhost dahil) direkt TRT kullanıyoruz — proxy devre dışı.
   Bu, segment path çözümleme sorunlarını ortadan kaldırır ve gecikmeyi azaltır.
*/
const STREAM_SOURCES = [
  'https://tv-trt1.medya.trt.com.tr/master.m3u8',         // TRT ana CDN (CORS açık)
  'https://trt-daioncdn.mb3x.com/trt-1/master.m3u8',      // yedek CDN
];
let currentSourceIndex = 0;

/* =================================================================
   Yardımcılar
   ================================================================= */
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function showToast(msg, dur = 2400) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  // reflow ile animasyonu tetikle
  void els.toast.offsetWidth;
  els.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => els.toast.classList.add('hidden'), 220);
  }, dur);
}

function showLandingError(msg) {
  els.landingError.textContent = msg;
  els.landingError.classList.remove('hidden');
  // animasyonu tekrar oynat
  els.landingError.style.animation = 'none';
  void els.landingError.offsetWidth;
  els.landingError.style.animation = '';
}

function avatarColor(name) {
  // isimden tutarlı renk üret
  const colors = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444', '#06b6d4', '#6366f1'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function initials(name) {
  return name.trim().slice(0, 2).toUpperCase();
}

/* =================================================================
   HLS.js kurulumu
   ================================================================= */
function setupHls() {
  if (els.loader) {
    els.loader.classList.remove('hidden');
  }

  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,           // düşük gecikme modu (canlı için)
      backBufferLength: 30,
      // canlı uçtakı oynatmayı tercih et
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 6,
      maxBufferLength: 20,
    });
    state.hls = hls;

    // İlk kaynaktan başla
    currentSourceIndex = 0;
    loadSource(hls);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      console.log('[hls] manifest yüklendi, seviye sayısı:', hls.levels.length);
      fillQualityOptions(hls);
      // Canlı uca otomatik git
      if (hls.liveSyncPosition) {
        els.video.currentTime = hls.liveSyncPosition;
      }
      // canlı yayında otomatik oynat
      tryStartPlayback();
    });

    hls.on(Hls.Events.FRAG_LOADED, () => {
      // segment geldi → loader'ı kesin gizle
      hideLoader();
      enableControls(true);
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => {
      // kalite değiştiğinde dropdown güncelle
      const level = hls.levels[data.level];
      if (level) updateQualitySelectValue(data.level);
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      console.warn('[hls] hata:', data.type, data.details, 'kaynak:', STREAM_SOURCES[currentSourceIndex]);
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            // Manifest yüklenemedi → sonraki kaynağa geç
            if (data.details === 'manifestLoadError' && currentSourceIndex < STREAM_SOURCES.length - 1) {
              currentSourceIndex++;
              console.log('[hls] kaynak değiştiriliyor →', STREAM_SOURCES[currentSourceIndex]);
              showToast('Kaynak değiştiriliyor…');
              // kısa gecikmeyle yeniden yükle
              setTimeout(() => loadSource(hls), 500);
            } else if (data.details === 'manifestLoadError') {
              // Tüm kaynaklar tükendi → baştan dene (döngü)
              showToast('Yayın kaynakları yeniden deneniyor…', 3000);
              currentSourceIndex = 0;
              setTimeout(() => loadSource(hls), 1500);
            } else {
              // Segment seviyesi ağ hatası → tekrar dene
              showToast('Yayın bağlantısı koptu, yeniden deneniyor…');
              hls.startLoad();
            }
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            showToast('Görüntü kurtarılıyor…');
            hls.recoverMediaError();
            break;
          default:
            showToast('Yayın yüklenemedi. TRT1 kaynağı şu an erişilemiyor olabilir.');
            destroyHls();
            break;
        }
      }
    });

  } else if (els.video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari yerel HLS desteği
    currentSourceIndex = 0;
    els.video.src = STREAM_SOURCES[0];
    els.video.addEventListener('loadedmetadata', () => {
      els.video.muted = true;
      els.video.play().then(unmuteInitial).catch(() => {});
      hideLoader();
      enableControls(true);
    });
  } else {
    showToast('Tarayıcınız HLS oynatmayı desteklemiyor.');
  }
}

// Belirli bir kaynağı HLS'e yükle
function loadSource(hls) {
  const url = STREAM_SOURCES[currentSourceIndex];
  console.log('[hls] yükleniyor:', url);
  hls.loadSource(url);
}

function destroyHls() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
}

function unmuteInitial() {
  // autoplay engellenirse butonla ses açılır; başta %80 volume
  try {
    const vol = parseInt(els.volumeSlider.value, 10) / 100;
    els.video.muted = false;
    els.video.volume = vol;
    updateMuteIcon();
  } catch (_) {}
}

/* Oynatmayı başlat — autoplay engelini robust şekilde ele alır.
   Tarayıcılar sessiz oynatmaya izin verir; sesi kullanıcı etkileşimiyle açarız. */
function tryStartPlayback() {
  // Başlangıçta sessiz (autoplay politikası) — sesi kullanıcı açacak
  els.video.muted = true;
  els.video.volume = 0;
  const p = els.video.play();
  if (p && typeof p.then === 'function') {
    p.then(() => {
      console.log('[hls] oynatma başladı (sessiz)');
      hideLoader();
    }).catch((err) => {
      console.warn('[hls] otomatik oynatma engellendi:', err.name);
      // Kullanıcı ilk etkileşimde (tıklama) başlat
      showPlayOverlay();
    });
  }
}

/* Autoplay engellenince video üzerinde tıklanabilir bir katman göster */
function showPlayOverlay() {
  let overlay = document.getElementById('playOverlay');
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'playOverlay';
  overlay.style.cssText = [
    'position:absolute', 'inset:0', 'display:grid', 'place-items:center',
    'background:rgba(0,0,0,0.5)', 'cursor:pointer', 'z-index:6',
    'transition:opacity .3s', 'border-radius:inherit',
  ].join(';');
  overlay.innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;gap:14px;color:#fff">' +
    '<div style="width:76px;height:76px;border-radius:50%;background:#3b82f6;display:grid;place-items:center;box-shadow:0 8px 30px rgba(59,130,246,.5)">' +
    '<svg viewBox="0 0 24 24" width="34" height="34" fill="#fff"><path d="M8 5v14l11-7z"/></svg></div>' +
    '<span style="font-size:15px;font-weight:600">Yayını başlatmak için tıkla</span></div>';
  els.video.parentElement.appendChild(overlay);
  const start = () => {
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 300);
    els.video.muted = true;
    els.video.play().then(() => {
      hideLoader();
      // kısa gecikmeyle sesi açmayı dene
      setTimeout(unmuteInitial, 200);
    }).catch(() => {});
  };
  overlay.addEventListener('click', start, { once: true });
}

function hideLoader() {
  els.loader.classList.add('hidden');
  els.connectingMsg.classList.add('hidden');
}

function fillQualityOptions(hls) {
  const sel = els.qualitySelect;
  // mevcut option'ları temizle (Otomatik hariç)
  sel.innerHTML = '<option value="-1">Otomatik</option>';
  hls.levels.forEach((lvl, i) => {
    const label = lvl.height ? `${lvl.height}p` : `Seviye ${i}`;
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = label;
    sel.appendChild(opt);
  });
}

function updateQualitySelectValue(levelIndex) {
  // level -1 (auto) host kontrol etmezse currentLevel gösterilir
  if (state.hls && state.hls.autoLevelEnabled) {
    els.qualitySelect.value = '-1';
  } else {
    els.qualitySelect.value = String(levelIndex);
  }
}

/* =================================================================
   Oynatma kontrolleri
   ================================================================= */
function enableControls(enabled) {
  els.playPauseBtn.disabled = !enabled;
}

function updatePlayIcon() {
  const paused = els.video.paused;
  els.playPauseBtn.querySelector('.icon-play').classList.toggle('hidden', !paused);
  els.playPauseBtn.querySelector('.icon-pause').classList.toggle('hidden', paused);
}

function updateMuteIcon() {
  const muted = els.video.muted || els.video.volume === 0;
  els.muteBtn.querySelector('.icon-vol').classList.toggle('hidden', muted);
  els.muteBtn.querySelector('.icon-mute').classList.toggle('hidden', !muted);
}

function updateLiveBadge() {
  // canlı uca yakınsa yeşil, değilse kırmızı
  const isLive = isAtLiveEdge();
  els.liveBtn.classList.toggle('live-btn-active', isLive);
}

function isAtLiveEdge() {
  if (!state.hls || !state.hls.liveSyncPosition) {
    return !els.video.paused;
  }
  const edge = state.hls.liveSyncPosition;
  const cur = els.video.currentTime;
  return Math.abs(edge - cur) < 8;
}

function seekToLive() {
  if (state.hls && state.hls.liveSyncPosition) {
    els.video.currentTime = state.hls.liveSyncPosition;
  }
  updateLiveBadge();
}

/* =================================================================
   Host ↔ İzleyici senkronizasyonu
   ================================================================= */
function sendHostCommand(cmd) {
  if (!state.isHost) return;
  state.socket.emit('host-command', cmd);
}

function applyCommand(cmd) {
  state.applyingRemoteCommand = true;
  try {
    switch (cmd.type) {
      case 'play':
        els.video.play().catch(() => {});
        break;
      case 'pause':
        els.video.pause();
        break;
      case 'seek-live':
        seekToLive();
        break;
      case 'mute':
        els.video.muted = cmd.value;
        updateMuteIcon();
        break;
      case 'volume':
        els.video.muted = false;
        els.video.volume = cmd.value;
        els.volumeSlider.value = Math.round(cmd.value * 100);
        updateMuteIcon();
        break;
      case 'quality':
        setQuality(cmd.value);
        break;
      case 'snapshot':
        // host'tan gelen tam durum (ilk katılım)
        applySnapshot(cmd.state);
        break;
    }
  } finally {
    state.applyingRemoteCommand = false;
  }
}

function applySnapshot(s) {
  if (s.paused) els.video.pause(); else els.video.play().catch(() => {});
  if (typeof s.muted === 'boolean') {
    els.video.muted = s.muted;
    updateMuteIcon();
  }
  if (typeof s.volume === 'number') {
    els.video.volume = s.volume;
    els.volumeSlider.value = Math.round(s.volume * 100);
  }
  if (typeof s.quality === 'number') setQuality(s.quality);
  // canlı uca git (yeni katılan herkes aynı noktada başlasın)
  seekToLive();
}

function setQuality(level) {
  if (!state.hls) return;
  state.hls.currentLevel = level; // -1 otomatik
}

/* =================================================================
   Socket.IO — oda katılımı ve olaylar
   ================================================================= */
function connectSocket(roomId, name) {
  const socket = io({ transports: ['websocket', 'polling'] });
  state.socket = socket;

  socket.on('connect', () => {
    socket.emit('join', { roomId, name }, (res) => {
      if (!res || !res.ok) {
        showLandingError('Odaya katılınamadı.');
        return;
      }
      state.isHost = res.isHost;
      enterRoom(res.room, roomId);
    });
  });

  socket.on('connect_error', () => {
    showToast('Sunucuya bağlanılamadı, yeniden deneniyor…');
  });

  // Oda durumu (katılımcı listesi) güncellemesi
  socket.on('room-state', (room) => {
    renderParticipants(room);
  });

  // İzleyici: host'tan komut al
  socket.on('command', (cmd) => {
    if (state.isHost) return; // host kendi komutunu geri almaz
    applyCommand(cmd);
  });

  // İzleyici: host'tan senkron zamanı
  socket.on('sync-time', () => {
    // host canlı uca işaret ettiğinde izleyici de yaklaştır
    if (!state.hls || !state.hls.liveSyncPosition) return;
    const edge = state.hls.liveSyncPosition;
    const cur = els.video.currentTime;
    if (Math.abs(edge - cur) > 10) {
      els.video.currentTime = edge;
    }
  });

  // Host: yeni katılan var, ona anlık state gönder
  socket.on('request-state', ({ to }) => {
    if (!state.isHost) return;
    socket.emit('state-snapshot', {
      to,
      state: {
        paused: els.video.paused,
        muted: els.video.muted,
        volume: els.video.volume,
        quality: state.hls ? state.hls.currentLevel : -1,
      },
    });
  });

  // Host oldu (mevcut host ayrılınca)
  socket.on('you-are-host', () => {
    state.isHost = true;
    els.hostBadge.classList.remove('hidden');
    els.viewerHint.classList.add('hidden');
    enableHostControls(true);
    startHostSync();
    showToast('Oda sahibi oldun! Artık kontrol sende.');
  });
}

function renderParticipants(room) {
  els.roomName.textContent = room.name;
  els.participantCount.textContent = room.users.length;
  els.participantList.innerHTML = '';

  room.users.forEach((u) => {
    const li = document.createElement('li');
    li.className = 'participant' + (u.isHost ? ' is-host' : '');

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = avatarColor(u.name);
    avatar.textContent = initials(u.name);

    const info = document.createElement('div');
    info.className = 'participant-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'participant-name';
    nameEl.textContent = u.name + (u.name === state.name ? ' (sen)' : '');
    const roleEl = document.createElement('div');
    roleEl.className = 'participant-role';
    roleEl.textContent = u.isHost ? 'Oda Sahibi' : 'İzleyici';
    info.appendChild(nameEl);
    info.appendChild(roleEl);

    li.appendChild(avatar);
    li.appendChild(info);
    els.participantList.appendChild(li);
  });
}

function enterRoom(room, roomId) {
  showScreen('room');
  els.roomName.textContent = room.name;
  els.roomCode.textContent = '#' + roomId;
  els.participantCount.textContent = room.users.length;

  // davet linki
  const invite = window.location.origin + '/room/' + roomId;
  els.inviteLink.value = invite;

  if (state.isHost) {
    els.hostBadge.classList.remove('hidden');
    enableHostControls(true);
    startHostSync();
  } else {
    els.hostBadge.classList.add('hidden');
    enableHostControls(false);
  }

  setupHls();
  renderParticipants(room);
}

function enableHostControls(host) {
  // Host kontrol eder; izleyici kontrolcü pasif görünür ama kilitli
  els.viewerHint.classList.toggle('hidden', host);
  els.playPauseBtn.disabled = !host;
  els.muteBtn.disabled = !host;
  els.volumeSlider.disabled = !host;
  els.qualitySelect.disabled = !host;
  els.liveBtn.disabled = !host;
  // kontroller her zaman görünür (hover) ama izleyicide bilgilendirme var
}

function startHostSync() {
  // Host periyodik olarak canlı senkron sinyali gönderir
  clearInterval(state.syncTimer);
  state.syncTimer = setInterval(() => {
    if (!state.isHost || !state.socket) return;
    state.socket.emit('sync-time', Date.now());
  }, 4000);
}

/* =================================================================
   Sinema modu — video tüm ekranı kaplar, arayüz gizlenir
   ================================================================= */
function toggleCinemaMode(force) {
  state.cinemaMode = typeof force === 'boolean' ? force : !state.cinemaMode;
  document.body.classList.toggle('cinema-active', state.cinemaMode);

  if (state.cinemaMode) {
    // sinema moduna girerken kontrolleri görünür kıl, idle sayacını başlat
    document.body.classList.remove('idle-hide');
    resetIdleTimer();
    showToast('Sinema modu — çıkmak için ESC', 1800);
  } else {
    // çıkışta idle gizlemeyi temizle
    clearTimeout(state.idleTimer);
    document.body.classList.remove('idle-hide');
  }
}

function resetIdleTimer() {
  if (!state.cinemaMode) return;
  document.body.classList.remove('idle-hide');
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    if (state.cinemaMode) document.body.classList.add('idle-hide');
  }, 2500);
}

/* =================================================================
   Olay bağlantıları (event listeners)
   ================================================================= */

// ---- Landing ----
els.createRoomBtn.addEventListener('click', () => {
  const name = els.nameInput.value.trim();
  if (!name) {
    showLandingError('Lütfen adını gir.');
    els.nameInput.focus();
    return;
  }
  const roomId = generateRoomIdLocal();
  startSession(roomId, name);
});

els.joinBtn.addEventListener('click', joinFromInput);
els.joinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinFromInput();
});
els.nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    // Eğer oda linkinden gelinmişse Katıl, değilse Oda Oluştur
    if (state.roomId) joinFromInput();
    else els.createRoomBtn.click();
  }
});

function joinFromInput() {
  const name = els.nameInput.value.trim();
  let roomId = els.joinInput.value.trim().toLowerCase().replace(/^#/, '');
  if (!name) {
    showLandingError('Lütfen adını gir.');
    return;
  }
  if (!roomId) {
    showLandingError('Oda kodu gir.');
    return;
  }
  startSession(roomId, name);
}

function generateRoomIdLocal() {
  // 6 karakter hex
  return Array.from({ length: 6 }, () =>
    '0123456789abcdef'[Math.floor(Math.random() * 16)]
  ).join('');
}

function startSession(roomId, name) {
  els.landingError.classList.add('hidden');
  state.name = name;
  state.roomId = roomId;
  // history'i oda url'iyle güncelle
  history.pushState({ roomId }, '', '/room/' + roomId);
  connectSocket(roomId, name);
}

// ---- Room: kontroller ----
els.playPauseBtn.addEventListener('click', () => {
  if (!state.isHost) return;
  if (els.video.paused) {
    els.video.play().then(() => sendHostCommand({ type: 'play' }));
  } else {
    els.video.pause();
    sendHostCommand({ type: 'pause' });
  }
  updatePlayIcon();
});

els.liveBtn.addEventListener('click', () => {
  if (!state.isHost) return;
  seekToLive();
  sendHostCommand({ type: 'seek-live' });
});

els.muteBtn.addEventListener('click', () => {
  if (!state.isHost) return;
  els.video.muted = !els.video.muted;
  updateMuteIcon();
  sendHostCommand({ type: 'mute', value: els.video.muted });
});

els.volumeSlider.addEventListener('input', () => {
  if (!state.isHost) return;
  const v = parseInt(els.volumeSlider.value, 10) / 100;
  els.video.muted = v === 0;
  els.video.volume = v;
  updateMuteIcon();
  sendHostCommand({ type: 'volume', value: v });
});

els.qualitySelect.addEventListener('change', () => {
  if (!state.isHost) return;
  const v = parseInt(els.qualitySelect.value, 10);
  setQuality(v);
  sendHostCommand({ type: 'quality', value: v });
});

// video elementi olayları
els.video.addEventListener('play', updatePlayIcon);
els.video.addEventListener('pause', updatePlayIcon);
els.video.addEventListener('volumechange', () => {
  updateMuteIcon();
  updateLiveBadge();
});
els.video.addEventListener('playing', () => {
  hideLoader();
  updateLiveBadge();
});
els.video.addEventListener('timeupdate', updateLiveBadge);
els.video.addEventListener('waiting', () => {
  // buffering göstergesi opsiyonel
});

/* ---- Panel ---- */
els.togglePanelBtn.addEventListener('click', () => {
  els.panel.classList.toggle('collapsed');
});

/* ---- Sinema modu ---- */
els.cinemaBtn.addEventListener('click', () => toggleCinemaMode());
els.cinemaExitBtn.addEventListener('click', () => toggleCinemaMode(false));

// ESC ile sinema modundan çık
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.cinemaMode) {
    toggleCinemaMode(false);
  }
});

// Sinema modunda fare hareketi → kontrolleri geçici göster
document.addEventListener('mousemove', () => {
  if (state.cinemaMode) resetIdleTimer();
});

els.copyInviteBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.inviteLink.value);
    showToast('Davet linki kopyalandı!');
  } catch (_) {
    els.inviteLink.select();
    document.execCommand('copy');
    showToast('Davet linki kopyalandı!');
  }
});

els.leaveBtn.addEventListener('click', () => {
  if (state.socket) {
    state.socket.emit('leave');
    state.socket.disconnect();
  }
  destroyHls();
  clearInterval(state.syncTimer);
  clearTimeout(state.idleTimer);
  document.body.classList.remove('cinema-active', 'idle-hide');
  history.pushState({}, '', '/');
  location.reload();
});

/* =================================================================
   URL'den doğrudan oda girişi
   ================================================================= */
(function init() {
  // Güvenlik: herhangi bir hata olsa bile landing görünür kalsın
  document.documentElement.classList.remove('no-js');
  try {
    // Önce her zaman landing ekranını göster — böylece asla boş ekran kalmaz
    showScreen('landing');
  } catch (e) {
    console.error('[init] showScreen hatası:', e);
    document.getElementById('landing').classList.add('active');
  }

  try {
    const path = window.location.pathname;
    const match = path.match(/^\/room\/([a-z0-9]+)/i);
    if (match) {
      // Direkt oda linkiyle gelinmiş — landing'i "bu odaya katıl" moduna çevir
      state.roomId = match[1];
      // Oda kodunu join alanına önden doldur ve bilgilendirme göster
      els.joinInput.value = match[1];
      els.joinInput.disabled = true;
      els.joinInput.style.opacity = '0.6';

      // Üst bilgi: hangi odaya katılacağı
      let info = document.getElementById('joinInfo');
      if (!info) {
        info = document.createElement('div');
        info.id = 'joinInfo';
        info.className = 'error-msg';
        info.style.background = 'rgba(59, 130, 246, 0.1)';
        info.style.borderColor = 'rgba(59, 130, 246, 0.3)';
        info.style.color = '#60a5fa';
        info.style.animation = 'none';
        info.style.display = 'block';
        els.landingError.parentElement.appendChild(info);
      }
      info.textContent = `🔗 "${match[1]}" odasına katılıyorsun. Adını gir ve Katıl'a bas.`;

      // İsim alanına odaklan
      setTimeout(() => { try { els.nameInput.focus(); } catch(_){} }, 100);
    }
  } catch (e) {
    console.error('[init] oda linki işlenirken hata:', e);
  }
})();
