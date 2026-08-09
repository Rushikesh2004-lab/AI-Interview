'use strict';

/**
 * Zero-dependency micro web framework covering just what this project needs:
 * JSON body parsing, simple GET/POST routing with :params, static file
 * serving, and CORS headers. This lets the whole project run with nothing
 * but `node server/index.js` — no `npm install` required — which matters a
 * lot for a hackathon demo where network/registry access can't be assumed.
 *
 * If you prefer Express, swap this file for `require('express')()` — the
 * route handler signatures (req, res) => {} are intentionally compatible
 * with how Express handlers are written in this project.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function createApp() {
  const routes = { GET: [], POST: [] };
  let staticDir = null;

  function matchRoute(method, pathname) {
    for (const r of routes[method] || []) {
      const match = pathname.match(r.regex);
      if (match) {
        const params = {};
        r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(match[i + 1])));
        return { handler: r.handler, params };
      }
    }
    return null;
  }

  function compileRoute(routePath) {
    const paramNames = [];
    const regexStr = routePath
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          paramNames.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { regex: new RegExp(`^${regexStr}/?$`), paramNames };
  }

  const app = {
    get(routePath, handler) {
      const { regex, paramNames } = compileRoute(routePath);
      routes.GET.push({ regex, paramNames, handler });
    },
    post(routePath, handler) {
      const { regex, paramNames } = compileRoute(routePath);
      routes.POST.push({ regex, paramNames, handler });
    },
    useStatic(dir) {
      staticDir = dir;
    },
    listen(port, cb) {
      const server = http.createServer(async (req, res) => {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const pathname = decodeURIComponent(parsedUrl.pathname);

        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }

        res.json = (obj, statusCode = 200) => {
          const body = JSON.stringify(obj);
          res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(body);
        };
        res.status = (code) => {
          res._statusCode = code;
          return {
            json: (obj) => res.json(obj, code)
          };
        };

        try {
          if (req.method === 'POST') {
            let raw = '';
            req.on('data', (chunk) => (raw += chunk));
            await new Promise((resolve) => req.on('end', resolve));
            try {
              req.body = raw ? JSON.parse(raw) : {};
            } catch {
              return res.json({ error: 'Invalid JSON body' }, 400);
            }
          }

          const method = req.method === 'GET' ? 'GET' : req.method === 'POST' ? 'POST' : null;
          const matched = method && matchRoute(method, pathname);

          if (matched) {
            req.params = matched.params;
            req.query = Object.fromEntries(parsedUrl.searchParams.entries());
            return await matched.handler(req, res);
          }

          // Static file fallback (GET only)
          if (req.method === 'GET' && staticDir) {
            let filePath = path.join(staticDir, pathname === '/' ? 'index.html' : pathname);
            if (!filePath.startsWith(staticDir)) {
              res.writeHead(403);
              return res.end('Forbidden');
            }
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
              const ext = path.extname(filePath);
              res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
              return fs.createReadStream(filePath).pipe(res);
            }
          }

          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        } catch (err) {
          console.error('[miniHttp] Unhandled error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        }
      });

      server.listen(port, cb);
      return server;
    }
  };

  return app;
}

module.exports = { createApp };
