/*
 * Convierte enlaces "para ver en la web" en enlaces al archivo en sí, para que
 * se pueda pegar la URL tal cual sale en el navegador.
 *
 *   github.com/u/r/blob/rama/lista.m3u     -> raw.githubusercontent.com/u/r/rama/lista.m3u
 *   gist.github.com/u/id                   -> gist.githubusercontent.com/u/id/raw
 *   dropbox.com/...?dl=0                   -> ...?dl=1
 *   drive.google.com/file/d/ID/view        -> drive.google.com/uc?export=download&id=ID
 *   pastebin.com/ID                        -> pastebin.com/raw/ID
 */
(function (root) {
  'use strict';

  var RULES = [
    {
      re: /^https?:\/\/(?:www\.)?github\.com\/([^\/]+)\/([^\/]+)\/(?:blob|raw)\/(.+?)(?:[?#].*)?$/i,
      to: function (m) { return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3]; }
    },
    {
      // Gist con varios archivos: /raw sirve el primero; con #file-... no se puede saber cuál.
      re: /^https?:\/\/gist\.github\.com\/([^\/]+)\/([0-9a-f]+)\/?(?:[?#].*)?$/i,
      to: function (m) { return 'https://gist.githubusercontent.com/' + m[1] + '/' + m[2] + '/raw'; }
    },
    {
      re: /^(https?:\/\/(?:www\.)?dropbox\.com\/.+?)([?&])dl=0(.*)$/i,
      to: function (m) { return m[1] + m[2] + 'dl=1' + m[3]; }
    },
    {
      re: /^https?:\/\/drive\.google\.com\/(?:file\/d\/([\w-]+)|open\?id=([\w-]+)).*$/i,
      to: function (m) { return 'https://drive.google.com/uc?export=download&id=' + (m[1] || m[2]); }
    },
    {
      re: /^https?:\/\/(?:www\.)?pastebin\.com\/(?!raw\/)([A-Za-z0-9]+)\/?$/i,
      to: function (m) { return 'https://pastebin.com/raw/' + m[1]; }
    }
  ];

  function normalizeListUrl(url) {
    var u = String(url).trim();
    for (var i = 0; i < RULES.length; i++) {
      var m = RULES[i].re.exec(u);
      if (m) return RULES[i].to(m);
    }
    return u;
  }

  var Urls = { normalizeListUrl: normalizeListUrl };

  if (typeof module !== 'undefined' && module.exports) module.exports = Urls;
  else root.Urls = Urls;
})(this);
