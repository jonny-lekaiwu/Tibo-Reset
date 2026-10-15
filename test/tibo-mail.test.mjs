import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTiboMail } from '../src/service/tibo-mail.js'
import { buildTiboStatus } from '../src/service/tibo-status.js'

const announcement = { day: 10, result: 'RESET', phase: 'RESET', text: 'Day 10/ Reset', publishedAt: '2026-10-15T04:55:00Z', url: 'https://x.com/thsottiaux/status/10' }
const completed = { ...announcement, phase: 'LIVE', liveText: 'Done and dusted', liveAt: '2026-10-15T06:28:00Z', liveUrl: 'https://x.com/thsottiaux/status/11' }
test('announcement mail clearly waits for completion and links announcement', () => {
    const mail = buildTiboMail(announcement)
    assert.match(mail.subject, /RESET 公告.*等待完成确认/)
    assert.match(mail.body, /尚未确认/)
    assert.match(mail.body, /12:55:00（北京时间）/)
    assert.ok(mail.body.includes(announcement.url))
    assert.doesNotMatch(mail.subject, /已确认完成/)
})
test('completion mail cites completion evidence and time instead of announcement', () => {
    const mail = buildTiboMail(completed)
    assert.match(mail.subject, /RESET 已确认完成/)
    assert.match(mail.body, /Done and dusted/)
    assert.match(mail.body, /14:28:00（北京时间）/)
    assert.ok(mail.body.includes(completed.liveUrl))
    assert.ok(!mail.body.includes(announcement.url + '\r'))
    assert.match(mail.body, /以账户页面显示为准/)
    assert.throws(() => buildTiboMail({ ...completed, liveText: null }), /evidence/)
})
test('UPDATE and receipt/test mail cannot be mistaken for new completed RESET', () => {
    assert.match(buildTiboMail({ ...announcement, result: 'UPDATE', phase: 'UPDATE' }).subject, /UPDATE/)
    for (const [options, prefix] of [[{ confirmation: true }, '订阅成功'], [{ test: true }, '测试邮件']]) {
        const mail = buildTiboMail(completed, options)
        assert.ok(mail.subject.startsWith(`【${prefix}】`))
        assert.doesNotMatch(mail.subject, /RESET 已确认完成/)
        assert.match(mail.body, /不代表/)
        assert.doesNotMatch(mail.body, /Done and dusted/)
    }
})
test('RSS completion preserves its own URL for the email source', () => {
    const xml = `<rss><item><link>${announcement.url}</link><pubDate>${announcement.publishedAt}</pubDate><description>Day 10/ Reset</description></item><item><link>${completed.liveUrl}</link><pubDate>${completed.liveAt}</pubDate><description>Reset is complete</description></item></rss>`
    const status = buildTiboStatus(xml).current
    assert.equal(status.liveUrl, completed.liveUrl)
    assert.ok(buildTiboMail(status).body.includes(completed.liveUrl))
})
