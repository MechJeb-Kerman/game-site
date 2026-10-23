// SEO / 元数据路由：封面图、og 图、站点图标、PWA 清单、robots.txt、sitemap.xml。
//
// 这些路由的特点是「只读、可缓存、不依赖登录态」，从 server.js 拆出来之后
// server.js 只需要 `app.use(seoRoutes({ originOf }))` 一行。
//
// originOf 由调用方注入，是因为它还要兼顾 SITE_ORIGIN 环境变量与反向代理头，
// 属于整个应用的关注点，不属于 SEO 路由。

import { Router } from 'express';
import { join } from 'node:path';

import { PUBLIC_DIR } from '../db.js';
import * as data from '../data.js';
import { coverSvg, ogSvg } from '../cover.js';
import * as seo from '../seo.js';

export function seoRoutes({ originOf }) {
  const r = Router();

  // ---------- 封面 / 站点图标 ----------
  r.get('/cover/:slug.svg', (req, res) => {
    const game = data.getGame(String(req.params.slug));
    if (!game) return res.status(404).end();
    res.type('image/svg+xml').setHeader('Cache-Control', 'public, max-age=86400');
    res.send(coverSvg(game));
  });

  r.get('/static/img/og.svg', (req, res) => {
    res.type('image/svg+xml').setHeader('Cache-Control', 'public, max-age=86400');
    res.send(ogSvg());
  });

  // 站点图标：独立游戏页（iframe 内）不会带上首页的 data-URI 图标，这里兜底，避免 404
  r.get(['/favicon.ico', '/favicon.svg'], (req, res) => {
    res.type('image/svg+xml').setHeader('Cache-Control', 'public, max-age=604800');
    res.send(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
        '<rect width="100" height="100" rx="22" fill="#6366f1"/>' +
        '<text x="50" y="54" text-anchor="middle" dominant-baseline="central" font-size="62">🎮</text>' +
        '</svg>'
    );
  });

  // ---------- PWA ----------
  // manifest 与 Service Worker 的单一事实来源就是 public/ 下这两个文件，每次都从磁盘读，改完即生效
  r.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json; charset=utf-8').setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(join(PUBLIC_DIR, 'manifest.webmanifest'));
  });

  r.get('/sw.js', (req, res) => {
    // no-cache：SW 脚本必须每次回源校验，否则「改了不生效」；Service-Worker-Allowed 让 SW 能控制整站
    res
      .type('application/javascript; charset=utf-8')
      .setHeader('Cache-Control', 'no-cache')
      .setHeader('Service-Worker-Allowed', '/');
    res.sendFile(join(PUBLIC_DIR, 'sw.js'));
  });

  // 预缓存清单：由 tools/gen-precache.mjs 扫描仓库生成，sw.js 在 install 时拉取
  r.get('/precache.json', (req, res) => {
    res.type('application/json; charset=utf-8').setHeader('Cache-Control', 'public, max-age=600');
    res.sendFile(join(PUBLIC_DIR, 'precache.json'));
  });

  // ---------- 爬虫 ----------
  r.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(seo.robotsTxt(originOf(req)));
  });

  // 站点地图：静态页 + 公告 + 分类 + 游戏，规则与转义都在 src/seo.js（纯函数，可单测）
  r.get('/sitemap.xml', (req, res) => {
    const entries = seo.sitemapEntries({
      posts: data.listPosts({ status: 1, limit: 50 }),
      categories: data.listCategories(),
      games: data.listGames({ sort: 'new', limit: 100 })
    });
    res.type('application/xml').send(seo.sitemapXml(originOf(req), entries));
  });

  return r;
}

export default seoRoutes;
