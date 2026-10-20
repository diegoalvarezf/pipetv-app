/*
 * Servicio de PipeTV dentro de TizenBrew.
 *
 * Corre en Node.js en la propia tele (TizenBrew lo arranca al abrir el
 * módulo). Hace de proxy local para descargar listas M3U que no permiten
 * CORS (p. ej. TDTChannels): la app pide http://127.0.0.1:8090/fetch?url=…
 * y el servicio la descarga sin pasar por ningún servidor externo.
 *
 * Solo módulos de serie de Node (http/https/url/zlib): TizenBrew lleva sus
 * dependencias empaquetadas y un módulo no puede hacer require de ellas.
 * ES5 puro: en algunas teles TizenBrew usa Node v4.
 */
var http = require('http');
var https = require('https');
var urlLib = require('url');
var zlib = require('zlib');

var PORT = 8090;
var MAX_REDIRECTS = 5;
var TIMEOUT_MS = 20000;

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function download(target, redirects, done) {
  var opts = urlLib.parse(target);
  var lib = opts.protocol === 'https:' ? https : http;
  opts.headers = { 'User-Agent': 'PipeTV', 'Accept-Encoding': 'gzip, deflate' };

  var req = lib.get(opts, function (r) {
    var status = r.statusCode;
    if (status >= 300 && status < 400 && r.headers.location) {
      r.resume();
      if (redirects >= MAX_REDIRECTS) return done(new Error('demasiadas redirecciones'));
      return download(urlLib.resolve(target, r.headers.location), redirects + 1, done);
    }
    var stream = r;
    var enc = (r.headers['content-encoding'] || '').toLowerCase();
    if (enc === 'gzip') stream = r.pipe(zlib.createGunzip());
    else if (enc === 'deflate') stream = r.pipe(zlib.createInflate());

    var chunks = [];
    stream.on('data', function (c) { chunks.push(c); });
    stream.on('end', function () { done(null, status, Buffer.concat(chunks).toString('utf8')); });
    stream.on('error', done);
  });
  req.on('error', done);
  req.setTimeout(TIMEOUT_MS, function () { req.abort(); done(new Error('tiempo de espera agotado')); });
}

var server = http.createServer(function (req, res) {
  var m = /^\/fetch\?url=([^&]+)/.exec(req.url);
  if (!m) return send(res, 404, 'no encontrado');

  var target;
  try { target = decodeURIComponent(m[1]); } catch (e) { return send(res, 400, 'url mal formada'); }
  if (!/^https?:\/\//i.test(target)) return send(res, 400, 'solo http(s)');

  var answered = false;
  download(target, 0, function (err, status, text) {
    if (answered) return;
    answered = true;
    if (err) return send(res, 502, String(err.message || err));
    send(res, status, text);
  });
});

// Si el puerto ya está cogido es que el servicio sigue vivo de antes.
server.on('error', function () {});
server.listen(PORT, '127.0.0.1');
