'use strict';
/**
 * Avdb 取数逻辑。站点：https://avdbapi.com（标准 JSON API）。
 * search: /api.php/provide/vod?ac=list&wd=KW&pg=N
 * detail: /api.php/provide/vod?ac=detail&ids=ID -> episodes.server_data.*.link_embed
 * play: 抓 embed 页，从 JSON 里提取 "m3u8":"https://..." 直链
 */
const https = require('https');
const http = require('http');

const API = 'https://avdbapi.com/api.php/provide/vod';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/604.1.14 (KHTML, like Gecko)';

function fetchUrl(url, { timeout = 20000, referer = '' } = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json,text/html,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Referer': referer || u.origin + '/',
        },
        timeout,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          fetchUrl(next, { timeout, referer }).then(resolve);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; if (data.length > 4e6) { res.destroy(); } });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    } catch { resolve(null); }
  });
}

function clean(s) {
  return String(s || '').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

function normList(raw) {
  const out = [];
  for (const it of raw || []) {
    out.push({
      vod_id: String(it.id || ''),
      vod_name: clean(it.name || it.origin_name || ''),
      vod_pic: it.poster_url || it.thumb_url || '',
      vod_remarks: it.type_name || '',
      vod_year: it.year || '',
      vod_actor: Array.isArray(it.actor) ? it.actor.join(',') : (it.actor || ''),
    });
  }
  return out;
}

/** 从关键词（可能是一整段标题）里提取番号，如 SNOS-401 */
function extractCode(s) {
  const m = String(s || '').match(/\b([A-Za-z]{2,10}-\d{2,6})\b/);
  return m ? m[1].toUpperCase() : '';
}

/** 检测查询是否为无码意图 */
function wantUncensored(q) {
  const s = String(q || '').toLowerCase();
  return s.includes('uncensored') || s.includes('uncut') || s.includes('leak') || s.includes('无码');
}

/** 检测条目是否为无码（avdb API 的 type_name 字段） */
function isUncensoredItem(it) {
  const s = String(it.vod_remarks || it.type_name || '').toLowerCase();
  return s.includes('uncensored') || s.includes('uncut');
}

async function search(wd, page = 1) {
  wd = String(wd || '').trim();
  if (!wd) return [];
  // 面板按名搜索时传的是完整标题，提番号搜更准（avdb API 按标题搜经常 0 条）
  const code = extractCode(wd);
  const url = `${API}?ac=list&wd=${encodeURIComponent(code || wd)}&pg=${page}`;
  const r = await fetchUrl(url);
  if (!r || r.status !== 200) return [];
  try {
    const d = JSON.parse(r.body);
    if (d.code !== 1) return [];
    let list = normList(d.list);
    // 有码/无码过滤：查询有明确无码信号时，只返回对应版本
    const wantUncen = wantUncensored(wd);
    if (wantUncen) {
      list = list.filter((it) => isUncensoredItem(it));
    }
    // 插件认证：番号对上的就是目标作品，面板直接采信（见 agg/match.js scoreItem）
    if (code) {
      for (const it of list) {
        if (extractCode(it.vod_name || '') === code) {
          if (wantUncen) {
            if (isUncensoredItem(it)) it.vod_exact = true;
          } else {
            it.vod_exact = true;
          }
        }
      }
    }
    return list;
  } catch { return []; }
}

async function listByPage(page = 1) {
  const url = `${API}?ac=list&pg=${page}`;
  const r = await fetchUrl(url);
  if (!r || r.status !== 200) return [];
  try {
    const d = JSON.parse(r.body);
    if (d.code !== 1) return [];
    return normList(d.list);
  } catch { return []; }
}

function extractEmbedLinks(item) {
  const links = [];
  const eps = item.episodes || {};
  const sd = eps.server_data || {};
  for (const name of Object.keys(sd)) {
    const e = sd[name] || {};
    if (e.link_embed) links.push({ name: name || eps.server_name || '正片', url: e.link_embed });
  }
  return links;
}

async function detail(id) {
  const url = `${API}?ac=detail&ids=${encodeURIComponent(id)}`;
  const r = await fetchUrl(url);
  if (!r || r.status !== 200) return null;
  try {
    const d = JSON.parse(r.body);
    const item = (d.list || [])[0];
    if (!item) return null;
    const links = extractEmbedLinks(item);
    return {
      vod_id: String(item.id),
      vod_name: clean(item.name || item.origin_name || ''),
      vod_pic: item.poster_url || item.thumb_url || '',
      vod_remarks: item.type_name || '',
      vod_year: item.year || '',
      vod_actor: Array.isArray(item.actor) ? item.actor.join(',') : (item.actor || ''),
      vod_content: clean(item.description || ''),
      vod_code: item.movie_code || '',
      embeds: links,
    };
  } catch { return null; }
}

/** 从 embed 页提取 m3u8 直链 */
async function resolvePlayUrl(embedUrl) {
  const r = await fetchUrl(embedUrl, { referer: 'https://upload18.org/' });
  if (!r || r.status !== 200 || !r.body) return '';
  const m = r.body.match(/"m3u8":"(https:[^"]+)"/);
  if (!m) return '';
  return m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
}

module.exports = { search, listByPage, detail, resolvePlayUrl, API, UA };
