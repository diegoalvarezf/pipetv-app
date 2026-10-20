/*
 * PipeTV: interfaz y navegación con el mando.
 *
 * Pantallas:
 *   list     -> columna de grupos + columna de canales
 *   watch    -> vídeo a pantalla completa con rótulo al cambiar de canal
 *   settings -> cambiar la lista (escribiéndola o mandándola desde el móvil)
 */
(function () {
  'use strict';

  var DEFAULT_LIST = 'https://www.tdtchannels.com/lists/tv.m3u8';
  var FAV_GROUP = '★ Favoritos';
  var ALL_GROUP = 'Todos';
  var CACHE_MAX_CHARS = 600000; // por lista; localStorage ronda los 5 MB en total

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 10009, ESC: 27, BACKSPACE: 8,
    CH_UP: 427, CH_DOWN: 428, PAGE_UP: 33, PAGE_DOWN: 34,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, INFO: 457,
    IME_DONE: 65376, IME_CANCEL: 65385
  };

  var TV_KEYS = ['ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green',
    'ColorF2Yellow', 'ColorF3Blue', 'Info',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

  var IS_TV = !!window.tizen;
  // Cargada como módulo de TizenBrew (servida desde su proxy local)
  var IN_TIZENBREW = location.hostname === '127.0.0.1' && location.port === '8081';
  // Servidor de desarrollo en el Mac
  var IS_DEV = location.hostname === 'localhost';
  // Proxy del servicio del módulo (tizenbrew/service.js) para listas sin CORS
  var LOCAL_PROXY = 'http://127.0.0.1:8090/fetch?url=';
  // TizenBrew (con el módulo TizenTube: YouTube sin anuncios)
  var TIZENBREW_ID = 'xvvl3S1bvH.TizenBrewStandalone';
  // En el navegador del Mac la lista remota choca con CORS; usamos la copia de dev/.
  var DEV_LIST = '../dev/tv.m3u8';

  // ---------- Estado ----------

  var state = {
    screen: 'list',
    column: 'channels',     // 'groups' | 'channels'
    groups: [],
    groupIndex: 0,
    channels: [],           // todos los canales de la lista
    byNumber: {},
    visible: [],            // canales del grupo seleccionado
    channelIndex: 0,
    playing: null,          // canal en reproducción
    sourceIndex: 0,
    favorites: {},
    digits: '',
    digitTimer: null,
    osdTimer: null
  };

  var $ = function (id) { return document.getElementById(id); };

  // ---------- Persistencia ----------

  var store = {
    get: function (k, def) {
      try {
        var v = localStorage.getItem('pipetv.' + k);
        return v === null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set: function (k, v) {
      try { localStorage.setItem('pipetv.' + k, JSON.stringify(v)); } catch (e) { /* lleno */ }
    },
    remove: function (k) {
      try { localStorage.removeItem('pipetv.' + k); } catch (e) { /* nada */ }
    }
  };

  var remote = Remote.create(store);

  // ---------- Lista virtual ----------
  //
  // Solo existen en el DOM las filas visibles; al moverse se reutilizan
  // cambiando su contenido. Así una lista de 20.000 canales va igual de fluida
  // que una de 20 en una tele modesta.

  function VirtualList(el, rowHeight, build, fill) {
    this.el = el;
    this.rowHeight = rowHeight;
    this.build = build;
    this.fill = fill;
    this.top = 0;
    this.nodes = [];
  }

  VirtualList.prototype.update = function (items, focus) {
    var rows = Math.max(1, Math.floor(this.el.clientHeight / this.rowHeight));
    var margin = Math.min(2, Math.floor((rows - 1) / 2));
    if (focus < this.top + margin) this.top = focus - margin;
    if (focus > this.top + rows - 1 - margin) this.top = focus - rows + 1 + margin;
    this.top = Math.max(0, Math.min(this.top, items.length - rows));

    while (this.nodes.length < rows) {
      var node = this.build();
      node.style.top = (this.nodes.length * this.rowHeight) + 'px';
      this.el.appendChild(node);
      this.nodes.push(node);
    }
    for (var i = 0; i < this.nodes.length; i++) {
      var idx = this.top + i;
      var n = this.nodes[i];
      if (i < rows && idx < items.length) {
        n.style.display = '';
        this.fill(n, items[idx], idx, idx === focus);
      } else {
        n.style.display = 'none';
      }
    }
  };

  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  var groupList, channelList;

  function buildGroupRow() {
    return el('li', 'item');
  }

  function fillGroupRow(node, name, idx, isFocus) {
    if (node.textContent !== name) node.textContent = name;
    node.classList.toggle('selected', idx === state.groupIndex);
    node.classList.toggle('focused', isFocus && state.column === 'groups');
  }

  function buildChannelRow() {
    var li = el('li', 'item channel');
    li.appendChild(el('span', 'num'));
    var logo = el('span', 'logo');
    var img = el('img');
    img.onerror = function () { this.style.visibility = 'hidden'; };
    img.onload = function () { this.style.visibility = ''; };
    logo.appendChild(img);
    li.appendChild(logo);
    li.appendChild(el('span', 'name'));
    li.appendChild(el('span', 'fav'));
    li.appendChild(el('span', 'alt'));
    return li;
  }

  function fillChannelRow(node, ch, idx, isFocus) {
    var c = node.children;
    c[0].textContent = ch.number;
    var img = c[1].firstChild;
    var logo = ch.logo || '';
    if (img.getAttribute('data-src') !== logo) {
      img.setAttribute('data-src', logo);
      img.style.visibility = 'hidden';
      if (logo) img.src = logo; else img.removeAttribute('src');
    }
    c[2].textContent = ch.name;
    c[3].textContent = isFavorite(ch) ? '★' : '';
    c[4].textContent = ch.sources.length > 1 ? ch.sources.length + ' fuentes' : '';
    node.classList.toggle('focused', isFocus && state.column === 'channels');
    node.classList.toggle('playing', !!state.playing && state.playing.key === ch.key);
  }

  // ---------- Carga de las listas ----------

  function getLists() {
    var lists = store.get('lists', null);
    if (!lists) {
      lists = Lists.defaults();
      // Migración: la versión anterior guardaba una sola URL
      var old = store.get('listUrl', null);
      if (old && old !== DEFAULT_LIST) lists.push(Lists.makeList(old));
      store.remove('listUrl');
      store.set('lists', lists);
    }
    return lists;
  }

  function saveLists(lists) { store.set('lists', lists); }

  function fetchDirect(url) {
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    });
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function fetchText(url) {
    url = Urls.normalizeListUrl(url);
    if (IS_DEV && url === DEFAULT_LIST) url = DEV_LIST;
    if (!IN_TIZENBREW) return fetchDirect(url);
    // En TizenBrew la página es una web normal y algunas listas no permiten CORS:
    // pasan por el servicio local. Al abrir, el servicio puede tardar un poco en arrancar.
    var viaProxy = function () { return fetchDirect(LOCAL_PROXY + encodeURIComponent(url)); };
    return viaProxy()
      .catch(function () { return delay(1500).then(viaProxy); })
      .catch(function () { return fetchDirect(url); });
  }

  // Descarga una lista; si falla, tira de la copia guardada (si la hay).
  function fetchList(list) {
    var cacheKey = 'cache:' + list.url;
    return fetchText(list.url).then(function (text) {
      if (text.length <= CACHE_MAX_CHARS) store.set(cacheKey, text);
      return { list: list, parsed: M3U.parse(text) };
    }).catch(function (err) {
      var cached = store.get(cacheKey, null);
      if (cached) return { list: list, parsed: M3U.parse(cached), stale: true };
      return { list: list, parsed: null, error: err.message };
    });
  }

  function loadList() {
    var lists = getLists().filter(function (l) { return l.enabled; });
    if (!lists.length) {
      applyChannels({ channels: [], groups: [] });
      setStatus('No hay listas activas. Pulsa AMARILLO para añadir una.');
      return Promise.resolve();
    }
    setStatus('Cargando ' + lists.length + (lists.length === 1 ? ' lista…' : ' listas…'));
    return Promise.all(lists.map(fetchList)).then(function (results) {
      state.listResults = results;
      var merged = Lists.merge(results);
      applyChannels(merged);
      var failed = results.filter(function (r) { return !r.parsed; }).length;
      var status = merged.channels.length + ' canales · ' + (results.length - failed) + ' listas';
      if (failed) status += ' · ' + failed + ' sin cargar';
      setStatus(status);
    });
  }

  function applyChannels(merged) {
    state.channels = merged.channels;
    state.byNumber = {};
    merged.channels.forEach(function (c) { state.byNumber[c.number] = c; });
    state.groups = merged.channels.length ? [FAV_GROUP, ALL_GROUP].concat(merged.groups) : [];
    state.favorites = toSet(store.get('favorites', []));
    if (!state.groups.length) {
      state.visible = [];
      renderAll();
      return;
    }
    var last = store.get('lastGroup', ALL_GROUP);
    var gi = state.groups.indexOf(last);
    if (gi === -1 || (last === FAV_GROUP && !countFavorites())) gi = 1;
    selectGroup(gi, store.get('lastChannel', null));
  }

  function toSet(arr) {
    var o = {};
    for (var i = 0; i < arr.length; i++) o[arr[i]] = true;
    return o;
  }

  // ---------- Grupos y canales ----------

  function channelsForGroup(name) {
    if (name === ALL_GROUP) return state.channels;
    if (name === FAV_GROUP) return state.channels.filter(isFavorite);
    return state.channels.filter(function (c) { return c.groups.indexOf(name) !== -1; });
  }

  function selectGroup(index, focusKey) {
    state.groupIndex = index;
    state.visible = channelsForGroup(state.groups[index]);
    var idx = 0;
    if (focusKey) {
      for (var i = 0; i < state.visible.length; i++) {
        if (state.visible[i].key === focusKey) { idx = i; break; }
      }
    }
    state.channelIndex = idx;
    store.set('lastGroup', state.groups[index]);
    renderAll();
  }

  function isFavorite(ch) { return !!state.favorites[ch.key]; }

  function countFavorites() {
    var n = 0;
    for (var k in state.favorites) if (state.favorites.hasOwnProperty(k)) n++;
    return n;
  }

  function toggleFavorite(ch) {
    if (!ch) return;
    var adding = !isFavorite(ch);
    if (adding) state.favorites[ch.key] = true;
    else delete state.favorites[ch.key];
    store.set('favorites', Object.keys(state.favorites));
    toast(adding ? '★ ' + ch.name + ' en favoritos' : ch.name + ' fuera de favoritos');
    $('preview').removeAttribute('data-key');
    if (state.groups[state.groupIndex] === FAV_GROUP) selectGroup(state.groupIndex, ch.key);
    else renderChannels();
  }

  // ---------- Render ----------

  function renderAll() {
    renderGroups();
    renderChannels();
  }

  function renderGroups() {
    groupList.update(state.groups, state.groupIndex);
    document.body.classList.toggle('col-groups', state.column === 'groups');
    document.body.classList.toggle('col-channels', state.column === 'channels');
  }

  function renderChannels() {
    var empty = $('channels-empty');
    if (!state.visible.length) {
      empty.textContent = state.groups[state.groupIndex] === FAV_GROUP
        ? 'Aún no tienes favoritos. Pulsa ROJO sobre un canal para guardarlo aquí.'
        : (state.channels.length ? 'Este grupo está vacío.' : '');
      empty.style.display = '';
    } else {
      empty.style.display = 'none';
    }
    channelList.update(state.visible, state.channelIndex);
    renderPreview(state.visible[state.channelIndex]);
  }

  function renderPreview(ch) {
    var panel = $('preview');
    if (!ch) { panel.style.visibility = 'hidden'; panel.removeAttribute('data-key'); return; }
    panel.style.visibility = 'visible';
    if (panel.getAttribute('data-key') === ch.key) return;
    panel.setAttribute('data-key', ch.key);

    var logo = $('preview-logo');
    logo.style.visibility = 'hidden';
    if (ch.logo) logo.src = ch.logo; else logo.removeAttribute('src');
    $('preview-num').textContent = ch.number;
    $('preview-name').textContent = ch.name;

    var meta = [ch.group];
    if (ch.sources.length > 1) meta.push(ch.sources.length + ' fuentes');
    if (isFavorite(ch)) meta.push('★ favorito');
    if (state.playing && state.playing.key === ch.key) meta.push('viendo ahora');
    $('preview-meta').textContent = meta.join('  ·  ');

    // Reinicia la animación de entrada
    panel.classList.remove('swap');
    void panel.offsetWidth;
    panel.classList.add('swap');
  }

  function setStatus(text) { $('status').textContent = text; }

  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.classList.remove('show'); }, 3000);
  }

  function showScreen(name) {
    var prev = state.screen;
    state.screen = name;
    document.body.setAttribute('data-screen', name);
    if (name === 'settings') {
      state.settingsIndex = 0;
      state.listsDirty = false;
      renderLists();
      remote.start(onRemoteUrl);
    } else {
      $('list-url').blur();
      if (prev === 'settings') {
        remote.stop();
        if (state.listsDirty) loadList();
      }
    }
    if (name === 'list') renderAll(); // las medidas de la lista cambian al hacerse visible
  }

  // ---------- Ajustes: listas ----------

  function resultFor(list) {
    var rs = state.listResults || [];
    for (var i = 0; i < rs.length; i++) if (rs[i].list.url === list.url) return rs[i];
    return null;
  }

  function renderLists() {
    var lists = getLists();
    var html = lists.map(function (l, i) {
      var r = resultFor(l);
      var info = !l.enabled ? 'Desactivada'
        : !r ? 'Se cargará al salir'
        : !r.parsed ? 'No se pudo cargar (' + r.error + ')'
        : r.parsed.channels.length + ' canales' + (r.stale ? ' · copia guardada' : '');
      return '<li class="list-row' + (l.enabled ? '' : ' off') + (i === state.settingsIndex ? ' focused' : '') + '">' +
        '<span class="check">' + (l.enabled ? '✓' : '') + '</span>' +
        '<span class="list-name">' + escapeHtml(l.name) + '</span>' +
        '<span class="list-info">' + escapeHtml(info) + '</span></li>';
    }).join('');
    html += '<li class="list-row add' + (state.settingsIndex === lists.length ? ' focused' : '') + '">' +
      '<span class="check">+</span><span class="list-name">Añadir una lista</span>' +
      '<span class="list-info">escribiendo la URL con el mando</span></li>';
    $('lists').innerHTML = html;
    $('settings').classList.toggle('adding', state.settingsIndex === lists.length);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function addList(url) {
    url = Urls.normalizeListUrl(url);
    if (!/^(https?|ftp):\/\//i.test(url)) { toast('Eso no parece una URL'); return false; }
    var lists = getLists();
    for (var i = 0; i < lists.length; i++) {
      if (lists[i].url === url) {
        lists[i].enabled = true;
        saveLists(lists);
        toast(lists[i].name + ' ya estaba; la he activado');
        state.listsDirty = true;
        return true;
      }
    }
    var list = Lists.makeList(url);
    lists.push(list);
    saveLists(lists);
    state.listsDirty = true;
    toast('Lista añadida: ' + list.name);
    return true;
  }

  function onRemoteUrl(url) {
    if (!addList(url)) return;
    if (state.screen === 'settings') {
      state.settingsIndex = getLists().length - 1;
      renderLists();
    } else {
      loadList();
    }
  }

  function setupSettings() {
    Remote.renderQr($('qr'), remote.pageUrl);
    $('qr-url').textContent = remote.pageUrl.replace('https://', '');
    // El teclado de la tele solo aparece al pulsar OK sobre el campo.
    $('list-url').addEventListener('focus', function () { $('settings').classList.add('typing'); });
    $('list-url').addEventListener('blur', function () { $('settings').classList.remove('typing'); });
  }

  // ---------- Reproducción ----------

  function playChannel(ch, sourceIndex) {
    if (!ch) return;
    state.playing = ch;
    state.sourceIndex = sourceIndex || 0;
    document.body.classList.add('playing');
    $('preview').removeAttribute('data-key');
    store.set('lastChannel', ch.key);
    showScreen('watch');
    showOsd(ch, 'Conectando…', true);

    Player.play(ch.sources[state.sourceIndex], {
      onPlaying: function () { showOsd(ch, null); },
      onBuffering: function (p) { showOsd(ch, 'Cargando' + (p ? ' ' + p + '%' : '…'), true); },
      onError: function (msg) {
        if (state.playing !== ch) return;
        if (state.sourceIndex + 1 < ch.sources.length) {
          toast('Fuente ' + (state.sourceIndex + 1) + ' caída, probando la siguiente');
          playChannel(ch, state.sourceIndex + 1);
        } else {
          showOsd(ch, 'No se puede reproducir (' + msg + ')', true);
        }
      }
    });
  }

  function indexInVisible(ch) {
    for (var i = 0; i < state.visible.length; i++) {
      if (state.visible[i].key === ch.key) return i;
    }
    return -1;
  }

  function zap(delta) {
    if (!state.visible.length) return;
    var idx = state.playing ? indexInVisible(state.playing) : -1;
    if (idx === -1) idx = state.channelIndex;
    idx = (idx + delta + state.visible.length) % state.visible.length;
    state.channelIndex = idx;
    playChannel(state.visible[idx]);
  }

  function showOsd(ch, message, sticky) {
    var osd = $('osd');
    $('osd-num').textContent = ch.number;
    $('osd-name').textContent = ch.name;
    $('osd-group').textContent = ch.group +
      (ch.sources.length > 1 ? ' · fuente ' + (state.sourceIndex + 1) + ' de ' + ch.sources.length : '');
    $('osd-msg').textContent = message || '';
    var logo = $('osd-logo');
    if (ch.logo) {
      if (logo.getAttribute('src') !== ch.logo) { logo.style.display = 'none'; logo.src = ch.logo; }
    } else {
      logo.removeAttribute('src');
      logo.style.display = 'none';
    }
    osd.classList.add('show');
    clearTimeout(state.osdTimer);
    if (!sticky) {
      state.osdTimer = setTimeout(function () { osd.classList.remove('show'); }, message ? 6000 : 4000);
    }
  }

  // Marcar el número de canal con el mando
  function typeDigit(d) {
    state.digits = (state.digits + d).slice(-5);
    $('digits').textContent = state.digits;
    $('digits').classList.add('show');
    clearTimeout(state.digitTimer);
    state.digitTimer = setTimeout(function () {
      var n = parseInt(state.digits, 10);
      state.digits = '';
      $('digits').classList.remove('show');
      var ch = state.byNumber[n];
      if (!ch) { toast('No hay canal ' + n); return; }
      // Al marcar un número pasamos a "Todos" para que el zapping siga en orden.
      state.groupIndex = state.groups.indexOf(ALL_GROUP);
      state.visible = state.channels;
      state.channelIndex = ch.number - 1;
      store.set('lastGroup', ALL_GROUP);
      playChannel(ch);
    }, 1200);
  }

  // ---------- Teclado / mando ----------

  function openYouTube() {
    if (!IS_TV) { toast('YouTube (TizenTube) solo se abre en la tele'); return; }
    try {
      tizen.application.launch(TIZENBREW_ID, function () { Player.stop(); }, function () {
        toast('TizenBrew no está instalado en esta tele');
      });
    } catch (e) {
      toast('No se pudo abrir TizenBrew');
    }
  }

  function exitApp() {
    Player.stop();
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* navegador */ }
  }

  function moveChannel(delta) {
    var n = state.visible.length;
    if (!n) return;
    state.channelIndex = Math.max(0, Math.min(n - 1, state.channelIndex + delta));
    renderChannels();
  }

  function onKeyList(code) {
    if (state.column === 'groups') {
      if (code === KEY.UP && state.groupIndex > 0) selectGroup(state.groupIndex - 1);
      else if (code === KEY.DOWN && state.groupIndex < state.groups.length - 1) selectGroup(state.groupIndex + 1);
      else if (code === KEY.PAGE_UP || code === KEY.CH_UP) selectGroup(Math.max(0, state.groupIndex - 8));
      else if (code === KEY.PAGE_DOWN || code === KEY.CH_DOWN) {
        selectGroup(Math.min(state.groups.length - 1, state.groupIndex + 8));
      } else if ((code === KEY.RIGHT || code === KEY.ENTER) && state.visible.length) {
        state.column = 'channels';
        renderAll();
      }
      return;
    }

    if (code === KEY.UP) moveChannel(-1);
    else if (code === KEY.DOWN) moveChannel(1);
    else if (code === KEY.PAGE_UP || code === KEY.CH_UP) moveChannel(-8);
    else if (code === KEY.PAGE_DOWN || code === KEY.CH_DOWN) moveChannel(8);
    else if (code === KEY.LEFT) {
      state.column = 'groups';
      renderAll();
    } else if (code === KEY.ENTER) playChannel(state.visible[state.channelIndex]);
    else if (code === KEY.RED) toggleFavorite(state.visible[state.channelIndex]);
  }

  function openGuide() {
    var idx = state.playing ? indexInVisible(state.playing) : -1;
    if (idx !== -1) state.channelIndex = idx;
    state.column = 'channels';
    showScreen('list');
  }

  function onKeyWatch(code) {
    if (code === KEY.UP || code === KEY.CH_UP) zap(-1);
    else if (code === KEY.DOWN || code === KEY.CH_DOWN) zap(1);
    else if (code === KEY.ENTER || code === KEY.LEFT) openGuide();
    else if (code === KEY.INFO || code === KEY.RIGHT) { if (state.playing) showOsd(state.playing, null); }
    else if (code === KEY.RED) toggleFavorite(state.playing);
    else if (code === KEY.GREEN && state.playing && state.playing.sources.length > 1) {
      playChannel(state.playing, (state.sourceIndex + 1) % state.playing.sources.length);
    }
  }

  function onKeySettings(e) {
    var code = e.keyCode;
    var input = $('list-url');
    var lists = getLists();

    if (document.activeElement === input) {
      if (code === KEY.ENTER || code === KEY.IME_DONE) {
        if (input.value.trim() && addList(input.value)) input.value = '';
        input.blur();
        renderLists();
        return true;
      }
      if (code === KEY.BACK || code === KEY.ESC || code === KEY.IME_CANCEL) { input.blur(); return true; }
      return false; // dejar que el campo reciba la tecla
    }

    var i = state.settingsIndex;
    if (code === KEY.UP && i > 0) state.settingsIndex--;
    else if (code === KEY.DOWN && i < lists.length) state.settingsIndex++;
    else if (code === KEY.ENTER) {
      if (i === lists.length) { input.focus(); return true; }
      lists[i].enabled = !lists[i].enabled;
      saveLists(lists);
      state.listsDirty = true;
    } else if (code === KEY.RED && i < lists.length) {
      toast(lists[i].name + ' quitada');
      lists.splice(i, 1);
      saveLists(lists);
      state.listsDirty = true;
      state.settingsIndex = Math.min(i, lists.length);
    } else if (code === KEY.BLUE) {
      saveLists(Lists.defaults());
      state.listsDirty = true;
      state.settingsIndex = 0;
      toast('Listas por defecto restauradas');
    } else if (code === KEY.BACK || code === KEY.ESC || code === KEY.YELLOW) {
      showScreen(state.playing ? 'watch' : 'list');
      return true;
    } else {
      return true;
    }
    renderLists();
    return true;
  }

  // En el Mac no hay teclas de colores: R, G, Y y B hacen de ellas.
  var DEV_COLOR_KEYS = { 82: KEY.RED, 71: KEY.GREEN, 89: KEY.YELLOW, 66: KEY.BLUE, 73: KEY.INFO };

  function onKeyDown(e) {
    var code = e.keyCode;
    if (!IS_TV && DEV_COLOR_KEYS[code] && document.activeElement !== $('list-url')) {
      code = DEV_COLOR_KEYS[code];
      e = { keyCode: code, preventDefault: function () {} };
    }

    if (state.screen === 'settings') {
      if (onKeySettings(e)) e.preventDefault();
      return;
    }

    if (code >= 48 && code <= 57) { typeDigit(String(code - 48)); e.preventDefault(); return; }

    if (code === KEY.BACK || code === KEY.ESC || code === KEY.BACKSPACE) {
      e.preventDefault();
      if (state.screen === 'watch') openGuide();
      else if (state.playing) {
        showScreen('watch');
        showOsd(state.playing, null);
      } else exitApp();
      return;
    }

    if (code === KEY.YELLOW) { showScreen('settings'); e.preventDefault(); return; }
    if (code === KEY.BLUE) { openYouTube(); e.preventDefault(); return; }

    if (state.screen === 'watch') onKeyWatch(code);
    else onKeyList(code);
    e.preventDefault();
  }

  // ---------- Arranque ----------

  function registerTvKeys() {
    if (!IS_TV || !tizen.tvinputdevice) return;
    TV_KEYS.forEach(function (k) {
      try { tizen.tvinputdevice.registerKey(k); } catch (e) { /* tecla no soportada */ }
    });
  }

  function tickClock() {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    $('clock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  document.addEventListener('visibilitychange', function () {
    // Al salir al menú de la tele soltamos el reproductor y lo retomamos al volver.
    if (document.hidden) Player.stop();
    else if (state.screen === 'watch' && state.playing) playChannel(state.playing, state.sourceIndex);
  });

  window.addEventListener('load', function () {
    groupList = new VirtualList($('groups'), 56, buildGroupRow, fillGroupRow);
    channelList = new VirtualList($('channels'), 92, buildChannelRow, fillChannelRow);
    $('preview-logo').onload = function () { this.style.visibility = 'visible'; };
    $('osd-logo').onload = function () { this.style.display = ''; };

    registerTvKeys();
    setupSettings();
    document.addEventListener('keydown', onKeyDown);
    showScreen('list');
    tickClock();
    setInterval(tickClock, 15000);
    // Por si se mandó una lista con la app cerrada
    remote.checkOnce(onRemoteUrl);
    loadList();
  });
})();
