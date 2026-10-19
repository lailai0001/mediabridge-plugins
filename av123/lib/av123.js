'use strict';
/**
 * 123AV 取数逻辑。
 * 站点：https://123av.com（英文路径 /en）
 * 搜索：/en/search?keyword=xxx&page=N
 * 详情：/en/v/<slug>，播放器 episodes 藏在 x-data="player(JSON.parse('...'))"
 * 播放：episode 的 embed URL（https://<host>/e/<hash>）-> GET https://<host>/stream?id=<hash> 取真实 m3u8
 */
const https = require('https');
const http = require('http');

const HOSTS = ['https://123av.com'];
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
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
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

async function getHtml(pathOrUrl) {
  for (const h of HOSTS) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : h + pathOrUrl;
    const r = await fetchUrl(url, { referer: h + '/' });
    if (r && r.status === 200 && r.body && !r.body.includes('Just a moment') && r.body.length > 5000) {
      return { html: r.body, base: h };
    }
  }
  return { html: '', base: HOSTS[0] };
}

function clean(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;#039;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

/** 解析列表页 div.card 块 */
function parseList(html, base) {
  const result = [];
  const blocks = html.split(/<div class="card"/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].slice(0, 8000);
    // 封面链接 + 标题：a.card__link[href="/en/v/xxx"]text</a>
    const lm = block.match(/<a class="card__link" href="(\/en\/v\/[^"]+)">([\s\S]*?)<\/a>/);
    if (!lm) continue;
    const href = lm[1] || '';
    const title = clean(lm[2]);
    // 封面：img.card__img[src]
    let pic = '';
    const pm = block.match(/<img class="card__img" src="([^"]+)"/);
    if (pm) pic = pm[1];
    // 时长
    let remarks = '';
    const dm = block.match(/<span class="card__dur">([^<]*)<\/span>/);
    if (dm) remarks = clean(dm[1]);
    if (!href || !title) continue;
    const id = href.startsWith('http') ? href : base + href;
    result.push({ vod_id: id, vod_name: title, vod_pic: pic, vod_remarks: remarks });
  }
  return result;
}

/** 从关键词（可能是一整段标题）里提取番号，如 SNOS-401 */
function extractCode(s) {
  const m = String(s || '').match(/\b([A-Za-z]{2,10}-\d{2,6})\b/);
  return m ? m[1].toUpperCase() : '';
}

/** 检测是否为无码版本（从 slug 或标题） */
function isUncensoredItem(it) {
  const s = String((it.vod_id || '') + ' ' + (it.vod_name || '')).toLowerCase();
  return s.includes('uncensored') || s.includes('uncut');
}

/** 检测查询是否为无码意图（从查询词） */
function wantUncensored(q) {
  const s = String(q || '').toLowerCase();
  return s.includes('uncensored') || s.includes('uncut') || s.includes('leak') || s.includes('无码');
}

async function search(wd, page = 1) {
  wd = String(wd || '').trim();
  if (!wd) return [];
  // 面板按名搜索时传的是完整标题（如 "SNOS-401 一位身穿…"），提番号搜更准
  const code = extractCode(wd);
  const kw = encodeURIComponent(code || wd);
  const { html, base } = await getHtml(`/en/search?keyword=${kw}&page=${page}`);
  if (!html) return [];
  let list = parseList(html, base);
  // 有码/无码过滤：查询是无码意图时，只返回无码版本；反之只返回有码版本
  // 避免面板文件列表里同时出现有码和无码两个版本
  const wantUncen = wantUncensored(wd);
  const hasUncenSignal = wantUncen || /uncensored|leak/i.test(wd);
  if (hasUncenSignal || code) {
    // 只有当查询明确带无码信号，或能提取番号时，才做过滤
    // （纯标题搜索不带信号时不过滤，避免误杀）
    if (hasUncenSignal) {
      list = list.filter((it) => isUncensoredItem(it) === wantUncen);
    }
  }
  // 插件认证：番号对上的就是目标作品，面板直接采信（见 agg/match.js scoreItem）
  // 有码/无码状态必须一致才标 exact
  if (code) {
    for (const it of list) {
      const idCode = extractCode(it.vod_id || '');
      const nameCode = extractCode(it.vod_name || '');
      if (idCode === code || nameCode === code) {
        // 如果查询有明确的无码意图，要求结果的无码状态一致
        if (hasUncenSignal) {
          if (isUncensoredItem(it) === wantUncen) it.vod_exact = true;
        } else {
          it.vod_exact = true;
        }
      }
    }
  }
  return list;
}

/** 从 x-data="player(JSON.parse('...'))" 解析 episodes */
function parseEpisodes(html) {
  const eps = [];
  const i = html.indexOf('x-data="player(');
  if (i < 0) return eps;
  const j = html.indexOf('">', i);
  if (j < 0) return eps;
  const raw = html.slice(i + 'x-data="player('.length, j);
  const m = raw.match(/JSON\.parse\('((?:[^']|'(?!\)))*)'\)/s);
  if (!m) return eps;
  try {
    // 转义层级：\\u0022(源码) -> \u0022(HTML文本) -> \u0022 -> "
    let s = m[1].replace(/\\\\u0022/g, '\\u0022').replace(/\\\\\//g, '\\/');
    s = s.replace(/\\u0022/g, '"').replace(/\\\//g, '/');
    const arr = JSON.parse(s);
    for (const ep of arr) {
      if (ep && ep.url) eps.push({ number: ep.number || eps.length + 1, name: String(ep.name || ep.number || ''), url: ep.url });
    }
  } catch { /* ignore */ }
  return eps;
}

/** 详情：标题/简介/episodes（embed URL，播放时再解析 m3u8）
 * @param {string} id 完整 URL（如 https://123av.com/en/v/mida-808）或 slug（如 mida-808）
 */
async function detail(id) {
  // slug -> 完整 URL（metadata entryId 用 slug，面板 ENTRY_KEY_RE 不允许 URL 中的 : 和 /）
  let url = String(id || '').trim();
  if (url && !url.startsWith('http')) {
    // 去掉可能的前缀，只留 slug
    const m = url.match(/\/v\/([^\/?#]+)/);
    const slug = m ? m[1] : url.split('/').pop();
    url = `https://123av.com/en/v/${slug}`;
  }
  const { html, base } = await getHtml(url);
  if (!html) return null;
  let title = '';
  const tm = html.match(/<meta property="og:title" content="([^"]*)"/) || html.match(/<title>([^<]*)<\/title>/);
  if (tm) title = clean(tm[1]).replace(/ — 123AV$/, '');
  let pic = '';
  const pm = html.match(/<meta property="og:image" content="([^"]*logo[^"]*)"/);
  // og:image 是站 logo，改用视频封面：player 背景图
  const cm = html.match(/background-image:url\('([^']+)'\)/);
  if (cm) pic = cm[1];
  else if (pm) pic = pm[1];
  const episodes = parseEpisodes(html);
  return { vod_id: id, vod_name: title || id, vod_pic: pic, episodes, base };
}

/** embed URL -> /stream API -> 真实 m3u8 */
async function resolveStream(embedUrl) {
  try {
    const u = new URL(embedUrl);
    const mm = u.pathname.match(/\/e\/([a-z0-9_]+)/i);
    if (!mm) return '';
    const api = `${u.origin}/stream?id=${mm[1]}`;
    const r = await fetchUrl(api, { referer: 'https://123av.com/', timeout: 15000 });
    if (!r || r.status !== 200) return '';
    const o = JSON.parse(r.body);
    return (o && o.media && o.media.stream) ? o.media.stream : '';
  } catch { return ''; }
}

/** 如果 m3u8 是 master 清单，解析出最高清晰度的 variant 直链。
 * 123av 的 /stream 返回的可能是 master，直接给客户端会导致无法 seek。
 * 取分辨率最大者，取不到则返回原 URL。 */
async function bestVariantUrl(m3u8Url, referer) {
  try {
    const r = await fetchUrl(m3u8Url, { referer: referer || 'https://123av.com/', timeout: 15000 });
    if (!r || r.status !== 200 || !r.body || !r.body.includes('#EXT-X-STREAM-INF')) return m3u8Url;
    const variants = [];
    const lines = r.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/#EXT-X-STREAM-INF:[^\r\n]*RESOLUTION=(\d+)x(\d+)/);
      if (m) {
        const next = (lines[i + 1] || '').trim();
        if (next && !next.startsWith('#')) {
          variants.push({ px: (+m[1]) * (+m[2]), url: new URL(next, m3u8Url).toString() });
        }
      }
      // 无 RESOLUTION 时按 BANDWIDTH 排
      const mb = lines[i].match(/#EXT-X-STREAM-INF:[^\r\n]*BANDWIDTH=(\d+)/);
      if (mb && !lines[i].includes('RESOLUTION=')) {
        const next = (lines[i + 1] || '').trim();
        if (next && !next.startsWith('#')) {
          variants.push({ px: +mb[1], url: new URL(next, m3u8Url).toString() });
        }
      }
    }
    if (!variants.length) return m3u8Url;
    variants.sort((a, b) => b.px - a.px);
    return variants[0].url;
  } catch { return m3u8Url; }
}

module.exports = { search, detail, parseList, parseEpisodes, resolveStream, bestVariantUrl, HOSTS, UA };
