// MissAV 封面图片代理 + Avdb 视频代理 Worker
//
// 部署：Cloudflare Dashboard → Workers 和 Pages → 找到已有的 missav-emby → 编辑代码 → 粘贴本文件 → 保存并部署
//
// 端点：
//   /img?url=<图片地址>            封面图片代理（仅放行 *.mrstcdn.store，走边缘缓存）
//   /video?embed=<embed页地址>     avdb 专用：Worker 内同 IP 完成「抓 embed 页→提 m3u8→改写分片」
//                                  解决 helvid.com m3u8 的 IP 绑定问题（换 IP 取直接 404）
//   /vseg?u=<分片地址>&ck=<cookie>  视频分片代理（供 /video 改写后的 m3u8 调用）
//
// v3 更新：新增 /video、/vseg，avdb 播放走本 Worker 全程代理，Emby 只跟 Worker 打交道。

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/604.1.14 (KHTML, like Gecko)';
const EMBED_REFERER = 'https://upload18.org/';

// 仅放行 avdb 的 embed 页，防止被当成开放代理滥用
const EMBED_ALLOW = /^https:\/\/upload18\.org\//i;
// 仅放行 helvid.com 的视频资源
const SEG_ALLOW = /^https:\/\/helvid\.com\//i;

function mergeCookies(setCookieArr) {
  const out = [];
  for (const c of setCookieArr || []) out.push(String(c).split(';')[0]);
  return out.join('; ');
}

function getSetCookies(headers) {
  try {
    if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  } catch (_) { /* ignore */ }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

async function fetchText(url, headers) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  const body = await r.text();
  return { status: r.status, ok: r.ok, body, cookies: mergeCookies(getSetCookies(r.headers)) };
}

// master 清单则选最高 BANDWIDTH 的分档
function pickBestVariant(m3u8, base) {
  const lines = m3u8.split('\n');
  let best = null, bestBw = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/#EXT-X-STREAM-INF:[^\n]*BANDWIDTH=(\d+)/);
    if (m) {
      const bw = parseInt(m[1], 10);
      const uri = (lines[i + 1] || '').trim();
      if (uri && !uri.startsWith('#') && bw > bestBw) {
        bestBw = bw;
        best = new URL(uri, base).toString();
      }
    }
  }
  return best;
}

// 把分片 / KEY 地址改写为本 Worker 的 /vseg（带上 cookie，保证同 IP+同 cookie 取分片）
function rewritePlaylist(m3u8, base, workerOrigin, cookie) {
  const ck = encodeURIComponent(cookie || '');
  const wrap = (abs) => `${workerOrigin}/vseg?u=${encodeURIComponent(abs)}&ck=${ck}`;
  const lines = m3u8.split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#EXT-X-KEY')) {
      out.push(line.replace(/URI="([^"]+)"/, (mm, uri) => {
        try {
          const abs = new URL(uri, base).toString();
          return SEG_ALLOW.test(abs) ? `URI="${wrap(abs)}"` : mm;
        } catch (_) { return mm; }
      }));
    } else if (t && !t.startsWith('#')) {
      try {
        const abs = new URL(t, base).toString();
        out.push(SEG_ALLOW.test(abs) ? wrap(abs) : line);
      } catch (_) { out.push(line); }
    } else {
      out.push(line); // 注释行（含 #U18-CANARY）原样保留，播放器会忽略
    }
  }
  return out.join('\n');
}

async function handleVideo(request, workerOrigin) {
  const url = new URL(request.url);
  const embedUrl = url.searchParams.get('embed') || '';
  if (!EMBED_ALLOW.test(embedUrl)) return new Response('Invalid embed URL', { status: 400 });

  try {
    // 1. 抓 embed 页（Referer 必带，否则可能 403）
    const er = await fetchText(embedUrl, { 'Referer': EMBED_REFERER });
    if (!er.ok || !er.body) return new Response('Embed upstream ' + er.status, { status: 502 });
    // 2. 从内嵌 JSON 提 m3u8
    const m = er.body.match(/"m3u8":"(https:[^"]+)"/);
    if (!m) return new Response('No m3u8 in embed page', { status: 502 });
    const m3u8url = m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
    let cookie = er.cookies;

    // 3. 取 m3u8（带 embed 页下发的 cookie，内含 IP 绑定签名）
    let pr = await fetchText(m3u8url, { 'Referer': EMBED_REFERER, 'Cookie': cookie });
    if (!pr.ok || !pr.body) return new Response('m3u8 upstream ' + pr.status, { status: 502 });
    if (pr.cookies) cookie = cookie ? cookie + '; ' + pr.cookies : pr.cookies;
    let playlist = pr.body;
    let base = m3u8url;

    // 4. master 清单则跟进最高码率分档
    const variant = pickBestVariant(playlist, base);
    if (variant) {
      const vr = await fetchText(variant, { 'Referer': EMBED_REFERER, 'Cookie': cookie });
      if (!vr.ok || !vr.body) return new Response('variant upstream ' + vr.status, { status: 502 });
      if (vr.cookies) cookie = cookie ? cookie + '; ' + vr.cookies : vr.cookies;
      playlist = vr.body;
      base = variant;
    }

    const out = rewritePlaylist(playlist, base, workerOrigin, cookie);
    return new Response(out, {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        // m3u8 签名 2 小时时效，不缓存，每次实时生成
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response('Video proxy failed: ' + e.message, { status: 500 });
  }
}

async function handleVseg(request) {
  const url = new URL(request.url);
  const u = url.searchParams.get('u') || '';
  const ck = url.searchParams.get('ck') || '';
  if (!SEG_ALLOW.test(u)) return new Response('Invalid URL', { status: 400 });
  try {
    const r = await fetch(u, {
      headers: { 'User-Agent': UA, 'Referer': EMBED_REFERER, 'Cookie': ck },
    });
    if (!r.ok) return new Response('Upstream ' + r.status, { status: 502 });
    // 分片内容不可变，可缓存
    return new Response(r.body, {
      headers: {
        'Content-Type': r.headers.get('Content-Type') || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response('Segment proxy failed: ' + e.message, { status: 500 });
  }
}

async function handleImg(request, ctx) {
  const url = new URL(request.url);
  const imgUrl = url.searchParams.get('url') || '';
  // 仅放行 missav 的图片 CDN，防止被滥用
  if (!/^https:\/\/[a-z0-9-]+\.mrstcdn\.store\//i.test(imgUrl)) {
    return new Response('Invalid URL', { status: 400 });
  }

  const cache = caches.default;
  let hit = await cache.match(request);
  if (hit) {
    hit = new Response(hit.body, hit);
    hit.headers.set('X-Proxy-Cache', 'HIT');
    return hit;
  }

  try {
    const resp = await fetch(imgUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://missav.fans/',
      },
    });
    if (!resp.ok) return new Response('Upstream ' + resp.status, { status: 502 });
    const ct = resp.headers.get('Content-Type') || 'image/jpeg';
    const out = new Response(resp.body, {
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'X-Proxy-Cache': 'MISS',
      },
    });
    ctx.waitUntil(cache.put(request, out.clone()));
    return out;
  } catch (e) {
    return new Response('Proxy failed: ' + e.message, { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/img') return handleImg(request, ctx);
    if (url.pathname === '/video') return handleVideo(request, url.origin);
    if (url.pathname === '/vseg') return handleVseg(request);
    return new Response('Usage: /img?url= | /video?embed= | /vseg?u=', { status: 400 });
  },
};
