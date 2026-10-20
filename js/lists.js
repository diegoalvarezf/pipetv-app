/*
 * Varias listas M3U en una sola guía.
 *
 * Cada lista tiene un modo de agrupar sus canales:
 *   own      -> usa los grupos de la propia lista (TDT: Generalistas, Deportivos…)
 *   single   -> todos sus canales van a un grupo con el nombre de la lista (Música)
 *   prefixed -> "Lista · grupo" (Free-TV · Spain), para listas con muchos grupos
 *
 * Un mismo canal (mismo tvg-id) en varias listas se fusiona: suma fuentes y
 * aparece en todos sus grupos.
 */
(function (root) {
  'use strict';

  // Listas limpias (español/inglés, sin canales caídos, adultos, religiosos ni
  // teletienda) que genera a diario tools/build-lists.js en el repo público.
  var CURATED = 'https://raw.githubusercontent.com/diegoalvarezf/pipetv-app/main/lists/';

  var DEFAULTS = [
    { name: 'TDT', url: 'https://www.tdtchannels.com/lists/tv.m3u8', groups: 'own' },
    { name: 'Música', url: CURATED + 'musica.m3u', groups: 'single' },
    { name: 'Noticias', url: CURATED + 'noticias.m3u', groups: 'single' },
    { name: 'Infantil', url: CURATED + 'infantil.m3u', groups: 'single' },
    { name: 'Deportes', url: CURATED + 'deportes.m3u', groups: 'single' },
    { name: 'Películas', url: CURATED + 'peliculas.m3u', groups: 'single' },
    { name: 'España', url: CURATED + 'espana.m3u', groups: 'single' },
    { name: 'Free-TV', url: CURATED + 'freetv.m3u', groups: 'prefixed' }
  ];

  // Listas por defecto de versiones anteriores -> su sustituta limpia
  var IPTV_ORG = 'https://iptv-org.github.io/iptv/';
  var REPLACED = {};
  REPLACED[IPTV_ORG + 'categories/music.m3u'] = CURATED + 'musica.m3u';
  REPLACED[IPTV_ORG + 'categories/news.m3u'] = CURATED + 'noticias.m3u';
  REPLACED[IPTV_ORG + 'categories/kids.m3u'] = CURATED + 'infantil.m3u';
  REPLACED[IPTV_ORG + 'categories/sports.m3u'] = CURATED + 'deportes.m3u';
  REPLACED[IPTV_ORG + 'categories/movies.m3u'] = CURATED + 'peliculas.m3u';
  REPLACED[IPTV_ORG + 'countries/es.m3u'] = CURATED + 'espana.m3u';
  REPLACED['https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8'] = CURATED + 'freetv.m3u';

  // Actualiza listas guardadas: cambia las antiguas por defecto y conserva las añadidas a mano.
  function migrate(lists) {
    var changed = false;
    lists.forEach(function (l) {
      if (REPLACED[l.url]) { l.url = REPLACED[l.url]; changed = true; }
    });
    return changed;
  }

  function defaults() {
    return DEFAULTS.map(function (l) {
      return { name: l.name, url: l.url, groups: l.groups, enabled: true };
    });
  }

  // Nombre corto para una lista añadida a mano
  function nameFromUrl(url) {
    var m = /^[a-z]+:\/\/([^\/?#]+)(\/[^?#]*)?/i.exec(url);
    if (!m) return 'Lista';
    var host = m[1].replace(/^www\./, '');
    var parts = (m[2] || '').split('/').filter(Boolean);
    if (/githubusercontent\.com$|github\.io$/.test(host)) {
      return host.indexOf('github.io') !== -1 ? host.split('.')[0] : (parts[0] || host);
    }
    return host;
  }

  function makeList(url) {
    return { name: nameFromUrl(url), url: url, groups: 'prefixed', enabled: true };
  }

  function groupsFor(list, ch, singleGroup) {
    if (list.groups === 'single') return [list.name];
    if (list.groups === 'own') return [ch.group];
    // prefixed: si la lista solo tiene un grupo, basta con el nombre de la lista
    return [singleGroup ? list.name : list.name + ' · ' + ch.group];
  }

  /*
   * results: [{ list, parsed }] en el orden en que se muestran.
   * Devuelve { channels, groups } con canales numerados de 1 en adelante.
   */
  function merge(results) {
    var channels = [];
    var groups = [];
    var groupSeen = {};
    var byKey = {};

    results.forEach(function (r) {
      if (!r.parsed) return;
      var single = r.parsed.groups.length <= 1;
      r.parsed.channels.forEach(function (ch) {
        var names = groupsFor(r.list, ch, single);
        var target = byKey[ch.key];
        if (!target) {
          target = {
            key: ch.key,
            number: channels.length + 1,
            name: ch.name,
            logo: ch.logo,
            tvgId: ch.tvgId,
            group: names[0],
            groups: [],
            sources: []
          };
          byKey[ch.key] = target;
          channels.push(target);
        }
        if (!target.logo && ch.logo) target.logo = ch.logo;
        names.forEach(function (g) {
          if (target.groups.indexOf(g) === -1) target.groups.push(g);
          if (!groupSeen[g]) { groupSeen[g] = true; groups.push(g); }
        });
        ch.sources.forEach(function (s) {
          for (var i = 0; i < target.sources.length; i++) {
            if (target.sources[i].url === s.url) return;
          }
          target.sources.push(s);
        });
      });
    });

    return { channels: channels, groups: groups };
  }

  var Lists = { defaults: defaults, makeList: makeList, nameFromUrl: nameFromUrl, merge: merge, migrate: migrate };

  if (typeof module !== 'undefined' && module.exports) module.exports = Lists;
  else root.Lists = Lists;
})(this);
