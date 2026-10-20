/*
 * Reproductor: usa AVPlay (reproductor nativo de Samsung) en la tele y un
 * <video> normal en el navegador del Mac para desarrollar.
 *
 * API: Player.play(source, callbacks), Player.stop()
 * source: { url, userAgent, referrer } (ver m3u.js)
 * callbacks: { onPlaying, onBuffering(percent), onError(message) }
 */
(function (root) {
  'use strict';

  var avplay = root.webapis && root.webapis.avplay ? root.webapis.avplay : null;
  var video = null;
  var current = null; // token de la reproducción activa

  function screenRect() {
    // AVPlay trabaja en coordenadas de 1920x1080 aunque la app use otra resolución.
    return [0, 0, 1920, 1080];
  }

  function playAvplay(source, cb, token) {
    try {
      avplay.open(source.url);
      // Algunos servidores rechazan reproductores que no se identifican como VLC/Kodi.
      // AVPlay no permite fijar el Referer, así que esa cabecera se ignora aquí.
      if (source.userAgent) {
        try { avplay.setStreamingProperty('USER_AGENT', source.userAgent); } catch (e) { /* firmware antiguo */ }
      }
      var r = screenRect();
      avplay.setDisplayRect(r[0], r[1], r[2], r[3]);
      avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
      avplay.setListener({
        onbufferingstart: function () { if (token === current) cb.onBuffering(0); },
        onbufferingprogress: function (p) { if (token === current) cb.onBuffering(p); },
        onbufferingcomplete: function () { if (token === current) cb.onPlaying(); },
        onerror: function (e) { if (token === current) cb.onError(String(e)); },
        onstreamcompleted: function () { if (token === current) cb.onError('Fin de la emisión'); }
      });
      // Los directos HLS tardan en arrancar en teles lentas.
      avplay.setTimeoutForBuffering(15);
      avplay.prepareAsync(function () {
        if (token !== current) return;
        avplay.play();
        cb.onPlaying();
      }, function (e) {
        if (token === current) cb.onError(String(e));
      });
    } catch (e) {
      cb.onError(e && e.message ? e.message : String(e));
    }
  }

  // En el navegador no se pueden cambiar User-Agent ni Referer: solo sirve para desarrollar.
  function playVideo(source, cb, token) {
    if (!video) {
      var obj = document.getElementById('av-player');
      if (obj) obj.style.display = 'none';
      video = document.createElement('video');
      video.id = 'html-player';
      video.autoplay = true;
      document.body.insertBefore(video, document.body.firstChild);
    }
    video.onplaying = function () { if (token === current) cb.onPlaying(); };
    video.onwaiting = function () { if (token === current) cb.onBuffering(0); };
    video.onerror = function () {
      if (token !== current) return;
      var err = video.error;
      cb.onError(err ? 'MediaError ' + err.code : 'Error de vídeo');
    };
    video.src = source.url;
    var p = video.play();
    if (p && p.catch) p.catch(function () { /* autoplay bloqueado: el usuario pulsa play */ });
  }

  function stop() {
    current = null;
    if (avplay) {
      try { avplay.stop(); } catch (e) { /* no estaba reproduciendo */ }
      try { avplay.close(); } catch (e) { /* ya cerrado */ }
    } else if (video) {
      video.removeAttribute('src');
      video.load();
    }
  }

  function play(source, cb) {
    stop();
    var token = {};
    current = token;
    if (avplay) playAvplay(source, cb, token);
    else playVideo(source, cb, token);
  }

  root.Player = { play: play, stop: stop, native: !!avplay };
})(this);
