import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import { buildTiboStatus } from './tibo-status.js'
import { createResetAnalyzer } from './tibo-ai.js'
import { buildTiboMail } from './tibo-mail.js'
import { createRecentPostDiagnostics } from './tibo-diagnostics.js'

const env = (key, fallback = '') => globalThis?.process?.env?.[key] || fallback
const FEED_URL = env('TIBO_FEED_URL', 'https://fxtwitter.com/thsottiaux/feed.xml')
const DATA_DIR = env('DATA_DIR', './data')
const SUBSCRIBERS_FILE = path.resolve(DATA_DIR, 'tibo-subscribers.json')
const MONITOR_STATE_FILE = path.resolve(DATA_DIR, 'tibo-monitor-state.json')
const MONITOR_INTERVAL_MS = Math.max(60000, Number(env('TIBO_MONITOR_INTERVAL_MS', '300000')) || 300000)
const SMTP_HOST = env('TIBO_SMTP_HOST', 'smtp.qq.com')
const SMTP_PORT = Number(env('TIBO_SMTP_PORT', '587'))
const SMTP_USER = env('TIBO_SMTP_USER')
const SMTP_AUTH_CODE = env('TIBO_SMTP_AUTH_CODE')
const SMTP_FROM = env('TIBO_SMTP_FROM', SMTP_USER)
const REQUEST_TIMEOUT_MS = 15000
const MAX_BODY_BYTES = 4096
let writeQueue = Promise.resolve()
const analyzeReset = createResetAnalyzer({ cacheFile: path.resolve(DATA_DIR, 'tibo-ai-decisions.json') })
const diagnoseRecent = createRecentPostDiagnostics({ logFile: path.resolve(DATA_DIR, 'tibo-ai-recent20.log') })

async function fetchStatus() {
    const response = await fetch(FEED_URL, {
        headers: { 'User-Agent': 'Tibo-Reset/1.0' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`RSS upstream ${response.status}`)
    const xml = await response.text()
    return analyzeReset(buildTiboStatus(xml))
}

async function readSubscribers() {
    try {
        const data = JSON.parse(await fs.readFile(SUBSCRIBERS_FILE, 'utf8'))
        return Array.isArray(data) ? data : []
    } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
    }
}

async function saveSubscribers(list) {
    await fs.mkdir(path.dirname(SUBSCRIBERS_FILE), { recursive: true })
    const tmp = `${SUBSCRIBERS_FILE}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(list, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, SUBSCRIBERS_FILE)
}


async function readMonitorState() {
    try {
        const data = JSON.parse(await fs.readFile(MONITOR_STATE_FILE, 'utf8'))
        return data && typeof data === 'object' ? data : {}
    } catch (error) {
        if (error?.code === 'ENOENT') return {}
        throw error
    }
}

async function saveMonitorState(state) {
    await fs.mkdir(path.dirname(MONITOR_STATE_FILE), { recursive: true })
    const tmp = `${MONITOR_STATE_FILE}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, MONITOR_STATE_FILE)
}

function notificationKey(status) {
    if (!status?.day) return ''
    if (status.result === 'RESET') return `day-${status.day}-${status.phase === 'LIVE' ? 'LIVE' : 'RESET'}`
    if (status.result === 'UPDATE') return `day-${status.day}-UPDATE`
    return ''
}


function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase()
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return ''
    return email
}

async function bodyJson(c) {
    const raw = await c.req.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw Object.assign(new Error('请求内容过大'), { status: 413 })
    try { return JSON.parse(raw || '{}') } catch { throw Object.assign(new Error('请求格式错误'), { status: 400 }) }
}

function smtpRead(socket) {
    return new Promise((resolve, reject) => {
        let data = ''
        const timer = setTimeout(() => done(new Error('SMTP timeout')), 15000)
        const done = (err, value) => {
            clearTimeout(timer); socket.off('data', onData); socket.off('error', onError)
            err ? reject(err) : resolve(value)
        }
        const onError = err => done(err)
        const onData = chunk => {
            data += chunk.toString('utf8')
            const lines = data.split(/\r?\n/).filter(Boolean)
            const last = lines.at(-1) || ''
            if (/^\d{3} /.test(last)) done(null, data)
        }
        socket.on('data', onData); socket.once('error', onError)
    })
}

async function smtpCommand(socket, command, expected) {
    if (command !== null) socket.write(command + '\r\n')
    const reply = await smtpRead(socket)
    const code = Number(reply.slice(0, 3))
    if (!expected.includes(code)) throw new Error(`SMTP ${code || 'invalid reply'}`)
    return reply
}

async function sendMail(to, status, options = {}) {
    if (!SMTP_USER || !SMTP_AUTH_CODE || !SMTP_FROM) throw new Error('SMTP is not configured')
    const { subject, body } = buildTiboMail(status, options)
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`
    const message = [
        `From: Tibo Monitor <${SMTP_FROM}>`, `To: <${to}>`, `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
        Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'), '.', ''
    ].join('\r\n')

    const plain = net.connect({ host: SMTP_HOST, port: SMTP_PORT })
    plain.setTimeout(15000, () => plain.destroy(new Error('SMTP timeout')))
    await smtpCommand(plain, null, [220])
    await smtpCommand(plain, 'EHLO localhost', [250])
    await smtpCommand(plain, 'STARTTLS', [220])
    const socket = tls.connect({ socket: plain, servername: SMTP_HOST, rejectUnauthorized: true })
    await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject) })
    await smtpCommand(socket, 'EHLO localhost', [250])
    await smtpCommand(socket, 'AUTH LOGIN', [334])
    await smtpCommand(socket, Buffer.from(SMTP_USER).toString('base64'), [334])
    await smtpCommand(socket, Buffer.from(SMTP_AUTH_CODE).toString('base64'), [235])
    await smtpCommand(socket, `MAIL FROM:<${SMTP_FROM}>`, [250])
    await smtpCommand(socket, `RCPT TO:<${to}>`, [250, 251])
    await smtpCommand(socket, 'DATA', [354])
    socket.write(message)
    await smtpCommand(socket, null, [250])
    socket.write('QUIT\r\n')
    socket.end()
}

function cors(c) {
    // Standalone UI and API share one origin; no external CORS allowlist.
    c.header('Cache-Control', 'no-store')
}

export async function status(c) {
    cors(c)
    try { return c.json(await fetchStatus()) }
    catch { return c.json({ error: '暂时无法获取 Tibo 状态' }, 502) }
}

// Opt-in diagnostic route. It never starts the monitor or sends email.
export async function diagnostics(c) {
    cors(c)
    if (!/^(true|1|yes)$/i.test(env('TIBO_DIAGNOSTICS_ENABLED'))) return c.json({ error: 'Not Found' }, 404)
    try {
        const result = await fetchStatus()
        const diagnostic = await diagnoseRecent(result)
        return c.json({ current: result.current, semantic: result.semantic || null, diagnostics: diagnostic }, diagnostic.status === 'fallback' ? 502 : 200)
    } catch { return c.json({ error: '暂时无法获取 AI 诊断' }, 502) }
}

export async function subscribe(c) {
    cors(c)
    try {
        const { email: raw } = await bodyJson(c)
        const email = normalizeEmail(raw)
        if (!email) return c.json({ error: '请输入有效的邮箱地址' }, 400)
        return await (writeQueue = writeQueue.then(async () => {
            const list = await readSubscribers()
            if (list.some(item => item.email === email && item.active !== false)) {
                return c.json({ ok: true, alreadySubscribed: true, message: '这个邮箱已经订阅过了，无需重复操作。' })
            }
            const old = list.find(item => item.email === email)
            if (old) { old.active = true; old.subscribedAt = new Date().toISOString() }
            else list.push({ email, active: true, subscribedAt: new Date().toISOString() })
            await saveSubscribers(list)

            let confirmationSent = false
            try {
                const { current } = await fetchStatus()
                await sendMail(email, current, { confirmation: true })
                confirmationSent = true
            } catch (error) {
                console.error('[TIBO CONFIRM MAIL]', error?.message || error)
            }

            return c.json({
                ok: true,
                alreadySubscribed: false,
                confirmationSent,
                message: confirmationSent
                    ? '订阅成功，确认邮件已发送，请检查邮箱。'
                    : '订阅成功，但确认邮件发送失败。之后仍会正常接收状态提醒。'
            })
        }))
    } catch (error) { return c.json({ error: error?.message || '订阅失败' }, error?.status || 500) }
}

export async function testNotify(c) {
    cors(c)
    try {
        const { email: raw } = await bodyJson(c)
        const email = normalizeEmail(raw)
        if (!email) return c.json({ error: '请输入有效的邮箱地址' }, 400)
        const list = await readSubscribers()
        if (!list.some(item => item.email === email && item.active !== false)) return c.json({ error: '请先订阅这个邮箱' }, 400)
        const { current } = await fetchStatus()
        await sendMail(email, current, { test: true })
        return c.json({ ok: true, message: '测试邮件已发送，请检查邮箱。' })
    } catch (error) {
        console.error('[TIBO TEST MAIL]', error?.message || error)
        return c.json({ error: '测试邮件发送失败，请稍后再试' }, 502)
    }
}

let monitorTimer = null
let monitorRunning = false

export async function runMonitorOnce() {
    if (monitorRunning) return { ok: true, skipped: true, reason: 'busy' }
    monitorRunning = true
    try {
        const { current } = await fetchStatus()
        const key = notificationKey(current)
        if (!key) return { ok: true, skipped: true, reason: 'no-notifiable-status' }

        const state = await readMonitorState()
        const notified = state.notified && typeof state.notified === 'object' ? state.notified : {}

        // First production run establishes a baseline, so deploying the monitor
        // cannot suddenly mail historical events to every existing subscriber.
        if (!state.initialized) {
            notified[key] = new Date().toISOString()
            await saveMonitorState({ initialized: true, notified, lastSeen: current })
            return { ok: true, baseline: true, key }
        }

        if (notified[key]) {
            await saveMonitorState({ ...state, initialized: true, notified, lastSeen: current })
            return { ok: true, duplicate: true, key }
        }

        const subscribers = (await readSubscribers()).filter(item => item.email && item.active !== false)
        let sent = 0
        const failed = []
        for (const item of subscribers) {
            try {
                await sendMail(item.email, current)
                sent++
            } catch (error) {
                failed.push({ email: item.email, error: error?.message || String(error) })
                console.error('[TIBO MONITOR MAIL]', item.email, error?.message || error)
            }
        }

        // Mark the event complete only when every active subscriber was delivered.
        // If some failed, the next poll retries; successful recipients are not tracked
        // individually, so keep the subscriber set small until a persistent delivery
        // queue is introduced.
        if (failed.length === 0) notified[key] = new Date().toISOString()
        await saveMonitorState({
            initialized: true,
            notified,
            lastSeen: current,
            lastAttempt: { key, at: new Date().toISOString(), sent, failed: failed.length },
        })
        return { ok: failed.length === 0, key, sent, failed: failed.length }
    } finally {
        monitorRunning = false
    }
}

export function startMonitor() {
    if (monitorTimer) return monitorTimer
    const tick = () => runMonitorOnce().catch(error => console.error('[TIBO MONITOR]', error?.message || error))
    monitorTimer = setInterval(tick, MONITOR_INTERVAL_MS)
    monitorTimer.unref?.()
    setTimeout(tick, 5000).unref?.()
    return monitorTimer
}

