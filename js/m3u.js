/*
 * Parser de listas M3U / M3U8 (formato IPTV extendido).
 *
 * Devuelve canales agrupados: las entradas con el mismo tvg-id (o el mismo
 * nombre si no hay tvg-id) se fusionan en un único canal con varias fuentes,
 * para poder saltar a la siguiente si una falla.
 *
 * Cada fuente es { url, userAgent, referrer }. Las cabeceras se leen de los
 * formatos habituales:
 *   #EXTVLCOPT:http-user-agent=...   / http-referrer=...
 *   #EXTHTTP:{"User-Agent":"...","Referer":"..."}
 *   url|User-Agent=...&Referer=...   (estilo Kodi)
 *
 * Escrito en ES5 sin dependencias: Tizen 5.5 usa un Chromium antiguo.
 */
(function (root) {
  'use strict';

  var ATTR_RE = /([\w-]+)="([^"]*)"/g;

  function parseAttributes(text) {
    var attrs = {};
    var match;
    ATTR_RE.lastIndex = 0;
    while ((match = ATTR_RE.exec(text)) !== null) {
      attrs[match[1].toLowerCase()] = match[2];
    }
    return attrs;
  }

  // "#EXTINF:-1 tvg-id="x" group-title="y",Nombre" -> { attrs, name }
  function parseExtinf(line) {
    var body = line.slice(line.indexOf(':') + 1);
    // La coma que separa atributos del nombre es la primera fuera de comillas.
    var inQuotes = false;
    var split = -1;
    for (var i = 0; i < body.length; i++) {
      var ch = body[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ',' && !inQuotes) { split = i; break; }
    }
    var head = split === -1 ? body : body.slice(0, split);
    var name = split === -1 ? '' : body.slice(split + 1).trim();
    return { attrs: parseAttributes(head), name: name };
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function applyHeader(headers, name, value) {
    var key = name.trim().toLowerCase();
    if (key === 'user-agent' || key === 'http-user-agent') headers.userAgent = value;
    else if (key === 'referer' || key === 'referrer' || key === 'http-referrer' || key === 'http-referer') {
      headers.referrer = value;
    }
  }

  // "http://x/y.m3u8|User-Agent=Foo&Referer=http%3A%2F%2Fz" -> { url, headers }
  function splitKodiUrl(line, headers) {
    var bar = line.indexOf('|');
    if (bar === -1) return line;
    var opts = line.slice(bar + 1).split('&');
    for (var i = 0; i < opts.length; i++) {
      var eq = opts[i].indexOf('=');
      if (eq > 0) applyHeader(headers, opts[i].slice(0, eq), safeDecode(opts[i].slice(eq + 1)));
    }
    return line.slice(0, bar);
  }

  function channelKey(entry) {
    var id = entry.attrs['tvg-id'];
    if (id) return 'id:' + id.toLowerCase();
    return 'name:' + entry.name.toLowerCase();
  }

  function parse(text) {
    var lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
    var channels = [];
    var byKey = {};
    var groups = [];
    var groupSeen = {};
    var pending = null;
    var pendingGroup = null; // #EXTGRP, alternativa a group-title
    var headers = {};        // cabeceras para la siguiente URL
    var epgUrl = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      if (line.indexOf('#EXTM3U') === 0) {
        var header = parseAttributes(line);
        epgUrl = epgUrl || header['url-tvg'] || header['x-tvg-url'] || null;
        continue;
      }
      if (line.indexOf('#EXTINF') === 0) {
        pending = parseExtinf(line);
        continue;
      }
      if (line.indexOf('#EXTGRP:') === 0) {
        pendingGroup = line.slice(8).trim();
        continue;
      }
      if (line.indexOf('#EXTVLCOPT:') === 0) {
        var opt = line.slice(11);
        var eq = opt.indexOf('=');
        if (eq > 0) applyHeader(headers, opt.slice(0, eq), opt.slice(eq + 1).trim());
        continue;
      }
      if (line.indexOf('#EXTHTTP:') === 0) {
        try {
          var json = JSON.parse(line.slice(9));
          for (var h in json) if (json.hasOwnProperty(h)) applyHeader(headers, h, String(json[h]));
        } catch (e) { /* cabecera mal formada: se ignora */ }
        continue;
      }
      if (line[0] === '#') continue;

      // Línea de URL
      var url = splitKodiUrl(line, headers);
      if (!pending) pending = { attrs: {}, name: url };
      var attrs = pending.attrs;
      var name = pending.name || attrs['tvg-name'] || url;
      var entry = { attrs: attrs, name: name };
      var key = channelKey(entry);

      var channel = byKey[key];
      if (!channel) {
        var group = attrs['group-title'] || pendingGroup || 'Sin grupo';
        channel = {
          key: key,
          number: channels.length + 1,
          name: name,
          logo: attrs['tvg-logo'] || null,
          group: group,
          tvgId: attrs['tvg-id'] || null,
          sources: []
        };
        byKey[key] = channel;
        channels.push(channel);
        if (!groupSeen[group]) { groupSeen[group] = true; groups.push(group); }
      }

      var dup = false;
      for (var s = 0; s < channel.sources.length; s++) {
        if (channel.sources[s].url === url) { dup = true; break; }
      }
      if (!dup) {
        channel.sources.push({
          url: url,
          userAgent: headers.userAgent || null,
          referrer: headers.referrer || null
        });
      }

      pending = null;
      pendingGroup = null;
      headers = {};
    }

    return { channels: channels, groups: groups, epgUrl: epgUrl };
  }

  var M3U = { parse: parse };

  if (typeof module !== 'undefined' && module.exports) module.exports = M3U;
  else root.M3U = M3U;
})(this);
