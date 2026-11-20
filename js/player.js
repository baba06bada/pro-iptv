/* ==========================================================================
   js/player.js - LG webOS 2.2.3 Advanced HTML5 TV Video Engine
   Pure ES5 - Direct MPEG-TS (.ts) First for webOS 2.2.3, Permanent Hardware
   Video Plane (No DOM Reparenting), Full Fallback Chain (direct src + MIME
   source), Autoplay Recovery, Auto-Reconnect, Screensaver Prevent & 3s Speed Guard
   ========================================================================== */

var IPTVPlayer = (function () {
  'use strict';

  var videoEl = null;
  var stageLayerEl = null;
  var currentItem = null;
  var isLiveStream = true;
  var currentMode = 'hidden'; // 'hidden' | 'preview' | 'fullscreen'
  var aspectModes = ['contain', 'fill', 'cover'];
  var aspectLabels = { contain: 'Orijinal', fill: 'Tam Ekran', cover: 'Yakınlaştır' };
  var speedSteps = [1.0, 1.25, 1.5, 2.0];
  var currentAspect = 'contain';
  var currentSpeed = 1.0;

  // Candidate playback entries: { url: string, mode: 'direct' | 'source', mime: string, label: string }
  var candidates = [];
  var candidateIndex = 0;
  var loadToken = 0;
  var isSwitching = false;
  var userPaused = false;
  var mutedByAutoplay = false;
  var isBufferingVisible = false;
  var lastProgressTime = -1;
  var stallOverlayTimer = null;
  var pendingResumeSec = 0;
  var activeFormatLabel = 'MPEG-TS';
  var activeResolutionText = '';

  var reconnectAttempts = 0;
  var MAX_RECONNECT = 5;
  var reconnectTimer = null;
  var stallTimer = null;
  var screensaverTimer = null;

  // Hardware speed safety watchdog for webOS 2.2.3
  var speedWatchTimer = null;
  var speedStartTime = 0;
  var speedProgressed = false;
  var speedTesting = false;

  var callbacks = {
    onBuffering: null,
    onPlaying: null,
    onTimeUpdate: null,
    onError: null,
    onSpeedFallback: null,
    onResolution: null,
    onMuteChange: null,
    onEnded: null
  };

  function isWebOSTV() {
    if (typeof window.webOS !== 'undefined') { return true; }
    var ua = (navigator && navigator.userAgent) ? navigator.userAgent.toLowerCase() : '';
    return ua.indexOf('web0s') !== -1 || ua.indexOf('webos') !== -1 || ua.indexOf('netcast') !== -1;
  }

  function canPlayNativeHls(v) {
    if (isWebOSTV()) { return true; }
    if (!v || !v.canPlayType) { return false; }
    var res = v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('application/x-mpegURL');
    return res === 'probably' || res === 'maybe';
  }

  function endsWithCI(str, suffix) {
    if (!str || str.length < suffix.length) { return false; }
    return str.toLowerCase().slice(-suffix.length) === suffix.toLowerCase();
  }

  function stripQuery(url) {
    if (!url) { return ''; }
    var q = url.indexOf('?');
    return q !== -1 ? url.substring(0, q) : url;
  }

  function addCandidate(list, url, mode, mime, label) {
    if (!url || typeof url !== 'string') { return; }
    for (var i = 0; i < list.length; i++) {
      if (list[i].url === url && list[i].mode === mode && list[i].mime === mime) {
        return;
      }
    }
    list.push({
      url: url,
      mode: mode || 'direct',
      mime: mime || '',
      label: label || 'Yayın'
    });
  }

  function toTsVariant(url) {
    if (!url) { return ''; }
    var clean = stripQuery(url);
    if (endsWithCI(clean, '.m3u8')) {
      return clean.substring(0, clean.length - 5) + '.ts';
    }
    if (endsWithCI(clean, '.ts')) {
      return url;
    }
    return '';
  }

  function toHlsVariant(url) {
    if (!url) { return ''; }
    var clean = stripQuery(url);
    if (endsWithCI(clean, '.ts')) {
      return clean.substring(0, clean.length - 3) + '.m3u8';
    }
    if (endsWithCI(clean, '.m3u8')) {
      return url;
    }
    return '';
  }

  function buildProxyStreamUrl(url) {
    if (!url) { return ''; }
    var settings = IPTVStorage.getSettings();
    var proxy = settings && settings.corsProxy ? String(settings.corsProxy).replace(/^\s+|\s+$/g, '') : '';
    if (!proxy) { return ''; }
    if (proxy.indexOf('{url}') !== -1) {
      return proxy.replace('{url}', encodeURIComponent(url));
    }
    return proxy + encodeURIComponent(url);
  }

  function isHttpsContext() {
    try {
      return !!(window.location && window.location.protocol === 'https:');
    } catch (e) {
      return false;
    }
  }

  function buildCandidateList(item, isLive) {
    var list = [];
    if (!item) { return list; }

    var settings = IPTVStorage.getSettings();
    var pref = settings.liveFormat || 'ts'; // 'ts' | 'hls' | 'auto'
    var webos = isWebOSTV();
    var nativeHlsBrowser = !webos && canPlayNativeHls(videoEl); // iPhone / iPad / Mac Safari
    var httpsMixed = isHttpsContext();
    var primary = item.url || '';
    var tsUrl = item.tsUrl || toTsVariant(primary);
    var rawTsUrl = item.rawTsUrl || '';
    var rawUrl = item.rawUrl || '';
    var hlsUrl = item.hlsUrl || toHlsVariant(primary);
    var fallback = item.fallbackUrl || '';
    var fallbackIsMp4 = endsWithCI(stripQuery(fallback), '.mp4');

    // VOD & Series: play directly with videoEl.src (plus proxy fallback if HTTPS -> HTTP)
    if (!isLive) {
      if (httpsMixed && primary.indexOf('http://') === 0) {
        var proxVod = buildProxyStreamUrl(primary);
        if (proxVod) {
          addCandidate(list, proxVod, 'direct', '', 'VOD (Proxy)');
        }
      }
      addCandidate(list, primary, 'direct', '', 'VOD');
      addCandidate(list, fallback, 'direct', '', 'VOD Yedek');
      return list;
    }

    // Desktop non-Safari browser preview with Demo MP4 fallback
    if (!webos && !nativeHlsBrowser && fallbackIsMp4) {
      addCandidate(list, fallback, 'direct', '', 'MP4 Canlı Önizleme');
      addCandidate(list, primary, 'direct', '', 'HLS');
      return list;
    }

    // iPhone / iPad / Mac Safari: natively plays HLS (.m3u8), NOT raw .ts
    if (nativeHlsBrowser) {
      if (hlsUrl) {
        if (httpsMixed && hlsUrl.indexOf('http://') === 0) {
          var proxHls = buildProxyStreamUrl(hlsUrl);
          if (proxHls) {
            // Explicit HLS MIME first so iOS AVPlayer recognizes query-param proxy URLs
            addCandidate(list, proxHls, 'source', 'application/vnd.apple.mpegurl', 'HLS Proxy MIME');
            addCandidate(list, proxHls, 'direct', '', 'HLS (Proxy)');
          }
        }
        addCandidate(list, hlsUrl, 'source', 'application/vnd.apple.mpegurl', 'HLS MIME');
        addCandidate(list, hlsUrl, 'direct', '', 'HLS (.m3u8)');
      }
      if (primary && primary !== hlsUrl) {
        if (httpsMixed && primary.indexOf('http://') === 0) {
          var proxPrimary = buildProxyStreamUrl(primary);
          if (proxPrimary) {
            addCandidate(list, proxPrimary, 'source', 'application/vnd.apple.mpegurl', 'Akış Proxy MIME');
            addCandidate(list, proxPrimary, 'direct', '', 'Akış (Proxy)');
          }
        }
        addCandidate(list, primary, 'direct', '', 'Ana Akış');
      }
      if (fallback) {
        addCandidate(list, fallback, 'direct', '', 'Yedek Akış');
      }
      return list;
    }

    // LG webOS 2.2.3 Live TV: Direct MPEG-TS (.ts) first!
    if (pref === 'hls') {
      if (hlsUrl) {
        addCandidate(list, hlsUrl, 'direct', '', 'HLS (.m3u8)');
        addCandidate(list, hlsUrl, 'source', 'application/vnd.apple.mpegurl', 'HLS MIME');
      }
      if (tsUrl) {
        addCandidate(list, tsUrl, 'direct', '', 'MPEG-TS (.ts)');
        addCandidate(list, tsUrl, 'source', 'video/mp2t', 'MPEG-TS MIME');
      }
      addCandidate(list, rawTsUrl, 'direct', '', 'MPEG-TS (Ham)');
      addCandidate(list, rawUrl, 'direct', '', 'Canlı Akış');
      addCandidate(list, primary, 'direct', '', 'Ana Akış');
      addCandidate(list, fallback, 'direct', '', 'Yedek Akış');
    } else {
      // 'ts' (default for LG webOS 2.2.3) or 'auto'
      if (tsUrl) {
        addCandidate(list, tsUrl, 'direct', '', 'MPEG-TS (.ts)');
        addCandidate(list, tsUrl, 'source', 'video/mp2t', 'MPEG-TS MIME');
      }
      if (rawTsUrl) {
        addCandidate(list, rawTsUrl, 'direct', '', 'MPEG-TS (Alternatif)');
      }
      if (rawUrl) {
        addCandidate(list, rawUrl, 'direct', '', 'MPEG-TS (Uzantısız)');
        addCandidate(list, rawUrl, 'source', 'video/mp2t', 'MPEG-TS MIME');
      }
      if (primary && primary !== tsUrl) {
        addCandidate(list, primary, 'direct', '', 'Ana Akış');
      }
      if (hlsUrl) {
        addCandidate(list, hlsUrl, 'direct', '', 'HLS (.m3u8)');
        addCandidate(list, hlsUrl, 'source', 'application/vnd.apple.mpegurl', 'HLS MIME');
      }
      if (fallback) {
        addCandidate(list, fallback, 'direct', '', 'Yedek Akış');
      }
    }

    return list;
  }

  function notifyBuffering(show, msg) {
    isBufferingVisible = !!show;
    if (!show && stallOverlayTimer) {
      window.clearTimeout(stallOverlayTimer);
      stallOverlayTimer = null;
    }
    if (callbacks.onBuffering) {
      callbacks.onBuffering(isBufferingVisible, msg || '');
    }
  }

  function clearTimers() {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (stallTimer) {
      window.clearTimeout(stallTimer);
      stallTimer = null;
    }
    if (stallOverlayTimer) {
      window.clearTimeout(stallOverlayTimer);
      stallOverlayTimer = null;
    }
    clearSpeedWatchdog();
  }

  function clearSpeedWatchdog() {
    if (speedWatchTimer) {
      window.clearTimeout(speedWatchTimer);
      speedWatchTimer = null;
    }
    speedTesting = false;
  }

  function keepWebOSScreenAwake() {
    try {
      if (window.webOS && window.webOS.service && window.webOS.service.request) {
        window.webOS.service.request('luna://com.webos.service.tvpower', {
          method: 'power/setScreenSaver',
          parameters: { state: 'off' },
          onSuccess: function () {},
          onFailure: function () {}
        });
      }
    } catch (e) {}
  }

  function startScreensaverPrevent() {
    stopScreensaverPrevent();
    keepWebOSScreenAwake();
    screensaverTimer = window.setInterval(function () {
      if (videoEl && !videoEl.paused && !videoEl.ended) {
        keepWebOSScreenAwake();
      }
    }, 55000);
  }

  function stopScreensaverPrevent() {
    if (screensaverTimer) {
      window.clearInterval(screensaverTimer);
      screensaverTimer = null;
    }
  }

  function applyAspectClass(mode) {
    if (!videoEl) { return; }
    currentAspect = mode;
    videoEl.className = 'video-el aspect-' + mode;
  }

  function setMutedFlag(flag) {
    mutedByAutoplay = !!flag;
    if (callbacks.onMuteChange) {
      callbacks.onMuteChange(mutedByAutoplay);
    }
  }

  function revertSpeedWithWarning() {
    clearSpeedWatchdog();
    currentSpeed = 1.0;
    if (videoEl) {
      try { videoEl.playbackRate = 1.0; } catch (e) {}
    }
    if (callbacks.onSpeedFallback) {
      callbacks.onSpeedFallback('Bu yayın formatı TV donanımında hızlandırmayı desteklemiyor, 1x hızına dönüldü');
    }
  }

  function clearVideoSources() {
    if (!videoEl) { return; }
    while (videoEl.firstChild) {
      videoEl.removeChild(videoEl.firstChild);
    }
    videoEl.removeAttribute('src');
  }

  function attemptPlay(preferUnmuted, token) {
    if (!videoEl || !currentItem) { return; }
    if (typeof token === 'number' && token !== loadToken) { return; }

    if (preferUnmuted) {
      videoEl.muted = false;
      setMutedFlag(false);
    }

    try {
      var playRet = videoEl.play();
      if (playRet && typeof playRet['catch'] === 'function') {
        playRet['catch'](function () {
          if (!videoEl || !currentItem) { return; }
          if (typeof token === 'number' && token !== loadToken) { return; }
          if (!videoEl.muted) {
            videoEl.muted = true;
            setMutedFlag(true);
            try {
              var retryRet = videoEl.play();
              if (retryRet && typeof retryRet['catch'] === 'function') {
                retryRet['catch'](function () {});
              }
            } catch (e2) {}
          }
        });
      }
    } catch (e) {}
  }

  function advanceOrReconnect(reasonText, capturedToken) {
    if (!currentItem) { return; }
    if (typeof capturedToken === 'number' && capturedToken !== loadToken) { return; }

    // Immediately try next format/URL candidate (.ts -> video/mp2t -> raw -> .m3u8)
    if (candidateIndex + 1 < candidates.length) {
      candidateIndex++;
      loadCandidateAt(candidateIndex, !mutedByAutoplay);
      return;
    }

    // Desktop browser notice if attempting raw .ts/.m3u8 without native support
    if (!isWebOSTV() && isLiveStream && !canPlayNativeHls(videoEl)) {
      var firstUrl = candidates.length > 0 ? candidates[0].url : '';
      if (!endsWithCI(stripQuery(firstUrl), '.mp4')) {
        if (callbacks.onBuffering) { callbacks.onBuffering(false, ''); }
        if (callbacks.onError) {
          callbacks.onError('Masaüstü tarayıcı .ts/.m3u8 canlı yayını oynatmaz; LG webOS 2.2.3 TV üzerinde doğrudan .ts olarak oynar.');
        }
        return;
      }
    }

    // iOS / Safari HTTPS Mixed-Content / HLS Proxy diagnostic
    if (!isWebOSTV() && canPlayNativeHls(videoEl) && isHttpsContext() && currentItem && currentItem.url && currentItem.url.indexOf('http://') === 0) {
      var hasProxy = !!buildProxyStreamUrl(currentItem.url);
      if (!hasProxy) {
        if (callbacks.onBuffering) { callbacks.onBuffering(false, ''); }
        if (callbacks.onError) {
          callbacks.onError('iPhone Safari (HTTPS) üzerinden HTTP yayın açılamaz. HLS destekli CORS Proxy URL girin.');
        }
        return;
      }
      if (reconnectAttempts >= 1) {
        if (callbacks.onBuffering) { callbacks.onBuffering(false, ''); }
        if (callbacks.onError) {
          callbacks.onError('iPhone Safari HLS oynatamadı: Proxy sunucunuzun .m3u8 içindeki parça linklerini de proxy üzerinden yönlendirmesi gerekir.');
        }
        return;
      }
    }

    var settings = IPTVStorage.getSettings();
    if (!settings.autoReconnect) {
      if (callbacks.onBuffering) { callbacks.onBuffering(false, ''); }
      if (callbacks.onError) {
        callbacks.onError(reasonText || 'Yayın oynatılamadı.');
      }
      return;
    }

    if (reconnectAttempts >= MAX_RECONNECT) {
      if (callbacks.onBuffering) { callbacks.onBuffering(false, ''); }
      if (callbacks.onError) {
        callbacks.onError('Yayın bağlantısı kurulamadı (' + MAX_RECONNECT + ' deneme başarısız).');
      }
      return;
    }

    reconnectAttempts++;
    candidateIndex = 0;
    if (callbacks.onBuffering) {
      callbacks.onBuffering(true, 'Yeniden bağlanılıyor (' + reconnectAttempts + '/' + MAX_RECONNECT + ')...');
    }

    var delayMs = Math.max(2000, (settings.bufferSeconds || 5) * 600);
    if (reconnectTimer) { window.clearTimeout(reconnectTimer); }
    var retryToken = loadToken;
    reconnectTimer = window.setTimeout(function () {
      if (!currentItem || retryToken !== loadToken) { return; }
      loadCandidateAt(0, !mutedByAutoplay);
    }, delayMs);
  }

  function startStallWatch(capturedToken) {
    if (stallTimer) { window.clearTimeout(stallTimer); }
    var settings = IPTVStorage.getSettings();
    // On fallback candidates, switch faster if a format fails to decode
    var baseMs = (candidateIndex === 0)
      ? Math.max(7000, (settings.bufferSeconds || 5) * 1600)
      : 6000;
    stallTimer = window.setTimeout(function () {
      if (!videoEl || !currentItem || capturedToken !== loadToken || userPaused) { return; }
      if (videoEl.readyState < 2) {
        advanceOrReconnect('Yayın yanıt vermedi, alternatif format deneniyor...', capturedToken);
      }
    }, baseMs);
  }

  function loadCandidateAt(idx, preferUnmuted) {
    if (!videoEl || !currentItem) { return; }
    var cand = candidates[idx];
    if (!cand || !cand.url) {
      if (callbacks.onError) { callbacks.onError('Geçersiz yayın adresi.'); }
      return;
    }

    loadToken++;
    var myToken = loadToken;
    userPaused = false;
    lastProgressTime = -1;
    activeFormatLabel = cand.label || (isLiveStream ? 'MPEG-TS' : 'VOD');

    notifyBuffering(true, cand.label + ' bağlanıyor...');

    isSwitching = true;
    try {
      videoEl.pause();
      clearVideoSources();
    } catch (e) {}

    if (cand.mode === 'source') {
      var sourceEl = document.createElement('source');
      sourceEl.src = cand.url;
      if (cand.mime) {
        sourceEl.type = cand.mime;
      }
      // CRITICAL: <source> errors do NOT bubble to <video> in WebKit/HTML5!
      sourceEl.addEventListener('error', function () {
        if (isSwitching || !currentItem || myToken !== loadToken) { return; }
        advanceOrReconnect('Akış formatı desteklenmedi.', myToken);
      }, false);
      videoEl.appendChild(sourceEl);
    } else {
      videoEl.src = cand.url;
    }

    videoEl.playbackRate = 1.0;
    currentSpeed = 1.0;

    try {
      videoEl.load();
    } catch (e2) {}
    isSwitching = false;

    attemptPlay(!!preferUnmuted, myToken);
    startStallWatch(myToken);
  }

  function bindVideoEvents() {
    videoEl.addEventListener('playing', function () {
      reconnectAttempts = 0;
      if (stallTimer) {
        window.clearTimeout(stallTimer);
        stallTimer = null;
      }
      startScreensaverPrevent();
      notifyBuffering(false, '');
      if (callbacks.onPlaying) { callbacks.onPlaying(currentItem); }
    }, false);

    videoEl.addEventListener('canplay', function () {
      if (stallTimer) {
        window.clearTimeout(stallTimer);
        stallTimer = null;
      }
      if (!userPaused && videoEl.paused && currentItem) {
        attemptPlay(!mutedByAutoplay, loadToken);
      }
      if (!videoEl.paused) {
        notifyBuffering(false, '');
      }
    }, false);

    videoEl.addEventListener('loadedmetadata', function () {
      if (pendingResumeSec > 0 && !isLiveStream && videoEl.duration && isFinite(videoEl.duration)) {
        var targetPos = Math.min(pendingResumeSec, Math.max(0, videoEl.duration - 5));
        pendingResumeSec = 0;
        try { videoEl.currentTime = targetPos; } catch (e) {}
      }
      if (videoEl.videoWidth) {
        var tag = 'SD';
        if (videoEl.videoWidth >= 3800) {
          tag = '4K UHD';
        } else if (videoEl.videoWidth >= 1900) {
          tag = 'FHD';
        } else if (videoEl.videoWidth >= 1200) {
          tag = 'HD';
        }
        activeResolutionText = videoEl.videoWidth + 'x' + videoEl.videoHeight + ' ' + tag;
        if (callbacks.onResolution) {
          callbacks.onResolution(tag, videoEl.videoWidth, videoEl.videoHeight);
        }
      }
    }, false);

    videoEl.addEventListener('waiting', function () {
      if (isSwitching || !currentItem || userPaused) { return; }
      if (videoEl.readyState >= 3) { return; }
      notifyBuffering(true, 'Tamponlanıyor...');
      startStallWatch(loadToken);
    }, false);

    videoEl.addEventListener('stalled', function () {
      if (isSwitching || !currentItem || userPaused) { return; }
      // LG webOS 2.2.3 MPEG-TS streams fire periodic 'stalled' events even while smoothly playing.
      // Only show buffering text if video actually stops advancing for 1.8s.
      if (videoEl.readyState >= 3) { return; }
      var snapTime = videoEl.currentTime || 0;
      var snapToken = loadToken;
      if (stallOverlayTimer) { window.clearTimeout(stallOverlayTimer); }
      stallOverlayTimer = window.setTimeout(function () {
        stallOverlayTimer = null;
        if (!videoEl || !currentItem || snapToken !== loadToken || userPaused) { return; }
        if (videoEl.readyState < 3 && Math.abs((videoEl.currentTime || 0) - snapTime) < 0.05) {
          notifyBuffering(true, 'Akış bekleniyor...');
          startStallWatch(loadToken);
        }
      }, 1800);
    }, false);

    videoEl.addEventListener('timeupdate', function () {
      var curT = videoEl.currentTime || 0;
      // Clear any stuck buffering overlay as soon as playback frames advance
      if (curT > 0 && curT !== lastProgressTime) {
        lastProgressTime = curT;
        if (stallTimer) {
          window.clearTimeout(stallTimer);
          stallTimer = null;
        }
        if (isBufferingVisible || stallOverlayTimer) {
          notifyBuffering(false, '');
        }
      }
      if (speedTesting && curT > speedStartTime + 0.35) {
        speedProgressed = true;
      }
      if (callbacks.onTimeUpdate) {
        callbacks.onTimeUpdate(curT, videoEl.duration || 0, isLiveStream);
      }
    }, false);

    videoEl.addEventListener('error', function () {
      if (isSwitching || !currentItem) { return; }
      if (speedTesting && currentSpeed !== 1.0) {
        revertSpeedWithWarning();
        return;
      }
      advanceOrReconnect('Video akış hatası oluştu.', loadToken);
    }, false);

    videoEl.addEventListener('ended', function () {
      stopScreensaverPrevent();
      if (isLiveStream && currentItem) {
        if (videoEl.duration && isFinite(videoEl.duration) && videoEl.duration > 0) {
          try {
            videoEl.currentTime = 0;
            attemptPlay(!mutedByAutoplay, loadToken);
            return;
          } catch (e) {}
        }
        advanceOrReconnect('Canlı yayın sona erdi, yeniden bağlanılıyor...', loadToken);
      } else if (!isLiveStream && currentItem) {
        if (callbacks.onEnded) {
          callbacks.onEnded(currentItem);
        }
      }
    }, false);
  }

  return {
    init: function (opts) {
      videoEl = document.getElementById('main-video');
      stageLayerEl = document.getElementById('video-stage-layer');
      if (videoEl) {
        try {
          videoEl.playsInline = true;
          videoEl.setAttribute('playsinline', '');
          videoEl.setAttribute('webkit-playsinline', '');
          videoEl.setAttribute('x-webkit-airplay', 'allow');
        } catch (e) {}
      }
      if (opts) {
        callbacks.onBuffering = opts.onBuffering || null;
        callbacks.onPlaying = opts.onPlaying || null;
        callbacks.onTimeUpdate = opts.onTimeUpdate || null;
        callbacks.onError = opts.onError || null;
        callbacks.onSpeedFallback = opts.onSpeedFallback || null;
        callbacks.onResolution = opts.onResolution || null;
        callbacks.onMuteChange = opts.onMuteChange || null;
        callbacks.onEnded = opts.onEnded || null;
      }
      var settings = IPTVStorage.getSettings();
      applyAspectClass(settings.aspectMode || 'contain');
      bindVideoEvents();
    },

    // Pure CSS geometry switch - NEVER detaches <video> from DOM!
    // Keeps LG webOS 2.2.3 Starfish hardware decoder plane intact across Preview <-> Fullscreen.
    mountTo: function (mode) {
      if (!stageLayerEl) { return; }
      var nextMode = (mode === 'preview' || mode === 'fullscreen') ? mode : 'hidden';
      currentMode = nextMode;
      stageLayerEl.className = 'video-stage-layer mode-' + nextMode;
    },

    play: function (item, isLive, mode, fromUserGesture, startPosSec) {
      clearTimers();
      currentItem = item;
      isLiveStream = !!isLive;
      reconnectAttempts = 0;
      userPaused = false;
      pendingResumeSec = (!isLiveStream && startPosSec > 0) ? startPosSec : 0;
      activeResolutionText = '';
      candidates = buildCandidateList(item, isLiveStream);
      candidateIndex = 0;

      if (mode) {
        this.mountTo(mode);
      }
      loadCandidateAt(0, fromUserGesture !== false);
    },

    ensurePlaying: function (unmuteNow) {
      if (!videoEl || !currentItem) { return; }
      userPaused = false;
      if (unmuteNow) {
        videoEl.muted = false;
        setMutedFlag(false);
      }
      if (videoEl.paused || videoEl.readyState < 2) {
        if (!videoEl.src && !videoEl.firstChild && candidates.length > 0) {
          loadCandidateAt(candidateIndex, !!unmuteNow);
        } else {
          attemptPlay(!!unmuteNow, loadToken);
        }
      }
    },

    stop: function () {
      clearTimers();
      stopScreensaverPrevent();
      loadToken++;
      isSwitching = true;
      userPaused = false;
      currentItem = null;
      candidates = [];
      candidateIndex = 0;
      if (videoEl) {
        try {
          videoEl.pause();
          clearVideoSources();
          videoEl.load();
        } catch (e) {}
      }
      isSwitching = false;
      this.mountTo('hidden');
    },

    togglePlayPause: function () {
      if (!videoEl || !currentItem) { return false; }
      if (videoEl.paused) {
        userPaused = false;
        videoEl.muted = false;
        setMutedFlag(false);
        attemptPlay(true, loadToken);
        return true;
      }
      userPaused = true;
      try { videoEl.pause(); } catch (e) {}
      return false;
    },

    setPaused: function (pauseFlag) {
      if (!videoEl || !currentItem) { return; }
      userPaused = !!pauseFlag;
      try {
        if (pauseFlag) {
          videoEl.pause();
        } else {
          videoEl.muted = false;
          setMutedFlag(false);
          attemptPlay(true, loadToken);
        }
      } catch (e) {}
    },

    isPaused: function () {
      return !videoEl || videoEl.paused;
    },

    seekBy: function (deltaSeconds) {
      if (!videoEl || isLiveStream) { return false; }
      if (!videoEl.duration || isNaN(videoEl.duration) || !isFinite(videoEl.duration)) {
        return false;
      }
      var next = (videoEl.currentTime || 0) + deltaSeconds;
      if (next < 0) { next = 0; }
      if (next > videoEl.duration - 1) { next = Math.max(0, videoEl.duration - 1); }
      try {
        videoEl.currentTime = next;
        return true;
      } catch (e) {
        return false;
      }
    },

    seekTo: function (targetSeconds) {
      if (!videoEl || isLiveStream) { return false; }
      if (!videoEl.duration || isNaN(videoEl.duration) || !isFinite(videoEl.duration)) {
        return false;
      }
      var next = Number(targetSeconds);
      if (isNaN(next)) { return false; }
      if (next < 0) { next = 0; }
      if (next > videoEl.duration - 1) { next = Math.max(0, videoEl.duration - 1); }
      try {
        videoEl.currentTime = next;
        return true;
      } catch (e) {
        return false;
      }
    },

    getCurrentTime: function () {
      return videoEl ? (videoEl.currentTime || 0) : 0;
    },

    getDuration: function () {
      return (videoEl && videoEl.duration && isFinite(videoEl.duration)) ? videoEl.duration : 0;
    },

    getStreamTechInfo: function () {
      return {
        format: activeFormatLabel,
        resolution: activeResolutionText
      };
    },

    cycleAspectRatio: function () {
      var idx = aspectModes.indexOf(currentAspect);
      var nextMode = aspectModes[(idx + 1) % aspectModes.length];
      applyAspectClass(nextMode);
      IPTVStorage.updateSetting('aspectMode', nextMode);
      return { mode: nextMode, label: aspectLabels[nextMode] };
    },

    getAspectInfo: function () {
      return { mode: currentAspect, label: aspectLabels[currentAspect] || 'Orijinal' };
    },

    cyclePlaybackSpeed: function () {
      if (!videoEl || !currentItem) { return 1.0; }
      var idx = speedSteps.indexOf(currentSpeed);
      var nextSpeed = speedSteps[(idx + 1) % speedSteps.length];
      return this.setPlaybackSpeed(nextSpeed);
    },

    setPlaybackSpeed: function (rate) {
      if (!videoEl || !currentItem) { return 1.0; }
      clearSpeedWatchdog();
      currentSpeed = rate;

      try {
        videoEl.playbackRate = rate;
      } catch (e) {
        revertSpeedWithWarning();
        return 1.0;
      }

      if (rate !== 1.0) {
        speedStartTime = videoEl.currentTime || 0;
        speedProgressed = false;
        speedTesting = true;
        speedWatchTimer = window.setTimeout(function () {
          if (!speedTesting) { return; }
          var stuck = !speedProgressed || videoEl.error || (videoEl.currentTime <= speedStartTime + 0.15 && !videoEl.paused);
          speedTesting = false;
          if (stuck || isLiveStream) {
            revertSpeedWithWarning();
          }
        }, 3000);
      }
      return currentSpeed;
    },

    getPlaybackSpeed: function () {
      return currentSpeed;
    },

    getAudioTracks: function () {
      var tracks = [];
      if (videoEl && videoEl.audioTracks && videoEl.audioTracks.length > 0) {
        for (var i = 0; i < videoEl.audioTracks.length; i++) {
          var t = videoEl.audioTracks[i];
          tracks.push({
            index: i,
            label: t.label || t.language || ('Ses Kanalı ' + (i + 1)),
            active: !!t.enabled
          });
        }
      } else {
        tracks.push({ index: 0, label: 'Varsayılan Ses (Orijinal)', active: true });
      }
      return tracks;
    },

    selectAudioTrack: function (index) {
      if (!videoEl || !videoEl.audioTracks || videoEl.audioTracks.length === 0) { return; }
      for (var i = 0; i < videoEl.audioTracks.length; i++) {
        videoEl.audioTracks[i].enabled = (i === index);
      }
    },

    getSubtitleTracks: function () {
      var tracks = [{ index: -1, label: 'Kapalı', active: true }];
      if (videoEl && videoEl.textTracks && videoEl.textTracks.length > 0) {
        var anyActive = false;
        for (var i = 0; i < videoEl.textTracks.length; i++) {
          var t = videoEl.textTracks[i];
          var isShowing = (t.mode === 'showing');
          if (isShowing) { anyActive = true; }
          tracks.push({
            index: i,
            label: t.label || t.language || ('Altyazı ' + (i + 1)),
            active: isShowing
          });
        }
        tracks[0].active = !anyActive;
      }
      return tracks;
    },

    selectSubtitleTrack: function (index) {
      if (!videoEl || !videoEl.textTracks) { return; }
      for (var i = 0; i < videoEl.textTracks.length; i++) {
        videoEl.textTracks[i].mode = (i === index) ? 'showing' : 'disabled';
      }
    },

    getCurrentItem: function () {
      return currentItem;
    },

    isLive: function () {
      return isLiveStream;
    }
  };
})();
