/*
 * Mandar la URL de la lista desde el móvil o el Mac.
 *
 * Una app de Tizen no puede abrir un servidor, así que usamos ntfy.sh como
 * buzón: la tele genera un tema aleatorio, enseña un QR a https://ntfy.sh/<tema>
 * y consulta ese tema cada pocos segundos. Desde el móvil se escribe la URL en
 * la web de ntfy y la tele la recoge.
 *
 * Ojo: quien conozca el tema puede leer lo enviado, y ntfy lo guarda unas horas.
 */
(function (root) {
  'use strict';

  var BASE = 'https://ntfy.sh/';
  var POLL_MS = 3000;
  var URL_RE = /(?:https?|rtmp|rtsp):\/\/[^\s<>"']+/i;
  var ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // sin caracteres que se confundan

  var timer = null;

  function randomId(n) {
    var bytes = new Uint8Array(n);
    root.crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < n; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
  }

  function create(store) {
    var topic = store.get('remoteTopic', null);
    if (!topic) {
      topic = 'canutillo-' + randomId(12);
      store.set('remoteTopic', topic);
    }

    function since() {
      // Solo interesan mensajes nuevos: la primera vez, desde ahora.
      var s = store.get('remoteSince', null);
      if (!s) {
        s = String(Math.floor(Date.now() / 1000));
        store.set('remoteSince', s);
      }
      return s;
    }

    function poll(onUrl) {
      var url = BASE + topic + '/json?poll=1&since=' + encodeURIComponent(since());
      return fetch(url, { cache: 'no-store' }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      }).then(function (text) {
        var found = null;
        text.split('\n').forEach(function (line) {
          if (!line) return;
          var msg;
          try { msg = JSON.parse(line); } catch (e) { return; }
          if (msg.event !== 'message') return;
          store.set('remoteSince', msg.id); // continuar justo después de este mensaje
          var m = URL_RE.exec(msg.message || '');
          if (m) found = m[0];
        });
        if (found) onUrl(found);
      }).catch(function () { /* sin red: se reintenta en el siguiente ciclo */ });
    }

    return {
      topic: topic,
      pageUrl: BASE + topic,
      start: function (onUrl) {
        this.stop();
        poll(onUrl);
        timer = setInterval(function () { poll(onUrl); }, POLL_MS);
      },
      stop: function () {
        if (timer) clearInterval(timer);
        timer = null;
      },
      checkOnce: poll
    };
  }

  // QR como SVG (oscuro sobre claro: es lo que mejor leen las cámaras).
  function renderQr(el, text) {
    var qr = root.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 10, margin: 0, scalable: true });
  }

  root.Remote = { create: create, renderQr: renderQr };
})(this);
