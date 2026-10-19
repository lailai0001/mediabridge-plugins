'use strict';
/**
 * Avdb 源插件。
 *
 * 动作：sites / search / detail / play / probe / http
 *
 * 模型：单组（default）单站（avdb），两层式（directLines=false）。
 * ref 形状：`avdb/<base64url(JSON)>`，JSON = { t:'avdb', v:vod_id, f:flag, e:embedUrl }
 */
const fs = require('fs');
const path = require('path');
const { search, detail, API } = require('./lib/avdb');

const PLUGIN_ID = 'avdb';
const SITE_KEY = 'avdb';
const SITE_NAME = 'Avdb';
const FLAG = 'Avdb';

/* ---------------- 视频代理 ---------------- */
// helvid.com 的 m3u8 有 IP 绑定：取 embed 页下发的 cookie 含客户端 IP，前后换 IP 取直接 404。
// 解法：Worker 内同 IP 一次性完成「抓 embed 页→提 m3u8→改写分片」，Emby 只跟 Worker 打交道。
// 用与 missav 封面代理同一个 Worker（用户已部署，只需用新版代码重部署一次）。
const DEFAULT_VIDEO_PROXY = 'https://missav-emby.li768435813.workers.dev';
function videoProxyUrl(embedUrl) {
  return DEFAULT_VIDEO_PROXY + '/video?embed=' + encodeURIComponent(embedUrl);
}

function encodeRef(body) {
  return PLUGIN_ID + '/' + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}
function decodeRef(ref) {
  const s = String(ref || '');
  const want = PLUGIN_ID + '/';
  if (!s.startsWith(want)) return null;
  try {
    const o = JSON.parse(Buffer.from(s.slice(want.length), 'base64url').toString('utf8'));
    return (o && typeof o === 'object' && o.t) ? o : null;
  } catch { return null; }
}

function err(code, message) {
  return { ok: false, error: { code, message: String(message || code) } };
}

const actions = {
  async sites(args, ctx) {
    return {
      sources: [{
        id: 'default', name: SITE_NAME, url: API,
        mode: 'remote', enabled: true, ok: true, ms: 0, siteCount: 1,
      }],
      sites: [{
        key: SITE_KEY, name: SITE_NAME, api: 'avdb',
        searchable: true, source: 'default', directLines: false,
      }],
    };
  },

  async search(args, ctx) {
    const wd = String(args.wd || '').trim();
    const page = Math.max(1, parseInt(args.page, 10) || 1);
    if (!wd) return { ok: true, status: 200, json: { list: [] } };
    try {
      const list = await search(wd, page);
      return { ok: true, status: 200, json: { list }, source: 'default', site: SITE_KEY };
    } catch (e) {
      return err('UPSTREAM_ERROR', e.message);
    }
  },

  async detail(args, ctx) {
    const id = String(args.id || '');
    if (!id) return err('BAD_ARGS', '缺少 id');
    try {
      const d = await detail(id);
      if (!d) return err('NOT_FOUND', '详情取不到');
      const embeds = d.embeds && d.embeds.length ? d.embeds : [{ name: '正片', url: '' }];
      const items = embeds.map((e, i) => ({
        flag: FLAG, name: e.name, id: e.url, index: i, matchedBy: 'item',
        ref: encodeRef({ t: SITE_KEY, v: d.vod_id, f: FLAG, e: e.url, n: e.name }),
      }));
      const target = items[0];
      const line = {
        flag: FLAG, playVia: 'client',
        episodes: embeds.map((e, i) => ({ name: e.name, id: e.url, index: i })),
        items, target,
      };
      const out = {
        vodId: d.vod_id, vod_id: d.vod_id,
        name: d.vod_name, vod_name: d.vod_name,
        pic: d.vod_pic, vod_pic: d.vod_pic,
        vod_actor: d.vod_actor, vod_year: d.vod_year,
        vod_content: d.vod_content, vod_code: d.vod_code,
        lines: [line], lineCount: 1,
        pick: 'items', target,
      };
      return { ok: true, status: 200, json: { list: [out] }, detail: out };
    } catch (e) {
      return err('UPSTREAM_ERROR', e.message);
    }
  },

  async play(args, ctx) {
    const o = decodeRef(args.ref);
    if (!o) return err('BAD_REF', '认不出这个 ref');
    const embedUrl = String(o.e || '');
    if (!/^https?:\/\//i.test(embedUrl)) return err('NO_PLAY_URL', '没有可播地址');
    // 不在 Railway 侧解析 m3u8（换 IP 即 404），直接把 embed 页交给 Worker，
    // Worker 内同 IP 抓 embed→提 m3u8→代理分片，返回的 m3u8 分片全指向 Worker。
    // playVia: 'client'，Emby 直连 Worker 取 m3u8 和分片。
    return {
      ok: true, status: 200,
      urls: [videoProxyUrl(embedUrl)],
      parse: 0,
    };
  },

  async probe(args, ctx) {
    const t0 = Date.now();
    try {
      const list = await search('SSIS', 1);
      return { ok: list.length > 0, ms: Date.now() - t0, count: list.length };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: e.message };
    }
  },

  async http(args, ctx) {
    const dataDir = (ctx && ctx.dataDir) || path.join(__dirname, 'data');
    const sf = path.join(dataDir, 'settings.json');
    const readSettings = () => {
      try { return JSON.parse(fs.readFileSync(sf, 'utf8')); } catch { return {}; }
    };
    if (args.path === '/save' && args.method === 'POST') {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(sf, JSON.stringify(JSON.parse(args.body || '{}'), null, 2));
        return { body: { ok: true } };
      } catch (e) { return { status: 500, body: { ok: false, error: e.message } }; }
    }
    if (args.path === '/settings') return { body: readSettings() };
    return { status: 404, body: { ok: false, error: 'no route' } };
  },
};

/* ---------------- metadata 角色（Emby 搜索域） ---------------- */
// 让 avdb 出现在 Emby 实例的"搜索域"中。entryId 直接使用 avdb 的 vod_id
//（与 source/detail 共用），lookup 复用 lib 的 detail()。
const DOMAIN = 'avdb';
const metadataActions = {
  async register(args, ctx) {
    return {
      domain: DOMAIN,
      series: false,
      name: 'Avdb',
      version: '0.2.6',
      language: 'zh-CN',
      imageBase: '',
      capabilities: {
        search: true,
        lookup: true,
        season: false,
        genres: false,
        cast: false,
        overview: true,
        poster: true,
        premiereDate: false,
      },
      links: [],
    };
  },

  async search(args, ctx) {
    const kw = String(args.keyword || args.wd || args.query || '').trim();
    if (!kw) return { ok: true, rows: [] };
    const page = Math.max(1, parseInt(args.page, 10) || 1);
    try {
      const list = await search(kw, page);
      return {
        ok: true,
        // 面板 meta.js 的 search() 读的是 v.rows，字段名必须叫 rows（不能叫 list）
        rows: list.map((it) => ({
          entryId: it.vod_id,
          type: 'movie',
          title: it.vod_name,
          year: it.vod_year || '',
          overview: it.vod_remarks || '',
          posterPath: it.vod_pic || '',
        })),
      };
    } catch (e) {
      return err('UPSTREAM_ERROR', e.message);
    }
  },

  async lookup(args, ctx) {
    const entryId = String(args.entryId || args.id || '').trim();
    if (!entryId) return { ok: false, error: { code: 'BAD_INPUT', message: '缺少 entryId' } };
    try {
      const d = await detail(entryId);
      if (!d) return { ok: false, error: { code: 'NOT_FOUND', message: '未找到: ' + entryId } };
      return {
        ok: true,
        // 面板 lookup() 回 { ok:true, item: out.item }，必须包一层 item，否则面板读 undefined.title 抛错 → Emby 500
        item: {
          entryId: d.vod_id,
          type: 'movie',
          title: d.vod_name,
          originalTitle: '',
          year: d.vod_year || '',
          premiereDate: '',
          searchTitle: d.vod_name,
          overview: d.vod_content || '',
          posterPath: d.vod_pic || '',
          backdropPath: '',
          genres: d.vod_remarks ? [d.vod_remarks] : [],
          cast: d.vod_actor ? d.vod_actor.split(',').map((n) => ({ name: n.trim() })).filter((c) => c.name) : [],
          studio: '',
        },
      };
    } catch (e) {
      return err('UPSTREAM_ERROR', e.message);
    }
  },

  async season(args, ctx) {
    return { ok: true, item: { episodes: [] } };
  },
};

actions.metadata = metadataActions;

module.exports = { actions };
