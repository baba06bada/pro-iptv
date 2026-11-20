/* ==========================================================================
   js/app.js - Pro IPTV Player Main Application Brain (LG webOS 2.2.3)
   Strict ES5 - Virtual Windowing, EPG + Time-Shift, Parental PIN,
   Clean Live Info OSD, Interactive VOD/Series Seek Bar, Quick Channel Drawer,
   Resume Playback, Auto-Next Episode, In-Player Episodes Picker, Recall,
   Sleep Timer, Account Info & TV Mode Startup
   ========================================================================== */

(function () {
  'use strict';

  // Virtual DOM pool capacities (tuned for 3-meter large TV readability + zero DOM bloat)
  var CAT_VISIBLE_COUNT = 11;
  var CH_VISIBLE_COUNT = 11;
  var DRAWER_VISIBLE_COUNT = 11;
  var GRID_COLS = 4;
  var GRID_ROWS = 2;
  var GRID_VISIBLE_COUNT = GRID_COLS * GRID_ROWS; // 8 large cinema poster DOM nodes max
  var DETAIL_EP_VISIBLE = 5;
  var MODAL_EP_VISIBLE = 6;

  // Inline SVG fallback logo for channels whose logo fails to load
  var FALLBACK_CH_LOGO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 36'%3E%3Crect width='48' height='36' rx='4' fill='%23122038'/%3E%3Crect x='11' y='8' width='26' height='16' rx='2' fill='none' stroke='%2300a8ff' stroke-width='2'/%3E%3Cpath d='M18 28h12M24 24v4' stroke='%2300a8ff' stroke-width='2'/%3E%3C/svg%3E";

  var app = {
    screen: 'manager',      // 'manager' | 'dashboard'
    section: 'live',        // 'live' | 'vod' | 'series' | 'favorites' | 'recent' | 'search' | 'settings'
    inDetail: false,
    inFullscreen: false,
    osdVisible: false,
    drawerOpen: false,
    activeModal: null,      // 'pin' | 'tracks' | 'exit' | 'resume' | 'episodes'

    activeProfile: null,
    editingProfileId: null,
    managerTab: 'xtream',
    hasDoneStartupAutoplay: false,

    data: {
      sourceType: 'demo',
      xtreamConfig: null,
      accountInfo: null,
      liveCategories: [],
      liveChannels: [],
      vodCategories: [],
      vodItems: [],
      seriesCategories: [],
      seriesItems: []
    },

    // Live TV virtual list state
    liveCatList: [],
    liveCatStart: 0,
    liveSelectedCatKey: '__ALL__',
    liveFilteredChannels: [],
    liveChStart: 0,
    liveFocusedChIndex: 0,
    livePlayingChannel: null,
    previousLiveChannel: null,
    livePreviewTimer: null,
    liveCatNodes: [],
    liveChNodes: [],

    // Fullscreen quick channel drawer state
    drawerStart: 0,
    drawerNodes: [],

    // Media (VOD / Series) virtual grid state
    mediaMode: 'vod', // 'vod' | 'series'
    mediaCatList: [],
    mediaCatStart: 0,
    mediaSelectedCat: '__ALL__',
    mediaFilteredItems: [],
    mediaRowStart: 0,
    mediaCatNodes: [],
    mediaGridNodes: [],

    // Detail state
    detailItem: null,
    detailReturnSection: 'vod',
    detailSeasonKey: '1',
    detailEpisodes: [],
    detailEpStart: 0,

    // Active Series playback context & in-player episodes modal
    currentSeriesCtx: null, // { seriesItem, seasonKey, episodes, epIndex }
    epModalSeasonKey: '1',
    epModalEpisodes: [],
    epModalStart: 0,

    // Resume playback & Auto-Next episode state
    pendingResumeData: null, // { mediaObj, seriesCtx, savedPos }
    lastSavedProgressTs: 0,
    nextEpVisible: false,
    nextEpDismissed: false,
    nextEpTarget: null,

    // Sleep timer state
    sleepMinutes: 0,
    sleepEndTs: 0,
    sleepInterval: null,

    // Search state
    searchFilter: 'all',
    searchResults: [],

    // Parental PIN state
    pinBuffer: '',
    pinMode: 'verify', // 'verify' | 'change'
    pinSuccessCallback: null,
    unlockedCategories: {},

    // OSD, Zap & Timers
    osdTimer: null,
    zapTimer: null,
    digitBuffer: '',
    digitTimer: null,
    toastTimer: null,
    epgCache: {},
    currentEpg: null,

    // Viewport scale & touch drag suppression
    viewportScale: 1,
    suppressClickUntil: 0
  };

  /* ========================================================================
     DOM & FORMATTING HELPERS (PURE ES5)
     ======================================================================== */

  function $(id) {
    return document.getElementById(id);
  }

  // Responsive viewport scaler: 100% native 1920x1080 (transform: none) on LG webOS TV;
  // automatically fits and centers cleanly on any PC browser window or iPhone screen.
  function applyViewportScale() {
    var root = $('app-root');
    if (!root) { return; }
    var vw = window.innerWidth || document.documentElement.clientWidth || 1920;
    var vh = window.innerHeight || document.documentElement.clientHeight || 1080;
    var isNativeTV = (Math.abs(vw - 1920) <= 2 && Math.abs(vh - 1080) <= 2);
    if (isNativeTV) {
      app.viewportScale = 1;
      root.style.webkitTransform = 'none';
      root.style.transform = 'none';
      root.style.left = '0px';
      root.style.top = '0px';
      return;
    }
    var scale = Math.min(vw / 1920, vh / 1080);
    if (!scale || !isFinite(scale) || scale <= 0) { scale = 1; }
    app.viewportScale = scale;
    var offsetX = Math.floor((vw - 1920 * scale) / 2);
    var offsetY = Math.floor((vh - 1080 * scale) / 2);
    if (offsetX < 0) { offsetX = 0; }
    if (offsetY < 0) { offsetY = 0; }
    root.style.left = offsetX + 'px';
    root.style.top = offsetY + 'px';
    var tf = 'scale(' + scale.toFixed(5) + ')';
    root.style.webkitTransform = tf;
    root.style.transform = tf;
  }

  // Feature-detect addEventListener passive option (pure ES5, safe on WebKit 538.2 & iOS Safari)
  var _passiveOptionSupported = null;
  function getNonPassiveListenerOpts() {
    if (_passiveOptionSupported === null) {
      _passiveOptionSupported = false;
      try {
        var opts = Object.defineProperty({}, 'passive', {
          get: function () {
            _passiveOptionSupported = true;
            return false;
          }
        });
        window.addEventListener('testpassive', null, opts);
        window.removeEventListener('testpassive', null, opts);
      } catch (e) {
        _passiveOptionSupported = false;
      }
    }
    return _passiveOptionSupported ? { passive: false } : false;
  }

  function isClickSuppressed() {
    return (new Date().getTime()) < app.suppressClickUntil;
  }

  // Touch swipe (iPhone/Android/touchscreens) + Mouse / LG Magic Remote wheel scroll for virtualized pools
  function bindVirtualScroll(containerEl, logicalStepPx, onStepDelta) {
    if (!containerEl || typeof onStepDelta !== 'function') { return; }

    var startY = 0;
    var lastY = 0;
    var accumY = 0;
    var isDragging = false;
    var listenerOpts = getNonPassiveListenerOpts();

    containerEl.addEventListener('touchstart', function (e) {
      if (!e.touches || e.touches.length !== 1) { return; }
      startY = e.touches[0].clientY;
      lastY = startY;
      accumY = 0;
      isDragging = false;
    }, listenerOpts);

    containerEl.addEventListener('touchmove', function (e) {
      if (!e.touches || e.touches.length !== 1) { return; }
      var y = e.touches[0].clientY;
      var dy = y - lastY;
      lastY = y;

      if (!isDragging && Math.abs(y - startY) > 10) {
        isDragging = true;
      }
      if (isDragging) {
        if (e.cancelable !== false && e.preventDefault) {
          e.preventDefault();
        }
        app.suppressClickUntil = new Date().getTime() + 260;
        accumY += dy;

        var scale = app.viewportScale || 1;
        var stepPx = Math.max(14, Math.round((logicalStepPx || 72) * scale));
        var steps = 0;
        while (accumY <= -stepPx) {
          steps += 1;
          accumY += stepPx;
        }
        while (accumY >= stepPx) {
          steps -= 1;
          accumY -= stepPx;
        }
        if (steps !== 0) {
          onStepDelta(steps);
        }
      }
    }, listenerOpts);

    containerEl.addEventListener('touchend', function () {
      if (isDragging) {
        app.suppressClickUntil = new Date().getTime() + 260;
      }
      isDragging = false;
      accumY = 0;
    }, false);

    function handleWheel(e) {
      var deltaY = (typeof e.deltaY === 'number') ? e.deltaY : (typeof e.wheelDelta === 'number' ? -e.wheelDelta : 0);
      if (deltaY === 0) { return; }
      if (e.preventDefault) { e.preventDefault(); }
      var dir = deltaY > 0 ? 1 : -1;
      onStepDelta(dir);
    }

    if ('onwheel' in document) {
      containerEl.addEventListener('wheel', handleWheel, listenerOpts);
    } else {
      containerEl.addEventListener('mousewheel', handleWheel, false);
    }
  }

  function showEl(el) {
    if (typeof el === 'string') { el = $(el); }
    if (!el) { return; }
    el.className = (' ' + el.className + ' ').replace(' is-hidden ', ' ').replace(/^\s+|\s+$/g, '');
  }

  function hideEl(el) {
    if (typeof el === 'string') { el = $(el); }
    if (!el) { return; }
    if ((' ' + el.className + ' ').indexOf(' is-hidden ') === -1) {
      el.className = el.className ? (el.className + ' is-hidden') : 'is-hidden';
    }
  }

  function setClassFlag(el, cls, flag) {
    if (!el) { return; }
    var has = (' ' + el.className + ' ').indexOf(' ' + cls + ' ') !== -1;
    if (flag && !has) {
      el.className = el.className ? (el.className + ' ' + cls) : cls;
    } else if (!flag && has) {
      el.className = (' ' + el.className + ' ').replace(' ' + cls + ' ', ' ').replace(/^\s+|\s+$/g, '');
    }
  }

  function pad2(n) {
    return n < 10 ? ('0' + n) : String(n);
  }

  function pad3(n) {
    if (n < 10) { return '00' + n; }
    if (n < 100) { return '0' + n; }
    return String(n);
  }

  function formatClock(dateObj) {
    return pad2(dateObj.getHours()) + ':' + pad2(dateObj.getMinutes());
  }

  function formatDateTR(dateObj) {
    var days = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
    var months = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
    return days[dateObj.getDay()] + ', ' + pad2(dateObj.getDate()) + ' ' + months[dateObj.getMonth()];
  }

  function formatShortDateTR(ts) {
    if (!ts) { return '-'; }
    var d = new Date(ts);
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
  }

  function formatTimeSec(sec) {
    if (!sec || isNaN(sec) || !isFinite(sec) || sec < 0) { return '00:00'; }
    var s = Math.floor(sec);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    if (h > 0) {
      return pad2(h) + ':' + pad2(m) + ':' + pad2(r);
    }
    return pad2(m) + ':' + pad2(r);
  }

  function getEpgOffsetMs() {
    var s = IPTVStorage.getSettings();
    return (s.epgOffsetHours || 0) * 3600000;
  }

  function formatTsHM(ts) {
    if (!ts) { return '--:--'; }
    var d = new Date(ts + getEpgOffsetMs());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function calcEpgPercent(epgNow) {
    if (!epgNow || !epgNow.startTs || !epgNow.stopTs) { return 0; }
    var offset = getEpgOffsetMs();
    var now = new Date().getTime();
    var start = epgNow.startTs + offset;
    var stop = epgNow.stopTs + offset;
    var total = stop - start;
    if (total <= 0) { return 0; }
    var pct = Math.floor(((now - start) / total) * 100);
    if (pct < 0) { pct = 0; }
    if (pct > 100) { pct = 100; }
    return pct;
  }

  function calcEpgRemainingText(epgNow) {
    if (!epgNow || !epgNow.stopTs) { return ''; }
    var stop = epgNow.stopTs + getEpgOffsetMs();
    var diffMin = Math.ceil((stop - new Date().getTime()) / 60000);
    if (diffMin <= 0) { return 'Sona eriyor'; }
    return diffMin + ' dk kaldı';
  }

  function showToast(msg, type) {
    var box = $('toast-box');
    box.textContent = msg;
    box.className = 'toast-box' + (type ? (' toast-' + type) : '');
    if (app.toastTimer) { window.clearTimeout(app.toastTimer); }
    app.toastTimer = window.setTimeout(function () {
      hideEl(box);
    }, 3600);
  }

  function setLoading(visible, statusText, percent) {
    if (visible) {
      $('loading-status').textContent = statusText || 'Yükleniyor...';
      $('loading-bar-fill').style.width = (percent || 15) + '%';
      showEl('screen-loading');
    } else {
      hideEl('screen-loading');
    }
  }

  function getObjectKeys(obj) {
    var keys = [];
    if (!obj) { return keys; }
    for (var k in obj) {
      if (obj.hasOwnProperty(k)) {
        keys.push(k);
      }
    }
    return keys;
  }

  /* ========================================================================
     CLOCK, EPG TICKER & SLEEP TIMER
     ======================================================================== */

  function updateClocks() {
    var now = new Date();
    var c = formatClock(now);
    var d = formatDateTR(now);
    $('manager-clock').textContent = c;
    $('manager-date').textContent = d;
    $('dash-clock').textContent = c;
    $('dash-date').textContent = d;
    $('osd-clock').textContent = c;
    $('live-osd-clock').textContent = c;

    if (app.screen === 'dashboard' && app.section === 'live' && app.currentEpg) {
      renderEpgProgressOnly(app.currentEpg);
    }
    if (app.inFullscreen && app.osdVisible && IPTVPlayer.isLive() && app.livePlayingChannel) {
      renderLiveOsdEpg(app.livePlayingChannel);
    }
  }

  function getSleepRemainingMin() {
    if (!app.sleepEndTs) { return 0; }
    var diff = app.sleepEndTs - new Date().getTime();
    if (diff <= 0) { return 0; }
    return Math.ceil(diff / 60000);
  }

  function updateSleepTimerUI() {
    var rem = getSleepRemainingMin();
    var label = rem > 0 ? (rem + ' dk') : 'KAPALI';
    var btnLabel = rem > 0 ? ('Uyku: ' + rem + 'dk') : 'Uyku: Kapalı';
    var badgeText = 'UYKU: ' + rem + 'dk';

    if ($('val-sleep')) { $('val-sleep').textContent = label; }
    if ($('losd-btn-sleep')) { $('losd-btn-sleep').textContent = btnLabel; }
    if ($('osd-btn-sleep')) { $('osd-btn-sleep').textContent = btnLabel; }

    if (rem > 0) {
      if ($('live-osd-sleep-badge')) {
        $('live-osd-sleep-badge').textContent = badgeText;
        showEl('live-osd-sleep-badge');
      }
      if ($('osd-sleep-badge')) {
        $('osd-sleep-badge').textContent = badgeText;
        showEl('osd-sleep-badge');
      }
    } else {
      hideEl('live-osd-sleep-badge');
      hideEl('osd-sleep-badge');
    }
  }

  function checkSleepTimerTick() {
    if (!app.sleepEndTs) { return; }
    if (new Date().getTime() >= app.sleepEndTs) {
      app.sleepEndTs = 0;
      app.sleepMinutes = 0;
      if (app.sleepInterval) {
        window.clearInterval(app.sleepInterval);
        app.sleepInterval = null;
      }
      saveCurrentMediaProgress(true);
      IPTVPlayer.stop();
      app.livePlayingChannel = null;
      if (app.inFullscreen) {
        exitFullscreen();
      } else {
        showEl('preview-idle');
      }
      updateSleepTimerUI();
      showToast('Uyku zamanlayıcısı doldu, yayın durduruldu.', 'warn');
      return;
    }
    updateSleepTimerUI();
  }

  function cycleSleepTimer() {
    var steps = [0, 30, 60, 90, 120];
    var idx = steps.indexOf(app.sleepMinutes);
    var nextMin = steps[(idx + 1) % steps.length];
    app.sleepMinutes = nextMin;

    if (app.sleepInterval) {
      window.clearInterval(app.sleepInterval);
      app.sleepInterval = null;
    }

    if (nextMin > 0) {
      app.sleepEndTs = new Date().getTime() + nextMin * 60000;
      app.sleepInterval = window.setInterval(checkSleepTimerTick, 20000);
      showToast('Uyku zamanlayıcısı: ' + nextMin + ' dakika ayarlandı.');
    } else {
      app.sleepEndTs = 0;
      showToast('Uyku zamanlayıcısı kapatıldı.');
    }
    updateSleepTimerUI();
  }

  /* ========================================================================
     ACCOUNT / PLAYLIST MANAGER
     ======================================================================== */

  function openManagerScreen() {
    if (app.livePreviewTimer) {
      window.clearTimeout(app.livePreviewTimer);
      app.livePreviewTimer = null;
    }
    saveCurrentMediaProgress(true);
    closeChannelDrawer();
    hideNextEpCard(true);
    app.livePlayingChannel = null;
    app.currentSeriesCtx = null;
    IPTVPlayer.stop();
    app.inFullscreen = false;
    app.inDetail = false;
    hideEl('fullscreen-stage');
    hideEl('screen-dashboard');
    showEl('screen-manager');
    app.screen = 'manager';
    renderProfileList();
    setManagerTab(app.managerTab);
    if ($('inp-cors-proxy')) {
      $('inp-cors-proxy').value = IPTVStorage.getSettings().corsProxy || '';
    }
    window.setTimeout(function () {
      var list = IPTVStorage.getProfiles();
      if (list.length > 0) {
        SpatNav.focusFirstIn('profile-list');
      } else {
        SpatNav.focus('btn-load-demo');
      }
    }, 30);
  }

  function setManagerTab(tab) {
    app.managerTab = tab;
    setClassFlag($('tab-xtream'), 'is-active', tab === 'xtream');
    setClassFlag($('tab-m3u'), 'is-active', tab === 'm3u');
    if (tab === 'xtream') {
      showEl('form-xtream');
      hideEl('form-m3u');
    } else {
      hideEl('form-xtream');
      showEl('form-m3u');
    }
  }

  function resetManagerForm() {
    app.editingProfileId = null;
    $('form-title').textContent = 'Yeni Hesap / Liste Ekle';
    $('inp-xt-name').value = '';
    $('inp-xt-url').value = '';
    $('inp-xt-user').value = '';
    $('inp-xt-pass').value = '';
    $('inp-m3u-name').value = '';
    $('inp-m3u-url').value = '';
    hideEl('btn-cancel-edit');
  }

  function startEditProfile(profile) {
    app.editingProfileId = profile.id;
    $('form-title').textContent = 'Profili Düzenle: ' + profile.name;
    showEl('btn-cancel-edit');
    if (profile.type === 'xtream') {
      setManagerTab('xtream');
      $('inp-xt-name').value = profile.name || '';
      $('inp-xt-url').value = profile.serverUrl || '';
      $('inp-xt-user').value = profile.username || '';
      $('inp-xt-pass').value = profile.password || '';
      SpatNav.focus('inp-xt-name');
    } else {
      setManagerTab('m3u');
      $('inp-m3u-name').value = profile.name || '';
      $('inp-m3u-url').value = profile.url || '';
      SpatNav.focus('inp-m3u-name');
    }
  }

  function collectFormProfile() {
    if (app.managerTab === 'xtream') {
      var xName = $('inp-xt-name').value.replace(/^\s+|\s+$/g, '');
      var xUrl = $('inp-xt-url').value.replace(/^\s+|\s+$/g, '');
      var xUser = $('inp-xt-user').value.replace(/^\s+|\s+$/g, '');
      var xPass = $('inp-xt-pass').value.replace(/^\s+|\s+$/g, '');
      if (!xUrl || !xUser || !xPass) {
        showToast('Lütfen Sunucu URL, Kullanıcı Adı ve Şifre alanlarını doldurun.', 'warn');
        return null;
      }
      return {
        id: app.editingProfileId || null,
        type: 'xtream',
        name: xName || ('Xtream - ' + xUser),
        serverUrl: xUrl,
        username: xUser,
        password: xPass
      };
    }
    var mName = $('inp-m3u-name').value.replace(/^\s+|\s+$/g, '');
    var mUrl = $('inp-m3u-url').value.replace(/^\s+|\s+$/g, '');
    if (!mUrl) {
      showToast('Lütfen geçerli bir M3U/M3U8 bağlantısı girin.', 'warn');
      return null;
    }
    return {
      id: app.editingProfileId || null,
      type: 'm3u',
      name: mName || 'M3U Yayın Listesi',
      url: mUrl
    };
  }

  function renderProfileList() {
    var container = $('profile-list');
    container.innerHTML = '';
    var profiles = IPTVStorage.getProfiles();
    if (profiles.length === 0) {
      showEl('profile-list-empty');
      return;
    }
    hideEl('profile-list-empty');

    var activeId = IPTVStorage.getActiveProfile() ? IPTVStorage.getActiveProfile().id : null;

    for (var i = 0; i < profiles.length && i < 4; i++) {
      (function (prof) {
        var card = document.createElement('div');
        card.className = 'profile-card';

        var top = document.createElement('div');
        top.className = 'profile-card-top';
        var titleEl = document.createElement('div');
        titleEl.className = 'profile-card-name';
        titleEl.textContent = (prof.id === activeId ? '★ ' : '') + prof.name;
        var typeEl = document.createElement('div');
        typeEl.className = 'profile-card-type';
        typeEl.textContent = prof.type === 'xtream' ? 'XTREAM API' : (prof.type === 'demo' ? 'DEMO LİSTE' : 'M3U URL');
        top.appendChild(titleEl);
        top.appendChild(typeEl);

        var meta = document.createElement('div');
        meta.className = 'profile-card-meta';
        meta.textContent = prof.type === 'xtream'
          ? (prof.serverUrl + ' (' + prof.username + ')')
          : (prof.type === 'demo' ? 'Açık kaynak HLS / MP4 test kanalları, filmler ve diziler' : prof.url);

        var actions = document.createElement('div');
        actions.className = 'profile-card-actions';

        var btnConnect = document.createElement('button');
        btnConnect.className = 'p-btn p-btn-connect';
        btnConnect.textContent = 'Bağlan';
        btnConnect.setAttribute('data-focusable', 'true');
        btnConnect.setAttribute('data-zone', 'manager');
        btnConnect.onclick = function () {
          connectProfile(prof);
        };
        actions.appendChild(btnConnect);

        if (prof.type !== 'demo') {
          var btnEdit = document.createElement('button');
          btnEdit.className = 'p-btn';
          btnEdit.textContent = 'Düzenle';
          btnEdit.setAttribute('data-focusable', 'true');
          btnEdit.setAttribute('data-zone', 'manager');
          btnEdit.onclick = function () {
            startEditProfile(prof);
          };
          actions.appendChild(btnEdit);
        }

        var btnDel = document.createElement('button');
        btnDel.className = 'p-btn p-btn-del';
        btnDel.textContent = 'Sil';
        btnDel.setAttribute('data-focusable', 'true');
        btnDel.setAttribute('data-zone', 'manager');
        btnDel.onclick = function () {
          IPTVStorage.deleteProfile(prof.id);
          renderProfileList();
          showToast('Profil silindi.');
          SpatNav.focus('btn-load-demo');
        };
        actions.appendChild(btnDel);

        card.appendChild(top);
        card.appendChild(meta);
        card.appendChild(actions);
        container.appendChild(card);
      })(profiles[i]);
    }
  }

  function findChannelById(chId) {
    if (!chId) { return null; }
    var target = String(chId);
    for (var i = 0; i < app.data.liveChannels.length; i++) {
      if (String(app.data.liveChannels[i].id) === target) {
        return app.data.liveChannels[i];
      }
    }
    return null;
  }

  function connectProfile(profile) {
    if (!profile) { return; }
    if (app.screen === 'manager' && $('inp-cors-proxy')) {
      var proxyVal = $('inp-cors-proxy').value.replace(/^\s+|\s+$/g, '');
      IPTVStorage.updateSetting('corsProxy', proxyVal);
    }
    app.activeProfile = profile;
    if (profile.id) {
      IPTVStorage.setActiveProfileId(profile.id);
    }
    setLoading(true, profile.name + ' bağlanıyor...', 12);

    IPTVParser.loadProfile(profile, function (pct, msg) {
      setLoading(true, msg, pct);
    }, function (parsedData) {
      app.data = parsedData;
      app.epgCache = {};
      app.unlockedCategories = {};
      setLoading(false);
      openDashboard();
      showToast(profile.name + ' yüklendi (' + parsedData.liveChannels.length + ' kanal).');

      // TV Mode: Startup directly into last watched live channel in Fullscreen
      var settings = IPTVStorage.getSettings();
      if (settings.startupLiveFullscreen && !app.hasDoneStartupAutoplay && parsedData.liveChannels.length > 0) {
        app.hasDoneStartupAutoplay = true;
        var lastCh = findChannelById(IPTVStorage.getLastLiveChannelId()) || parsedData.liveChannels[0];
        if (lastCh) {
          setActiveLiveChannel(lastCh);
          hideEl('preview-idle');
          $('preview-ch-label').textContent = pad3(lastCh.num) + '  ' + lastCh.name;
          IPTVPlayer.play(lastCh, true, 'fullscreen', true);
          loadAndRenderEpg(lastCh);
          enterFullscreen(lastCh);
        }
      } else {
        app.hasDoneStartupAutoplay = true;
      }
    }, function (errMsg) {
      setLoading(false);
      showToast(errMsg, 'error');
      if (app.screen !== 'manager') {
        openManagerScreen();
      }
    });
  }

  function loadDemoProfile() {
    var existing = IPTVStorage.getProfiles();
    var demoProf = null;
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].type === 'demo') {
        demoProf = existing[i];
        break;
      }
    }
    if (!demoProf) {
      demoProf = IPTVStorage.saveProfile({
        type: 'demo',
        name: 'Pro IPTV Demo Liste'
      });
    }
    connectProfile(demoProf);
  }

  /* ========================================================================
     DASHBOARD & NAVIGATION
     ======================================================================== */

  function openDashboard() {
    hideEl('screen-manager');
    showEl('screen-dashboard');
    app.screen = 'dashboard';
    $('dash-profile-name').textContent = app.activeProfile ? app.activeProfile.name : 'Liste';
    switchSection('live');
  }

  function updateSidebarActive(sectionName) {
    var navs = document.querySelectorAll('.nav-btn');
    for (var i = 0; i < navs.length; i++) {
      setClassFlag(navs[i], 'is-active', navs[i].getAttribute('data-nav') === sectionName);
    }
  }

  function switchSection(sectionName) {
    if (sectionName === 'accounts') {
      openManagerScreen();
      return;
    }

    app.section = sectionName;
    app.inDetail = false;
    updateSidebarActive(sectionName);

    hideEl('view-live');
    hideEl('view-media');
    hideEl('view-detail');
    hideEl('view-search');
    hideEl('view-settings');

    if (sectionName !== 'live' && sectionName !== 'favorites' && sectionName !== 'recent') {
      if (!app.inFullscreen) {
        if (app.livePreviewTimer) {
          window.clearTimeout(app.livePreviewTimer);
          app.livePreviewTimer = null;
        }
        app.livePlayingChannel = null;
        IPTVPlayer.stop();
        showEl('preview-idle');
      }
    }

    if (sectionName === 'live' || sectionName === 'favorites' || sectionName === 'recent') {
      var titleMap = { live: 'Canlı TV', favorites: 'Favoriler', recent: 'Son İzlenenler' };
      $('dash-section-title').textContent = titleMap[sectionName];
      showEl('view-live');
      buildLiveCategoryModel();
      if (sectionName === 'favorites') {
        selectLiveCategory('__FAV__', false);
      } else if (sectionName === 'recent') {
        selectLiveCategory('__RECENT__', false);
      } else {
        selectLiveCategory('__ALL__', false);
      }
      window.setTimeout(function () {
        if (app.liveFilteredChannels.length > 0) {
          SpatNav.focus(app.liveChNodes[0]);
        } else {
          SpatNav.focus(app.liveCatNodes[0]);
        }
      }, 20);
    } else if (sectionName === 'vod' || sectionName === 'series') {
      app.mediaMode = sectionName;
      $('dash-section-title').textContent = sectionName === 'vod' ? 'Filmler (VOD)' : 'Diziler (Series)';
      showEl('view-media');
      buildMediaModel();
      window.setTimeout(function () {
        if (app.mediaFilteredItems.length > 0) {
          SpatNav.focus(app.mediaGridNodes[0]);
        } else if (app.mediaCatNodes.length > 0) {
          SpatNav.focus(app.mediaCatNodes[0]);
        }
      }, 20);
    } else if (sectionName === 'search') {
      $('dash-section-title').textContent = 'Arama';
      showEl('view-search');
      runSearch();
      window.setTimeout(function () {
        SpatNav.focus('inp-search');
      }, 20);
    } else if (sectionName === 'settings') {
      $('dash-section-title').textContent = 'Ayarlar & Abonelik';
      showEl('view-settings');
      renderSettingsView();
      window.setTimeout(function () {
        SpatNav.focus('set-liveformat');
      }, 20);
    }
  }

  /* ========================================================================
     VIRTUAL DOM POOLS (LIVE CATS, LIVE CHANNELS, QUICK DRAWER, MEDIA GRID)
     ======================================================================== */

  function initVirtualPools() {
    var i;

    // 1. Live Categories pool
    var catContainer = $('live-cat-list');
    catContainer.innerHTML = '';
    app.liveCatNodes = [];
    for (i = 0; i < CAT_VISIBLE_COUNT; i++) {
      (function (slot) {
        var row = document.createElement('div');
        row.className = 'cat-row is-hidden';
        row.setAttribute('data-focusable', 'true');
        row.setAttribute('data-zone', 'live-cat');
        row.setAttribute('data-slot', String(slot));
        row.innerHTML = '<span class="cat-name"></span><span class="cat-count"></span>';
        row.onclick = function () {
          if (isClickSuppressed()) { return; }
          var idx = app.liveCatStart + slot;
          if (idx >= 0 && idx < app.liveCatList.length) {
            attemptSelectLiveCategory(app.liveCatList[idx]);
          }
        };
        catContainer.appendChild(row);
        app.liveCatNodes.push(row);
      })(i);
    }

    // 2. Live Channels pool
    var chContainer = $('live-ch-list');
    chContainer.innerHTML = '';
    app.liveChNodes = [];
    for (i = 0; i < CH_VISIBLE_COUNT; i++) {
      (function (slot) {
        var row = document.createElement('div');
        row.className = 'ch-row is-hidden';
        row.setAttribute('data-focusable', 'true');
        row.setAttribute('data-zone', 'live-ch');
        row.setAttribute('data-slot', String(slot));

        var numEl = document.createElement('div');
        numEl.className = 'ch-num';

        var logoBox = document.createElement('div');
        logoBox.className = 'ch-logo-box';
        var img = document.createElement('img');
        img.className = 'ch-logo-img';
        img.alt = '';
        img.onerror = function () {
          if (this.src !== FALLBACK_CH_LOGO) {
            this.src = FALLBACK_CH_LOGO;
          }
        };
        logoBox.appendChild(img);

        var main = document.createElement('div');
        main.className = 'ch-main';
        var nameEl = document.createElement('div');
        nameEl.className = 'ch-name';
        var epgMini = document.createElement('div');
        epgMini.className = 'ch-epg-mini';
        var progTrack = document.createElement('div');
        progTrack.className = 'ch-mini-prog';
        var progFill = document.createElement('div');
        progFill.className = 'ch-mini-prog-fill';
        progTrack.appendChild(progFill);
        main.appendChild(nameEl);
        main.appendChild(epgMini);
        main.appendChild(progTrack);

        var favEl = document.createElement('div');
        favEl.className = 'ch-fav';
        favEl.textContent = '★';

        row.appendChild(numEl);
        row.appendChild(logoBox);
        row.appendChild(main);
        row.appendChild(favEl);

        row._refs = {
          num: numEl,
          img: img,
          name: nameEl,
          epgMini: epgMini,
          progFill: progFill,
          fav: favEl
        };

        row.onclick = function () {
          if (isClickSuppressed()) { return; }
          var idx = app.liveChStart + slot;
          if (idx >= 0 && idx < app.liveFilteredChannels.length) {
            handleChannelActivate(app.liveFilteredChannels[idx]);
          }
        };

        chContainer.appendChild(row);
        app.liveChNodes.push(row);
      })(i);
    }

    // 3. Fullscreen Quick Channel Drawer pool (13 DOM nodes)
    var drawerBox = $('drawer-ch-list');
    drawerBox.innerHTML = '';
    app.drawerNodes = [];
    for (i = 0; i < DRAWER_VISIBLE_COUNT; i++) {
      (function (slot) {
        var row = document.createElement('div');
        row.className = 'drawer-ch-row is-hidden';
        row.setAttribute('data-focusable', 'true');
        row.setAttribute('data-zone', 'drawer-ch');
        row.setAttribute('data-slot', String(slot));

        var numEl = document.createElement('div');
        numEl.className = 'ch-num';

        var logoBox = document.createElement('div');
        logoBox.className = 'ch-logo-box';
        var img = document.createElement('img');
        img.className = 'ch-logo-img';
        img.alt = '';
        img.onerror = function () {
          if (this.src !== FALLBACK_CH_LOGO) {
            this.src = FALLBACK_CH_LOGO;
          }
        };
        logoBox.appendChild(img);

        var main = document.createElement('div');
        main.className = 'drawer-ch-main';
        var nameEl = document.createElement('div');
        nameEl.className = 'ch-name';
        var epgMini = document.createElement('div');
        epgMini.className = 'ch-epg-mini';
        main.appendChild(nameEl);
        main.appendChild(epgMini);

        var favEl = document.createElement('div');
        favEl.className = 'ch-fav';
        favEl.textContent = '★';

        row.appendChild(numEl);
        row.appendChild(logoBox);
        row.appendChild(main);
        row.appendChild(favEl);

        row._refs = { num: numEl, img: img, name: nameEl, epgMini: epgMini, fav: favEl };

        row.onclick = function () {
          if (isClickSuppressed()) { return; }
          var idx = app.drawerStart + slot;
          if (idx >= 0 && idx < app.liveFilteredChannels.length) {
            var targetCh = app.liveFilteredChannels[idx];
            if (app.livePlayingChannel && app.livePlayingChannel.id === targetCh.id) {
              closeChannelDrawer();
              return;
            }
            switchLiveChannelInPlace(targetCh, idx);
            closeChannelDrawer();
          }
        };

        drawerBox.appendChild(row);
        app.drawerNodes.push(row);
      })(i);
    }

    // 4. Media category virtual pool
    var mCatBox = $('media-cat-list');
    mCatBox.innerHTML = '';
    app.mediaCatNodes = [];
    for (i = 0; i < CAT_VISIBLE_COUNT; i++) {
      (function (slot) {
        var row = document.createElement('div');
        row.className = 'cat-row is-hidden';
        row.setAttribute('data-focusable', 'true');
        row.setAttribute('data-zone', 'media-cat');
        row.setAttribute('data-slot', String(slot));
        row.innerHTML = '<span class="cat-name"></span><span class="cat-count"></span>';
        row.onclick = function () {
          if (isClickSuppressed()) { return; }
          var idx = app.mediaCatStart + slot;
          if (idx >= 0 && idx < app.mediaCatList.length) {
            selectMediaCategory(app.mediaCatList[idx].key);
          }
        };
        mCatBox.appendChild(row);
        app.mediaCatNodes.push(row);
      })(i);
    }

    // 5. Media poster grid virtual pool (5x3 = 15 DOM nodes)
    var gridBox = $('media-poster-grid');
    gridBox.innerHTML = '';
    app.mediaGridNodes = [];
    for (i = 0; i < GRID_VISIBLE_COUNT; i++) {
      (function (slot) {
        var card = document.createElement('div');
        card.className = 'poster-card is-hidden' + ((slot % GRID_COLS === GRID_COLS - 1) ? ' col-last' : '');
        card.setAttribute('data-focusable', 'true');
        card.setAttribute('data-zone', 'media-grid');
        card.setAttribute('data-slot', String(slot));

        var imgWrap = document.createElement('div');
        imgWrap.className = 'poster-img-wrap';
        var img = document.createElement('img');
        img.className = 'poster-img';
        img.alt = '';
        var fallback = document.createElement('div');
        fallback.className = 'poster-fallback is-hidden';
        var rating = document.createElement('div');
        rating.className = 'poster-rating';

        var progTrack = document.createElement('div');
        progTrack.className = 'poster-prog-track is-hidden';
        var progFill = document.createElement('div');
        progFill.className = 'poster-prog-fill';
        progTrack.appendChild(progFill);

        img.onerror = function () {
          hideEl(img);
          showEl(fallback);
        };

        imgWrap.appendChild(img);
        imgWrap.appendChild(fallback);
        imgWrap.appendChild(rating);
        imgWrap.appendChild(progTrack);

        var info = document.createElement('div');
        info.className = 'poster-info';
        var title = document.createElement('div');
        title.className = 'poster-title';
        var sub = document.createElement('div');
        sub.className = 'poster-sub';
        info.appendChild(title);
        info.appendChild(sub);

        card.appendChild(imgWrap);
        card.appendChild(info);
        card._refs = {
          img: img,
          fallback: fallback,
          rating: rating,
          progTrack: progTrack,
          progFill: progFill,
          title: title,
          sub: sub
        };

        card.onclick = function () {
          if (isClickSuppressed()) { return; }
          var idx = app.mediaRowStart * GRID_COLS + slot;
          if (idx >= 0 && idx < app.mediaFilteredItems.length) {
            openMediaDetail(app.mediaFilteredItems[idx]);
          }
        };

        gridBox.appendChild(card);
        app.mediaGridNodes.push(card);
      })(i);
    }
  }

  /* ========================================================================
     LIVE TV MODEL, EPG & CHANNEL SWITCHING
     ======================================================================== */

  function setActiveLiveChannel(ch) {
    if (!ch) { return; }
    if (app.livePlayingChannel && String(app.livePlayingChannel.id) !== String(ch.id)) {
      app.previousLiveChannel = app.livePlayingChannel;
    }
    app.livePlayingChannel = ch;
    app.currentSeriesCtx = null;
    IPTVStorage.setLastLiveChannelId(ch.id);
  }

  function buildLiveCategoryModel() {
    var favCount = IPTVStorage.getFavorites('live').length;
    var recList = IPTVStorage.getRecents();
    var recLiveCount = 0;
    var i;
    for (i = 0; i < recList.length; i++) {
      if (recList[i].type === 'live') { recLiveCount++; }
    }

    var visibleAllCount = 0;
    for (i = 0; i < app.data.liveChannels.length; i++) {
      if (!IPTVStorage.isCategoryHidden(app.data.liveChannels[i].group)) {
        visibleAllCount++;
      }
    }

    var list = [
      { key: '__ALL__', name: 'Tüm Kanallar', count: visibleAllCount, isAdult: false },
      { key: '__FAV__', name: '★ Favoriler', count: favCount, isAdult: false },
      { key: '__RECENT__', name: '◷ Son İzlenenler', count: recLiveCount, isAdult: false }
    ];

    for (i = 0; i < app.data.liveCategories.length; i++) {
      var cat = app.data.liveCategories[i];
      if (!IPTVStorage.isCategoryHidden(cat.name)) {
        list.push({
          key: cat.name,
          name: cat.name,
          count: cat.count,
          isAdult: !!cat.isAdult
        });
      }
    }

    app.liveCatList = list;
    app.liveCatStart = 0;
    $('live-cat-counter').textContent = String(list.length);
    renderLiveCatWindow();
  }

  function renderLiveCatWindow() {
    var settings = IPTVStorage.getSettings();
    for (var i = 0; i < CAT_VISIBLE_COUNT; i++) {
      var idx = app.liveCatStart + i;
      var node = app.liveCatNodes[i];
      if (idx < app.liveCatList.length) {
        var cat = app.liveCatList[idx];
        var locked = settings.parentalEnabled && cat.isAdult && !app.unlockedCategories[cat.key];
        node.firstChild.textContent = (locked ? '🔒 ' : '') + cat.name;
        node.lastChild.textContent = String(cat.count);
        setClassFlag(node, 'is-selected', cat.key === app.liveSelectedCatKey);
        showEl(node);
      } else {
        hideEl(node);
      }
    }
  }

  function attemptSelectLiveCategory(cat) {
    var settings = IPTVStorage.getSettings();
    if (settings.parentalEnabled && cat.isAdult && !app.unlockedCategories[cat.key]) {
      openPinModal('verify', 'Yetişkin (+18) Kategori Kilidi', 'Bu kategoriye girmek için 4 haneli PIN kodunu girin.', function () {
        app.unlockedCategories[cat.key] = true;
        selectLiveCategory(cat.key, true);
      });
      return;
    }
    selectLiveCategory(cat.key, true);
  }

  function selectLiveCategory(catKey, focusFirstChannel) {
    app.liveSelectedCatKey = catKey;
    var settings = IPTVStorage.getSettings();
    var filtered = [];
    var i, ch;

    if (catKey === '__ALL__') {
      for (i = 0; i < app.data.liveChannels.length; i++) {
        ch = app.data.liveChannels[i];
        if (IPTVStorage.isCategoryHidden(ch.group)) { continue; }
        if (settings.parentalEnabled && ch.isAdult && !app.unlockedCategories[ch.group]) { continue; }
        filtered.push(ch);
      }
      $('live-ch-header-title').textContent = 'Tüm Kanallar';
    } else if (catKey === '__FAV__') {
      var favIds = IPTVStorage.getFavorites('live');
      for (i = 0; i < app.data.liveChannels.length; i++) {
        if (favIds.indexOf(String(app.data.liveChannels[i].id)) !== -1) {
          filtered.push(app.data.liveChannels[i]);
        }
      }
      $('live-ch-header-title').textContent = 'Favori Kanallar';
    } else if (catKey === '__RECENT__') {
      var recents = IPTVStorage.getRecents();
      for (i = 0; i < recents.length; i++) {
        if (recents[i].type !== 'live') { continue; }
        for (var j = 0; j < app.data.liveChannels.length; j++) {
          if (String(app.data.liveChannels[j].id) === String(recents[i].id)) {
            filtered.push(app.data.liveChannels[j]);
            break;
          }
        }
      }
      $('live-ch-header-title').textContent = 'Son İzlenen Kanallar';
    } else {
      for (i = 0; i < app.data.liveChannels.length; i++) {
        if (app.data.liveChannels[i].group === catKey) {
          filtered.push(app.data.liveChannels[i]);
        }
      }
      $('live-ch-header-title').textContent = catKey;
    }

    app.liveFilteredChannels = filtered;
    app.liveChStart = 0;
    app.liveFocusedChIndex = 0;
    renderLiveCatWindow();
    renderLiveChWindow();

    if (filtered.length === 0) {
      showEl('live-ch-empty');
    } else {
      hideEl('live-ch-empty');
      if (focusFirstChannel) {
        SpatNav.focus(app.liveChNodes[0]);
      }
    }
  }

  function renderLiveChWindow() {
    var total = app.liveFilteredChannels.length;
    $('live-ch-counter').textContent = (total > 0 ? (app.liveFocusedChIndex + 1) : 0) + ' / ' + total;

    for (var i = 0; i < CH_VISIBLE_COUNT; i++) {
      var idx = app.liveChStart + i;
      var node = app.liveChNodes[i];
      if (idx < total) {
        var ch = app.liveFilteredChannels[idx];
        var r = node._refs;
        r.num.textContent = pad3(ch.num);
        r.img.src = ch.logo ? ch.logo : FALLBACK_CH_LOGO;
        r.name.textContent = ch.name;

        var cachedEpg = app.epgCache[ch.id] || ch.epg || null;
        if (cachedEpg && cachedEpg.now) {
          r.epgMini.textContent = cachedEpg.now.title;
          r.progFill.style.width = calcEpgPercent(cachedEpg.now) + '%';
        } else {
          r.epgMini.textContent = ch.group;
          r.progFill.style.width = '0%';
        }

        var isFav = IPTVStorage.isFavorite('live', ch.id);
        setClassFlag(r.fav, 'is-fav', isFav);
        setClassFlag(node, 'is-playing', !!(app.livePlayingChannel && app.livePlayingChannel.id === ch.id));
        showEl(node);
      } else {
        hideEl(node);
      }
    }
  }

  function handleChannelFocus(ch, chIndex, source) {
    app.liveFocusedChIndex = chIndex;
    $('live-ch-counter').textContent = (chIndex + 1) + ' / ' + app.liveFilteredChannels.length;
    loadAndRenderEpg(ch);

    // Never auto-switch channels on LG Magic Remote mouse hover!
    if (source === 'mouse') {
      return;
    }

    var settings = IPTVStorage.getSettings();
    if (settings.autoPreview && (!app.livePlayingChannel || app.livePlayingChannel.id !== ch.id)) {
      if (app.livePreviewTimer) { window.clearTimeout(app.livePreviewTimer); }
      app.livePreviewTimer = window.setTimeout(function () {
        if (app.screen === 'dashboard' && !app.inFullscreen && (app.section === 'live' || app.section === 'favorites' || app.section === 'recent')) {
          startLivePreview(ch, false);
        }
      }, 420);
    }
  }

  function startLivePreview(ch, fromUserGesture) {
    if (!ch) { return; }
    if (app.livePreviewTimer) {
      window.clearTimeout(app.livePreviewTimer);
      app.livePreviewTimer = null;
    }
    setActiveLiveChannel(ch);
    hideEl('preview-idle');
    $('preview-ch-label').textContent = pad3(ch.num) + '  ' + ch.name;
    IPTVPlayer.play(ch, true, 'preview', !!fromUserGesture);
    IPTVStorage.addRecent(ch);
    renderLiveChWindow();
  }

  function handleChannelActivate(ch) {
    if (!ch) { return; }
    if (app.livePreviewTimer) {
      window.clearTimeout(app.livePreviewTimer);
      app.livePreviewTimer = null;
    }
    // 1st OK on a channel -> play in right preview box.
    // 2nd OK on the same already-playing channel -> open Fullscreen.
    if (app.livePlayingChannel && app.livePlayingChannel.id === ch.id && IPTVPlayer.getCurrentItem()) {
      IPTVPlayer.ensurePlaying(true);
      enterFullscreen(ch);
    } else {
      startLivePreview(ch, true);
    }
  }

  function loadAndRenderEpg(ch) {
    if (!ch) { return; }
    $('epg-ch-meta').textContent = pad3(ch.num) + ' · ' + ch.group;

    var existing = app.epgCache[ch.id] || ch.epg || null;
    if (existing) {
      app.currentEpg = existing;
      renderEpgPanel(existing);
      if (app.inFullscreen && app.osdVisible && IPTVPlayer.isLive() && app.livePlayingChannel && app.livePlayingChannel.id === ch.id) {
        renderLiveOsdEpg(ch);
      }
      return;
    }

    renderEpgPanel(null);
    if (app.data.sourceType === 'xtream' && app.data.xtreamConfig && ch.streamId) {
      IPTVParser.fetchXtreamShortEpg(app.data.xtreamConfig, ch.streamId, function (epgData) {
        if (epgData) {
          app.epgCache[ch.id] = epgData;
          if (app.liveFilteredChannels[app.liveFocusedChIndex] && app.liveFilteredChannels[app.liveFocusedChIndex].id === ch.id) {
            app.currentEpg = epgData;
            renderEpgPanel(epgData);
          }
          if (app.inFullscreen && app.osdVisible && IPTVPlayer.isLive() && app.livePlayingChannel && app.livePlayingChannel.id === ch.id) {
            renderLiveOsdEpg(ch);
          }
          renderLiveChWindow();
          if (app.drawerOpen) { renderDrawerWindow(); }
        }
      });
    }
  }

  function renderEpgPanel(epg) {
    if (!epg || !epg.now) {
      $('epg-now-title').textContent = 'Program bilgisi bulunamadı';
      $('epg-now-time').textContent = '--:-- - --:--';
      $('epg-progress-fill').style.width = '0%';
      $('epg-now-desc').textContent = 'Bu kanal için sunucudan EPG yayın akışı verisi sağlanmıyor.';
      $('epg-next-title').textContent = '---';
      $('epg-next-time').textContent = '--:-- - --:--';
      return;
    }
    $('epg-now-title').textContent = epg.now.title || 'Yayın';
    $('epg-now-time').textContent = formatTsHM(epg.now.startTs) + ' - ' + formatTsHM(epg.now.stopTs);
    $('epg-progress-fill').style.width = calcEpgPercent(epg.now) + '%';
    $('epg-now-desc').textContent = epg.now.desc || 'Açıklama bulunmuyor.';
    if (epg.next) {
      $('epg-next-title').textContent = epg.next.title || '---';
      $('epg-next-time').textContent = formatTsHM(epg.next.startTs) + ' - ' + formatTsHM(epg.next.stopTs);
    } else {
      $('epg-next-title').textContent = 'Sonraki program bilgisi yok';
      $('epg-next-time').textContent = '--:-- - --:--';
    }
  }

  function renderEpgProgressOnly(epg) {
    if (!epg || !epg.now) { return; }
    $('epg-progress-fill').style.width = calcEpgPercent(epg.now) + '%';
  }

  /* ========================================================================
     FULLSCREEN TRANSLUCENT QUICK CHANNEL DRAWER
     ======================================================================== */

  function openChannelDrawer() {
    if (!app.inFullscreen || !IPTVPlayer.isLive()) { return; }
    if (!app.liveFilteredChannels.length) {
      showToast('Bu kategoride kanal bulunmuyor.', 'warn');
      return;
    }
    hideOsd();
    app.drawerOpen = true;
    showEl('fs-channel-drawer');

    var curIdx = 0;
    if (app.livePlayingChannel) {
      for (var i = 0; i < app.liveFilteredChannels.length; i++) {
        if (app.liveFilteredChannels[i].id === app.livePlayingChannel.id) {
          curIdx = i;
          break;
        }
      }
    }

    var half = Math.floor(DRAWER_VISIBLE_COUNT / 2);
    var maxStart = Math.max(0, app.liveFilteredChannels.length - DRAWER_VISIBLE_COUNT);
    app.drawerStart = Math.max(0, Math.min(maxStart, curIdx - half));

    $('drawer-cat-title').textContent = $('live-ch-header-title').textContent || 'Kanallar';
    $('drawer-cat-count').textContent = (curIdx + 1) + ' / ' + app.liveFilteredChannels.length;
    renderDrawerWindow();

    var focusSlot = curIdx - app.drawerStart;
    if (focusSlot < 0 || focusSlot >= DRAWER_VISIBLE_COUNT) { focusSlot = 0; }
    SpatNav.focus(app.drawerNodes[focusSlot]);
  }

  function closeChannelDrawer() {
    if (!app.drawerOpen) { return; }
    app.drawerOpen = false;
    hideEl('fs-channel-drawer');
  }

  function renderDrawerWindow() {
    var total = app.liveFilteredChannels.length;
    for (var i = 0; i < DRAWER_VISIBLE_COUNT; i++) {
      var idx = app.drawerStart + i;
      var node = app.drawerNodes[i];
      if (idx < total) {
        var ch = app.liveFilteredChannels[idx];
        var r = node._refs;
        r.num.textContent = pad3(ch.num);
        r.img.src = ch.logo ? ch.logo : FALLBACK_CH_LOGO;
        r.name.textContent = ch.name;

        var cachedEpg = app.epgCache[ch.id] || ch.epg || null;
        if (cachedEpg && cachedEpg.now) {
          r.epgMini.textContent = cachedEpg.now.title + ' (' + formatTsHM(cachedEpg.now.startTs) + '-' + formatTsHM(cachedEpg.now.stopTs) + ')';
        } else {
          r.epgMini.textContent = ch.group;
        }

        setClassFlag(r.fav, 'is-fav', IPTVStorage.isFavorite('live', ch.id));
        setClassFlag(node, 'is-playing', !!(app.livePlayingChannel && app.livePlayingChannel.id === ch.id));
        showEl(node);
      } else {
        hideEl(node);
      }
    }
  }

  /* ========================================================================
     VOD & SERIES VIRTUAL GRID + DETAIL SCREEN + RESUME PLAYBACK
     ======================================================================== */

  function buildMediaModel() {
    var isVod = app.mediaMode === 'vod';
    var cats = isVod ? app.data.vodCategories : app.data.seriesCategories;
    var items = isVod ? app.data.vodItems : app.data.seriesItems;
    var favCount = IPTVStorage.getFavorites(app.mediaMode).length;

    var list = [
      { key: '__ALL__', name: isVod ? 'Tüm Filmler' : 'Tüm Diziler', count: items.length },
      { key: '__FAV__', name: '★ Favoriler', count: favCount }
    ];
    for (var i = 0; i < cats.length; i++) {
      list.push({ key: cats[i].name, name: cats[i].name, count: cats[i].count });
    }

    app.mediaCatList = list;
    app.mediaCatStart = 0;
    $('media-cat-heading').textContent = isVod ? 'Film Kategorileri' : 'Dizi Kategorileri';
    $('media-cat-counter').textContent = String(list.length);
    selectMediaCategory('__ALL__');
  }

  function renderMediaCatWindow() {
    for (var i = 0; i < CAT_VISIBLE_COUNT; i++) {
      var idx = app.mediaCatStart + i;
      var node = app.mediaCatNodes[i];
      if (idx < app.mediaCatList.length) {
        var cat = app.mediaCatList[idx];
        node.firstChild.textContent = cat.name;
        node.lastChild.textContent = String(cat.count);
        setClassFlag(node, 'is-selected', cat.key === app.mediaSelectedCat);
        showEl(node);
      } else {
        hideEl(node);
      }
    }
  }

  function selectMediaCategory(catKey) {
    app.mediaSelectedCat = catKey;
    var isVod = app.mediaMode === 'vod';
    var source = isVod ? app.data.vodItems : app.data.seriesItems;
    var filtered = [];
    var i;

    if (catKey === '__ALL__') {
      filtered = source.slice(0);
      $('media-grid-heading').textContent = isVod ? 'Tüm Filmler' : 'Tüm Diziler';
    } else if (catKey === '__FAV__') {
      var favIds = IPTVStorage.getFavorites(app.mediaMode);
      for (i = 0; i < source.length; i++) {
        if (favIds.indexOf(String(source[i].id)) !== -1) {
          filtered.push(source[i]);
        }
      }
      $('media-grid-heading').textContent = 'Favoriler';
    } else {
      for (i = 0; i < source.length; i++) {
        if (source[i].group === catKey) {
          filtered.push(source[i]);
        }
      }
      $('media-grid-heading').textContent = catKey;
    }

    app.mediaFilteredItems = filtered;
    app.mediaRowStart = 0;
    $('media-grid-counter').textContent = filtered.length + ' içerik';
    renderMediaCatWindow();
    renderMediaGridWindow();
    if (filtered.length === 0) {
      showEl('media-grid-empty');
    } else {
      hideEl('media-grid-empty');
    }
  }

  function renderMediaGridWindow() {
    var baseIdx = app.mediaRowStart * GRID_COLS;
    var total = app.mediaFilteredItems.length;
    for (var i = 0; i < GRID_VISIBLE_COUNT; i++) {
      var idx = baseIdx + i;
      var card = app.mediaGridNodes[i];
      if (idx < total) {
        var item = app.mediaFilteredItems[idx];
        var r = card._refs;
        if (item.poster) {
          r.img.src = item.poster;
          showEl(r.img);
          hideEl(r.fallback);
        } else {
          hideEl(r.img);
          r.fallback.textContent = item.name.substring(0, 14);
          showEl(r.fallback);
        }
        r.rating.textContent = '★ ' + (item.rating || '-');
        r.title.textContent = item.name;
        r.sub.textContent = (item.year || 'HD') + ' · ' + (item.group || '');

        // Watch progress bar on VOD poster cards
        var prog = item.type === 'vod' ? IPTVStorage.getWatchProgress(item.id) : null;
        if (prog && prog.pct > 0) {
          r.progFill.style.width = prog.pct + '%';
          r.progFill.style.backgroundColor = prog.watched ? '#22c55e' : '#00a8ff';
          showEl(r.progTrack);
        } else {
          hideEl(r.progTrack);
        }

        showEl(card);
      } else {
        hideEl(card);
      }
    }
  }

  function openMediaDetail(item) {
    app.detailItem = item;
    app.detailReturnSection = app.section;
    app.inDetail = true;

    hideEl('view-media');
    hideEl('view-search');
    showEl('view-detail');

    $('detail-title').textContent = item.name;
    $('detail-meta').textContent = (item.year || 'HD') + ' · IMDb ' + (item.rating || '-') + ' · ' + (item.genre || item.group || '');
    $('detail-credits').textContent = 'Yönetmen: ' + (item.director || '-') + ' · Oyuncular: ' + (item.cast || '-');
    $('detail-plot').textContent = item.plot || 'Özet bilgisi mevcut değil.';

    if (item.poster) {
      $('detail-poster').src = item.poster;
      $('detail-poster').onerror = function () {
        hideEl('detail-poster');
        showEl('detail-poster-fallback');
      };
      showEl('detail-poster');
      hideEl('detail-poster-fallback');
    } else {
      hideEl('detail-poster');
      $('detail-poster-fallback').textContent = item.name.substring(0, 16);
      showEl('detail-poster-fallback');
    }

    updateDetailPlayButton();
    updateDetailFavButton();

    if (item.type === 'series') {
      showEl('detail-series-area');
      if (item.seasons) {
        renderSeriesSeasons(item.seasons);
      } else if (app.data.sourceType === 'xtream' && app.data.xtreamConfig && item.seriesId) {
        $('detail-seasons-list').innerHTML = '';
        $('detail-episodes-list').innerHTML = '<div class="empty-col">Sezon ve bölümler yükleniyor...</div>';
        IPTVParser.fetchXtreamSeriesInfo(app.data.xtreamConfig, item.seriesId, function (res) {
          if (res && res.seasons) {
            item.seasons = res.seasons;
            if (res.info) {
              if (res.info.plot) { $('detail-plot').textContent = res.info.plot; }
              if (res.info.director || res.info.cast) {
                $('detail-credits').textContent = 'Yönetmen: ' + (res.info.director || '-') + ' · Oyuncular: ' + (res.info.cast || '-');
              }
            }
            renderSeriesSeasons(item.seasons);
          } else {
            $('detail-episodes-list').innerHTML = '<div class="empty-col">Bölüm bilgisi alınamadı.</div>';
          }
        });
      }
    } else {
      hideEl('detail-series-area');
      if (app.data.sourceType === 'xtream' && app.data.xtreamConfig && item.streamId) {
        IPTVParser.fetchXtreamVodInfo(app.data.xtreamConfig, item.streamId, function (info) {
          if (info && app.detailItem && app.detailItem.id === item.id) {
            if (info.plot || info.description) { $('detail-plot').textContent = info.plot || info.description; }
            $('detail-credits').textContent = 'Yönetmen: ' + (info.director || '-') + ' · Oyuncular: ' + (info.cast || info.actors || '-');
          }
        });
      }
    }

    window.setTimeout(function () {
      SpatNav.focus('btn-detail-play');
    }, 30);
  }

  function updateDetailPlayButton() {
    if (!app.detailItem) { return; }
    if (app.detailItem.type === 'vod') {
      var prog = IPTVStorage.getWatchProgress(app.detailItem.id);
      if (prog && !prog.watched && prog.pos >= 15) {
        $('btn-detail-play').textContent = '▶ Devam Et (' + formatTimeSec(prog.pos) + ')';
        return;
      }
    }
    $('btn-detail-play').textContent = '▶ Oynat';
  }

  function updateDetailFavButton() {
    if (!app.detailItem) { return; }
    var isFav = IPTVStorage.isFavorite(app.detailItem.type, app.detailItem.id);
    $('btn-detail-fav').textContent = isFav ? '★ Favorilerden Çıkar' : '☆ Favorilere Ekle';
  }

  function renderSeriesSeasons(seasonsObj) {
    var seasonsBar = $('detail-seasons-list');
    seasonsBar.innerHTML = '';
    var keys = getObjectKeys(seasonsObj);
    if (keys.length === 0) {
      $('detail-episodes-list').innerHTML = '<div class="empty-col">Bölüm bulunamadı.</div>';
      return;
    }
    if (!seasonsObj[app.detailSeasonKey]) {
      app.detailSeasonKey = keys[0];
    }

    for (var i = 0; i < keys.length; i++) {
      (function (sKey) {
        var btn = document.createElement('button');
        btn.className = 'season-tab' + (sKey === app.detailSeasonKey ? ' is-active' : '');
        btn.textContent = sKey + '. Sezon';
        btn.setAttribute('data-focusable', 'true');
        btn.setAttribute('data-zone', 'detail');
        btn.onclick = function () {
          app.detailSeasonKey = sKey;
          app.detailEpStart = 0;
          var allTabs = seasonsBar.querySelectorAll('.season-tab');
          for (var t = 0; t < allTabs.length; t++) {
            setClassFlag(allTabs[t], 'is-active', allTabs[t] === btn);
          }
          app.detailEpisodes = seasonsObj[sKey] || [];
          renderSeriesEpisodesWindow();
        };
        seasonsBar.appendChild(btn);
      })(keys[i]);
    }

    app.detailEpStart = 0;
    app.detailEpisodes = seasonsObj[app.detailSeasonKey] || [];
    renderSeriesEpisodesWindow();
  }

  function createEpisodeRowElement(ep, epIdx, seasonKey, seriesItem, zoneName, slotIdx, isActiveRow) {
    var row = document.createElement('div');
    row.className = (zoneName === 'modal-ep-row' ? 'ep-modal-row' : 'episode-row') + (isActiveRow ? ' is-active' : '');
    row.setAttribute('data-focusable', 'true');
    row.setAttribute('data-zone', zoneName);
    row.setAttribute('data-slot', String(slotIdx));

    var left = document.createElement('div');
    left.className = 'ep-left';
    var numSpan = document.createElement('span');
    numSpan.className = 'ep-num';
    numSpan.textContent = 'Bölüm ' + ep.episodeNum;
    var titleSpan = document.createElement('span');
    titleSpan.className = 'ep-title';
    titleSpan.textContent = ep.title;
    left.appendChild(numSpan);
    left.appendChild(titleSpan);

    var prog = IPTVStorage.getWatchProgress(ep.id);
    if (prog && prog.watched) {
      var wTag = document.createElement('span');
      wTag.className = 'ep-watched-tag';
      wTag.textContent = '✓ İzlendi';
      left.appendChild(wTag);
    } else if (prog && prog.pos >= 15) {
      var rTag = document.createElement('span');
      rTag.className = 'ep-resume-tag';
      rTag.textContent = '▶ ' + formatTimeSec(prog.pos);
      left.appendChild(rTag);
    }

    var durSpan = document.createElement('span');
    durSpan.className = 'ep-dur';
    durSpan.textContent = isActiveRow ? '● OYNATILIYOR' : (ep.duration || '');

    row.appendChild(left);
    row.appendChild(durSpan);

    row.onclick = function () {
      if (isClickSuppressed()) { return; }
      var ctx = {
        seriesItem: seriesItem,
        seasonKey: seasonKey,
        episodes: seriesItem.seasons[seasonKey] || [],
        epIndex: epIdx
      };
      var mediaObj = buildEpisodeMediaObj(seriesItem, seasonKey, ep);
      if (zoneName === 'modal-ep-row') {
        saveCurrentMediaProgress(true);
        closeEpisodesModal();
        var epProg = IPTVStorage.getWatchProgress(mediaObj.id);
        var startSec = (epProg && !epProg.watched && epProg.pos >= 15) ? epProg.pos : 0;
        playVodOrEpisode(mediaObj, ctx, startSec);
      } else {
        requestPlayVodOrEpisode(mediaObj, ctx);
      }
    };

    return row;
  }

  function renderSeriesEpisodesWindow() {
    var box = $('detail-episodes-list');
    box.innerHTML = '';
    var eps = app.detailEpisodes || [];
    if (eps.length === 0) {
      box.innerHTML = '<div class="empty-col">Bu sezonda bölüm bulunamadı.</div>';
      return;
    }
    var count = Math.min(DETAIL_EP_VISIBLE, eps.length - app.detailEpStart);
    for (var i = 0; i < count; i++) {
      var epIdx = app.detailEpStart + i;
      var row = createEpisodeRowElement(eps[epIdx], epIdx, app.detailSeasonKey, app.detailItem, 'detail-ep', i, false);
      box.appendChild(row);
    }
  }

  function buildEpisodeMediaObj(seriesItem, seasonKey, ep) {
    return {
      id: ep.id,
      type: 'series',
      name: seriesItem.name + ' · S' + seasonKey + ' B' + ep.episodeNum + ' - ' + ep.title,
      url: ep.url,
      group: seriesItem.group || 'Dizi',
      quality: 'HD'
    };
  }

  function closeMediaDetail() {
    app.inDetail = false;
    hideEl('view-detail');
    if (app.detailReturnSection === 'search') {
      showEl('view-search');
      SpatNav.focus('inp-search');
    } else {
      showEl('view-media');
      renderMediaGridWindow();
      SpatNav.focus(app.mediaGridNodes[0]);
    }
  }

  function saveCurrentMediaProgress(force) {
    if (IPTVPlayer.isLive()) { return; }
    var curItem = IPTVPlayer.getCurrentItem();
    if (!curItem) { return; }
    var now = new Date().getTime();
    if (!force && (now - app.lastSavedProgressTs) < 5000) { return; }
    var pos = IPTVPlayer.getCurrentTime();
    var dur = IPTVPlayer.getDuration();
    if (dur >= 15 && pos >= 5) {
      IPTVStorage.saveWatchProgress(curItem.id, pos, dur);
      app.lastSavedProgressTs = now;
    }
  }

  function requestPlayVodOrEpisode(mediaObj, seriesCtx) {
    var prog = IPTVStorage.getWatchProgress(mediaObj.id);
    if (prog && !prog.watched && prog.pos >= 15) {
      app.pendingResumeData = {
        mediaObj: mediaObj,
        seriesCtx: seriesCtx || null,
        savedPos: prog.pos
      };
      $('resume-desc').textContent = mediaObj.name + ' için ' + formatTimeSec(prog.pos) + ' / ' + formatTimeSec(prog.dur) + ' noktasında kaldınız.';
      $('btn-resume-continue').textContent = '▶ Devam Et (' + formatTimeSec(prog.pos) + ')';
      openResumeModal();
      return;
    }
    playVodOrEpisode(mediaObj, seriesCtx || null, 0);
  }

  function playVodOrEpisode(mediaObj, seriesCtx, startPosSec) {
    hideNextEpCard(true);
    app.nextEpDismissed = false;
    app.nextEpTarget = null;
    app.currentSeriesCtx = seriesCtx || null;
    app.livePlayingChannel = null;
    app.lastSavedProgressTs = 0;

    IPTVStorage.addRecent(mediaObj);
    IPTVPlayer.play(mediaObj, false, 'fullscreen', true, startPosSec || 0);
    enterFullscreen(mediaObj);
  }

  /* ========================================================================
     SERIES AUTO-NEXT EPISODE & IN-PLAYER EPISODES MODAL
     ======================================================================== */

  function getNextEpisodeInfo(ctx) {
    if (!ctx || !ctx.seriesItem || !ctx.seriesItem.seasons) { return null; }
    var eps = ctx.episodes || [];
    if (ctx.epIndex + 1 < eps.length) {
      return {
        seriesItem: ctx.seriesItem,
        seasonKey: ctx.seasonKey,
        episodes: eps,
        epIndex: ctx.epIndex + 1,
        ep: eps[ctx.epIndex + 1]
      };
    }
    var keys = getObjectKeys(ctx.seriesItem.seasons);
    var sIdx = keys.indexOf(ctx.seasonKey);
    if (sIdx !== -1 && sIdx + 1 < keys.length) {
      var nextKey = keys[sIdx + 1];
      var nextEps = ctx.seriesItem.seasons[nextKey] || [];
      if (nextEps.length > 0) {
        return {
          seriesItem: ctx.seriesItem,
          seasonKey: nextKey,
          episodes: nextEps,
          epIndex: 0,
          ep: nextEps[0]
        };
      }
    }
    return null;
  }

  function playNextEpisodeTarget(nextInfo) {
    if (!nextInfo || !nextInfo.ep) { return; }
    saveCurrentMediaProgress(true);
    var mediaObj = buildEpisodeMediaObj(nextInfo.seriesItem, nextInfo.seasonKey, nextInfo.ep);
    var nextCtx = {
      seriesItem: nextInfo.seriesItem,
      seasonKey: nextInfo.seasonKey,
      episodes: nextInfo.episodes,
      epIndex: nextInfo.epIndex
    };
    playVodOrEpisode(mediaObj, nextCtx, 0);
    showToast('Sıradaki bölüm başlatıldı: S' + nextInfo.seasonKey + ' B' + nextInfo.ep.episodeNum);
  }

  function hideNextEpCard(markDismissed) {
    app.nextEpVisible = false;
    if (markDismissed) { app.nextEpDismissed = true; }
    hideEl('next-ep-card');
  }

  function openEpisodesModal() {
    if (!app.currentSeriesCtx || !app.currentSeriesCtx.seriesItem || !app.currentSeriesCtx.seriesItem.seasons) {
      showToast('Bu içerik için bölüm listesi bulunamadı.', 'warn');
      return;
    }
    hideOsd();
    app.activeModal = 'episodes';
    var seriesItem = app.currentSeriesCtx.seriesItem;
    app.epModalSeasonKey = app.currentSeriesCtx.seasonKey;
    app.epModalEpisodes = seriesItem.seasons[app.epModalSeasonKey] || [];

    var activeIdx = app.currentSeriesCtx.epIndex || 0;
    var maxStart = Math.max(0, app.epModalEpisodes.length - MODAL_EP_VISIBLE);
    app.epModalStart = Math.max(0, Math.min(maxStart, activeIdx - 2));

    $('ep-modal-title').textContent = seriesItem.name + ' - Bölümler';
    renderEpisodesModalSeasons();
    renderEpisodesModalList();

    showEl('modal-episodes');
    var firstFocus = document.querySelector('#ep-modal-list .ep-modal-row.is-active') ||
      document.querySelector('#ep-modal-list .ep-modal-row') ||
      $('btn-ep-modal-close');
    SpatNav.pushTrap('modal-episodes', firstFocus);
  }

  function renderEpisodesModalSeasons() {
    var seriesItem = app.currentSeriesCtx.seriesItem;
    var bar = $('ep-modal-seasons');
    bar.innerHTML = '';
    var keys = getObjectKeys(seriesItem.seasons);
    for (var i = 0; i < keys.length; i++) {
      (function (sKey) {
        var btn = document.createElement('button');
        btn.className = 'season-tab' + (sKey === app.epModalSeasonKey ? ' is-active' : '');
        btn.textContent = sKey + '. Sezon';
        btn.setAttribute('data-focusable', 'true');
        btn.setAttribute('data-zone', 'modal-episodes');
        btn.onclick = function () {
          app.epModalSeasonKey = sKey;
          app.epModalEpisodes = seriesItem.seasons[sKey] || [];
          app.epModalStart = 0;
          var tabs = bar.querySelectorAll('.season-tab');
          for (var t = 0; t < tabs.length; t++) {
            setClassFlag(tabs[t], 'is-active', tabs[t] === btn);
          }
          renderEpisodesModalList();
        };
        bar.appendChild(btn);
      })(keys[i]);
    }
  }

  function renderEpisodesModalList() {
    var listEl = $('ep-modal-list');
    listEl.innerHTML = '';
    var eps = app.epModalEpisodes || [];
    var seriesItem = app.currentSeriesCtx.seriesItem;
    var curPlayingItem = IPTVPlayer.getCurrentItem();
    var count = Math.min(MODAL_EP_VISIBLE, eps.length - app.epModalStart);

    if (count <= 0) {
      listEl.innerHTML = '<div class="empty-col">Bu sezonda bölüm bulunamadı.</div>';
      return;
    }

    for (var i = 0; i < count; i++) {
      var epIdx = app.epModalStart + i;
      var ep = eps[epIdx];
      var isAct = !!(curPlayingItem && String(curPlayingItem.id) === String(ep.id));
      var row = createEpisodeRowElement(ep, epIdx, app.epModalSeasonKey, seriesItem, 'modal-ep-row', i, isAct);
      listEl.appendChild(row);
    }
  }

  function closeEpisodesModal() {
    hideEl('modal-episodes');
    app.activeModal = null;
    SpatNav.popTrap();
    if (app.inFullscreen && app.osdVisible) {
      resetOsdAutoHide();
    }
  }

  /* ========================================================================
     FULLSCREEN PLAYER, SEPARATE LIVE INFO OSD & INTERACTIVE VOD/SERIES OSD
     ======================================================================== */

  function enterFullscreen(explicitItem) {
    var item = explicitItem || IPTVPlayer.getCurrentItem() || app.livePlayingChannel;
    if (!item) { return; }

    hideEl('preview-buffering');
    closeChannelDrawer();
    app.inFullscreen = true;
    showEl('fullscreen-stage');
    IPTVPlayer.mountTo('fullscreen');
    IPTVPlayer.ensurePlaying(true);

    updateOsdMetadata(item);
    showOsd();
  }

  function exitFullscreen() {
    saveCurrentMediaProgress(true);
    closeChannelDrawer();
    hideNextEpCard(true);
    hideOsd();
    hideEl('zap-banner');
    hideEl('fs-buffering');
    hideEl('preview-buffering');
    app.inFullscreen = false;
    hideEl('fullscreen-stage');

    if (IPTVPlayer.isLive()) {
      IPTVPlayer.mountTo('preview');
      if (app.section === 'live' || app.section === 'favorites' || app.section === 'recent') {
        renderLiveChWindow();
        SpatNav.focus(app.liveChNodes[0]);
      }
    } else {
      app.currentSeriesCtx = null;
      IPTVPlayer.stop();
      if (app.inDetail) {
        updateDetailPlayButton();
        if (app.detailItem && app.detailItem.type === 'series') {
          renderSeriesEpisodesWindow();
        }
        SpatNav.focus('btn-detail-play');
      } else {
        if (app.section === 'vod' || app.section === 'series') {
          renderMediaGridWindow();
        }
        SpatNav.focusFirstIn('workspace');
      }
    }
  }

  function renderLiveOsdEpg(item) {
    if (!item) { return; }
    var epg = app.epgCache[item.id] || item.epg || null;
    if (epg && epg.now) {
      $('live-osd-now-title').textContent = epg.now.title || 'Canlı Yayın';
      $('live-osd-now-time').textContent = formatTsHM(epg.now.startTs) + ' - ' + formatTsHM(epg.now.stopTs);
      $('live-osd-now-rem').textContent = calcEpgRemainingText(epg.now);
      $('live-osd-epg-fill').style.width = calcEpgPercent(epg.now) + '%';
      $('live-osd-now-desc').textContent = epg.now.desc || (item.group || 'Canlı televizyon yayını');
      if (epg.next) {
        $('live-osd-next-title').textContent = epg.next.title || '---';
        $('live-osd-next-time').textContent = formatTsHM(epg.next.startTs) + ' - ' + formatTsHM(epg.next.stopTs);
      } else {
        $('live-osd-next-title').textContent = 'Sonraki program bilgisi yok';
        $('live-osd-next-time').textContent = '--:-- - --:--';
      }
    } else {
      $('live-osd-now-title').textContent = item.name || 'Canlı Yayın';
      $('live-osd-now-time').textContent = 'CANLI';
      $('live-osd-now-rem').textContent = '';
      $('live-osd-epg-fill').style.width = '100%';
      $('live-osd-now-desc').textContent = 'Bu kanal için sunucudan yayın akışı (EPG) bilgisi sağlanmıyor.';
      $('live-osd-next-title').textContent = '---';
      $('live-osd-next-time').textContent = '--:-- - --:--';
    }
  }

  function updateOsdMetadata(item) {
    if (!item) { return; }
    var isLive = IPTVPlayer.isLive();
    var tech = IPTVPlayer.getStreamTechInfo();
    var aspInfo = IPTVPlayer.getAspectInfo();
    var isFav = IPTVStorage.isFavorite(isLive ? 'live' : (item.type || 'vod'), item.id);
    updateSleepTimerUI();

    if (isLive) {
      var logoEl = $('live-osd-logo');
      logoEl.onerror = function () {
        if (this.src !== FALLBACK_CH_LOGO) { this.src = FALLBACK_CH_LOGO; }
      };
      logoEl.src = item.logo ? item.logo : FALLBACK_CH_LOGO;

      $('live-osd-num').textContent = item.num ? pad3(item.num) : 'TV';
      $('live-osd-name').textContent = item.name || 'Canlı Yayın';
      $('live-osd-res').textContent = tech.resolution || item.quality || 'HD';
      $('live-osd-format').textContent = tech.format || 'MPEG-TS';
      $('live-osd-group').textContent = item.group || 'Canlı TV';
      $('live-osd-clock').textContent = formatClock(new Date());

      $('losd-btn-aspect').textContent = 'Oran: ' + aspInfo.label;
      $('losd-btn-fav').textContent = isFav ? '★ Favori' : '☆ Favori';
      $('losd-btn-recall').textContent = app.previousLiveChannel
        ? ('↺ ' + pad3(app.previousLiveChannel.num) + ' ' + app.previousLiveChannel.name.substring(0, 12))
        : '↺ Son Kanal (0)';

      renderLiveOsdEpg(item);
      if (!app.epgCache[item.id] && !item.epg) {
        loadAndRenderEpg(item);
      }
      return;
    }

    // VOD & Series OSD
    $('osd-ch-num').textContent = item.type === 'series' ? 'DİZİ' : 'FİLM';
    $('osd-title').textContent = item.name || 'Yayın';
    $('osd-res').textContent = tech.resolution || item.quality || 'HD';
    $('osd-format').textContent = tech.format || 'VOD';
    $('osd-aspect-tag').textContent = aspInfo.label.toUpperCase();
    $('osd-speed-tag').textContent = IPTVPlayer.getPlaybackSpeed() + 'x';
    $('osd-btn-aspect').textContent = 'Oran: ' + aspInfo.label;
    $('osd-btn-speed').textContent = 'Hız: ' + IPTVPlayer.getPlaybackSpeed() + 'x';
    $('osd-btn-fav').textContent = isFav ? '★ Favori' : '☆ Favori';
    $('osd-btn-playpause').textContent = IPTVPlayer.isPaused() ? '▶ Oynat' : '❚❚ Duraklat';

    if (app.currentSeriesCtx) {
      $('osd-epg-line').textContent = app.currentSeriesCtx.seasonKey + '. Sezon · ' +
        (app.currentSeriesCtx.epIndex + 1) + ' / ' + app.currentSeriesCtx.episodes.length + ' Bölüm · ' + (item.group || 'Dizi');
      showEl('osd-btn-episodes');
    } else {
      $('osd-epg-line').textContent = item.group || 'İsteğe Bağlı Yayın (VOD)';
      hideEl('osd-btn-episodes');
    }

    updateSeekBarUI(IPTVPlayer.getCurrentTime(), IPTVPlayer.getDuration());
  }

  function updateSeekBarUI(cur, dur) {
    $('osd-time-cur').textContent = formatTimeSec(cur);
    $('osd-time-dur').textContent = formatTimeSec(dur);
    var pct = 0;
    if (dur > 0 && isFinite(dur)) {
      pct = Math.max(0, Math.min(100, (cur / dur) * 100));
    }
    $('osd-progress-fill').style.width = pct + '%';
    $('osd-progress-thumb').style.left = pct + '%';
  }

  function scrubSeekBarBy(deltaSec) {
    if (IPTVPlayer.isLive()) { return; }
    var dur = IPTVPlayer.getDuration();
    if (!dur || !isFinite(dur)) { return; }
    var target = Math.max(0, Math.min(dur - 1, IPTVPlayer.getCurrentTime() + deltaSec));
    if (IPTVPlayer.seekTo(target)) {
      updateSeekBarUI(target, dur);
      var pct = Math.max(0, Math.min(100, (target / dur) * 100));
      var tip = $('osd-seek-tooltip');
      tip.textContent = formatTimeSec(target);
      tip.style.left = pct + '%';
      showEl(tip);
      saveCurrentMediaProgress(true);
      resetOsdAutoHide();
    }
  }

  function showOsd() {
    if (!app.inFullscreen) { return; }
    closeChannelDrawer();
    app.osdVisible = true;
    var isLive = IPTVPlayer.isLive();

    if (isLive) {
      hideEl('player-osd');
      showEl('live-osd');
      updateOsdMetadata(IPTVPlayer.getCurrentItem());
      SpatNav.focus('losd-btn-drawer');
    } else {
      hideEl('live-osd');
      showEl('player-osd');
      updateOsdMetadata(IPTVPlayer.getCurrentItem());
      SpatNav.focus('osd-btn-playpause');
    }
    resetOsdAutoHide();
  }

  function hideOsd() {
    app.osdVisible = false;
    hideEl('player-osd');
    hideEl('live-osd');
    hideEl('osd-seek-tooltip');
    if (app.osdTimer) {
      window.clearTimeout(app.osdTimer);
      app.osdTimer = null;
    }
  }

  function resetOsdAutoHide() {
    if (app.osdTimer) { window.clearTimeout(app.osdTimer); }
    app.osdTimer = window.setTimeout(function () {
      if (app.inFullscreen && !app.activeModal) {
        hideOsd();
      }
    }, 6000);
  }

  function showZapBanner(numText, nameText) {
    $('zap-number').textContent = numText;
    $('zap-name').textContent = nameText;
    showEl('zap-banner');
    if (app.zapTimer) { window.clearTimeout(app.zapTimer); }
    app.zapTimer = window.setTimeout(function () {
      hideEl('zap-banner');
    }, 3000);
  }

  function switchLiveChannelInPlace(nextCh, optionalIdx) {
    if (!nextCh) { return; }
    setActiveLiveChannel(nextCh);
    if (typeof optionalIdx === 'number' && optionalIdx >= 0) {
      app.liveFocusedChIndex = optionalIdx;
    }
    IPTVPlayer.play(nextCh, true, app.inFullscreen ? 'fullscreen' : 'preview', true);
    IPTVStorage.addRecent(nextCh);
    loadAndRenderEpg(nextCh);

    if (app.inFullscreen) {
      showZapBanner(pad3(nextCh.num), nextCh.name);
      if (app.osdVisible) {
        updateOsdMetadata(nextCh);
        resetOsdAutoHide();
      }
      if (app.drawerOpen) {
        renderDrawerWindow();
      }
    } else {
      hideEl('preview-idle');
      $('preview-ch-label').textContent = pad3(nextCh.num) + '  ' + nextCh.name;
      renderLiveChWindow();
    }
  }

  function zapChannelStep(delta) {
    if (!app.liveFilteredChannels.length) { return; }
    var curIdx = -1;
    var cur = app.livePlayingChannel;
    if (cur) {
      for (var i = 0; i < app.liveFilteredChannels.length; i++) {
        if (app.liveFilteredChannels[i].id === cur.id) {
          curIdx = i;
          break;
        }
      }
    }
    var nextIdx = (curIdx + delta + app.liveFilteredChannels.length) % app.liveFilteredChannels.length;
    switchLiveChannelInPlace(app.liveFilteredChannels[nextIdx], nextIdx);
  }

  function recallPreviousChannel() {
    if (!app.previousLiveChannel) {
      showToast('Önceki kanal kaydı henüz yok.', 'warn');
      return;
    }
    var target = app.previousLiveChannel;
    var idx = -1;
    for (var i = 0; i < app.liveFilteredChannels.length; i++) {
      if (app.liveFilteredChannels[i].id === target.id) {
        idx = i;
        break;
      }
    }
    switchLiveChannelInPlace(target, idx);
    showToast('Son kanala dönüldü: ' + pad3(target.num) + ' ' + target.name);
  }

  function handleNumericZap(digit) {
    if (app.screen !== 'dashboard' || app.activeModal) { return; }
    if (!app.inFullscreen && app.section !== 'live' && app.section !== 'favorites' && app.section !== 'recent') {
      return;
    }
    if (app.inFullscreen && !IPTVPlayer.isLive()) { return; }

    // Pressing '0' with empty buffer triggers instant Recall (Last Channel)
    if (digit === 0 && app.digitBuffer === '') {
      recallPreviousChannel();
      return;
    }

    if (app.digitBuffer.length >= 4) {
      app.digitBuffer = '';
    }
    app.digitBuffer += String(digit);

    if (app.inFullscreen) {
      showZapBanner(app.digitBuffer, 'Kanal numarasına geçiliyor...');
    } else {
      showToast('Kanal No: ' + app.digitBuffer);
    }

    if (app.digitTimer) { window.clearTimeout(app.digitTimer); }
    app.digitTimer = window.setTimeout(commitNumericZap, 2000);
  }

  function commitNumericZap() {
    if (!app.digitBuffer) { return; }
    var targetNum = parseInt(app.digitBuffer, 10);
    app.digitBuffer = '';
    if (app.digitTimer) {
      window.clearTimeout(app.digitTimer);
      app.digitTimer = null;
    }
    var found = null;
    for (var i = 0; i < app.data.liveChannels.length; i++) {
      if (app.data.liveChannels[i].num === targetNum) {
        found = app.data.liveChannels[i];
        break;
      }
    }
    if (!found) {
      showToast('Kanal #' + targetNum + ' bulunamadı.', 'warn');
      return;
    }
    switchLiveChannelInPlace(found, -1);
  }

  /* ========================================================================
     SEARCH
     ======================================================================== */

  function runSearch() {
    var q = $('inp-search').value.replace(/^\s+|\s+$/g, '').toLowerCase();
    var results = [];
    var i, item;

    if (app.searchFilter === 'all' || app.searchFilter === 'live') {
      for (i = 0; i < app.data.liveChannels.length && results.length < 40; i++) {
        item = app.data.liveChannels[i];
        if (!q || item.name.toLowerCase().indexOf(q) !== -1 || item.group.toLowerCase().indexOf(q) !== -1) {
          results.push({ type: 'live', label: 'CANLI TV', item: item });
        }
      }
    }
    if (app.searchFilter === 'all' || app.searchFilter === 'vod') {
      for (i = 0; i < app.data.vodItems.length && results.length < 60; i++) {
        item = app.data.vodItems[i];
        if (!q || item.name.toLowerCase().indexOf(q) !== -1 || item.group.toLowerCase().indexOf(q) !== -1) {
          results.push({ type: 'vod', label: 'FİLM', item: item });
        }
      }
    }
    if (app.searchFilter === 'all' || app.searchFilter === 'series') {
      for (i = 0; i < app.data.seriesItems.length && results.length < 80; i++) {
        item = app.data.seriesItems[i];
        if (!q || item.name.toLowerCase().indexOf(q) !== -1 || item.group.toLowerCase().indexOf(q) !== -1) {
          results.push({ type: 'series', label: 'DİZİ', item: item });
        }
      }
    }

    app.searchResults = results;
    $('search-count').textContent = results.length + ' sonuç';

    var box = $('search-results');
    box.innerHTML = '';
    if (results.length === 0) {
      box.innerHTML = '<div class="empty-col">Aramanızla eşleşen içerik bulunamadı.</div>';
      return;
    }

    for (i = 0; i < results.length && i < 11; i++) {
      (function (entry) {
        var row = document.createElement('div');
        row.className = 'search-result-row';
        row.setAttribute('data-focusable', 'true');
        row.setAttribute('data-zone', 'search');
        row.innerHTML = '<span class="sr-type"></span><span class="sr-title"></span><span class="sr-group"></span>';
        row.querySelector('.sr-type').textContent = entry.label;
        row.querySelector('.sr-title').textContent = entry.item.name;
        row.querySelector('.sr-group').textContent = entry.item.group || '';
        row.onclick = function () {
          if (entry.type === 'live') {
            setActiveLiveChannel(entry.item);
            IPTVPlayer.play(entry.item, true, 'fullscreen', true);
            IPTVStorage.addRecent(entry.item);
            enterFullscreen(entry.item);
          } else {
            openMediaDetail(entry.item);
          }
        };
        box.appendChild(row);
      })(results[i]);
    }
  }

  /* ========================================================================
     SETTINGS, ACCOUNT INFO CARD & PARENTAL CONTROL
     ======================================================================== */

  function renderSettingsView() {
    var s = IPTVStorage.getSettings();
    var fmtLabel = s.liveFormat === 'hls' ? 'HLS (.m3u8)' : (s.liveFormat === 'auto' ? 'Otomatik (TS→HLS)' : 'MPEG-TS (.ts)');
    $('val-liveformat').textContent = fmtLabel;

    var off = s.epgOffsetHours || 0;
    $('val-epgoffset').textContent = (off > 0 ? ('+' + off) : String(off)) + ' saat';
    $('val-startup-live').textContent = s.startupLiveFullscreen ? 'AÇIK' : 'KAPALI';
    updateSleepTimerUI();

    $('val-reconnect').textContent = s.autoReconnect ? 'AÇIK' : 'KAPALI';
    $('val-autopreview').textContent = s.autoPreview ? 'AÇIK' : 'KAPALI';
    $('val-buffer').textContent = s.bufferSeconds + ' sn';
    $('val-parental').textContent = s.parentalEnabled ? 'AÇIK' : 'KAPALI';
    $('val-pin-display').textContent = '****';

    // Account & Subscription Info Card
    var info = app.data.accountInfo;
    var profName = app.activeProfile ? app.activeProfile.name : 'Liste';
    if (info) {
      $('acc-user-status').textContent = (info.username || profName) + ' · ' + (info.status || 'Active');
      if (info.expTs) {
        var remDays = Math.ceil((info.expTs - new Date().getTime()) / 86400000);
        $('acc-expiry').textContent = formatShortDateTR(info.expTs) + (remDays >= 0 ? (' (' + remDays + ' gün)') : ' (Doldu)');
      } else {
        $('acc-expiry').textContent = 'Sınırsız';
      }
      $('acc-conns').textContent = (info.activeCons || '0') + ' / ' + (info.maxConnections || '1') + ' cihaz';
    } else {
      $('acc-user-status').textContent = profName + ' · Aktif';
      $('acc-expiry').textContent = app.data.sourceType === 'm3u' ? 'M3U URL Listesi' : '---';
      $('acc-conns').textContent = '---';
    }
    $('acc-counts').textContent = app.data.liveChannels.length + ' TV · ' +
      app.data.vodItems.length + ' Film · ' + app.data.seriesItems.length + ' Dizi';

    // Category hiding list
    var box = $('settings-hide-cats');
    box.innerHTML = '';
    for (var i = 0; i < app.data.liveCategories.length && i < 7; i++) {
      (function (cat) {
        var isHidden = IPTVStorage.isCategoryHidden(cat.name);
        var row = document.createElement('div');
        row.className = 'hide-cat-row';
        row.setAttribute('data-focusable', 'true');
        row.setAttribute('data-zone', 'settings');
        row.innerHTML = '<span class="cat-name"></span><span class="hide-cat-status"></span>';
        row.firstChild.textContent = cat.name + ' (' + cat.count + ')';
        row.lastChild.textContent = isHidden ? 'GİZLİ' : 'GÖRÜNÜR';
        setClassFlag(row.lastChild, 'is-hidden-cat', isHidden);
        row.onclick = function () {
          var nextHidden = IPTVStorage.toggleCategoryHidden(cat.name);
          row.lastChild.textContent = nextHidden ? 'GİZLİ' : 'GÖRÜNÜR';
          setClassFlag(row.lastChild, 'is-hidden-cat', nextHidden);
          showToast(cat.name + (nextHidden ? ' gizlendi.' : ' tekrar görünür yapıldı.'));
        };
        box.appendChild(row);
      })(app.data.liveCategories[i]);
    }
  }

  /* ========================================================================
     MODALS (RESUME, PIN, TRACK SELECTOR, EXIT CONFIRM)
     ======================================================================== */

  function openResumeModal() {
    app.activeModal = 'resume';
    showEl('modal-resume');
    SpatNav.pushTrap('modal-resume', $('btn-resume-continue'));
  }

  function closeResumeModal() {
    hideEl('modal-resume');
    app.activeModal = null;
    app.pendingResumeData = null;
    SpatNav.popTrap();
  }

  function openPinModal(mode, title, desc, onSuccess) {
    app.activeModal = 'pin';
    app.pinMode = mode;
    app.pinBuffer = '';
    app.pinSuccessCallback = onSuccess || null;
    $('modal-pin-title').textContent = title || 'Ebeveyn Kontrolü PIN';
    $('modal-pin-desc').textContent = desc || '4 haneli PIN kodunu girin.';
    updatePinDots();
    showEl('modal-pin');
    SpatNav.pushTrap('modal-pin', document.querySelector('#modal-pin .pin-key'));
  }

  function closePinModal() {
    hideEl('modal-pin');
    app.activeModal = null;
    app.pinBuffer = '';
    SpatNav.popTrap();
  }

  function updatePinDots() {
    var dots = document.querySelectorAll('#pin-dots .pin-dot');
    for (var i = 0; i < dots.length; i++) {
      setClassFlag(dots[i], 'is-filled', i < app.pinBuffer.length);
    }
  }

  function handlePinInput(val) {
    if (val === 'cancel') {
      closePinModal();
      return;
    }
    if (val === 'clear') {
      app.pinBuffer = app.pinBuffer.slice(0, -1);
      updatePinDots();
      return;
    }
    if (app.pinBuffer.length >= 4) { return; }
    app.pinBuffer += String(val);
    updatePinDots();

    if (app.pinBuffer.length === 4) {
      var entered = app.pinBuffer;
      var savedPin = IPTVStorage.getSettings().parentalPin || '0000';
      if (app.pinMode === 'change') {
        IPTVStorage.updateSetting('parentalPin', entered);
        closePinModal();
        showToast('Yeni Ebeveyn PIN kodu kaydedildi.');
      } else {
        if (entered === savedPin) {
          var cb = app.pinSuccessCallback;
          closePinModal();
          if (cb) { cb(); }
        } else {
          app.pinBuffer = '';
          updatePinDots();
          showToast('Hatalı PIN kodu! Tekrar deneyin.', 'error');
        }
      }
    }
  }

  function openTrackModal(title, items, onPick) {
    app.activeModal = 'tracks';
    $('modal-tracks-title').textContent = title;
    var listEl = $('modal-tracks-list');
    listEl.innerHTML = '';

    for (var i = 0; i < items.length; i++) {
      (function (opt) {
        var btn = document.createElement('button');
        btn.className = 'track-option' + (opt.active ? ' is-active' : '');
        btn.textContent = (opt.active ? '✓ ' : '   ') + opt.label;
        btn.setAttribute('data-focusable', 'true');
        btn.setAttribute('data-zone', 'modal-tracks');
        btn.onclick = function () {
          closeTrackModal();
          onPick(opt);
        };
        listEl.appendChild(btn);
      })(items[i]);
    }

    showEl('modal-tracks');
    SpatNav.pushTrap('modal-tracks');
  }

  function closeTrackModal() {
    hideEl('modal-tracks');
    app.activeModal = null;
    SpatNav.popTrap();
    if (app.inFullscreen && app.osdVisible) {
      resetOsdAutoHide();
    }
  }

  function openExitModal() {
    app.activeModal = 'exit';
    showEl('modal-exit');
    SpatNav.pushTrap('modal-exit', $('btn-exit-cancel'));
  }

  function closeExitModal() {
    hideEl('modal-exit');
    app.activeModal = null;
    SpatNav.popTrap();
  }

  function exitApplication() {
    saveCurrentMediaProgress(true);
    IPTVPlayer.stop();
    try {
      if (window.webOS && typeof window.webOS.platformBack === 'function') {
        window.webOS.platformBack();
        return;
      }
    } catch (e) {}
    try {
      window.close();
    } catch (e2) {}
    closeExitModal();
    showToast('TV üzerinde uygulama kapatılır (webOS.platformBack).');
  }

  /* ========================================================================
     VIRTUAL WINDOWING BOUNDARY HANDLER FOR SPATNAV
     ======================================================================== */

  function onSpatNavBoundary(direction, currentEl) {
    var zone = currentEl.getAttribute('data-zone');
    var slot = parseInt(currentEl.getAttribute('data-slot'), 10);

    // 1. Live Categories vertical virtual scrolling
    if (zone === 'live-cat') {
      if (direction === 'up' && slot === 0 && app.liveCatStart > 0) {
        app.liveCatStart--;
        renderLiveCatWindow();
        return true;
      }
      if (direction === 'down' && slot === CAT_VISIBLE_COUNT - 1 && (app.liveCatStart + CAT_VISIBLE_COUNT) < app.liveCatList.length) {
        app.liveCatStart++;
        renderLiveCatWindow();
        return true;
      }
    }

    // 2. Live Channels vertical virtual scrolling (supports 10,000+ channels seamlessly)
    if (zone === 'live-ch') {
      if (direction === 'up' && slot === 0 && app.liveChStart > 0) {
        app.liveChStart--;
        renderLiveChWindow();
        handleChannelFocus(app.liveFilteredChannels[app.liveChStart], app.liveChStart, 'key');
        return true;
      }
      if (direction === 'down' && slot === CH_VISIBLE_COUNT - 1 && (app.liveChStart + CH_VISIBLE_COUNT) < app.liveFilteredChannels.length) {
        app.liveChStart++;
        renderLiveChWindow();
        var focusIdx = app.liveChStart + slot;
        handleChannelFocus(app.liveFilteredChannels[focusIdx], focusIdx, 'key');
        return true;
      }
    }

    // 3. Fullscreen Quick Channel Drawer vertical virtual scrolling (strictly clamped)
    if (zone === 'drawer-ch') {
      if (direction === 'up' && slot === 0) {
        if (app.drawerStart > 0) {
          app.drawerStart--;
          renderDrawerWindow();
          $('drawer-cat-count').textContent = (app.drawerStart + 1) + ' / ' + app.liveFilteredChannels.length;
        }
        return true;
      }
      if (direction === 'down') {
        if (slot === DRAWER_VISIBLE_COUNT - 1 && (app.drawerStart + DRAWER_VISIBLE_COUNT) < app.liveFilteredChannels.length) {
          app.drawerStart++;
          renderDrawerWindow();
          $('drawer-cat-count').textContent = (app.drawerStart + slot + 1) + ' / ' + app.liveFilteredChannels.length;
          return true;
        }
        if ((app.drawerStart + slot) >= app.liveFilteredChannels.length - 1) {
          return true;
        }
      }
    }

    // 4. Media Categories virtual scrolling
    if (zone === 'media-cat') {
      if (direction === 'up' && slot === 0 && app.mediaCatStart > 0) {
        app.mediaCatStart--;
        renderMediaCatWindow();
        return true;
      }
      if (direction === 'down' && slot === CAT_VISIBLE_COUNT - 1 && (app.mediaCatStart + CAT_VISIBLE_COUNT) < app.mediaCatList.length) {
        app.mediaCatStart++;
        renderMediaCatWindow();
        return true;
      }
    }

    // 5. Media Poster Grid virtual scrolling (5 columns x 3 rows)
    if (zone === 'media-grid') {
      var row = Math.floor(slot / GRID_COLS);
      var totalRows = Math.ceil(app.mediaFilteredItems.length / GRID_COLS);
      if (direction === 'up' && row === 0 && app.mediaRowStart > 0) {
        app.mediaRowStart--;
        renderMediaGridWindow();
        return true;
      }
      if (direction === 'down' && row === GRID_ROWS - 1 && (app.mediaRowStart + GRID_ROWS) < totalRows) {
        app.mediaRowStart++;
        renderMediaGridWindow();
        var nextIdx = app.mediaRowStart * GRID_COLS + slot;
        if (nextIdx >= app.mediaFilteredItems.length) {
          var lastVisibleSlot = app.mediaFilteredItems.length - 1 - app.mediaRowStart * GRID_COLS;
          if (lastVisibleSlot >= 0) {
            SpatNav.focus(app.mediaGridNodes[lastVisibleSlot]);
          }
        }
        return true;
      }
    }

    // 6. Detail Episodes vertical virtual scrolling
    if (zone === 'detail-ep') {
      if (direction === 'up' && slot === 0 && app.detailEpStart > 0) {
        app.detailEpStart--;
        renderSeriesEpisodesWindow();
        var topRow = document.querySelector('#detail-episodes-list .episode-row');
        if (topRow) { SpatNav.focus(topRow); }
        return true;
      }
      if (direction === 'down' && slot === DETAIL_EP_VISIBLE - 1 && (app.detailEpStart + DETAIL_EP_VISIBLE) < app.detailEpisodes.length) {
        app.detailEpStart++;
        renderSeriesEpisodesWindow();
        var allDetailRows = document.querySelectorAll('#detail-episodes-list .episode-row');
        if (allDetailRows.length > 0) { SpatNav.focus(allDetailRows[allDetailRows.length - 1]); }
        return true;
      }
    }

    // 7. In-Player Episodes Modal vertical virtual scrolling
    if (zone === 'modal-ep-row') {
      if (direction === 'up' && slot === 0 && app.epModalStart > 0) {
        app.epModalStart--;
        renderEpisodesModalList();
        var topModalRow = document.querySelector('#ep-modal-list .ep-modal-row');
        if (topModalRow) { SpatNav.focus(topModalRow); }
        return true;
      }
      if (direction === 'down' && slot === MODAL_EP_VISIBLE - 1 && (app.epModalStart + MODAL_EP_VISIBLE) < app.epModalEpisodes.length) {
        app.epModalStart++;
        renderEpisodesModalList();
        var allModalRows = document.querySelectorAll('#ep-modal-list .ep-modal-row');
        if (allModalRows.length > 0) { SpatNav.focus(allModalRows[allModalRows.length - 1]); }
        return true;
      }
    }

    return false;
  }

  function onSpatNavFocusChange(el, source) {
    if (!el) { return; }
    var zone = el.getAttribute('data-zone');
    if (zone === 'live-ch') {
      var slot = parseInt(el.getAttribute('data-slot'), 10);
      var idx = app.liveChStart + slot;
      if (idx >= 0 && idx < app.liveFilteredChannels.length) {
        handleChannelFocus(app.liveFilteredChannels[idx], idx, source);
      }
    } else if (zone === 'drawer-ch') {
      var dSlot = parseInt(el.getAttribute('data-slot'), 10);
      var dIdx = app.drawerStart + dSlot;
      if (dIdx >= 0 && dIdx < app.liveFilteredChannels.length) {
        $('drawer-cat-count').textContent = (dIdx + 1) + ' / ' + app.liveFilteredChannels.length;
      }
    } else if ((zone === 'osd' || zone === 'live-osd') && app.osdVisible) {
      resetOsdAutoHide();
      if (el.id !== 'osd-seek-bar') {
        hideEl('osd-seek-tooltip');
      }
    }
  }

  /* ========================================================================
     HIERARCHICAL BACK & LG REMOTE KEYMAP
     ======================================================================== */

  function handleBackAction() {
    if (app.activeModal === 'pin') { closePinModal(); return; }
    if (app.activeModal === 'tracks') { closeTrackModal(); return; }
    if (app.activeModal === 'resume') { closeResumeModal(); return; }
    if (app.activeModal === 'episodes') { closeEpisodesModal(); return; }
    if (app.activeModal === 'exit') { closeExitModal(); return; }

    if (app.inFullscreen) {
      if (app.drawerOpen) {
        closeChannelDrawer();
        return;
      }
      if (app.osdVisible) {
        hideOsd();
        return;
      }
      if (app.nextEpVisible) {
        hideNextEpCard(true);
        return;
      }
      exitFullscreen();
      return;
    }

    if (app.inDetail) {
      closeMediaDetail();
      return;
    }
    if (app.screen === 'manager') {
      if (app.activeProfile && app.data.liveChannels.length > 0) {
        openDashboard();
      } else {
        openExitModal();
      }
      return;
    }
    if (app.screen === 'dashboard' && app.section !== 'live') {
      switchSection('live');
      return;
    }
    openExitModal();
  }

  function toggleFavoriteShortcut() {
    if (app.inFullscreen) {
      var cur = IPTVPlayer.getCurrentItem();
      if (!cur) { return; }
      var t = IPTVPlayer.isLive() ? 'live' : (cur.type || 'vod');
      var added = IPTVStorage.toggleFavorite(t, cur.id);
      showToast(added ? (cur.name + ' favorilere eklendi.') : (cur.name + ' favorilerden çıkarıldı.'));
      if (app.osdVisible) { updateOsdMetadata(cur); }
      if (app.drawerOpen) { renderDrawerWindow(); }
      return;
    }
    var focused = SpatNav.getCurrent();
    if (!focused) { return; }
    var zone = focused.getAttribute('data-zone');
    if (zone === 'live-ch') {
      var idx = app.liveChStart + parseInt(focused.getAttribute('data-slot'), 10);
      var ch = app.liveFilteredChannels[idx];
      if (ch) {
        var ok = IPTVStorage.toggleFavorite('live', ch.id);
        showToast(ok ? (ch.name + ' favorilere eklendi.') : (ch.name + ' favorilerden çıkarıldı.'));
        buildLiveCategoryModel();
        renderLiveChWindow();
      }
    } else if (zone === 'media-grid') {
      var mIdx = app.mediaRowStart * GRID_COLS + parseInt(focused.getAttribute('data-slot'), 10);
      var item = app.mediaFilteredItems[mIdx];
      if (item) {
        var addedM = IPTVStorage.toggleFavorite(item.type, item.id);
        showToast(addedM ? (item.name + ' favorilere eklendi.') : (item.name + ' favorilerden çıkarıldı.'));
      }
    }
  }

  function handleKeyDown(e) {
    var code = e.keyCode || e.which;
    var activeTag = document.activeElement ? document.activeElement.tagName : '';
    var editingInput = (activeTag === 'INPUT' || activeTag === 'TEXTAREA');

    // Allow text typing inside focused inputs while keeping Up/Down/Escape/Back functional
    if (editingInput) {
      if (code === 13) {
        e.preventDefault();
        try { document.activeElement.blur(); } catch (err) {}
        if (document.activeElement && document.activeElement.id === 'inp-search') {
          runSearch();
        }
        return;
      }
      if (code === 38 || code === 40) {
        e.preventDefault();
        try { document.activeElement.blur(); } catch (err2) {}
        SpatNav.move(code === 38 ? 'up' : 'down');
        return;
      }
      if (code === 461 || code === 27) {
        e.preventDefault();
        try { document.activeElement.blur(); } catch (err3) {}
        handleBackAction();
        return;
      }
      return;
    }

    // Prevent default TV browser scroll / history behavior on all remote keys
    if (code === 37 || code === 38 || code === 39 || code === 40 || code === 13 ||
        code === 461 || code === 8 || code === 27 ||
        (code >= 403 && code <= 406) || (code >= 48 && code <= 57) ||
        (code >= 96 && code <= 105) ||
        code === 415 || code === 19 || code === 413 || code === 417 || code === 412 ||
        code === 427 || code === 428) {
      e.preventDefault();
    }

    // BACK (LG 461, Backspace 8, ESC 27)
    if (code === 461 || code === 8 || code === 27) {
      handleBackAction();
      return;
    }

    // Numeric keys 0-9 (PIN modal OR Live TV channel number zapping / 0 = Recall)
    if ((code >= 48 && code <= 57) || (code >= 96 && code <= 105)) {
      var digit = (code >= 96) ? (code - 96) : (code - 48);
      if (app.activeModal === 'pin') {
        handlePinInput(String(digit));
      } else {
        handleNumericZap(digit);
      }
      return;
    }

    // Modal active -> restrict keys strictly to modal navigation
    if (app.activeModal) {
      if (code === 37) { SpatNav.move('left'); }
      else if (code === 38) { SpatNav.move('up'); }
      else if (code === 39) { SpatNav.move('right'); }
      else if (code === 40) { SpatNav.move('down'); }
      else if (code === 13) { activateCurrentFocus(); }
      return;
    }

    // FULLSCREEN KEY HANDLING
    if (app.inFullscreen) {
      var isLive = IPTVPlayer.isLive();

      // Quick Channel Drawer open -> route keys directly to drawer
      if (app.drawerOpen) {
        if (code === 38) { SpatNav.move('up'); }
        else if (code === 40) { SpatNav.move('down'); }
        else if (code === 39) { closeChannelDrawer(); }
        else if (code === 13) { activateCurrentFocus(); }
        return;
      }

      if (code === 427) { if (isLive) { zapChannelStep(-1); } return; } // Channel Up
      if (code === 428) { if (isLive) { zapChannelStep(1); } return; }  // Channel Down
      if (code === 415) { // Play
        if (!isLive) {
          IPTVPlayer.setPaused(false);
          if (app.osdVisible) { updateOsdMetadata(IPTVPlayer.getCurrentItem()); }
        }
        return;
      }
      if (code === 19) { // Pause
        if (!isLive) {
          IPTVPlayer.setPaused(true);
          saveCurrentMediaProgress(true);
          showOsd();
        }
        return;
      }
      if (code === 413) { exitFullscreen(); return; } // Stop
      if (code === 417) { // FastForward
        if (!isLive && IPTVPlayer.seekBy(30)) {
          showOsd();
          updateSeekBarUI(IPTVPlayer.getCurrentTime(), IPTVPlayer.getDuration());
        }
        return;
      }
      if (code === 412) { // Rewind
        if (!isLive && IPTVPlayer.seekBy(-30)) {
          showOsd();
          updateSeekBarUI(IPTVPlayer.getCurrentTime(), IPTVPlayer.getDuration());
        }
        return;
      }
      if (code === 403) { toggleFavoriteShortcut(); return; } // Red: Favorite
      if (code === 406) { // Blue: Cycle Aspect Ratio
        var asp = IPTVPlayer.cycleAspectRatio();
        showToast('En-Boy Oranı: ' + asp.label);
        if (app.osdVisible) { updateOsdMetadata(IPTVPlayer.getCurrentItem()); }
        return;
      }

      // Fullscreen OSD CLOSED
      if (!app.osdVisible) {
        // If Auto-Next card is visible and user focuses its buttons
        var curFoc = SpatNav.getCurrent();
        var inNextEp = app.nextEpVisible && curFoc && curFoc.getAttribute('data-zone') === 'next-ep';
        if (inNextEp) {
          if (code === 37) { moveFocusInRow('next-ep-card', '.btn-sm', -1); return; }
          if (code === 39) { moveFocusInRow('next-ep-card', '.btn-sm', 1); return; }
          if (code === 13) { activateCurrentFocus(); return; }
        }

        if (code === 13) {
          if (app.digitBuffer) {
            commitNumericZap();
          } else {
            showOsd();
          }
          return;
        }
        if (code === 38 || code === 40) {
          if (isLive) {
            zapChannelStep(code === 38 ? -1 : 1);
          } else if (app.nextEpVisible) {
            SpatNav.focus('btn-next-ep-now');
          } else {
            showOsd();
          }
          return;
        }
        if (code === 37) {
          if (isLive) {
            openChannelDrawer();
          } else {
            showOsd();
            scrubSeekBarBy(-10);
          }
          return;
        }
        if (code === 39) {
          if (isLive) {
            showOsd();
          } else {
            showOsd();
            scrubSeekBarBy(10);
          }
          return;
        }
        return;
      }

      // Fullscreen OSD OPEN
      resetOsdAutoHide();
      if (isLive) {
        // Live Info OSD: horizontal utility buttons strictly clamped inside #live-osd
        if (code === 37) { moveFocusInRow('live-osd', '.osd-btn', -1); }
        else if (code === 39) { moveFocusInRow('live-osd', '.osd-btn', 1); }
        else if (code === 38 || code === 40) { hideOsd(); }
        else if (code === 13) { activateCurrentFocus(); }
        return;
      }

      // VOD / Series OSD with Interactive Seek Bar
      var focusedEl = SpatNav.getCurrent();
      var onSeekBar = focusedEl && focusedEl.id === 'osd-seek-bar';
      if (onSeekBar) {
        if (code === 37) { scrubSeekBarBy(-15); }
        else if (code === 39) { scrubSeekBarBy(15); }
        else if (code === 40) {
          hideEl('osd-seek-tooltip');
          SpatNav.focus('osd-btn-playpause');
        }
        else if (code === 38) { hideOsd(); }
        else if (code === 13) {
          var nowPlaying = IPTVPlayer.togglePlayPause();
          $('osd-btn-playpause').textContent = nowPlaying ? '❚❚ Duraklat' : '▶ Oynat';
          if (!nowPlaying) { saveCurrentMediaProgress(true); }
        }
        return;
      }

      // Bottom buttons in VOD/Series OSD: strictly clamped horizontally, Up moves onto seek bar!
      if (code === 37) { moveFocusInRow('player-osd', '.osd-btn', -1); }
      else if (code === 39) { moveFocusInRow('player-osd', '.osd-btn', 1); }
      else if (code === 38) {
        SpatNav.focus('osd-seek-bar');
        var dNow = IPTVPlayer.getDuration();
        var cNow = IPTVPlayer.getCurrentTime();
        if (dNow > 0) {
          var tipEl = $('osd-seek-tooltip');
          tipEl.textContent = formatTimeSec(cNow);
          tipEl.style.left = Math.max(0, Math.min(100, (cNow / dNow) * 100)) + '%';
          showEl(tipEl);
        }
      }
      else if (code === 40) { hideOsd(); }
      else if (code === 13) { activateCurrentFocus(); }
      return;
    }

    // DASHBOARD COLOR SHORTCUTS
    if (app.screen === 'dashboard') {
      if (code === 403) { toggleFavoriteShortcut(); return; } // Red: Favorite
      if (code === 404) { switchSection('search'); return; }  // Green: Quick Search
      if (code === 405) { // Yellow: Focus Category Column
        if (app.section === 'live' || app.section === 'favorites' || app.section === 'recent') {
          SpatNav.focus(app.liveCatNodes[0]);
        } else if (app.section === 'vod' || app.section === 'series') {
          SpatNav.focus(app.mediaCatNodes[0]);
        }
        return;
      }
      if (code === 406) { switchSection('settings'); return; } // Blue: Settings
      if (code === 427) { zapChannelStep(-1); return; }
      if (code === 428) { zapChannelStep(1); return; }
    }

    // STANDARD SPATIAL NAVIGATION
    if (code === 37) { SpatNav.move('left'); }
    else if (code === 38) { SpatNav.move('up'); }
    else if (code === 39) { SpatNav.move('right'); }
    else if (code === 40) { SpatNav.move('down'); }
    else if (code === 13) { activateCurrentFocus(); }
  }

  function moveFocusInRow(containerId, selector, delta) {
    var box = $(containerId);
    if (!box) { return; }
    var all = box.querySelectorAll(selector);
    var visible = [];
    for (var i = 0; i < all.length; i++) {
      if (SpatNav.isVisible(all[i])) {
        visible.push(all[i]);
      }
    }
    if (visible.length === 0) { return; }
    var cur = SpatNav.getCurrent();
    var idx = -1;
    for (var j = 0; j < visible.length; j++) {
      if (visible[j] === cur) { idx = j; break; }
    }
    if (idx === -1) {
      SpatNav.focus(visible[0]);
      return;
    }
    var nextIdx = idx + delta;
    if (nextIdx < 0) { nextIdx = 0; }
    if (nextIdx >= visible.length) { nextIdx = visible.length - 1; }
    SpatNav.focus(visible[nextIdx]);
  }

  function activateCurrentFocus() {
    var el = SpatNav.getCurrent();
    if (!el) { return; }
    if (el.tagName === 'INPUT') {
      try { el.focus(); } catch (e) {}
      return;
    }
    if (typeof el.click === 'function') {
      el.click();
    }
  }

  /* ========================================================================
     UI EVENT BINDINGS
     ======================================================================== */

  function bindStaticEvents() {
    // Manager controls
    $('tab-xtream').onclick = function () { setManagerTab('xtream'); };
    $('tab-m3u').onclick = function () { setManagerTab('m3u'); };
    $('btn-load-demo').onclick = loadDemoProfile;

    function persistCorsProxyField() {
      if (!$('inp-cors-proxy')) { return; }
      var val = $('inp-cors-proxy').value.replace(/^\s+|\s+$/g, '');
      IPTVStorage.updateSetting('corsProxy', val);
    }

    if ($('inp-cors-proxy')) {
      $('inp-cors-proxy').onchange = persistCorsProxyField;
      $('inp-cors-proxy').onblur = persistCorsProxyField;
    }

    $('btn-save-connect').onclick = function () {
      persistCorsProxyField();
      var prof = collectFormProfile();
      if (!prof) { return; }
      var saved = IPTVStorage.saveProfile(prof);
      resetManagerForm();
      renderProfileList();
      connectProfile(saved);
    };

    $('btn-save-only').onclick = function () {
      persistCorsProxyField();
      var prof = collectFormProfile();
      if (!prof) { return; }
      IPTVStorage.saveProfile(prof);
      resetManagerForm();
      renderProfileList();
      showToast('Hesap başarıyla kaydedildi.');
    };

    $('btn-cancel-edit').onclick = function () {
      resetManagerForm();
      SpatNav.focus('tab-xtream');
    };

    // Sidebar navigation
    var navBtns = document.querySelectorAll('.nav-btn');
    for (var i = 0; i < navBtns.length; i++) {
      (function (btn) {
        btn.onclick = function () {
          switchSection(btn.getAttribute('data-nav'));
        };
      })(navBtns[i]);
    }

    // Preview box click/OK -> Fullscreen
    $('preview-box').onclick = function () {
      if (app.livePlayingChannel && IPTVPlayer.getCurrentItem()) {
        IPTVPlayer.ensurePlaying(true);
        enterFullscreen(app.livePlayingChannel);
      } else if (app.liveFilteredChannels.length > 0) {
        var ch = app.liveFilteredChannels[app.liveFocusedChIndex] || app.liveFilteredChannels[0];
        startLivePreview(ch, true);
        enterFullscreen(ch);
      }
    };

    // Detail actions
    $('btn-detail-play').onclick = function () {
      if (!app.detailItem) { return; }
      if (app.detailItem.type === 'series' && app.detailItem.seasons) {
        var eps = app.detailItem.seasons[app.detailSeasonKey] || [];
        if (eps.length > 0) {
          var ctx = {
            seriesItem: app.detailItem,
            seasonKey: app.detailSeasonKey,
            episodes: eps,
            epIndex: 0
          };
          requestPlayVodOrEpisode(buildEpisodeMediaObj(app.detailItem, app.detailSeasonKey, eps[0]), ctx);
        } else {
          showToast('Oynatılacak bölüm bulunamadı.', 'warn');
        }
      } else {
        requestPlayVodOrEpisode(app.detailItem, null);
      }
    };

    $('btn-detail-fav').onclick = function () {
      if (!app.detailItem) { return; }
      var added = IPTVStorage.toggleFavorite(app.detailItem.type, app.detailItem.id);
      updateDetailFavButton();
      showToast(added ? 'Favorilere eklendi.' : 'Favorilerden çıkarıldı.');
    };

    $('btn-detail-back').onclick = closeMediaDetail;

    // Search bindings
    $('inp-search').oninput = runSearch;
    $('btn-search-clear').onclick = function () {
      $('inp-search').value = '';
      runSearch();
      SpatNav.focus('inp-search');
    };
    var sfilts = document.querySelectorAll('.filter-tab');
    for (var f = 0; f < sfilts.length; f++) {
      (function (btn) {
        btn.onclick = function () {
          app.searchFilter = btn.getAttribute('data-sfilt');
          for (var j = 0; j < sfilts.length; j++) {
            setClassFlag(sfilts[j], 'is-active', sfilts[j] === btn);
          }
          runSearch();
        };
      })(sfilts[f]);
    }

    // Settings bindings
    $('set-liveformat').onclick = function () {
      var modes = ['ts', 'auto', 'hls'];
      var cur = IPTVStorage.getSettings().liveFormat || 'ts';
      var next = modes[(modes.indexOf(cur) + 1) % modes.length];
      IPTVStorage.updateSetting('liveFormat', next);
      renderSettingsView();
      showToast('Canlı yayın formatı: ' + (next === 'hls' ? 'HLS (.m3u8)' : (next === 'auto' ? 'Otomatik (TS→HLS)' : 'MPEG-TS (.ts)')));
    };
    $('set-epgoffset').onclick = function () {
      var steps = [0, 1, 2, 3, -3, -2, -1];
      var cur = IPTVStorage.getSettings().epgOffsetHours || 0;
      var idx = steps.indexOf(cur);
      var next = steps[(idx + 1) % steps.length];
      IPTVStorage.updateSetting('epgOffsetHours', next);
      renderSettingsView();
      showToast('EPG saat farkı: ' + (next > 0 ? ('+' + next) : String(next)) + ' saat');
    };
    $('set-startup-live').onclick = function () {
      var cur = !!IPTVStorage.getSettings().startupLiveFullscreen;
      IPTVStorage.updateSetting('startupLiveFullscreen', !cur);
      renderSettingsView();
      showToast(!cur ? 'Açılışta son kanal tam ekran başlatılacak.' : 'Açılışta ana menü açılacak.');
    };
    $('set-sleep').onclick = function () {
      cycleSleepTimer();
      renderSettingsView();
    };
    $('set-reconnect').onclick = function () {
      var cur = IPTVStorage.getSettings().autoReconnect;
      IPTVStorage.updateSetting('autoReconnect', !cur);
      renderSettingsView();
    };
    $('set-autopreview').onclick = function () {
      var cur = IPTVStorage.getSettings().autoPreview;
      IPTVStorage.updateSetting('autoPreview', !cur);
      renderSettingsView();
    };
    $('set-buffer').onclick = function () {
      var steps = [2, 5, 10, 15];
      var cur = IPTVStorage.getSettings().bufferSeconds;
      var next = steps[(steps.indexOf(cur) + 1) % steps.length];
      IPTVStorage.updateSetting('bufferSeconds', next);
      renderSettingsView();
    };
    $('set-parental-toggle').onclick = function () {
      var cur = IPTVStorage.getSettings().parentalEnabled;
      openPinModal('verify', 'Ebeveyn Kontrolü Onayı', 'Bu ayarı değiştirmek için mevcut PIN kodunu girin.', function () {
        IPTVStorage.updateSetting('parentalEnabled', !cur);
        renderSettingsView();
        showToast(!cur ? 'Ebeveyn kilidi açıldı.' : 'Ebeveyn kilidi kapatıldı.');
      });
    };
    $('set-parental-pin').onclick = function () {
      openPinModal('verify', 'Mevcut PIN Kodu', 'Önce mevcut 4 haneli PIN kodunuzu doğrulayın.', function () {
        openPinModal('change', 'Yeni PIN Kodu Belirle', 'Yeni 4 haneli PIN kodunuzu girin.', null);
      });
    };
    $('set-manage-accounts').onclick = openManagerScreen;
    $('btn-refresh-playlist').onclick = function () {
      if (app.activeProfile) {
        connectProfile(app.activeProfile);
      } else {
        openManagerScreen();
      }
    };

    // LIVE TV INFO OSD bindings (no transport controls)
    $('losd-btn-drawer').onclick = openChannelDrawer;
    $('losd-btn-recall').onclick = function () {
      recallPreviousChannel();
      resetOsdAutoHide();
    };
    $('losd-btn-aspect').onclick = function () {
      var asp = IPTVPlayer.cycleAspectRatio();
      updateOsdMetadata(IPTVPlayer.getCurrentItem());
      showToast('En-Boy Oranı: ' + asp.label);
      resetOsdAutoHide();
    };
    $('losd-btn-audio').onclick = function () {
      var tracks = IPTVPlayer.getAudioTracks();
      openTrackModal('Ses Dili Seçimi', tracks, function (opt) {
        IPTVPlayer.selectAudioTrack(opt.index);
        showToast('Ses dili: ' + opt.label);
      });
    };
    $('losd-btn-sub').onclick = function () {
      var tracks = IPTVPlayer.getSubtitleTracks();
      openTrackModal('Altyazı Seçimi', tracks, function (opt) {
        IPTVPlayer.selectSubtitleTrack(opt.index);
        showToast('Altyazı: ' + opt.label);
      });
    };
    $('losd-btn-sleep').onclick = function () {
      cycleSleepTimer();
      resetOsdAutoHide();
    };
    $('losd-btn-fav').onclick = function () {
      toggleFavoriteShortcut();
      resetOsdAutoHide();
    };
    $('losd-btn-back').onclick = exitFullscreen;

    // Fullscreen video surface tap/click: close drawer if open, else toggle OSD (essential for iPhone/PC)
    $('fullscreen-stage').onclick = function (e) {
      if (e.target !== $('fullscreen-stage')) { return; }
      if (app.drawerOpen) {
        closeChannelDrawer();
        return;
      }
      if (app.osdVisible) {
        hideOsd();
      } else {
        showOsd();
      }
    };

    // INTERACTIVE SEEK BAR (Magic Remote click / hover scrub + iPhone touch drag)
    var seekBarEl = $('osd-seek-bar');
    function seekBarFromClientX(clientX, shouldCommit) {
      if (IPTVPlayer.isLive()) { return; }
      var dur = IPTVPlayer.getDuration();
      if (!dur || !isFinite(dur)) { return; }
      var rect = seekBarEl.getBoundingClientRect();
      if (!rect || rect.width <= 0) { return; }
      var ratio = (clientX - rect.left) / rect.width;
      if (ratio < 0) { ratio = 0; }
      if (ratio > 1) { ratio = 1; }
      var target = ratio * dur;
      var tip = $('osd-seek-tooltip');
      tip.textContent = formatTimeSec(target);
      tip.style.left = (ratio * 100) + '%';
      showEl(tip);
      if (shouldCommit) {
        if (IPTVPlayer.seekTo(target)) {
          updateSeekBarUI(target, dur);
          saveCurrentMediaProgress(true);
        }
      }
      resetOsdAutoHide();
    }
    seekBarEl.onmousemove = function (e) {
      seekBarFromClientX(e.clientX, false);
    };
    seekBarEl.onmouseleave = function () {
      if (SpatNav.getCurrent() !== seekBarEl) {
        hideEl('osd-seek-tooltip');
      }
    };
    seekBarEl.onclick = function (e) {
      seekBarFromClientX(e.clientX, true);
    };
    seekBarEl.addEventListener('touchstart', function (e) {
      if (!e.touches || e.touches.length !== 1) { return; }
      if (e.cancelable !== false && e.preventDefault) { e.preventDefault(); }
      seekBarFromClientX(e.touches[0].clientX, true);
    }, getNonPassiveListenerOpts());
    seekBarEl.addEventListener('touchmove', function (e) {
      if (!e.touches || e.touches.length !== 1) { return; }
      if (e.cancelable !== false && e.preventDefault) { e.preventDefault(); }
      seekBarFromClientX(e.touches[0].clientX, true);
    }, getNonPassiveListenerOpts());
    seekBarEl.addEventListener('touchend', function () {
      hideEl('osd-seek-tooltip');
    }, false);

    // VOD & SERIES OSD button bindings
    $('osd-btn-rw').onclick = function () { scrubSeekBarBy(-10); };
    $('osd-btn-ff').onclick = function () { scrubSeekBarBy(10); };
    $('osd-btn-playpause').onclick = function () {
      var playing = IPTVPlayer.togglePlayPause();
      $('osd-btn-playpause').textContent = playing ? '❚❚ Duraklat' : '▶ Oynat';
      if (!playing) { saveCurrentMediaProgress(true); }
      resetOsdAutoHide();
    };
    $('osd-btn-episodes').onclick = openEpisodesModal;
    $('osd-btn-aspect').onclick = function () {
      var asp = IPTVPlayer.cycleAspectRatio();
      updateOsdMetadata(IPTVPlayer.getCurrentItem());
      showToast('En-Boy Oranı: ' + asp.label);
      resetOsdAutoHide();
    };
    $('osd-btn-audio').onclick = function () {
      var tracks = IPTVPlayer.getAudioTracks();
      openTrackModal('Ses Dili Seçimi', tracks, function (opt) {
        IPTVPlayer.selectAudioTrack(opt.index);
        showToast('Ses dili: ' + opt.label);
      });
    };
    $('osd-btn-sub').onclick = function () {
      var tracks = IPTVPlayer.getSubtitleTracks();
      openTrackModal('Altyazı Seçimi', tracks, function (opt) {
        IPTVPlayer.selectSubtitleTrack(opt.index);
        showToast('Altyazı: ' + opt.label);
      });
    };
    $('osd-btn-speed').onclick = function () {
      var rate = IPTVPlayer.cyclePlaybackSpeed();
      updateOsdMetadata(IPTVPlayer.getCurrentItem());
      showToast('Oynatma Hızı: ' + rate + 'x');
      resetOsdAutoHide();
    };
    $('osd-btn-sleep').onclick = function () {
      cycleSleepTimer();
      resetOsdAutoHide();
    };
    $('osd-btn-fav').onclick = function () {
      toggleFavoriteShortcut();
      resetOsdAutoHide();
    };
    $('osd-btn-back').onclick = exitFullscreen;

    // Auto-Next Episode card bindings
    $('btn-next-ep-now').onclick = function () {
      if (app.nextEpTarget) {
        var t = app.nextEpTarget;
        hideNextEpCard(true);
        playNextEpisodeTarget(t);
      }
    };
    $('btn-next-ep-dismiss').onclick = function () {
      hideNextEpCard(true);
    };

    // Resume modal bindings
    $('btn-resume-continue').onclick = function () {
      var d = app.pendingResumeData;
      closeResumeModal();
      if (d) {
        playVodOrEpisode(d.mediaObj, d.seriesCtx, d.savedPos);
      }
    };
    $('btn-resume-restart').onclick = function () {
      var d = app.pendingResumeData;
      closeResumeModal();
      if (d) {
        IPTVStorage.clearWatchProgress(d.mediaObj.id);
        playVodOrEpisode(d.mediaObj, d.seriesCtx, 0);
      }
    };
    $('btn-resume-cancel').onclick = closeResumeModal;

    // Episodes modal close binding
    $('btn-ep-modal-close').onclick = closeEpisodesModal;

    // PIN, Track & Exit modal bindings
    var pinKeys = document.querySelectorAll('#modal-pin .pin-key');
    for (var p = 0; p < pinKeys.length; p++) {
      (function (btn) {
        btn.onclick = function () {
          handlePinInput(btn.getAttribute('data-pin'));
        };
      })(pinKeys[p]);
    }
    $('btn-tracks-close').onclick = closeTrackModal;
    $('btn-exit-confirm').onclick = exitApplication;
    $('btn-exit-cancel').onclick = closeExitModal;

    // Touch swipe (iPhone/touchscreens) + Mouse/Magic Remote scroll wheel for all 7 virtualized lists
    bindVirtualScroll($('live-cat-list'), 74, function (delta) {
      var maxStart = Math.max(0, app.liveCatList.length - CAT_VISIBLE_COUNT);
      var next = app.liveCatStart + delta;
      if (next < 0) { next = 0; }
      if (next > maxStart) { next = maxStart; }
      if (next !== app.liveCatStart) {
        app.liveCatStart = next;
        renderLiveCatWindow();
      }
    });

    bindVirtualScroll($('live-ch-list'), 76, function (delta) {
      var maxStart = Math.max(0, app.liveFilteredChannels.length - CH_VISIBLE_COUNT);
      var next = app.liveChStart + delta;
      if (next < 0) { next = 0; }
      if (next > maxStart) { next = maxStart; }
      if (next !== app.liveChStart) {
        app.liveChStart = next;
        renderLiveChWindow();
      }
    });

    bindVirtualScroll($('drawer-ch-list'), 76, function (delta) {
      var maxStart = Math.max(0, app.liveFilteredChannels.length - DRAWER_VISIBLE_COUNT);
      var next = app.drawerStart + delta;
      if (next < 0) { next = 0; }
      if (next > maxStart) { next = maxStart; }
      if (next !== app.drawerStart) {
        app.drawerStart = next;
        renderDrawerWindow();
      }
    });

    bindVirtualScroll($('media-cat-list'), 74, function (delta) {
      var maxStart = Math.max(0, app.mediaCatList.length - CAT_VISIBLE_COUNT);
      var next = app.mediaCatStart + delta;
      if (next < 0) { next = 0; }
      if (next > maxStart) { next = maxStart; }
      if (next !== app.mediaCatStart) {
        app.mediaCatStart = next;
        renderMediaCatWindow();
      }
    });

    bindVirtualScroll($('media-poster-grid'), 220, function (delta) {
      var totalRows = Math.ceil(app.mediaFilteredItems.length / GRID_COLS);
      var maxRow = Math.max(0, totalRows - GRID_ROWS);
      var next = app.mediaRowStart + delta;
      if (next < 0) { next = 0; }
      if (next > maxRow) { next = maxRow; }
      if (next !== app.mediaRowStart) {
        app.mediaRowStart = next;
        renderMediaGridWindow();
      }
    });

    bindVirtualScroll($('detail-episodes-list'), 74, function (delta) {
      var maxStart = Math.max(0, app.detailEpisodes.length - DETAIL_EP_VISIBLE);
      var next = app.detailEpStart + delta;
      if (next < 0) { next = 0; }
      if (next > maxStart) { next = maxStart; }
      if (next !== app.detailEpStart) {
        app.detailEpStart = next;
        renderSeriesEpisodesWindow();
      }
    });

    bindVirtualScroll($('ep-modal-list'), 72, function (delta) {
      var maxStart = Math.max(0, app.epModalEpisodes.length - MODAL_EP_VISIBLE);
      var next = app.epModalStart + delta;
      if (next < 0) { next = 0; }
      if (next > maxStart) { next = maxStart; }
      if (next !== app.epModalStart) {
        app.epModalStart = next;
        renderEpisodesModalList();
      }
    });

    document.addEventListener('keydown', handleKeyDown, false);
  }

  /* ========================================================================
     APPLICATION BOOTSTRAP
     ======================================================================== */

  function bootstrap() {
    applyViewportScale();
    window.addEventListener('resize', applyViewportScale, false);
    window.addEventListener('orientationchange', function () {
      window.setTimeout(applyViewportScale, 120);
    }, false);

    initVirtualPools();

    SpatNav.init({
      onFocusChange: onSpatNavFocusChange,
      onBoundary: onSpatNavBoundary
    });

    IPTVPlayer.init({
      onBuffering: function (isBuf, text) {
        if (!isBuf) {
          hideEl('preview-buffering');
          hideEl('fs-buffering');
          return;
        }
        if (app.inFullscreen) {
          hideEl('preview-buffering');
          $('fs-buffering-text').textContent = text || 'Yükleniyor...';
          showEl('fs-buffering');
        } else {
          hideEl('fs-buffering');
          $('preview-buffering-text').textContent = text || 'Bağlanıyor...';
          showEl('preview-buffering');
        }
      },
      onPlaying: function () {
        hideEl('preview-buffering');
        hideEl('fs-buffering');
        if (app.inFullscreen && app.osdVisible) {
          updateOsdMetadata(IPTVPlayer.getCurrentItem());
        }
      },
      onTimeUpdate: function (cur, dur, isLive) {
        if (isLive) { return; }

        // Throttled resume progress persistence
        saveCurrentMediaProgress(false);

        if (app.inFullscreen && app.osdVisible) {
          updateSeekBarUI(cur, dur);
        }

        // Auto-Next Episode prompt in last 20 seconds of a Series episode
        if (app.inFullscreen && app.currentSeriesCtx && dur > 45 && isFinite(dur) && !app.nextEpDismissed) {
          var rem = dur - cur;
          if (rem <= 20 && rem > 0) {
            var nextInfo = app.nextEpTarget || getNextEpisodeInfo(app.currentSeriesCtx);
            if (nextInfo) {
              app.nextEpTarget = nextInfo;
              $('next-ep-countdown').textContent = Math.max(1, Math.ceil(rem)) + ' sn';
              $('next-ep-title').textContent = 'S' + nextInfo.seasonKey + ' B' + nextInfo.ep.episodeNum + ' · ' + nextInfo.ep.title;
              if (!app.nextEpVisible) {
                app.nextEpVisible = true;
                showEl('next-ep-card');
              }
            }
          } else if (rem > 22 && app.nextEpVisible) {
            hideNextEpCard(false);
          }
        }
      },
      onEnded: function (endedItem) {
        if (endedItem && endedItem.id) {
          var d = IPTVPlayer.getDuration();
          if (d >= 15) {
            IPTVStorage.saveWatchProgress(endedItem.id, d, d);
          }
        }
        hideNextEpCard(true);
        if (app.currentSeriesCtx) {
          var nextInfo = getNextEpisodeInfo(app.currentSeriesCtx);
          if (nextInfo) {
            playNextEpisodeTarget(nextInfo);
            return;
          }
          showToast('Dizi sezonu tamamlandı.');
        } else {
          showToast('İçerik sona erdi.');
        }
        exitFullscreen();
      },
      onError: function (msg) {
        hideEl('preview-buffering');
        hideEl('fs-buffering');
        showToast(msg, 'error');
      },
      onSpeedFallback: function (warningMsg) {
        updateOsdMetadata(IPTVPlayer.getCurrentItem());
        showToast(warningMsg, 'warn');
      },
      onResolution: function (tag, w, h) {
        var fullLabel = (w && h) ? (w + 'x' + h + ' ' + tag) : tag;
        $('osd-res').textContent = fullLabel;
        $('live-osd-res').textContent = fullLabel;
      },
      onMuteChange: function (isMuted) {
        var hintEl = document.querySelector('.preview-fs-hint');
        if (hintEl) {
          hintEl.textContent = isMuted ? 'Sessiz · OK: Ses & Tam Ekran' : 'OK: Tam Ekran';
        }
      }
    });

    bindStaticEvents();
    updateClocks();
    window.setInterval(updateClocks, 15000);

    // Auto-connect to saved default profile or open Playlist Manager
    var activeProf = IPTVStorage.getActiveProfile();
    if (activeProf) {
      connectProfile(activeProf);
    } else {
      openManagerScreen();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, false);
  } else {
    bootstrap();
  }
})();
