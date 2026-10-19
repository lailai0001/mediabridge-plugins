'use strict';
/**
 * 123AV 源插件。
 *
 * 动作：sites / search / detail / play / probe / http
 *
 * 模型：单组（default）单站（av123），两层式（directLines=false）。
 * ref 形状：`av123/<base64url(JSON)>`，JSON = { t:'av123', v:vod_id, f:flag, e:embedUrl, n:episodeName }
 */
const fs = require('fs');
const path = require('path');
const { search, detail, resolveStream, bestVariantUrl, HOSTS, UA } = require('./lib/av123');

const PLUGIN_ID = 'av123';
const SITE_KEY = 'av123';
const SITE_NAME = '123AV';
const FLAG = '123AV';

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
        id: 'default', name: SITE_NAME, url: HOSTS[0],
        mode: 'remote', enabled: true, ok: true, ms: 0, siteCount: 1,
      }],
      sites: [{
        key: SITE_KEY, name: SITE_NAME, api: 'av123',
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
      const episodes = (d.episodes && d.episodes.length) ? d.episodes : [{ number: 1, name: '正片', url: '' }];
      const items = episodes.map((ep, i) => ({
        flag: FLAG,
        name: ep.name || ('第' + ep.number + '集'),
        id: ep.url || (d.vod_id + '#ep' + i),
        index: i,
        matchedBy: 'item',
        ref: encodeRef({ t: SITE_KEY, v: d.vod_id, f: FLAG, e: ep.url, n: ep.name || '' }),
      }));
      const target = items[0];
      const line = { flag: FLAG, playVia: 'proxy', episodes: items.map((it) => ({ name: it.name, id: it.id, index: it.index })), items, target };
      const out = {
        vodId: d.vod_id, vod_id: d.vod_id,
        name: d.vod_name, vod_name: d.vod_name,
        pic: d.vod_pic, vod_pic: d.vod_pic,
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
    try {
      const m3u8 = await resolveStream(embedUrl);
      if (!m3u8 || !/^https?:\/\//i.test(m3u8)) return err('NO_PLAY_URL', '解析不到播放地址');
      let referer = HOSTS[0] + '/';
      try { referer = new URL(embedUrl).origin + '/'; } catch {}
      // 如果是 master 清单，取最高清晰度 variant 直链，避免客户端无法 seek
      const best = await bestVariantUrl(m3u8, referer);
      return {
        ok: true, status: 200,
        urls: [best || m3u8],
        header: { 'User-Agent': UA, 'Referer': referer },
        parse: 0,
      };
    } catch (e) {
      return err('UPSTREAM_ERROR', e.message);
    }
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
// 让 av123 出现在 Emby 实例的"搜索域"中。
// entryId 直接使用 av123 的 vod_id（与 source/detail 共用）。
const DOMAIN = 'av123';
const metadataActions = {
  async register(args, ctx) {
    return {
      domain: DOMAIN,
      series: false,
      name: '123AV',
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
        // entryId 用 slug（面板 ENTRY_KEY_RE=/^[A-Za-z0-9._-]+$/ 不允许 URL 中的 : 和 /）
        rows: list.map((it) => {
          const m = String(it.vod_id || '').match(/\/v\/([^\/?#]+)/);
          const slug = m ? m[1] : String(it.vod_id || '');
          return {
            entryId: slug,
            type: 'movie',
            title: it.vod_name,
            year: '',
            overview: it.vod_remarks || '',
            posterPath: it.vod_pic || '',
          };
        }),
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
          year: '',
          premiereDate: '',
          searchTitle: d.vod_name,
          overview: '',
          posterPath: d.vod_pic || '',
          backdropPath: '',
          genres: [],
          cast: [],
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
