import http from 'node:http'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { status, diagnostics, subscribe, testNotify, startMonitor } from './src/service/tibo-monitor.js'

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/tools/tibo-monitor/', ['index.html', 'text/html; charset=utf-8']],
  ['/tibo-monitor.css', ['tibo-monitor.css', 'text/css; charset=utf-8']],
  ['/images/tibo-reset-mascot.webp', ['images/tibo-reset-mascot.webp', 'image/webp']],
])
const routes = new Map([
  ['GET /api/tibo-monitor/status', status],
  ['GET /api/tibo-monitor/analyze', status],
  ['GET /api/tibo-monitor/ai-diagnostics', diagnostics],
  ['POST /api/tibo-monitor/subscribe', subscribe],
  ['POST /api/tibo-monitor/test-notify', testNotify],
])

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname
      const route = routes.get(`${req.method} ${pathname}`)
      if (route) {
        const headers = { 'Content-Type': 'application/json; charset=utf-8' }
        const context = {
          req: {
            header: key => req.headers[key.toLowerCase()],
            text: async () => {
              const chunks = []; let size = 0
              for await (const chunk of req) {
                size += chunk.length
                if (size > 4096) { const error = new Error('请求内容过长'); error.status = 413; throw error }
                chunks.push(chunk)
              }
              return Buffer.concat(chunks).toString('utf8')
            },
          },
          header: (key, value) => { headers[key] = value },
          json: (data, code = 200) => ({ data, code }),
        }
        const result = await route(context)
        res.writeHead(result.code, headers); res.end(JSON.stringify(result.data)); return
      }
      if (req.method === 'GET' && pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return
      }
      const asset = assets.get(pathname)
      if ((req.method === 'GET' || req.method === 'HEAD') && asset) {
        const data = await fs.readFile(new URL(`./public/${asset[0]}`, import.meta.url))
        res.writeHead(200, { 'Content-Type': asset[1], 'X-Content-Type-Options': 'nosniff' })
        res.end(req.method === 'HEAD' ? undefined : data); return
      }
      res.writeHead(404); res.end('Not Found')
    } catch (error) {
      if (!res.headersSent) res.writeHead(error.status || 500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: error.status === 413 ? '请求内容过长' : '服务暂不可用' }))
    }
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3000)
  const host = process.env.HOST || '127.0.0.1'
  createServer().listen(port, host, () => {
    console.log(`Tibo-Reset listening on http://${host}:${port}`)
    if (process.env.TIBO_MONITOR_ENABLED !== 'false') startMonitor()
  })
}
