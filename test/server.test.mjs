import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../server.js'
import fs from 'node:fs/promises'

test('runtime sources do not retain original production domains', async () => {
  for (const name of ['tibo-monitor', 'tibo-mail', 'tibo-ai', 'tibo-status', 'tibo-diagnostics']) {
    const source = await fs.readFile(new URL(`../src/service/${name}.js`, import.meta.url), 'utf8')
    assert.ok(!source.includes('lekaiwu.cn'), name)
  }
})

test('standalone page and isolated routes work without SMTP or upstream access', async () => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const page = await fetch(base)
    assert.equal(page.status, 200)
    const text = await page.text()
    assert.ok(text.includes("const API='/api/tibo-monitor'"))
    assert.ok(!text.includes('api.lekaiwu.cn'))
    assert.equal((await fetch(base + '/tibo-monitor.css')).status, 200)
    assert.equal((await fetch(base + '/images/tibo-reset-mascot.webp')).status, 200)
    assert.equal((await fetch(base + '/healthz')).status, 200)
    assert.equal((await fetch(base + '/api/tibo-monitor/ai-diagnostics')).status, 404)
    assert.equal((await fetch(base + '/.env')).status, 404)
    assert.equal((await fetch(base + '/data/tibo-subscribers.json')).status, 404)
    const invalid = await fetch(base + '/api/tibo-monitor/subscribe', { method: 'POST', body: JSON.stringify({ email: 'invalid' }) })
    assert.equal(invalid.status, 400)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
