// MissAV 封面图片代理 Worker
// 用途：mrstcdn.store 图片 CDN 在部分网络下不可达，经 Cloudflare 边缘中转
// 部署：Cloudflare Dashboard → Workers 和 Pages → 创建 → Worker → 粘贴本文件 → 保存并部署
// 用法：https://<你的worker>.workers.dev/img?url=https://fourhoi.mrstcdn.store/xxx/cover-t.jpg

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/img') {
      return new Response('Usage: /img?url=<image url>', { status: 400 });
    }
    const imgUrl = url.searchParams.get('url') || '';
    // 仅放行 missav 的图片 CDN，防止被滥用
    if (!/^https:\/\/[a-z0-9-]+\.mrstcdn\.store\//i.test(imgUrl)) {
      return new Response('Invalid URL', { status: 400 });
    }
    try {
      const resp = await fetch(imgUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/604.1.14',
          'Referer': 'https://missav.fans/',
        },
      });
      if (!resp.ok) return new Response('Upstream ' + resp.status, { status: 502 });
      const ct = resp.headers.get('Content-Type') || 'image/jpeg';
      return new Response(resp.body, {
        headers: {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (e) {
      return new Response('Proxy failed: ' + e.message, { status: 500 });
    }
  },
};
