#!/usr/bin/env node
/*
 * Genera las listas "limpias" de PipeTV a partir de iptv-org y Free-TV.
 *
 * Se ejecuta a diario en el repo público (GitHub Actions) y al publicar.
 * La tele solo descarga el resultado, ya filtrado:
 *   - idiomas: español e inglés
 *   - fuera: cerrados, adultos, religiosos, teletienda, los que no emiten 24/7,
 *     los bloqueados por país (salvo los de España, que aquí sí se ven)
 *     y los directos de YouTube (no se pueden reproducir)
 *   - cada canal una sola vez, con sus otras calidades como fuentes alternativas
 *   - fuentes que no responden: se prueban todas y se quitan las caídas. Las de
 *     España no se prueban, porque GitHub está fuera y las vería bloqueadas.
 *     (PROBE=0 para saltarse la prueba)
 *
 *   node tools/build-lists.js [carpeta_salida]   (por defecto: lists/)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.resolve(process.argv[2] || 'lists');
const API = 'https://iptv-org.github.io/api/';
const FREETV = 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8';

const LANGS = new Set(['spa', 'eng']);
// Si un canal no declara idioma, se deduce por su país
const SPA_COUNTRIES = new Set(['ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'UY', 'PY', 'BO', 'CR', 'PA',
  'DO', 'GT', 'HN', 'SV', 'NI', 'CU', 'PR', 'GQ', 'AD']);
const ENG_COUNTRIES = new Set(['US', 'UK', 'GB', 'IE', 'CA', 'AU', 'NZ']);
const HOME_COUNTRY = 'ES'; // los bloqueados por país de aquí se ven
const BANNED_CATEGORIES = new Set(['religious', 'shop', 'xxx']);
const MAX_SOURCES = 3;
const PROBE = process.env.PROBE !== '0';
const PROBE_TIMEOUT_MS = 8000;
const PROBE_CONCURRENCY = 40;

// ¿Responde la fuente? Basta con que devuelva algo con pinta de vídeo o de HLS.
async function isAlive(url, userAgent, referrer) {
  const headers = { 'User-Agent': userAgent || 'Mozilla/5.0 (SMART-TV; Tizen 5.5) PipeTV' };
  if (referrer) headers.Referer = referrer;
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return false;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const reader = res.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    const head = Buffer.from(value || []).toString('latin1', 0, 64);
    return head.startsWith('#EXTM3U') || /mpegurl|video|octet-stream|mp2t|dash/.test(type);
  } catch (e) {
    return false;
  }
}

// Ejecuta fn sobre todos los elementos con un número máximo en paralelo
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

// Listas temáticas: nombre del fichero -> categorías de iptv-org (o país)
const OUTPUTS = [
  { file: 'musica.m3u', title: 'Música', categories: ['music'] },
  { file: 'noticias.m3u', title: 'Noticias', categories: ['news'] },
  { file: 'infantil.m3u', title: 'Infantil', categories: ['kids', 'animation'] },
  { file: 'deportes.m3u', title: 'Deportes', categories: ['sports'] },
  { file: 'peliculas.m3u', title: 'Películas', categories: ['movies'] },
  { file: 'espana.m3u', title: 'España', country: 'ES' }
];

// Grupos de Free-TV en español o inglés
const FREETV_GROUPS = new Set(['Spain', 'Andorra', 'Mexico', 'Argentina', 'Chile', 'Venezuela', 'Peru', 'Costa Rica',
  'Paraguay', 'Dominican Republic', 'UK', 'USA', 'Ireland', 'Canada', 'Australia', 'Trinidad',
  'News (ES)', 'Music (EN)', 'Documentaries (EN)', 'VOD Movies (EN)', 'Business', 'Weather']);

async function getJson(name) {
  const res = await fetch(API + name + '.json');
  if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
  return res.json();
}

function qualityRank(q) {
  const n = parseInt(q, 10);
  return Number.isFinite(n) ? n : 0;
}

function speaks(channel, feed) {
  const langs = feed && feed.languages && feed.languages.length ? feed.languages : null;
  if (langs) return langs.some((l) => LANGS.has(l));
  return SPA_COUNTRIES.has(channel.country) || ENG_COUNTRIES.has(channel.country);
}

function isSpanish(channel, feed) {
  if (feed && feed.languages && feed.languages.length) return feed.languages.includes('spa');
  return SPA_COUNTRIES.has(channel.country);
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "'");
}

function entry(ch, stream, group) {
  const attrs = [`tvg-id="${escapeAttr(ch.id)}"`];
  if (ch.logo) attrs.push(`tvg-logo="${escapeAttr(ch.logo)}"`);
  attrs.push(`group-title="${escapeAttr(group)}"`);
  const lines = [`#EXTINF:-1 ${attrs.join(' ')},${ch.name}`];
  if (stream.user_agent) lines.push(`#EXTVLCOPT:http-user-agent=${stream.user_agent}`);
  if (stream.referrer) lines.push(`#EXTVLCOPT:http-referrer=${stream.referrer}`);
  lines.push(stream.url);
  return lines.join('\n');
}

async function buildIptvOrg() {
  const [channels, feeds, streams, logos] = await Promise.all(
    ['channels', 'feeds', 'streams', 'logos'].map(getJson)
  );

  const channelById = new Map(channels.map((c) => [c.id, c]));
  const feedByKey = new Map(feeds.map((f) => [f.channel + '@' + f.id, f]));
  const mainFeed = new Map(feeds.filter((f) => f.is_main).map((f) => [f.channel, f]));
  const logoByChannel = new Map();
  for (const l of logos) if (!logoByChannel.has(l.channel)) logoByChannel.set(l.channel, l.url);

  // Canal -> sus streams válidos
  const byChannel = new Map();
  for (const s of streams) {
    const ch = channelById.get(s.channel);
    if (!ch || ch.closed || ch.is_nsfw) continue;
    if ((ch.categories || []).some((c) => BANNED_CATEGORIES.has(c))) continue;
    const labels = s.labels || [];
    if (labels.includes('Not 24/7')) continue;
    if (labels.includes('Geo-blocked') && ch.country !== HOME_COUNTRY) continue;
    if (/youtube\.com|youtu\.be/.test(s.url)) continue;
    const feed = (s.feed && feedByKey.get(s.channel + '@' + s.feed)) || mainFeed.get(s.channel);
    if (!speaks(ch, feed)) continue;

    let item = byChannel.get(ch.id);
    if (!item) {
      item = {
        id: ch.id,
        name: ch.name,
        country: ch.country,
        categories: ch.categories || [],
        logo: logoByChannel.get(ch.id) || null,
        spanish: isSpanish(ch, feed),
        streams: []
      };
      byChannel.set(ch.id, item);
    }
    if (!item.streams.some((x) => x.url === s.url)) item.streams.push(s);
  }

  let items = [...byChannel.values()];
  for (const it of items) {
    it.streams.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
  }

  if (PROBE) {
    const toProbe = [];
    for (const it of items) if (it.country !== HOME_COUNTRY) for (const s of it.streams) toProbe.push(s);
    const alive = await pool(toProbe, PROBE_CONCURRENCY, (s) => isAlive(s.url, s.user_agent, s.referrer));
    const dead = new Set(toProbe.filter((_, i) => !alive[i]));
    for (const it of items) it.streams = it.streams.filter((s) => !dead.has(s));
    const before = items.length;
    items = items.filter((it) => it.streams.length);
    console.log(`iptv-org: ${dead.size} de ${toProbe.length} fuentes caídas, ${before - items.length} canales fuera`);
  }
  for (const it of items) it.streams = it.streams.slice(0, MAX_SOURCES);
  // Primero los de habla hispana, luego por nombre
  items.sort((a, b) => (b.spanish - a.spanish) || a.name.localeCompare(b.name, 'es'));

  const result = {};
  for (const out of OUTPUTS) {
    const picked = items.filter((it) => out.country
      ? it.country === out.country
      : it.categories.some((c) => out.categories.includes(c)));
    result[out.file] = { title: out.title, items: picked };
  }
  return result;
}

async function buildFreeTv() {
  const res = await fetch(FREETV);
  if (!res.ok) throw new Error(`Free-TV: HTTP ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXTINF')) continue;
    const url = (lines[i + 1] || '').trim();
    const group = (/group-title="([^"]*)"/.exec(line) || [])[1];
    const name = line.slice(line.lastIndexOf(',') + 1);
    if (!url || url.startsWith('#') || !FREETV_GROUPS.has(group)) continue;
    if (name.includes('Ⓨ') || /youtube\.com|youtu\.be/.test(url)) continue;
    if (name.includes('Ⓖ') && group !== 'Spain' && group !== 'News (ES)') continue;
    // Quita las marcas de Free-TV (Ⓢ no HD, Ⓖ bloqueo por país) del nombre
    entries.push({ line: line.replace(/\s*[ⓈⒼⓎ]/gu, ''), url, spanish: group === 'Spain' || group === 'News (ES)' });
  }

  let kept = entries;
  if (PROBE) {
    const alive = await pool(entries, PROBE_CONCURRENCY, (e) => (e.spanish ? true : isAlive(e.url)));
    kept = entries.filter((_, i) => alive[i]);
    console.log(`Free-TV: ${entries.length - kept.length} de ${entries.length} canales caídos`);
  }
  const out = ['#EXTM3U'];
  for (const e of kept) out.push(e.line, e.url);
  return { text: out.join('\n') + '\n', count: kept.length };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const summary = [];

  const iptv = await buildIptvOrg();
  for (const [file, { title, items }] of Object.entries(iptv)) {
    const body = ['#EXTM3U'];
    let streams = 0;
    for (const it of items) {
      for (const s of it.streams) { body.push(entry(it, s, title)); streams++; }
    }
    fs.writeFileSync(path.join(OUT, file), body.join('\n') + '\n');
    summary.push(`${file.padEnd(16)} ${String(items.length).padStart(5)} canales  ${String(streams).padStart(5)} fuentes`);
  }

  const free = await buildFreeTv();
  fs.writeFileSync(path.join(OUT, 'freetv.m3u'), free.text);
  summary.push(`${'freetv.m3u'.padEnd(16)} ${String(free.count).padStart(5)} canales`);

  console.log(summary.join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
