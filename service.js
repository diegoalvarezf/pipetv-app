/*
 * Servicio de CanutilloTV dentro de TizenBrew.
 *
 * Corre en Node.js en la propia tele (TizenBrew lo arranca al abrir el
 * módulo). Hace de proxy local para descargar listas M3U que no permiten
 * CORS (p. ej. TDTChannels): la app pide http://127.0.0.1:8090/fetch?url=…
 * y el servicio la descarga sin pasar por ningún servidor externo.
 *
 * ES5 puro: en algunas teles TizenBrew usa Node v4.
 */
var http = require('http');
var fetch = require('node-fetch');

var PORT = 8090;

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

var server = http.createServer(function (req, res) {
  var m = /^\/fetch\?url=([^&]+)/.exec(req.url);
  if (!m) return send(res, 404, 'no encontrado');

  var target;
  try { target = decodeURIComponent(m[1]); } catch (e) { return send(res, 400, 'url mal formada'); }
  if (!/^https?:\/\//i.test(target)) return send(res, 400, 'solo http(s)');

  fetch(target, { timeout: 20000, headers: { 'User-Agent': 'CanutilloTV' } })
    .then(function (r) {
      return r.text().then(function (text) { send(res, r.status, text); });
    })
    .catch(function (e) {
      send(res, 502, String(e && e.message ? e.message : e));
    });
});

// Si el puerto ya está cogido es que el servicio sigue vivo de antes.
server.on('error', function () {});
server.listen(PORT, '127.0.0.1');
