/* ==========================================================================
   js/storage.js - Safe ES5 localStorage Manager for LG webOS 2.2.3
   Handles: Profiles, Favorites, Recents, Watch Progress (Resume),
   Last Live Channel, Parental PIN, Hidden Categories, and Settings
   ========================================================================== */

var IPTVStorage = (function () {
  'use strict';

  var STORAGE_KEY = 'pro_iptv_webos_v1';
  var MAX_RECENTS = 40;
  var MAX_PROGRESS_ENTRIES = 180;
  var memoryFallback = null;

  function createDefaultState() {
    return {
      profiles: [],
      activeProfileId: null,
      lastLiveChannelId: null,
      favorites: {
        live: [],
        vod: [],
        series: []
      },
      recents: [],
      watchProgress: {},
      hiddenCategories: {},
      prefsVersion: 2,
      settings: {
        autoReconnect: true,
        autoPreview: false,
        bufferSeconds: 5,
        liveFormat: 'ts',
        epgOffsetHours: 0,
        startupLiveFullscreen: false,
        corsProxy: '',
        parentalEnabled: true,
        parentalPin: '0000',
        aspectMode: 'contain'
      }
    };
  }

  function safeCloneDefaults(parsed) {
    var def = createDefaultState();
    if (!parsed || typeof parsed !== 'object') {
      return def;
    }
    if (parsed.profiles && Object.prototype.toString.call(parsed.profiles) === '[object Array]') {
      def.profiles = parsed.profiles;
    }
    if (typeof parsed.activeProfileId === 'string') {
      def.activeProfileId = parsed.activeProfileId;
    }
    if (typeof parsed.lastLiveChannelId === 'string') {
      def.lastLiveChannelId = parsed.lastLiveChannelId;
    }
    if (parsed.favorites && typeof parsed.favorites === 'object') {
      if (parsed.favorites.live && Object.prototype.toString.call(parsed.favorites.live) === '[object Array]') {
        def.favorites.live = parsed.favorites.live;
      }
      if (parsed.favorites.vod && Object.prototype.toString.call(parsed.favorites.vod) === '[object Array]') {
        def.favorites.vod = parsed.favorites.vod;
      }
      if (parsed.favorites.series && Object.prototype.toString.call(parsed.favorites.series) === '[object Array]') {
        def.favorites.series = parsed.favorites.series;
      }
    }
    if (parsed.recents && Object.prototype.toString.call(parsed.recents) === '[object Array]') {
      def.recents = parsed.recents;
    }
    if (parsed.watchProgress && typeof parsed.watchProgress === 'object') {
      def.watchProgress = parsed.watchProgress;
    }
    if (parsed.hiddenCategories && typeof parsed.hiddenCategories === 'object') {
      def.hiddenCategories = parsed.hiddenCategories;
    }
    if (parsed.settings && typeof parsed.settings === 'object') {
      var s = parsed.settings;
      var migrated = (parsed.prefsVersion >= 2);
      if (typeof s.autoReconnect === 'boolean') { def.settings.autoReconnect = s.autoReconnect; }
      if (migrated && typeof s.autoPreview === 'boolean') { def.settings.autoPreview = s.autoPreview; }
      if (typeof s.bufferSeconds === 'number') { def.settings.bufferSeconds = s.bufferSeconds; }
      if (typeof s.liveFormat === 'string') { def.settings.liveFormat = s.liveFormat; }
      if (typeof s.epgOffsetHours === 'number') { def.settings.epgOffsetHours = s.epgOffsetHours; }
      if (typeof s.startupLiveFullscreen === 'boolean') { def.settings.startupLiveFullscreen = s.startupLiveFullscreen; }
      if (typeof s.corsProxy === 'string') { def.settings.corsProxy = s.corsProxy; }
      if (typeof s.parentalEnabled === 'boolean') { def.settings.parentalEnabled = s.parentalEnabled; }
      if (typeof s.parentalPin === 'string' && s.parentalPin.length === 4) { def.settings.parentalPin = s.parentalPin; }
      if (typeof s.aspectMode === 'string') { def.settings.aspectMode = s.aspectMode; }
    }
    def.prefsVersion = 2;
    return def;
  }

  function loadState() {
    if (memoryFallback) {
      return memoryFallback;
    }
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        memoryFallback = safeCloneDefaults(parsed);
        return memoryFallback;
      }
    } catch (e) {}
    memoryFallback = createDefaultState();
    return memoryFallback;
  }

  function saveState(state) {
    memoryFallback = state;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return false;
    }
  }

  function pruneProgressMap(map) {
    var keys = [];
    var k;
    for (k in map) {
      if (map.hasOwnProperty(k)) {
        keys.push({ key: k, ts: map[k].updatedAt || 0 });
      }
    }
    if (keys.length <= MAX_PROGRESS_ENTRIES) { return; }
    keys.sort(function (a, b) { return a.ts - b.ts; });
    var removeCount = keys.length - MAX_PROGRESS_ENTRIES;
    for (var i = 0; i < removeCount; i++) {
      delete map[keys[i].key];
    }
  }

  function generateId() {
    return 'prof_' + (new Date().getTime()) + '_' + Math.floor(Math.random() * 10000);
  }

  return {
    getProfiles: function () {
      return loadState().profiles;
    },

    getProfileById: function (id) {
      var list = loadState().profiles;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          return list[i];
        }
      }
      return null;
    },

    getActiveProfile: function () {
      var st = loadState();
      if (st.activeProfileId) {
        var found = this.getProfileById(st.activeProfileId);
        if (found) {
          return found;
        }
      }
      return st.profiles.length > 0 ? st.profiles[0] : null;
    },

    setActiveProfileId: function (id) {
      var st = loadState();
      st.activeProfileId = id;
      saveState(st);
    },

    setLastLiveChannelId: function (chId) {
      var st = loadState();
      st.lastLiveChannelId = chId ? String(chId) : null;
      saveState(st);
    },

    getLastLiveChannelId: function () {
      return loadState().lastLiveChannelId;
    },

    saveProfile: function (profile) {
      var st = loadState();
      var i;
      if (profile.id) {
        for (i = 0; i < st.profiles.length; i++) {
          if (st.profiles[i].id === profile.id) {
            st.profiles[i] = profile;
            saveState(st);
            return profile;
          }
        }
      }
      profile.id = generateId();
      profile.createdAt = new Date().getTime();
      st.profiles.push(profile);
      if (!st.activeProfileId) {
        st.activeProfileId = profile.id;
      }
      saveState(st);
      return profile;
    },

    deleteProfile: function (id) {
      var st = loadState();
      var next = [];
      for (var i = 0; i < st.profiles.length; i++) {
        if (st.profiles[i].id !== id) {
          next.push(st.profiles[i]);
        }
      }
      st.profiles = next;
      if (st.activeProfileId === id) {
        st.activeProfileId = next.length > 0 ? next[0].id : null;
      }
      saveState(st);
    },

    isFavorite: function (type, itemId) {
      var st = loadState();
      var arr = st.favorites[type];
      if (!arr) { return false; }
      return arr.indexOf(String(itemId)) !== -1;
    },

    toggleFavorite: function (type, itemId) {
      var st = loadState();
      if (!st.favorites[type]) {
        st.favorites[type] = [];
      }
      var sid = String(itemId);
      var arr = st.favorites[type];
      var idx = arr.indexOf(sid);
      var added = false;
      if (idx !== -1) {
        arr.splice(idx, 1);
        added = false;
      } else {
        arr.unshift(sid);
        added = true;
      }
      saveState(st);
      return added;
    },

    getFavorites: function (type) {
      var st = loadState();
      return st.favorites[type] ? st.favorites[type].slice(0) : [];
    },

    addRecent: function (item) {
      if (!item || !item.id) { return; }
      var st = loadState();
      var sid = String(item.id);
      var next = [{
        id: sid,
        type: item.type || 'live',
        name: item.name || '',
        logo: item.logo || '',
        url: item.url || '',
        group: item.group || '',
        watchedAt: new Date().getTime()
      }];
      for (var i = 0; i < st.recents.length; i++) {
        if (String(st.recents[i].id) !== sid) {
          next.push(st.recents[i]);
        }
        if (next.length >= MAX_RECENTS) {
          break;
        }
      }
      st.recents = next;
      if (item.type === 'live') {
        st.lastLiveChannelId = sid;
      }
      saveState(st);
    },

    getRecents: function () {
      return loadState().recents.slice(0);
    },

    saveWatchProgress: function (mediaId, positionSec, durationSec) {
      if (!mediaId || !durationSec || isNaN(durationSec) || durationSec < 15) { return; }
      var st = loadState();
      var key = String(mediaId);
      var pos = Math.floor(positionSec || 0);
      var dur = Math.floor(durationSec);
      var pct = Math.floor((pos / dur) * 100);
      var completed = (pct >= 94 || (dur - pos) <= 15);

      st.watchProgress[key] = {
        pos: completed ? 0 : pos,
        dur: dur,
        pct: completed ? 100 : pct,
        watched: completed,
        updatedAt: new Date().getTime()
      };
      pruneProgressMap(st.watchProgress);
      saveState(st);
    },

    getWatchProgress: function (mediaId) {
      if (!mediaId) { return null; }
      var st = loadState();
      return st.watchProgress[String(mediaId)] || null;
    },

    clearWatchProgress: function (mediaId) {
      if (!mediaId) { return; }
      var st = loadState();
      if (st.watchProgress[String(mediaId)]) {
        delete st.watchProgress[String(mediaId)];
        saveState(st);
      }
    },

    isCategoryHidden: function (catName) {
      var st = loadState();
      return !!st.hiddenCategories[catName];
    },

    toggleCategoryHidden: function (catName) {
      var st = loadState();
      if (st.hiddenCategories[catName]) {
        delete st.hiddenCategories[catName];
        saveState(st);
        return false;
      }
      st.hiddenCategories[catName] = true;
      saveState(st);
      return true;
    },

    getSettings: function () {
      return loadState().settings;
    },

    updateSetting: function (key, value) {
      var st = loadState();
      st.settings[key] = value;
      saveState(st);
      return st.settings;
    }
  };
})();
