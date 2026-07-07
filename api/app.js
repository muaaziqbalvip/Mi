// ============================================================
// MITV — Web App Layer (runs inside the Android WebView)
// Talks to native code via window.MITVPlayer / window.MITVApp
// (see MainActivity.kt, PlayerBridge.kt, AppBridge.kt)
//
// Firebase structure matches the existing MITV Admin Panel exactly:
//   /live_channels/{id}, /movies/{id}, /series/{seriesId}, /series/{seriesId}/episodes/{id}
//   /series_index/{seriesId}
//   /users/{uid}/profile   (isPro, proExpiresAt, displayName, phone...)
//   /app_config/update
//   /app_config/payment    (jazzcash, easypaisa, whatsapp numbers + price)
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyBbnU8DkthpYQMHOLLyj6M0cc05qXfjMcw",
  authDomain: "ramadan-2385b.firebaseapp.com",
  databaseURL: "https://ramadan-2385b-default-rtdb.firebaseio.com",
  projectId: "ramadan-2385b",
  storageBucket: "ramadan-2385b.firebasestorage.app",
  messagingSenderId: "882828936310",
  appId: "1:882828936310:web:7f97b921031fe130fe4b57"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

// ---------- In-memory content caches ----------
let liveChannels = {};
let movies = {};
let seriesIndex = {};
let seriesEpisodesCache = {}; // seriesId -> {episodeId: episode}
let paymentConfig = {};
let currentUserProfile = null;

// ---------- Player / navigation state ----------
let currentPlaylist = [];      // ordered list of items for next/prev in the current player context
let currentPlaylistIndex = -1;
let currentPlayingCategory = ''; // 'live' | 'movies' | 'series'
let isPlayerControlsVisible = true;
let controlsHideTimer = null;
let currentScalingMode = 'fit'; // fit | fill | zoom
let isSeekingByUser = false;
let pendingDetailItem = null;
let pendingDetailCategory = '';

// ============================================================
// BOOTSTRAP
// ============================================================
const SPLASH_DURATION_MS = 2000; // fixed splash time — never changes with data load speed

document.addEventListener('DOMContentLoaded', function () {
  const splashStart = Date.now();

  // Start listening for auth state immediately (does NOT delay the splash —
  // it just resolves in the background while the splash plays out).
  let authResolved = false;
  let resolvedUser = null;
  auth.onAuthStateChanged(function (user) {
    resolvedUser = user;
    authResolved = true;
  });

  // Splash always shows for exactly SPLASH_DURATION_MS, regardless of
  // network/auth/data speed — content loads in the background underneath it.
  function proceedPastSplash() {
    const elapsed = Date.now() - splashStart;
    const remaining = Math.max(0, SPLASH_DURATION_MS - elapsed);
    setTimeout(function () {
      if (resolvedUser) {
        loadUserProfile(resolvedUser).then(function () {
          showScreen('appShell', true);
          startContentListeners();
        });
      } else {
        showScreen('loginScreen');
      }
    }, remaining);
  }

  // Poll briefly for auth to resolve, but never hold the splash past the fixed duration.
  const authCheckInterval = setInterval(function () {
    if (authResolved) {
      clearInterval(authCheckInterval);
      proceedPastSplash();
    }
  }, 50);
  // Hard safety net: even if auth never responds, don't get stuck on splash forever.
  setTimeout(function () {
    clearInterval(authCheckInterval);
    if (!authResolved) proceedPastSplash();
  }, SPLASH_DURATION_MS + 3000);
});

function showScreen(screenId, isAppShell) {
  document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('active'); });
  if (isAppShell) {
    document.getElementById('appShell').classList.add('active');
  } else {
    document.getElementById(screenId).classList.add('active');
  }
}

// ============================================================
// AUTH — virtual accounts stored under /users/{uid}
// Firebase Auth (email/password) handles the credential layer;
// a matching profile node under /users/{uid}/profile stores
// name/phone/isPro etc. so the admin panel can manage it.
// ============================================================

function showSignup() {
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('signupForm').style.display = 'block';
  document.getElementById('authSubtitle').textContent = 'Create your MITV account';
}
function showLogin() {
  document.getElementById('signupForm').style.display = 'none';
  document.getElementById('loginForm').style.display = 'block';
  document.getElementById('authSubtitle').textContent = 'Sign in to continue watching';
}

/** Accepts either an email or a phone number and resolves it to the account's email. */
function resolveLoginEmail(identifier) {
  return new Promise(function (resolve) {
    if (identifier.indexOf('@') !== -1) {
      resolve(identifier.trim().toLowerCase());
      return;
    }
    // Phone login: look up the email by phone in a lightweight index.
    const phoneKey = normalizePhone(identifier);
    db.ref('phone_index/' + phoneKey).once('value').then(function (snap) {
      resolve(snap.val() || null);
    }).catch(function () { resolve(null); });
  });
}

function normalizePhone(phone) {
  return phone.replace(/[^0-9]/g, '');
}

function handleLogin() {
  const identifier = document.getElementById('loginIdentifier').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  errorEl.textContent = '';

  if (!identifier || !password) {
    errorEl.textContent = 'Please enter your email/phone and password.';
    return;
  }
  setLoginLoading(true);

  resolveLoginEmail(identifier).then(function (email) {
    if (!email) {
      setLoginLoading(false);
      errorEl.textContent = 'No account found with that phone number.';
      return;
    }
    auth.signInWithEmailAndPassword(email, password)
      .then(function () {
        setLoginLoading(false);
      })
      .catch(function (error) {
        setLoginLoading(false);
        errorEl.textContent = friendlyAuthError(error);
      });
  });
}

function handleSignup() {
  const name = document.getElementById('signupName').value.trim();
  const phone = document.getElementById('signupPhone').value.trim();
  const email = document.getElementById('signupEmail').value.trim().toLowerCase();
  const password = document.getElementById('signupPassword').value;
  const errorEl = document.getElementById('signupError');
  errorEl.textContent = '';

  if (!name || !phone || !email || !password) {
    errorEl.textContent = 'Please fill in all fields.';
    return;
  }
  if (password.length < 6) {
    errorEl.textContent = 'Password must be at least 6 characters.';
    return;
  }
  setSignupLoading(true);

  auth.createUserWithEmailAndPassword(email, password)
    .then(function (cred) {
      const uid = cred.user.uid;
      const profile = {
        uid: uid,
        displayName: name,
        email: email,
        phone: phone,
        isPro: false,
        proActivatedAt: 0,
        proExpiresAt: 0,
        createdAt: Date.now()
      };
      const updates = {};
      updates['users/' + uid + '/profile'] = profile;
      updates['phone_index/' + normalizePhone(phone)] = email;
      return db.ref().update(updates);
    })
    .then(function () {
      setSignupLoading(false);
    })
    .catch(function (error) {
      setSignupLoading(false);
      errorEl.textContent = friendlyAuthError(error);
    });
}

function friendlyAuthError(error) {
  switch (error.code) {
    case 'auth/user-not-found': return 'No account found with that email.';
    case 'auth/wrong-password': return 'Incorrect password.';
    case 'auth/invalid-email': return 'That email address looks invalid.';
    case 'auth/email-already-in-use': return 'An account already exists with that email.';
    case 'auth/weak-password': return 'Please choose a stronger password.';
    case 'auth/network-request-failed': return 'Network error. Check your connection.';
    default: return error.message || 'Something went wrong.';
  }
}

function setLoginLoading(loading) {
  document.getElementById('loginBtnText').style.display = loading ? 'none' : 'inline';
  document.getElementById('loginLoader').style.display = loading ? 'inline-block' : 'none';
  document.getElementById('loginBtn').style.opacity = loading ? '0.7' : '1';
}
function setSignupLoading(loading) {
  document.getElementById('signupBtnText').style.display = loading ? 'none' : 'inline';
  document.getElementById('signupLoader').style.display = loading ? 'inline-block' : 'none';
  document.getElementById('signupBtn').style.opacity = loading ? '0.7' : '1';
}

function handleLogout() {
  auth.signOut().then(function () {
    showScreen('loginScreen');
    showLogin();
  });
}

function loadUserProfile(user) {
  return db.ref('users/' + user.uid + '/profile').once('value').then(function (snap) {
    currentUserProfile = snap.val() || { uid: user.uid, email: user.email, displayName: 'User', isPro: false };
    renderAccountHeader();
  });
}

function renderAccountHeader() {
  if (!currentUserProfile) return;
  const name = currentUserProfile.displayName || 'User';
  document.getElementById('accountName').textContent = name;
  document.getElementById('accountEmail').textContent = currentUserProfile.email || '';
  document.getElementById('avatarInitial').textContent = name.charAt(0).toUpperCase();
  const chip = document.getElementById('accountProChip');
  const isPro = isProActive();
  chip.textContent = isPro ? 'PRO' : 'FREE';
  chip.className = isPro ? 'pro-chip' : 'free-chip';
}

function isProActive() {
  if (!currentUserProfile || !currentUserProfile.isPro) return false;
  if (!currentUserProfile.proExpiresAt) return true; // no expiry set = lifetime
  return currentUserProfile.proExpiresAt > Date.now();
}

// ============================================================
// NAVIGATION
// ============================================================
function switchPage(pageId) {
  document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
  document.getElementById(pageId).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(function (n) {
    n.classList.toggle('active', n.getAttribute('data-page') === pageId);
  });
  document.querySelector('.content-area').scrollTop = 0;
}

function openSearchGrid() {
  switchPage('moviesPage');
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(function () { toast.classList.remove('show'); }, 2200);
  if (window.MITVApp) { try { window.MITVApp.toast(message); } catch (e) {} }
}

// ============================================================
// FIREBASE CONTENT LISTENERS
// ============================================================
let contentLoadFlags = { live: false, movies: false, series: false, config: false };

function startContentListeners() {
  db.ref('live_channels').on('value', function (snap) {
    liveChannels = snap.val() || {};
    contentLoadFlags.live = true;
    renderGrid('live'); renderHome(); maybeHideLoading();
  });
  db.ref('movies').on('value', function (snap) {
    movies = snap.val() || {};
    contentLoadFlags.movies = true;
    renderGrid('movies'); renderHome(); maybeHideLoading();
  });
  db.ref('series_index').on('value', function (snap) {
    seriesIndex = snap.val() || {};
    contentLoadFlags.series = true;
    renderGrid('series'); renderHome(); maybeHideLoading();
  });
  db.ref('app_config/payment').on('value', function (snap) {
    paymentConfig = snap.val() || {};
    renderProPricing();
    contentLoadFlags.config = true;
    maybeHideLoading();
  });
  const user = auth.currentUser;
  if (user) {
    db.ref('users/' + user.uid + '/profile').on('value', function (snap) {
      currentUserProfile = snap.val() || currentUserProfile;
      renderAccountHeader();
    });
  }
  const appVersion = (window.MITVApp && window.MITVApp.getAppVersion) ? window.MITVApp.getAppVersion() : '2.0.0';
  document.getElementById('appVersionValue').textContent = 'v' + appVersion;
  document.getElementById('aboutVersion').textContent = appVersion;
}

function maybeHideLoading() {
  // Hide the full-screen loading overlay as soon as we have at least one
  // category back — the rest keep streaming in live via their own listeners;
  // a Netflix-style skeleton shimmer covers whatever hasn't arrived yet.
  if (contentLoadFlags.live || contentLoadFlags.movies || contentLoadFlags.series) {
    document.getElementById('loadingOverlay').classList.add('hidden');
  }
}

function renderProPricing() {
  const priceEl = document.getElementById('proPrice');
  if (priceEl && paymentConfig.price) priceEl.textContent = 'Rs. ' + paymentConfig.price;
}

// ============================================================
// RENDER: HOME (hero + rows)
// ============================================================
function renderHome() {
  renderHero();
  const rowsEl = document.getElementById('homeRows');
  let html = '';
  html += contentLoadFlags.live
    ? buildRow('Live TV', objToArray(liveChannels).filter(canView), 'live', false)
    : buildSkeletonRow('Live TV', 6);
  html += contentLoadFlags.movies
    ? buildRow('Movies', objToArray(movies).filter(canView), 'movies', true)
    : buildSkeletonRow('Movies', 5);
  html += contentLoadFlags.series
    ? buildRow('Series', objToArray(seriesIndex).filter(canView), 'series', true)
    : buildSkeletonRow('Series', 5);
  rowsEl.innerHTML = html;
}

function buildSkeletonRow(title, count) {
  let cards = '';
  for (let i = 0; i < count; i++) {
    cards += '<div class="card wide"><div class="card-thumb"></div><div class="card-title">&nbsp;</div></div>';
  }
  return '<div class="row-block skel-row"><div class="row-title">' + escapeHtml(title) + '</div><div class="row-scroll">' + cards + '</div></div>';
}

function renderHero() {
  const featured = objToArray(movies).concat(objToArray(seriesIndex)).filter(function (i) { return i.isFeatured; })[0];
  const heroEl = document.getElementById('heroContainer');
  if (!featured) { heroEl.innerHTML = ''; return; }
  const bg = featured.backdropUrl || featured.posterUrl || '';
  const cat = (featured.episodeCount !== undefined || featured.seasonNumber !== undefined) ? 'series' : 'movies';
  heroEl.innerHTML =
    '<div class="hero" style="background-image:url(\'' + escapeHtml(bg) + '\')">' +
      '<div class="hero-info">' +
        '<div class="hero-title">' + escapeHtml(featured.title || '') + '</div>' +
        '<div class="hero-actions">' +
          '<button class="hero-btn play" onclick="openDetailById(\'' + featured.id + '\',\'' + cat + '\')">&#9654; Play</button>' +
          '<button class="hero-btn info" onclick="openDetailById(\'' + featured.id + '\',\'' + cat + '\')">&#8505; Info</button>' +
        '</div>' +
      '</div>' +
    '</div>';
}

function buildRow(title, items, category, wide) {
  if (!items.length) return '';
  const cardsHtml = items.map(function (item) { return buildCard(item, category, wide); }).join('');
  return '<div class="row-block"><div class="row-title">' + escapeHtml(title) + '</div><div class="row-scroll">' + cardsHtml + '</div></div>';
}

function buildCard(item, category, wide) {
  const img = item.posterUrl || item.logoUrl || '';
  const isLive = category === 'live';
  const thumbClass = isLive ? 'card-thumb live' : 'card-thumb';
  const bgStyle = img ? ' style="background-image:url(\'' + escapeHtml(img) + '\')"' : '';
  const placeholderIcon = img ? '' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
  const liveBadge = isLive ? '<span class="badge live-badge">LIVE</span>' : '';
  const proBadge = (item.isFree === false) ? '<span class="badge pro-badge">PRO</span>' : '';
  const clickFn = isLive ? 'playItemDirect(\'' + item.id + '\',\'live\')' : 'openDetailById(\'' + item.id + '\',\'' + category + '\')';
  return (
    '<div class="card' + (wide ? ' wide' : '') + '" onclick="' + clickFn + '">' +
      '<div class="' + thumbClass + '"' + bgStyle + '>' + placeholderIcon + liveBadge + proBadge + '</div>' +
      '<div class="card-title">' + escapeHtml(item.title || 'Untitled') + '</div>' +
    '</div>'
  );
}

// ============================================================
// RENDER: GRID PAGES
// ============================================================
function renderGrid(kind, filterText) {
  filterText = (filterText || '').toLowerCase();
  const gridEl = document.getElementById(kind + 'Grid');
  if (!gridEl) return;

  if (!contentLoadFlags[kind]) {
    let skelCards = '';
    for (let i = 0; i < 9; i++) {
      skelCards += '<div class="card skel-row"><div class="card-thumb"></div><div class="card-title">&nbsp;</div></div>';
    }
    gridEl.innerHTML = skelCards;
    return;
  }

  let dataObj = kind === 'live' ? liveChannels : (kind === 'movies' ? movies : seriesIndex);
  const entries = objToArray(dataObj)
    .filter(canView)
    .filter(function (item) { return !filterText || (item.title || '').toLowerCase().indexOf(filterText) !== -1; })
    .sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });

  if (!entries.length) {
    gridEl.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><h3>No ' + kind + ' yet</h3><p>Check back soon.</p></div>';
    return;
  }
  gridEl.innerHTML = entries.map(function (item) { return buildCard(item, kind, false); }).join('');
}

// ============================================================
// HELPERS
// ============================================================
function objToArray(obj) {
  return Object.keys(obj || {}).map(function (id) { return Object.assign({ id: id }, obj[id]); });
}
function canView(item) {
  if (item.isFree === false && !isProActive()) return false;
  return true;
}
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
function formatTime(ms) {
  if (!ms || isNaN(ms)) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? (h + ':' + mm + ':' + ss) : (mm + ':' + ss);
}

// ============================================================
// DETAIL SCREEN — Movie / Series info page
// ============================================================
let currentDetailSeasons = {};
let currentDetailSelectedSeason = null;

function openDetailById(id, category) {
  const dataObj = category === 'movies' ? movies : seriesIndex;
  const item = Object.assign({ id: id }, dataObj[id]);
  if (!item) return;
  if (item.isFree === false && !isProActive()) {
    showToast('This is a Pro-only title. Upgrade to watch.');
    switchPage('buyProPage');
    return;
  }
  pendingDetailItem = item;
  pendingDetailCategory = category;

  document.getElementById('detailBackdrop').style.backgroundImage =
    'url(\'' + (item.backdropUrl || item.posterUrl || '') + '\')';
  document.getElementById('detailTitle').textContent = item.title || '';
  const metaParts = [];
  if (item.year) metaParts.push(item.year);
  if (item.rating) metaParts.push('star ' + item.rating);
  if (item.language) metaParts.push(item.language);
  if (category === 'series' && item.episodeCount) metaParts.push(item.episodeCount + ' episodes');
  document.getElementById('detailMeta').textContent = metaParts.join('  -  ');
  document.getElementById('detailDesc').textContent = item.description || '';

  const seasonBox = document.getElementById('seasonTabsContainer');
  if (category === 'series') {
    seasonBox.style.display = 'block';
    loadSeriesEpisodes(id);
  } else {
    seasonBox.style.display = 'none';
  }
  showScreen('detailScreen');
}

function closeDetail() {
  showScreen('appShell', true);
}

function loadSeriesEpisodes(seriesId) {
  document.getElementById('episodeList').innerHTML = '<div class="empty-state"><p>Loading episodes...</p></div>';
  db.ref('series/' + seriesId + '/episodes').once('value').then(function (snap) {
    const episodes = objToArray(snap.val() || {});
    seriesEpisodesCache[seriesId] = snap.val() || {};
    currentDetailSeasons = {};
    episodes.forEach(function (ep) {
      const sNum = ep.seasonNumber || 1;
      if (!currentDetailSeasons[sNum]) currentDetailSeasons[sNum] = [];
      currentDetailSeasons[sNum].push(ep);
    });
    Object.keys(currentDetailSeasons).forEach(function (sNum) {
      currentDetailSeasons[sNum].sort(function (a, b) { return (a.episodeNumber || 0) - (b.episodeNumber || 0); });
    });
    const seasonNums = Object.keys(currentDetailSeasons).map(Number).sort(function (a, b) { return a - b; });
    if (!seasonNums.length) {
      document.getElementById('seasonTabs').innerHTML = '';
      document.getElementById('episodeList').innerHTML = '<div class="empty-state"><p>No episodes yet.</p></div>';
      return;
    }
    currentDetailSelectedSeason = seasonNums[0];
    document.getElementById('seasonTabs').innerHTML = seasonNums.map(function (sNum) {
      return '<div class="season-tab' + (sNum === currentDetailSelectedSeason ? ' active' : '') +
        '" data-season="' + sNum + '" onclick="selectSeason(' + sNum + ')">Season ' + sNum + '</div>';
    }).join('');
    renderEpisodeList();
  });
}

function selectSeason(seasonNum) {
  currentDetailSelectedSeason = seasonNum;
  document.querySelectorAll('.season-tab').forEach(function (t) {
    t.classList.toggle('active', Number(t.getAttribute('data-season')) === seasonNum);
  });
  renderEpisodeList();
}

function renderEpisodeList() {
  const episodes = currentDetailSeasons[currentDetailSelectedSeason] || [];
  const listEl = document.getElementById('episodeList');
  listEl.innerHTML = episodes.map(function (ep) {
    const thumb = ep.posterUrl ? ' style="background-image:url(\'' + escapeHtml(ep.posterUrl) + '\')"' : '';
    return (
      '<div class="episode-item" onclick="playEpisode(\'' + ep.id + '\')">' +
        '<div class="episode-thumb"' + thumb + '></div>' +
        '<div class="episode-info">' +
          '<div class="episode-title">' + ep.episodeNumber + '. ' + escapeHtml(ep.title || '') + '</div>' +
          '<div class="episode-desc">' + escapeHtml(ep.description || '') + '</div>' +
        '</div>' +
      '</div>'
    );
  }).join('');
}

function playFromDetail() {
  if (!pendingDetailItem) return;
  if (pendingDetailCategory === 'series') {
    const episodes = currentDetailSeasons[currentDetailSelectedSeason] || [];
    if (episodes.length) {
      playEpisode(episodes[0].id);
    } else {
      showToast('No episodes available yet.');
    }
  } else {
    playItemDirect(pendingDetailItem.id, 'movies');
  }
}

function playEpisode(episodeId) {
  const seriesId = pendingDetailItem.id;
  const allEpisodes = objToArray(seriesEpisodesCache[seriesId] || {})
    .sort(function (a, b) {
      if ((a.seasonNumber || 0) !== (b.seasonNumber || 0)) return (a.seasonNumber || 0) - (b.seasonNumber || 0);
      return (a.episodeNumber || 0) - (b.episodeNumber || 0);
    });
  const idx = allEpisodes.findIndex(function (e) { return e.id === episodeId; });
  currentPlaylist = allEpisodes;
  currentPlaylistIndex = idx;
  currentPlayingCategory = 'series';
  const ep = allEpisodes[idx];
  launchPlayer(ep, 'S' + (ep.seasonNumber || 1) + ' E' + (ep.episodeNumber || 1) + ' - ' + (pendingDetailItem.title || ''));
}

function playItemDirect(id, category) {
  const dataObj = category === 'live' ? liveChannels : movies;
  const item = Object.assign({ id: id }, dataObj[id]);
  if (item.isFree === false && !isProActive()) {
    showToast('This is a Pro-only title. Upgrade to watch.');
    switchPage('buyProPage');
    return;
  }
  const list = objToArray(dataObj).filter(canView).sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });
  currentPlaylist = list;
  currentPlaylistIndex = list.findIndex(function (i) { return i.id === id; });
  currentPlayingCategory = category;
  launchPlayer(item, item.groupTitle || '');
}

// ============================================================
// PLAYER — controls the native ExoPlayer through window.MITVPlayer
// ============================================================
function launchPlayer(item, subtitle) {
  if (!item || !item.streamUrl) {
    showToast('This item has no playable stream yet.');
    return;
  }
  showScreen('playerScreen');
  document.getElementById('playerTitle').textContent = item.title || '';
  document.getElementById('playerSub').textContent = subtitle || '';
  document.getElementById('liveIndicatorRow').style.display = (currentPlayingCategory === 'live') ? 'block' : 'none';
  document.getElementById('seekRow').style.display = (currentPlayingCategory === 'live') ? 'none' : 'flex';
  document.getElementById('bufferingSpinner').style.display = 'block';
  showPlayerControls();

  if (window.MITVPlayer) {
    window.MITVPlayer.play(item.streamUrl, 0);
  }
  updatePlayerHoleRect();
  renderPlayerPanelList('');
}

function closePlayer() {
  if (window.MITVPlayer) window.MITVPlayer.stop();
  showScreen('appShell', true);
  clearTimeout(controlsHideTimer);
}

function togglePlayPause(evt) {
  if (evt) evt.stopPropagation();
  if (!window.MITVPlayer) return;
  const playing = window.MITVPlayer.isPlaying();
  if (playing) {
    window.MITVPlayer.pause();
    document.getElementById('playPauseBtn').innerHTML = '&#9654;';
  } else {
    window.MITVPlayer.resume();
    document.getElementById('playPauseBtn').innerHTML = '&#10074;&#10074;';
  }
  resetControlsHideTimer();
}

function playerNext(evt) {
  if (evt) evt.stopPropagation();
  if (currentPlaylistIndex < currentPlaylist.length - 1) {
    currentPlaylistIndex++;
    const item = currentPlaylist[currentPlaylistIndex];
    const subtitle = currentPlayingCategory === 'series'
      ? 'S' + (item.seasonNumber || 1) + ' E' + (item.episodeNumber || 1)
      : (item.groupTitle || '');
    launchPlayer(item, subtitle);
  } else {
    showToast('This is the last item.');
  }
  resetControlsHideTimer();
}

function playerPrev(evt) {
  if (evt) evt.stopPropagation();
  if (currentPlaylistIndex > 0) {
    currentPlaylistIndex--;
    const item = currentPlaylist[currentPlaylistIndex];
    const subtitle = currentPlayingCategory === 'series'
      ? 'S' + (item.seasonNumber || 1) + ' E' + (item.episodeNumber || 1)
      : (item.groupTitle || '');
    launchPlayer(item, subtitle);
  } else {
    showToast('This is the first item.');
  }
  resetControlsHideTimer();
}

function togglePlayerControls() {
  if (isPlayerControlsVisible) {
    hidePlayerControls();
  } else {
    showPlayerControls();
  }
}

function showPlayerControls() {
  document.getElementById('playerControls').classList.remove('hidden');
  isPlayerControlsVisible = true;
  resetControlsHideTimer();
}
function hidePlayerControls() {
  document.getElementById('playerControls').classList.add('hidden');
  isPlayerControlsVisible = false;
  clearTimeout(controlsHideTimer);
}
function resetControlsHideTimer() {
  clearTimeout(controlsHideTimer);
  controlsHideTimer = setTimeout(function () {
    if (currentPlayingCategory !== 'live' || true) hidePlayerControls();
  }, 4500);
}

function onSeekInput(value) {
  isSeekingByUser = true;
  const duration = window.MITVPlayer ? window.MITVPlayer.getDuration() : 0;
  const pos = (value / 100) * duration;
  document.getElementById('timeCurrent').textContent = formatTime(pos);
  resetControlsHideTimer();
}

function cyclePlayerScaling(inPlayer) {
  const modes = ['fit', 'fill', 'zoom'];
  const idx = modes.indexOf(currentScalingMode);
  currentScalingMode = modes[(idx + 1) % modes.length];
  const label = currentScalingMode.charAt(0).toUpperCase() + currentScalingMode.slice(1);
  const scalingValueEl = document.getElementById('scalingValue');
  if (scalingValueEl) scalingValueEl.textContent = label;
  if (inPlayer) showToast('Scaling: ' + label);
  resetControlsHideTimer();
}

/** Reports the current on-screen rect of the video hole to native code so
    ExoPlayer's surface lines up with it (in CSS px; the bridge scales to device px). */
function updatePlayerHoleRect() {
  const hole = document.getElementById('videoHole');
  if (!hole || !window.MITVPlayer) return;
  const rect = hole.getBoundingClientRect();
  window.MITVPlayer.resizeFrame(rect.left, rect.top, rect.width, rect.height);
}
window.addEventListener('resize', updatePlayerHoleRect);

// ============================================================
// NATIVE -> JS EVENT BRIDGE (called from PlayerBridge.kt)
// ============================================================
window.onMitvPlayerEvent = function (eventName, jsonDataString) {
  let data = {};
  try { data = JSON.parse(jsonDataString); } catch (e) {}

  switch (eventName) {
    case 'ready':
      document.getElementById('bufferingSpinner').style.display = 'none';
      document.getElementById('timeDuration').textContent = formatTime(data.duration || 0);
      break;
    case 'buffering':
      document.getElementById('bufferingSpinner').style.display = 'block';
      break;
    case 'ended':
      if (currentPlayingCategory !== 'live') playerNext();
      break;
    case 'error':
      showToast('Playback error: ' + (data.message || 'unknown'));
      document.getElementById('bufferingSpinner').style.display = 'none';
      break;
    case 'playingChanged':
      document.getElementById('playPauseBtn').innerHTML = data.isPlaying ? '&#10074;&#10074;' : '&#9654;';
      break;
    case 'progress':
      if (!isSeekingByUser) {
        const duration = data.duration || 1;
        const pct = duration > 0 ? (data.position / duration) * 100 : 0;
        document.getElementById('seekBar').value = pct;
        document.getElementById('timeCurrent').textContent = formatTime(data.position || 0);
        document.getElementById('timeDuration').textContent = formatTime(data.duration || 0);
      }
      break;
  }
};

/** Called from MainActivity's onKeyDown when the hardware back button is pressed. */
window.onNativeBackPressed = function () {
  const playerScreen = document.getElementById('playerScreen');
  if (playerScreen.classList.contains('active')) {
    closePlayer();
    return true;
  }
  const detailScreen = document.getElementById('detailScreen');
  if (detailScreen.classList.contains('active')) {
    closeDetail();
    return true;
  }
  const panel = document.getElementById('playerPanel');
  if (panel.classList.contains('active')) {
    closePlayerPanel();
    return true;
  }
  const homePage = document.getElementById('homePage');
  if (document.getElementById('appShell').classList.contains('active') && !homePage.classList.contains('active')) {
    switchPage('homePage');
    return true;
  }
  return false; // let native handle it (usually exits the app)
};

window.onAppPaused = function () {
  if (window.MITVPlayer && document.getElementById('playerScreen').classList.contains('active')) {
    window.MITVPlayer.pause();
  }
};
window.onAppResumed = function () {};

// ============================================================
// PLAYER SIDE PANEL — quick channel/movie switcher inside the player
// ============================================================
function openPlayerPanel() {
  document.getElementById('playerPanel').classList.add('active');
  resetControlsHideTimer();
}
function closePlayerPanel() {
  document.getElementById('playerPanel').classList.remove('active');
}
function renderPlayerPanelList(filterText) {
  filterText = (filterText || '').toLowerCase();
  const listEl = document.getElementById('playerPanelList');
  const items = currentPlaylist.filter(function (i) {
    return !filterText || (i.title || '').toLowerCase().indexOf(filterText) !== -1;
  });
  listEl.innerHTML = items.map(function (item) {
    const idx = currentPlaylist.indexOf(item);
    const isActive = idx === currentPlaylistIndex;
    const logo = item.logoUrl || item.posterUrl || '';
    const logoStyle = logo ? ' style="background-image:url(\'' + escapeHtml(logo) + '\')"' : '';
    return (
      '<div class="panel-channel-item' + (isActive ? ' active' : '') + '" onclick="jumpToPlaylistIndex(' + idx + ')">' +
        '<div class="panel-channel-logo"' + logoStyle + '></div>' +
        '<div class="panel-channel-name">' + escapeHtml(item.title || '') + '</div>' +
      '</div>'
    );
  }).join('');
}
function jumpToPlaylistIndex(idx) {
  currentPlaylistIndex = idx;
  const item = currentPlaylist[idx];
  const subtitle = currentPlayingCategory === 'series'
    ? 'S' + (item.seasonNumber || 1) + ' E' + (item.episodeNumber || 1)
    : (item.groupTitle || '');
  launchPlayer(item, subtitle);
  closePlayerPanel();
}

// ============================================================
// SETTINGS PAGE
// ============================================================
let appSettings = { autoplay: true };

function toggleSetting(key) {
  appSettings[key] = !appSettings[key];
  if (key === 'autoplay') {
    document.getElementById('autoplayValue').textContent = appSettings.autoplay ? 'On' : 'Off';
  }
  showToast((appSettings[key] ? 'Enabled' : 'Disabled') + ' ' + key);
}

function showAbout() {
  document.getElementById('aboutModalOverlay').classList.add('active');
}
function closeAboutModal() {
  document.getElementById('aboutModalOverlay').classList.remove('active');
}
function closeAboutModalBg(evt) {
  if (evt.target.id === 'aboutModalOverlay') closeAboutModal();
}

// ============================================================
// BUY PRO — payment detail modals (JazzCash / EasyPaisa / WhatsApp)
// Numbers come from /app_config/payment written by the admin panel.
// ============================================================
function openPayModal(method) {
  const overlay = document.getElementById('payModalOverlay');
  const titleEl = document.getElementById('payModalTitle');
  const bodyEl = document.getElementById('payModalBody');

  if (method === 'jazzcash') {
    titleEl.textContent = 'Pay via JazzCash';
    bodyEl.innerHTML = buildPayInstructions(paymentConfig.jazzcash, 'JazzCash Number');
  } else if (method === 'easypaisa') {
    titleEl.textContent = 'Pay via EasyPaisa';
    bodyEl.innerHTML = buildPayInstructions(paymentConfig.easypaisa, 'EasyPaisa Number');
  } else if (method === 'whatsapp') {
    titleEl.textContent = 'Contact on WhatsApp';
    const wa = paymentConfig.whatsapp || '';
    bodyEl.innerHTML =
      '<div class="copy-field"><span>' + escapeHtml(wa || 'Not set yet') + '</span>' +
      (wa ? '<button onclick="copyToClipboard(\'' + escapeHtml(wa) + '\')">Copy</button>' : '') + '</div>' +
      (wa ? '<button class="btn btn-primary" style="margin-top:10px;" onclick="openWhatsApp(\'' + escapeHtml(wa) + '\')">Open WhatsApp</button>' : '');
  }
  overlay.classList.add('active');
}

function buildPayInstructions(number, label) {
  if (!number) {
    return '<p style="color:var(--text-dim);font-size:13px;">Payment details are not set up yet. Please try WhatsApp instead.</p>';
  }
  return (
    '<div class="copy-field"><span>' + escapeHtml(number) + '</span><button onclick="copyToClipboard(\'' + escapeHtml(number) + '\')">Copy</button></div>' +
    '<p style="color:var(--text-dim);font-size:13px;line-height:1.6;margin-top:8px;">' +
    'Send Rs. ' + escapeHtml(String(paymentConfig.price || '—')) + ' to the ' + label + ' above, then message us on WhatsApp with your payment screenshot to activate Pro.' +
    '</p>'
  );
}

function copyToClipboard(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); showToast('Copied to clipboard'); } catch (e) {}
  document.body.removeChild(ta);
}

function openWhatsApp(number) {
  const clean = number.replace(/[^0-9]/g, '');
  window.location.href = 'https://wa.me/' + clean;
}

function closePayModal() {
  document.getElementById('payModalOverlay').classList.remove('active');
}
function closePayModalBg(evt) {
  if (evt.target.id === 'payModalOverlay') closePayModal();
}
