/* ==========================================================================
   js/parser.js - Memory-Safe ES5 M3U/M3U8 & Xtream Codes API Parser
   Designed for LG webOS 2.2.3 (WebKit 538.2 / Chrome 34)
   Handles 10,000+ channels via chunked streaming line-by-line parsing
   ========================================================================== */

var IPTVParser = (function () {
  'use strict';

  var XHR_TIMEOUT = 25000;
  var CHUNK_LINES = 2000;

  // Pure ES5 Base64 UTF-8 decoder for Xtream EPG titles & descriptions
  function decodeBase64Utf8(str) {
    if (!str) { return ''; }
    try {
      var bin = window.atob(str);
      var out = '';
      var i = 0;
      var len = bin.length;
      while (i < len) {
        var c = bin.charCodeAt(i++);
        if (c < 128) {
          out += String.fromCharCode(c);
        } else if (c > 191 && c < 224) {
          var c2 = bin.charCodeAt(i++);
          out += String.fromCharCode(((c & 31) << 6) | (c2 & 63));
        } else {
          var c2b = bin.charCodeAt(i++);
          var c3 = bin.charCodeAt(i++);
          out += String.fromCharCode(((c & 15) << 12) | ((c2b & 63) << 6) | (c3 & 63));
        }
      }
      return out;
    } catch (e) {
      return str;
    }
  }

  function trimStr(s) {
    if (!s) { return ''; }
    return String(s).replace(/^\s+|\s+$/g, '');
  }

  function normalizeBaseUrl(url) {
    var u = trimStr(url);
    if (!u) { return ''; }
    if (u.indexOf('http://') !== 0 && u.indexOf('https://') !== 0) {
      u = 'http://' + u;
    }
    var qIdx = u.indexOf('?');
    if (qIdx !== -1) {
      u = u.substring(0, qIdx);
    }
    u = u.replace(/\/(player_api|panel_api|get)\.php$/i, '');
    while (u.length > 0 && u.charAt(u.length - 1) === '/') {
      u = u.substring(0, u.length - 1);
    }
    return u;
  }

  function normalizeProxyBase(rawProxy) {
    var p = trimStr(rawProxy);
    if (!p) { return ''; }
    if (p.indexOf('{url}') !== -1) { return p; }
    if (p.indexOf('?') !== -1) { return p; }
    if (p.charAt(p.length - 1) === '/') {
      return p + '?url=';
    }
    return p + '/?url=';
  }

  function buildProxiedUrl(targetUrl) {
    if (!targetUrl) { return ''; }
    var proxy = '';
    try {
      if (typeof IPTVStorage !== 'undefined' && IPTVStorage.getSettings) {
        proxy = normalizeProxyBase(IPTVStorage.getSettings().corsProxy || '');
      }
    } catch (e) {}
    if (!proxy) { return targetUrl; }
    if (proxy.indexOf('{url}') !== -1) {
      return proxy.replace('{url}', encodeURIComponent(targetUrl));
    }
    return proxy + encodeURIComponent(targetUrl);
  }

  function isHttpsPage() {
    try {
      return !!(window.location && window.location.protocol === 'https:');
    } catch (e) {
      return false;
    }
  }

  function xhrGet(url, onSuccess, onError) {
    var reqUrl = buildProxiedUrl(url);
    var hasProxy = (reqUrl !== url);
    var canDirectFallback = hasProxy && !(isHttpsPage() && url.indexOf('http://') === 0);

    function runRequest(finalUrl, usingProxy, allowDirectRetry) {
      var xhr = new XMLHttpRequest();
      var finished = false;

      function doneError(msg) {
        if (finished) { return; }
        finished = true;
        if (allowDirectRetry) {
          runRequest(url, false, false);
          return;
        }
        if (onError) { onError(msg); }
      }

      function buildNetworkErrorMsg() {
        if (isHttpsPage() && url.indexOf('http://') === 0 && !usingProxy) {
          return 'HTTPS / CORS Engeli: GitHub Pages (HTTPS) üzerinden HTTP IPTV adresi doğrudan okunamaz. CORS Proxy URL girin veya LG TV (.ipk) kullanın.';
        }
        if (!usingProxy && window.location && (window.location.protocol === 'http:' || window.location.protocol === 'https:')) {
          return 'Tarayıcı CORS Engeli: IPTV sunucusu tarayıcı erişimine izin vermiyor. CORS Proxy URL girin veya LG TV (.ipk) kullanın.';
        }
        return 'Sunucuya erişilemedi (CORS Proxy veya IPTV panel adresi hatalı/engelli olabilir).';
      }

      try {
        xhr.open('GET', finalUrl, true);
        xhr.timeout = XHR_TIMEOUT;
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4 || finished) { return; }
          if (xhr.status >= 200 && xhr.status < 300) {
            finished = true;
            if (onSuccess) { onSuccess(xhr.responseText); }
          } else if (xhr.status === 0) {
            doneError(buildNetworkErrorMsg());
          } else if (usingProxy && (xhr.status === 404 || xhr.status === 403 || xhr.status === 400)) {
            doneError('Proxy / Panel hatası: HTTP ' + xhr.status + ' (Worker User-Agent veya Proxy URL ayarını kontrol edin).');
          } else {
            doneError('Sunucu hatası: HTTP ' + xhr.status);
          }
        };
        xhr.ontimeout = function () {
          doneError('Sunucu yanıt vermedi (Zaman aşımı).');
        };
        xhr.onerror = function () {
          doneError(buildNetworkErrorMsg());
        };
        xhr.send(null);
      } catch (e) {
        doneError('İstek gönderilemedi: ' + (e.message || 'Bilinmeyen hata'));
      }
    }

    runRequest(reqUrl, hasProxy, canDirectFallback);
  }

  function xhrGetJson(url, onSuccess, onError) {
    xhrGet(url, function (text) {
      try {
        var parsed = JSON.parse(text);
        onSuccess(parsed);
      } catch (e) {
        onError('Geçersiz JSON yanıtı alındı.');
      }
    }, onError);
  }

  function extractAttr(line, attrName) {
    var key = attrName + '="';
    var idx = line.indexOf(key);
    if (idx === -1) { return ''; }
    var start = idx + key.length;
    var end = line.indexOf('"', start);
    if (end === -1) { return ''; }
    return line.substring(start, end);
  }

  function isAdultCategoryName(name) {
    if (!name) { return false; }
    var low = String(name).toLowerCase();
    var patterns = ['+18', '18+', 'adult', 'yetişkin', 'yetiskin', 'xxx', 'porn', 'erotic', 'erotik'];
    for (var i = 0; i < patterns.length; i++) {
      if (low.indexOf(patterns[i]) !== -1) {
        return true;
      }
    }
    return false;
  }

  // Memory-friendly chunked M3U/M3U8 parser (no full-string .split() array spike)
  function parseM3UText(text, onProgress, onComplete) {
    var len = text ? text.length : 0;
    var pos = 0;
    var liveChannels = [];
    var vodItems = [];
    var seriesMap = {};
    var seriesItems = [];
    var liveCatMap = {};
    var vodCatMap = {};
    var pendingMeta = null;
    var chNum = 1;

    function processChunk() {
      var linesProcessed = 0;
      while (pos < len && linesProcessed < CHUNK_LINES) {
        var nl = text.indexOf('\n', pos);
        var line;
        if (nl === -1) {
          line = text.substring(pos);
          pos = len;
        } else {
          line = text.substring(pos, nl);
          pos = nl + 1;
        }
        linesProcessed++;

        line = trimStr(line);
        if (!line) { continue; }

        if (line.indexOf('#EXTINF:') === 0) {
          var commaIdx = line.lastIndexOf(',');
          var displayName = commaIdx !== -1 ? trimStr(line.substring(commaIdx + 1)) : 'Kanal ' + chNum;
          var group = extractAttr(line, 'group-title') || 'Genel';
          var logo = extractAttr(line, 'tvg-logo') || '';
          var tvgId = extractAttr(line, 'tvg-id') || '';
          pendingMeta = {
            name: displayName || ('Kanal ' + chNum),
            group: group,
            logo: logo,
            tvgId: tvgId
          };
        } else if (line.charAt(0) === '#') {
          continue;
        } else if (line.indexOf('http://') === 0 || line.indexOf('https://') === 0 || line.indexOf('rtmp://') === 0) {
          var meta = pendingMeta || {
            name: 'Yayın ' + chNum,
            group: 'Genel',
            logo: '',
            tvgId: ''
          };
          pendingMeta = null;

          var lowUrl = line.toLowerCase();
          var isVodFile = (lowUrl.indexOf('.mp4') !== -1 || lowUrl.indexOf('.mkv') !== -1 || lowUrl.indexOf('.avi') !== -1 || lowUrl.indexOf('/movie/') !== -1);
          var isSeriesUrl = (lowUrl.indexOf('/series/') !== -1);

          if (isSeriesUrl) {
            var sKey = meta.group + '::' + meta.name.replace(/\s+S\d+E\d+.*$/i, '');
            if (!seriesMap[sKey]) {
              seriesMap[sKey] = {
                id: 'ser_' + (seriesItems.length + 1),
                type: 'series',
                name: meta.name.replace(/\s+S\d+E\d+.*$/i, ''),
                group: meta.group,
                poster: meta.logo,
                year: '2024',
                rating: '7.8',
                plot: 'M3U listesinden aktarılan dizi içeriği.',
                director: 'Bilinmiyor',
                cast: '-',
                seasons: { '1': [] }
              };
              seriesItems.push(seriesMap[sKey]);
            }
            seriesMap[sKey].seasons['1'].push({
              id: 'ep_' + chNum,
              episodeNum: seriesMap[sKey].seasons['1'].length + 1,
              title: meta.name,
              duration: '45 dk',
              url: line
            });
          } else if (isVodFile) {
            vodCatMap[meta.group] = (vodCatMap[meta.group] || 0) + 1;
            vodItems.push({
              id: 'vod_' + (vodItems.length + 1),
              type: 'vod',
              name: meta.name,
              group: meta.group,
              poster: meta.logo,
              url: line,
              year: '2024',
              rating: '7.5',
              genre: meta.group,
              director: 'Bilinmiyor',
              cast: '-',
              plot: 'M3U listesinde yer alan film içeriği.'
            });
          } else {
            liveCatMap[meta.group] = (liveCatMap[meta.group] || 0) + 1;
            liveChannels.push({
              id: 'live_' + chNum,
              num: chNum,
              type: 'live',
              name: meta.name,
              group: meta.group,
              logo: meta.logo,
              epgId: meta.tvgId,
              url: line,
              isAdult: isAdultCategoryName(meta.group)
            });
          }
          chNum++;
        }
      }

      if (onProgress && len > 0) {
        onProgress(Math.min(98, Math.floor((pos / len) * 100)), 'Ayrıştırılıyor... (' + liveChannels.length + ' kanal)');
      }

      if (pos < len) {
        window.setTimeout(processChunk, 8);
      } else {
        var liveCats = [];
        var k;
        for (k in liveCatMap) {
          if (liveCatMap.hasOwnProperty(k)) {
            liveCats.push({ name: k, count: liveCatMap[k], isAdult: isAdultCategoryName(k) });
          }
        }
        var vodCats = [];
        for (k in vodCatMap) {
          if (vodCatMap.hasOwnProperty(k)) {
            vodCats.push({ name: k, count: vodCatMap[k], isAdult: isAdultCategoryName(k) });
          }
        }
        var serCatMap = {};
        var serCats = [];
        for (var s = 0; s < seriesItems.length; s++) {
          var sg = seriesItems[s].group;
          serCatMap[sg] = (serCatMap[sg] || 0) + 1;
        }
        for (k in serCatMap) {
          if (serCatMap.hasOwnProperty(k)) {
            serCats.push({ name: k, count: serCatMap[k], isAdult: isAdultCategoryName(k) });
          }
        }
        onComplete({
          sourceType: 'm3u',
          liveCategories: liveCats,
          liveChannels: liveChannels,
          vodCategories: vodCats,
          vodItems: vodItems,
          seriesCategories: serCats,
          seriesItems: seriesItems
        });
      }
    }

    processChunk();
  }

  function loadM3U(profile, onProgress, onSuccess, onError) {
    if (onProgress) { onProgress(12, 'M3U dosyası indiriliyor...'); }
    xhrGet(profile.url, function (text) {
      if (!text || text.indexOf('#EXT') === -1 && text.indexOf('http') === -1) {
        onError('Geçerli bir M3U/M3U8 yayın listesi bulunamadı.');
        return;
      }
      parseM3UText(text, onProgress, onSuccess);
    }, onError);
  }

  function loadXtream(profile, onProgress, onSuccess, onError) {
    var base = normalizeBaseUrl(profile.serverUrl);
    var user = encodeURIComponent(trimStr(profile.username));
    var pass = encodeURIComponent(trimStr(profile.password));
    var apiBase = base + '/player_api.php?username=' + user + '&password=' + pass;

    var state = {
      userInfo: null,
      liveCatsRaw: [],
      liveStreamsRaw: [],
      vodCatsRaw: [],
      vodStreamsRaw: [],
      seriesCatsRaw: [],
      seriesRaw: []
    };

    if (onProgress) { onProgress(10, 'Xtream sunucusuna bağlanılıyor...'); }

    xhrGetJson(apiBase, function (authData) {
      if (!authData || !authData.user_info || String(authData.user_info.auth) === '0') {
        onError('Xtream Codes giriş bilgileri hatalı veya hesap süresi dolmuş.');
        return;
      }
      state.userInfo = authData.user_info;

      if (onProgress) { onProgress(25, 'Canlı TV kategorileri alınıyor...'); }
      xhrGetJson(apiBase + '&action=get_live_categories', function (liveCats) {
        state.liveCatsRaw = liveCats && liveCats.length ? liveCats : [];

        if (onProgress) { onProgress(42, 'Canlı TV kanalları alınıyor...'); }
        xhrGetJson(apiBase + '&action=get_live_streams', function (liveStreams) {
          state.liveStreamsRaw = liveStreams && liveStreams.length ? liveStreams : [];

          if (onProgress) { onProgress(60, 'Film (VOD) arşivi alınıyor...'); }
          xhrGetJson(apiBase + '&action=get_vod_categories', function (vodCats) {
            state.vodCatsRaw = vodCats && vodCats.length ? vodCats : [];

            xhrGetJson(apiBase + '&action=get_vod_streams', function (vodStreams) {
              state.vodStreamsRaw = vodStreams && vodStreams.length ? vodStreams : [];

              if (onProgress) { onProgress(80, 'Dizi arşivi alınıyor...'); }
              xhrGetJson(apiBase + '&action=get_series_categories', function (serCats) {
                state.seriesCatsRaw = serCats && serCats.length ? serCats : [];

                xhrGetJson(apiBase + '&action=get_series', function (serList) {
                  state.seriesRaw = serList && serList.length ? serList : [];
                  if (onProgress) { onProgress(95, 'Veriler hazırlanıyor...'); }
                  finalizeXtreamData(base, profile.username, profile.password, state, onSuccess);
                }, function () {
                  finalizeXtreamData(base, profile.username, profile.password, state, onSuccess);
                });
              }, function () {
                finalizeXtreamData(base, profile.username, profile.password, state, onSuccess);
              });
            }, function () {
              finalizeXtreamData(base, profile.username, profile.password, state, onSuccess);
            });
          }, function () {
            finalizeXtreamData(base, profile.username, profile.password, state, onSuccess);
          });
        }, onError);
      }, onError);
    }, onError);
  }

  function finalizeXtreamData(base, rawUser, rawPass, state, onSuccess) {
    var i, item;
    var liveCatNames = {};
    var liveCatCounts = {};
    for (i = 0; i < state.liveCatsRaw.length; i++) {
      liveCatNames[String(state.liveCatsRaw[i].category_id)] = state.liveCatsRaw[i].category_name;
    }

    var liveChannels = [];
    for (i = 0; i < state.liveStreamsRaw.length; i++) {
      item = state.liveStreamsRaw[i];
      var grp = liveCatNames[String(item.category_id)] || 'Genel';
      liveCatCounts[grp] = (liveCatCounts[grp] || 0) + 1;
      liveChannels.push({
        id: String(item.stream_id),
        streamId: String(item.stream_id),
        num: i + 1,
        type: 'live',
        name: item.name || ('Kanal ' + (i + 1)),
        group: grp,
        logo: item.stream_icon || '',
        epgId: item.epg_channel_id || '',
        url: base + '/live/' + rawUser + '/' + rawPass + '/' + item.stream_id + '.ts',
        tsUrl: base + '/live/' + rawUser + '/' + rawPass + '/' + item.stream_id + '.ts',
        rawTsUrl: base + '/' + rawUser + '/' + rawPass + '/' + item.stream_id + '.ts',
        rawUrl: base + '/' + rawUser + '/' + rawPass + '/' + item.stream_id,
        hlsUrl: base + '/live/' + rawUser + '/' + rawPass + '/' + item.stream_id + '.m3u8',
        fallbackUrl: base + '/live/' + rawUser + '/' + rawPass + '/' + item.stream_id + '.m3u8',
        isAdult: isAdultCategoryName(grp)
      });
    }

    var liveCategories = [];
    for (i = 0; i < state.liveCatsRaw.length; i++) {
      var lcName = state.liveCatsRaw[i].category_name;
      if (liveCatCounts[lcName]) {
        liveCategories.push({
          id: String(state.liveCatsRaw[i].category_id),
          name: lcName,
          count: liveCatCounts[lcName],
          isAdult: isAdultCategoryName(lcName)
        });
      }
    }

    var vodCatNames = {};
    var vodCatCounts = {};
    for (i = 0; i < state.vodCatsRaw.length; i++) {
      vodCatNames[String(state.vodCatsRaw[i].category_id)] = state.vodCatsRaw[i].category_name;
    }

    var vodItems = [];
    for (i = 0; i < state.vodStreamsRaw.length; i++) {
      item = state.vodStreamsRaw[i];
      var vGrp = vodCatNames[String(item.category_id)] || 'Filmler';
      var ext = item.container_extension || 'mp4';
      vodCatCounts[vGrp] = (vodCatCounts[vGrp] || 0) + 1;
      vodItems.push({
        id: String(item.stream_id),
        streamId: String(item.stream_id),
        type: 'vod',
        name: item.name || 'Film',
        group: vGrp,
        poster: item.stream_icon || '',
        url: base + '/movie/' + rawUser + '/' + rawPass + '/' + item.stream_id + '.' + ext,
        year: item.added ? String(new Date(Number(item.added) * 1000).getFullYear()) : '',
        rating: item.rating || '-',
        genre: vGrp,
        director: '-',
        cast: '-',
        plot: 'Film detayları seçildiğinde sunucudan yüklenir.'
      });
    }

    var vodCategories = [];
    for (i = 0; i < state.vodCatsRaw.length; i++) {
      var vcName = state.vodCatsRaw[i].category_name;
      if (vodCatCounts[vcName]) {
        vodCategories.push({
          id: String(state.vodCatsRaw[i].category_id),
          name: vcName,
          count: vodCatCounts[vcName],
          isAdult: isAdultCategoryName(vcName)
        });
      }
    }

    var serCatNames = {};
    var serCatCounts = {};
    for (i = 0; i < state.seriesCatsRaw.length; i++) {
      serCatNames[String(state.seriesCatsRaw[i].category_id)] = state.seriesCatsRaw[i].category_name;
    }

    var seriesItems = [];
    for (i = 0; i < state.seriesRaw.length; i++) {
      item = state.seriesRaw[i];
      var sGrp = serCatNames[String(item.category_id)] || 'Diziler';
      serCatCounts[sGrp] = (serCatCounts[sGrp] || 0) + 1;
      seriesItems.push({
        id: String(item.series_id),
        seriesId: String(item.series_id),
        type: 'series',
        name: item.name || 'Dizi',
        group: sGrp,
        poster: item.cover || '',
        year: item.releaseDate ? String(item.releaseDate).substring(0, 4) : '',
        rating: item.rating || '-',
        genre: item.genre || sGrp,
        director: item.director || '-',
        cast: item.cast || '-',
        plot: item.plot || 'Bölüm listesi için dizi detayını açın.',
        seasons: null
      });
    }

    var seriesCategories = [];
    for (i = 0; i < state.seriesCatsRaw.length; i++) {
      var scName = state.seriesCatsRaw[i].category_name;
      if (serCatCounts[scName]) {
        seriesCategories.push({
          id: String(state.seriesCatsRaw[i].category_id),
          name: scName,
          count: serCatCounts[scName],
          isAdult: isAdultCategoryName(scName)
        });
      }
    }

    var ui = state.userInfo || {};
    var expTs = ui.exp_date ? (Number(ui.exp_date) * 1000) : 0;
    var accountInfo = {
      username: ui.username || rawUser,
      status: ui.status || 'Active',
      expTs: expTs,
      activeCons: ui.active_cons !== undefined ? String(ui.active_cons) : '0',
      maxConnections: ui.max_connections !== undefined ? String(ui.max_connections) : '1'
    };

    onSuccess({
      sourceType: 'xtream',
      xtreamConfig: { base: base, user: rawUser, pass: rawPass },
      accountInfo: accountInfo,
      liveCategories: liveCategories,
      liveChannels: liveChannels,
      vodCategories: vodCategories,
      vodItems: vodItems,
      seriesCategories: seriesCategories,
      seriesItems: seriesItems
    });
  }

  function fetchXtreamShortEpg(xtreamCfg, streamId, onResult) {
    if (!xtreamCfg || !streamId) {
      onResult(null);
      return;
    }
    var url = xtreamCfg.base + '/player_api.php?username=' + encodeURIComponent(xtreamCfg.user) +
      '&password=' + encodeURIComponent(xtreamCfg.pass) +
      '&action=get_short_epg&stream_id=' + encodeURIComponent(streamId) + '&limit=4';
    xhrGetJson(url, function (data) {
      if (!data || !data.epg_listings || !data.epg_listings.length) {
        onResult(null);
        return;
      }
      var list = data.epg_listings;
      var nowItem = list[0];
      var nextItem = list.length > 1 ? list[1] : null;
      onResult({
        now: {
          title: decodeBase64Utf8(nowItem.title),
          desc: decodeBase64Utf8(nowItem.description),
          startTs: Number(nowItem.start_timestamp) * 1000,
          stopTs: Number(nowItem.stop_timestamp) * 1000
        },
        next: nextItem ? {
          title: decodeBase64Utf8(nextItem.title),
          startTs: Number(nextItem.start_timestamp) * 1000,
          stopTs: Number(nextItem.stop_timestamp) * 1000
        } : null
      });
    }, function () {
      onResult(null);
    });
  }

  function fetchXtreamSeriesInfo(xtreamCfg, seriesId, onResult) {
    if (!xtreamCfg || !seriesId) {
      onResult(null);
      return;
    }
    var url = xtreamCfg.base + '/player_api.php?username=' + encodeURIComponent(xtreamCfg.user) +
      '&password=' + encodeURIComponent(xtreamCfg.pass) +
      '&action=get_series_info&series_id=' + encodeURIComponent(seriesId);
    xhrGetJson(url, function (data) {
      if (!data || !data.episodes) {
        onResult(null);
        return;
      }
      var seasons = {};
      var seasonKey;
      for (seasonKey in data.episodes) {
        if (data.episodes.hasOwnProperty(seasonKey)) {
          var eps = data.episodes[seasonKey];
          seasons[seasonKey] = [];
          for (var i = 0; i < eps.length; i++) {
            var ep = eps[i];
            var ext = ep.container_extension || 'mp4';
            seasons[seasonKey].push({
              id: String(ep.id),
              episodeNum: ep.episode_num || (i + 1),
              title: ep.title || ('Bölüm ' + (i + 1)),
              duration: (ep.info && ep.info.duration) ? ep.info.duration : '45 dk',
              url: xtreamCfg.base + '/series/' + xtreamCfg.user + '/' + xtreamCfg.pass + '/' + ep.id + '.' + ext
            });
          }
        }
      }
      onResult({
        info: data.info || null,
        seasons: seasons
      });
    }, function () {
      onResult(null);
    });
  }

  function fetchXtreamVodInfo(xtreamCfg, vodId, onResult) {
    if (!xtreamCfg || !vodId) {
      onResult(null);
      return;
    }
    var url = xtreamCfg.base + '/player_api.php?username=' + encodeURIComponent(xtreamCfg.user) +
      '&password=' + encodeURIComponent(xtreamCfg.pass) +
      '&action=get_vod_info&vod_id=' + encodeURIComponent(vodId);
    xhrGetJson(url, function (data) {
      onResult(data && data.info ? data.info : null);
    }, function () {
      onResult(null);
    });
  }

  // Real working open-source HLS & MP4 streams for immediate testing
  function buildDemoData() {
    var now = new Date().getTime();
    var hr = 3600000;
    var baseStart = Math.floor(now / hr) * hr;

    var STREAM_MUX_HLS = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
    var STREAM_SINTEL_HLS = 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8';
    var STREAM_TEARS_HLS = 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8';
    var MP4_BBB = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
    var MP4_SINTEL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4';
    var MP4_TEARS = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4';
    var MP4_ELEPHANT = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4';
    var MP4_BLAZES = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';
    var MP4_JOY = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4';

    function makeEpg(title1, desc1, title2) {
      return {
        now: {
          title: title1,
          desc: desc1,
          startTs: baseStart,
          stopTs: baseStart + hr
        },
        next: {
          title: title2,
          startTs: baseStart + hr,
          stopTs: baseStart + hr * 2
        }
      };
    }

    var liveChannels = [
      {
        id: 'demo_1', num: 1, type: 'live', name: 'PRO ULUSAL 1 FHD', group: 'TR: Ulusal',
        logo: '', url: STREAM_MUX_HLS, fallbackUrl: MP4_BBB, quality: 'FHD',
        epg: makeEpg('Gündem Özel Canlı Yayın', 'Türkiye ve dünyadan öne çıkan gelişmeler, uzman konuklar ve canlı bağlantılarla ekranlarda.', 'Akşam Haber Bülteni')
      },
      {
        id: 'demo_2', num: 2, type: 'live', name: 'PRO SİNEMA HD', group: 'TR: Sinema',
        logo: '', url: STREAM_SINTEL_HLS, fallbackUrl: MP4_SINTEL, quality: 'FHD',
        epg: makeEpg('Sintel — Fantastik Macera', 'Genç bir savaşçının kayıp ejderhasını ararken çıktığı destansı yolculuk.', 'Çelik Gözyaşları (Tears of Steel)')
      },
      {
        id: 'demo_3', num: 3, type: 'live', name: 'PRO BİLİM KURGU HD', group: 'TR: Sinema',
        logo: '', url: STREAM_TEARS_HLS, fallbackUrl: MP4_TEARS, quality: 'FHD',
        epg: makeEpg('Tears of Steel (4K Master)', 'Amsterdam sokaklarında robotlara karşı insanlığın geleceğini belirleyen kritik mücadele.', 'Gece Sineması Kuşağı')
      },
      {
        id: 'demo_4', num: 4, type: 'live', name: 'HABER 24 CANLI', group: 'TR: Haber',
        logo: '', url: STREAM_MUX_HLS, fallbackUrl: MP4_BLAZES, quality: 'HD',
        epg: makeEpg('Ekonomi ve Teknoloji Raporu', 'Küresel piyasalar, teknoloji trendleri ve anlık analizler.', 'Gece Görüşü')
      },
      {
        id: 'demo_5', num: 5, type: 'live', name: 'PRO SPOR ARENA 1', group: 'TR: Spor',
        logo: '', url: STREAM_TEARS_HLS, fallbackUrl: MP4_JOY, quality: 'FHD',
        epg: makeEpg('Avrupa Ligi Maç Özeti & Analiz', 'Haftanın kritik karşılaşmaları, taktik tahtası ve stüdyo yorumları.', 'Canlı Basketbol Karşılaşması')
      },
      {
        id: 'demo_6', num: 6, type: 'live', name: 'PRO SPOR MOTOR', group: 'TR: Spor',
        logo: '', url: STREAM_MUX_HLS, fallbackUrl: MP4_JOY, quality: 'HD',
        epg: makeEpg('Pistte Hız — Otomobil Sporları', 'Dünya pistlerinden nefes kesen yarışlar ve araç incelemeleri.', 'Ralli Özel')
      },
      {
        id: 'demo_7', num: 7, type: 'live', name: 'DOĞA BELGESEL FHD', group: 'TR: Belgesel',
        logo: '', url: STREAM_SINTEL_HLS, fallbackUrl: MP4_BBB, quality: 'FHD',
        epg: makeEpg('Vahşi Ormanın Sırları', 'Yaban hayatının derinliklerine uzanan yüksek çözünürlüklü doğa belgeseli.', 'Okyanusların Derinliği')
      },
      {
        id: 'demo_8', num: 8, type: 'live', name: 'ANİMASYON ÇOCUK TV', group: 'TR: Çocuk',
        logo: '', url: STREAM_MUX_HLS, fallbackUrl: MP4_BBB, quality: 'HD',
        epg: makeEpg('Big Buck Bunny — Macera Saati', 'Neşeli tavşanın ormandaki komik dostlarıyla dolu eğlenceli maceraları.', 'Rüyalar Diyarı')
      },
      {
        id: 'demo_9', num: 9, type: 'live', name: 'PRO MÜZİK & KLİP', group: 'TR: Müzik',
        logo: '', url: STREAM_TEARS_HLS, fallbackUrl: MP4_ELEPHANT, quality: 'HD',
        epg: makeEpg('Top 20 Haftanın En İyileri', 'Listelerin zirvesindeki en popüler parçalar kesintisiz yayında.', 'Akustik Gece')
      },
      {
        id: 'demo_10', num: 10, type: 'live', name: 'YETİŞKİN SİNEMA (+18)', group: 'Yetişkin (+18)',
        logo: '', url: STREAM_TEARS_HLS, fallbackUrl: MP4_ELEPHANT, quality: 'HD', isAdult: true,
        epg: makeEpg('Gece Kuşağı Özel Yayın', 'Bu kategori Ebeveyn Kontrolü PIN kodu ile korunmaktadır.', 'Gece Sineması')
      }
    ];

    // Add extra demo channels to demonstrate smooth virtual windowing across 60+ channels
    var extraGroups = ['TR: Ulusal', 'TR: Haber', 'TR: Spor', 'TR: Belgesel', 'TR: Sinema', 'TR: Müzik'];
    for (var n = 11; n <= 60; n++) {
      var gName = extraGroups[(n - 1) % extraGroups.length];
      liveChannels.push({
        id: 'demo_' + n,
        num: n,
        type: 'live',
        name: 'PRO TEST KANAL ' + n + (n % 2 === 0 ? ' FHD' : ' HD'),
        group: gName,
        logo: '',
        url: (n % 2 === 0) ? STREAM_MUX_HLS : STREAM_SINTEL_HLS,
        fallbackUrl: (n % 3 === 0) ? MP4_TEARS : ((n % 2 === 0) ? MP4_BBB : MP4_SINTEL),
        quality: (n % 2 === 0) ? 'FHD' : 'HD',
        epg: makeEpg('Özel Yayın Kuşağı #' + n, 'Sanal liste (Virtual Windowing) bellek koruma testi için aktif canlı akış kanalı.', 'Sonraki Yayın #' + (n + 1))
      });
    }

    var catCounts = {};
    var catOrder = [];
    for (var c = 0; c < liveChannels.length; c++) {
      var grp = liveChannels[c].group;
      if (!catCounts[grp]) {
        catCounts[grp] = 0;
        catOrder.push(grp);
      }
      catCounts[grp]++;
    }
    var liveCategories = [];
    for (var j = 0; j < catOrder.length; j++) {
      liveCategories.push({
        name: catOrder[j],
        count: catCounts[catOrder[j]],
        isAdult: isAdultCategoryName(catOrder[j])
      });
    }

    var vodItems = [
      {
        id: 'vod_1', type: 'vod', name: 'Tears of Steel', group: 'Bilim Kurgu',
        poster: '', url: MP4_TEARS, year: '2023', rating: '8.4', genre: 'Bilim Kurgu, Aksiyon',
        director: 'Ian Hubert', cast: 'Derek de Lint, Sergio Hasselbaink, Rogier Schippers',
        plot: 'Yakın gelecekteki Amsterdam şehrinde bir grup bilim insanı ve savaşçı, yapay zeka robotlarının şehri ele geçirmesini durdurmak için geçmişteki kritik bir olayı yeniden canlandırmaya çalışır.'
      },
      {
        id: 'vod_2', type: 'vod', name: 'Sintel: Ejderha Yolu', group: 'Fantastik',
        poster: '', url: MP4_SINTEL, year: '2022', rating: '8.7', genre: 'Fantastik, Macera',
        director: 'Colin Levy', cast: 'Halina Reijn, Thom Hoffman',
        plot: 'Yalnız bir genç kız olan Sintel, yaralı halde bulup büyüttüğü yavru ejderhası Scales kaçırılınca zorlu dağları ve tehlikeli diyarları aşarak onu kurtarmaya yemin eder.'
      },
      {
        id: 'vod_3', type: 'vod', name: 'Big Buck Bunny', group: 'Animasyon',
        poster: '', url: MP4_BBB, year: '2021', rating: '8.1', genre: 'Animasyon, Komedi',
        director: 'Sacha Goedegebure', cast: 'Blender Studio',
        plot: 'Barışçıl ve dev kalpli tavşan Bunny, ormandaki kelebeklere zarar veren üç yaramaz kemirgene unutulmaz ve zekice bir ders vermeye karar verir.'
      },
      {
        id: 'vod_4', type: 'vod', name: 'Elephants Dream', group: 'Bilim Kurgu',
        poster: '', url: MP4_ELEPHANT, year: '2020', rating: '7.6', genre: 'Bilim Kurgu, Gizem',
        director: 'Bassam Kurdali', cast: 'Tygo Gernandt, Cas Jansen',
        plot: 'Devasa ve sonu gelmeyen mekanik bir makinenin içinde yolculuk yapan Proog ve Emo, gerçeklik ile hayal arasındaki ince sınırda yüzleşir.'
      },
      {
        id: 'vod_5', type: 'vod', name: 'Büyük Alevler', group: 'Aksiyon',
        poster: '', url: MP4_BLAZES, year: '2024', rating: '7.9', genre: 'Aksiyon, Macera',
        director: 'Pro Studio', cast: 'Aksiyon Ekibi',
        plot: 'Yüksek tempolu aksiyon sahneleri ve etkileyici sinematografisiyle yüksek çözünürlüklü kısa film gösterimi.'
      },
      {
        id: 'vod_6', type: 'vod', name: 'Hız Tutkusu', group: 'Aksiyon',
        poster: '', url: MP4_JOY, year: '2024', rating: '8.0', genre: 'Aksiyon, Spor',
        director: 'Pro Studio', cast: 'Yarış Ekibi',
        plot: 'Kıvrımlı dağ yollarında adrenalin dolu sürüş deneyimi sunan yüksek kare hızlı test filmi.'
      }
    ];

    var vodCategories = [
      { name: 'Bilim Kurgu', count: 2, isAdult: false },
      { name: 'Fantastik', count: 1, isAdult: false },
      { name: 'Animasyon', count: 1, isAdult: false },
      { name: 'Aksiyon', count: 2, isAdult: false }
    ];

    var seriesItems = [
      {
        id: 'ser_1', type: 'series', name: 'Siber Ufuk (Cyber Horizon)', group: 'Bilim Kurgu Dizileri',
        poster: '', year: '2024', rating: '8.9', genre: 'Bilim Kurgu, Gerilim',
        director: 'M. Kaya', cast: 'A. Yılmaz, E. Demir, C. Arslan',
        plot: '2048 yılında enerji şebekesini koruyan bir grup mühendisin, küresel bir yapay zeka krizine karşı verdiği nefes kesen mücadele.',
        seasons: {
          '1': [
            { id: 's1e1', episodeNum: 1, title: '1. Bölüm: İlk Sinyal', duration: '12 dk', url: MP4_TEARS },
            { id: 's1e2', episodeNum: 2, title: '2. Bölüm: Karanlık Ağ', duration: '14 dk', url: MP4_SINTEL },
            { id: 's1e3', episodeNum: 3, title: '3. Bölüm: Çelik Kalkan', duration: '10 dk', url: MP4_ELEPHANT }
          ],
          '2': [
            { id: 's2e1', episodeNum: 1, title: '1. Bölüm: Yeni Başlangıç', duration: '10 dk', url: MP4_BBB },
            { id: 's2e2', episodeNum: 2, title: '2. Bölüm: Son Protokol', duration: '12 dk', url: MP4_TEARS }
          ]
        }
      },
      {
        id: 'ser_2', type: 'series', name: 'Kayıp Krallık Günlükleri', group: 'Macera Dizileri',
        poster: '', year: '2023', rating: '8.5', genre: 'Fantastik, Macera',
        director: 'S. Öztürk', cast: 'D. Aksoy, K. Aydın',
        plot: 'Antik haritaların izini süren kaşiflerin unutulmuş bir medeniyeti keşfetme serüveni.',
        seasons: {
          '1': [
            { id: 's2_1', episodeNum: 1, title: '1. Bölüm: Kadim Harita', duration: '14 dk', url: MP4_SINTEL },
            { id: 's2_2', episodeNum: 2, title: '2. Bölüm: Kuzey Geçidi', duration: '10 dk', url: MP4_BBB }
          ]
        }
      }
    ];

    var seriesCategories = [
      { name: 'Bilim Kurgu Dizileri', count: 1, isAdult: false },
      { name: 'Macera Dizileri', count: 1, isAdult: false }
    ];

    return {
      sourceType: 'demo',
      accountInfo: {
        username: 'demo_pro',
        status: 'Aktif (Demo)',
        expTs: now + (365 * 24 * 3600000),
        activeCons: '1',
        maxConnections: '3'
      },
      liveCategories: liveCategories,
      liveChannels: liveChannels,
      vodCategories: vodCategories,
      vodItems: vodItems,
      seriesCategories: seriesCategories,
      seriesItems: seriesItems
    };
  }

  return {
    loadProfile: function (profile, onProgress, onSuccess, onError) {
      if (!profile) {
        onError('Geçersiz profil.');
        return;
      }
      if (profile.type === 'demo') {
        if (onProgress) { onProgress(50, 'Demo yayın listesi hazırlanıyor...'); }
        window.setTimeout(function () {
          if (onProgress) { onProgress(100, 'Hazır'); }
          onSuccess(buildDemoData());
        }, 120);
        return;
      }
      if (profile.type === 'xtream') {
        loadXtream(profile, onProgress, onSuccess, onError);
      } else {
        loadM3U(profile, onProgress, onSuccess, onError);
      }
    },
    fetchXtreamShortEpg: fetchXtreamShortEpg,
    fetchXtreamSeriesInfo: fetchXtreamSeriesInfo,
    fetchXtreamVodInfo: fetchXtreamVodInfo,
    isAdultCategoryName: isAdultCategoryName,
    buildDemoData: buildDemoData
  };
})();
