#!/usr/bin/env node
/**
 * serve-docs.mjs — 本地预览 docs/，零依赖
 *
 * 用途：改完 site/ 或 docs/ 之后，在推之前先在本机看一眼。
 * 直接读盘，不缓存，改完刷新即生效。
 *
 * 用法：
 *   node scripts/serve-docs.mjs            # http://localhost:4321
 *   node scripts/serve-docs.mjs 8080       # 换端口
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "docs");
const PORT = Number(process.argv[2]) || 4321;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  if (rel.endsWith("/")) rel += "index.html";

  const abs = path.join(ROOT, path.normalize(rel));
  // 防目录穿越
  if (!abs.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    const notFound = path.join(ROOT, "404.html");
    if (fs.existsSync(notFound)) {
      res.writeHead(404, { "content-type": TYPES[".html"] }).end(fs.readFileSync(notFound));
    } else {
      res.writeHead(404).end("404");
    }
    console.log("404 " + rel);
    return;
  }

  res.writeHead(200, {
    "content-type": TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(fs.readFileSync(abs));
});

server.listen(PORT, () => {
  console.log("docs/ → http://localhost:" + PORT + "/");
  console.log("(Ctrl+C 停止)");
});
