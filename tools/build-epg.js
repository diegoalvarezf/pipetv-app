#!/usr/bin/env node
/*
 * Genera la guía de programación (EPG) de PipeTV en un JSON pequeño.
 *
 * La guía XMLTV de TDTChannels pesa varios MB y trae días enteros; la tele solo
 * necesita lo que se emite ahora y en las próximas horas. Se ejecuta cada pocas
 * horas en el repo público (GitHub Actions).
 *
 *   node tools/build-epg.js [salida]   (por defecto: epg/tdt.json)
 *
 * Formato de salida:
 *   {
 *     generated: <segundos unix>,
 *     programs: { "<tvg-id>": [[inicio, fin, "título", "descripción"], …] },
 *     names:    { "<nombre normalizado>": "<tvg-id>" }   // para canales de otras listas
 *   }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.resolve(process.argv[2] || 'epg/tdt.json');
const EPG_URL = 'https://www.tdtchannels.com/epg/TV.xml.gz';
const LIST_URL = 'https://www.tdtchannels.com/lists/tv.m3u8';

const PAST_S = 30 * 60;        // lo que acabó hace menos de media hora
const AHEAD_S = 10 * 3600;     // y lo de las próximas 10 horas
const MAX_PER_CHANNEL = 10;
const DESC_MAX = 140;

// Igual que normalize() en app/js/epg.js
function normalize(name) {
  return String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.tv$/, '')
    .replace(/[^a-z0-9]+/g, '')
    .replace(/(hd|fhd|uhd|4k)$/, '');
}

function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&')
    .trim();
}

// "20261020054900 +0000" -> segundos unix
function parseTime(stamp, offset) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return NaN;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  const o = /^([+-])(\d{2})(\d{2})$/.exec(offset || '+0000');
  const shift = o ? (o[1] === '-' ? -1 : 1) * (+o[2] * 3600 + +o[3] * 60) : 0;
  return utc - shift;
}

function shorten(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : max).replace(/[,.;:]?$/, '…');
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const [gz, list] = await Promise.all([download(EPG_URL), download(LIST_URL)]);
  const xml = zlib.gunzipSync(gz).toString('utf8');

  const programs = {};
  const re = /<programme\s+channel="([^"]+)"\s+start="(\d{14})\s*([+-]\d{4})?"\s+stop="(\d{14})\s*([+-]\d{4})?"[^>]*>([\s\S]*?)<\/programme>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const start = parseTime(m[2], m[3]);
    const stop = parseTime(m[4], m[5]);
    if (!(stop > now - PAST_S && start < now + AHEAD_S)) continue;
    const title = decodeXml((/<title[^>]*>([\s\S]*?)<\/title>/.exec(m[6]) || [])[1] || '');
    if (!title) continue;
    const desc = shorten(decodeXml((/<desc[^>]*>([\s\S]*?)<\/desc>/.exec(m[6]) || [])[1] || ''), DESC_MAX);
    (programs[m[1]] = programs[m[1]] || []).push([start, stop, title, desc]);
  }
  for (const id of Object.keys(programs)) {
    programs[id].sort((a, b) => a[0] - b[0]);
    programs[id] = programs[id].slice(0, MAX_PER_CHANNEL);
  }

  // Nombres de la lista de TDTChannels -> tvg-id, para encontrar la guía de
  // canales que vienen de otras listas con otro tvg-id (p. ej. "La 1" de iptv-org).
  const names = {};
  const text = list.toString('utf8');
  const ext = /#EXTINF[^\n]*tvg-id="([^"]+)"[^\n]*,([^\n]+)/g;
  while ((m = ext.exec(text)) !== null) {
    const id = m[1];
    if (!programs[id]) continue;
    for (const n of [m[2], id]) {
      const key = normalize(n);
      if (key && !names[key]) names[key] = id;
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generated: now, programs, names }));
  const count = Object.values(programs).reduce((n, p) => n + p.length, 0);
  console.log(`${path.basename(OUT)}: ${Object.keys(programs).length} canales, ${count} programas, ` +
    `${Object.keys(names).length} nombres, ${Math.round(fs.statSync(OUT).size / 1024)} KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
