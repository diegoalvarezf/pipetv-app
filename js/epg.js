/*
 * Guía de programación (EPG).
 *
 * Lee el JSON compacto que genera tools/build-epg.js en el repo público y
 * responde "qué echan ahora y a continuación" en cada canal. Los canales de la
 * TDT se encuentran por tvg-id; los de otras listas, por nombre normalizado.
 */
(function (root) {
  'use strict';

  // Igual que normalize() en tools/build-epg.js
  function normalize(name) {
    var s = String(name);
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.toLowerCase()
      .replace(/\.tv$/, '')
      .replace(/[^a-z0-9]+/g, '')
      .replace(/(hd|fhd|uhd|4k)$/, '');
  }

  var data = null;

  function set(json) { data = json && json.programs ? json : null; }

  function idFor(ch) {
    if (!data) return null;
    if (ch.tvgId && data.programs[ch.tvgId]) return ch.tvgId;
    return data.names[normalize(ch.name)] || null;
  }

  // -> { current: {start, stop, title, desc, progress}, next: {...} } o null
  function now(ch, at) {
    var id = idFor(ch);
    if (!id) return null;
    var t = (at || Date.now()) / 1000;
    var list = data.programs[id];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p[0] <= t && t < p[1]) {
        return { current: toProgram(p, t), next: list[i + 1] ? toProgram(list[i + 1], t) : null };
      }
      if (p[0] > t) return { current: null, next: toProgram(p, t) };
    }
    return null;
  }

  function toProgram(p, t) {
    return {
      start: p[0], stop: p[1], title: p[2], desc: p[3] || '',
      progress: Math.max(0, Math.min(1, (t - p[0]) / (p[1] - p[0])))
    };
  }

  function hhmm(sec) {
    var d = new Date(sec * 1000);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  var Epg = { set: set, now: now, hhmm: hhmm, normalize: normalize, loaded: function () { return !!data; } };

  if (typeof module !== 'undefined' && module.exports) module.exports = Epg;
  else root.Epg = Epg;
})(this);
