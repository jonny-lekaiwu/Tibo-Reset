import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTiboStatus } from '../src/service/tibo-status.js'

const item = (id, time, text, quote = '') => `<item><title>${text}</title><link>https://x.com/thsottiaux/status/${id}</link><pubDate>${time}</pubDate><description><![CDATA[<p>${text}</p>${quote ? `<blockquote><a href="https://x.com/thsottiaux/status/${quote}">Landing within the next 2 hours</a></blockquote>` : ''}]]></description></item>`
const announced = item('100','Thu, 15 Oct 2026 04:55:51 GMT','The reports of my reset button being lost are greatly exaggerated<br/><br/>Day 10/ Reset')
const preview = item('101','Thu, 15 Oct 2026 04:56:07 GMT','Landing within the next 2 hours')
const done = item('102','Thu, 15 Oct 2026 06:28:13 GMT','Done and dusted','101')
const xml = (...items) => `<rss><channel>${items.join('')}</channel></rss>`
const parse = (...items) => buildTiboStatus(xml(...items),new Date('2026-10-15T07:00:00Z'))

test('Done and dusted quoting the preview completes Day 10; quote is not its own post',()=>{
    const status=parse(done,preview,announced)
    assert.equal(status.current.phase,'LIVE')
    assert.equal(status.current.liveText,'Done and dusted')
    assert.equal(status.currentPosts.length,3)
    assert.equal(status.currentPosts[1].text,'Landing within the next 2 hours')
    assert.match(status.currentPosts[2].text,/exaggerated\n\nDay 10\/ Reset/)
    assert.equal(status.currentPosts[0].text,'Done and dusted')
})
test('future preview alone never completes reset',()=>{
    assert.equal(parse(preview,announced).current.phase,'RESET')
})
test('unrelated posts remain visible and generic unrelated completion cannot send LIVE',()=>{
    const unrelated=item('103','Thu, 15 Oct 2026 06:00:00 GMT','Done and dusted')
    const other=item('99','Thu, 15 Oct 2026 02:00:00 GMT','A different update this morning')
    const status=parse(unrelated,preview,announced,other)
    assert.equal(status.currentPosts.length,4)
    assert.equal(status.currentPosts.at(-1).text,'A different update this morning')
    assert.equal(status.current.phase,'RESET')
})
test('quoted Day markers do not create duplicate history days; later cycle cannot complete old reset',()=>{
    const old=item('90','Tue, 13 Oct 2026 01:00:00 GMT','Day 8/ Reset')
    const quotedDay='<item><title>Just a comment</title><link>https://x.com/thsottiaux/status/91</link><pubDate>Tue, 13 Oct 2026 01:02:00 GMT</pubDate><description><![CDATA[<p>Just a comment</p><blockquote>Day 8/ Reset</blockquote>]]></description></item>'
    const status=parse(done,preview,announced,quotedDay,old)
    assert.equal(status.history.length,2)
    assert.equal(status.history.find(day=>day.day===8).phase,'RESET')
})
test('negation in the authored text must not complete a reset',()=>{
    const negated=item('104','Thu, 15 Oct 2026 06:28:13 GMT','Reset is not done','101')
    assert.equal(parse(negated,preview,announced).current.phase,'RESET')
})
test('UPDATE day does not become reset when completion text appears',()=>{
    const update=item('100','Thu, 15 Oct 2026 04:55:51 GMT','Day 10/ New feature shipped')
    assert.equal(parse(done,preview,update).current.phase,'UPDATE')
})
test('a feature update mentioning no reset is not a RESET announcement',()=>{
    const update=item('100','Thu, 15 Oct 2026 04:55:51 GMT','Day 10/ New feature shipped; no reset today')
    assert.equal(parse(update).current.result,'UPDATE')
})
test('RESET cycle starts at its announcement across midnight, outside the latest 20',()=>{
    const old=item('200','Wed, 14 Oct 2026 22:00:00 GMT','Day 10/ Reset')
    const later=item('201','Thu, 15 Oct 2026 04:00:00 GMT','Global reset is complete')
    const extra=Array.from({length:22},(_,i)=>item(String(300+i),`Thu, 15 Oct 2026 05:${String(i).padStart(2,'0')}:00 GMT`,'Unrelated feature discussion'))
    const result=parse(old,later,...extra)
    assert.equal(result.current.phase,'LIVE')
    assert.equal(result.analysisPosts[0].url,'https://x.com/thsottiaux/status/200')
    assert.ok(!result.recentPosts.some(post=>post.url.endsWith('/200')))
    assert.ok(result.diagnosticContext.some(post=>post.url.endsWith('/200')))
})
test('missing announcement or missing reference parent cannot imply completion',()=>{
    assert.throws(()=>parse(item('102','Thu, 15 Oct 2026 06:28:13 GMT','Done and dusted','101')),/No Day/)
    const result=parse(announced,item('102','Thu, 15 Oct 2026 06:28:13 GMT','Global reset is complete','999'))
    assert.equal(result.current.phase,'RESET')
})
test('different timestamp offsets across Beijing midnight stay in one RESET cycle',()=>{
    const announced=item('500','2026-10-14T23:55:00+08:00','Day 10/ Reset')
    const completed=item('501','2026-10-14T16:05:00Z','Global reset is complete','500')
    const result=parse(announced,completed)
    assert.equal(result.current.day,10)
    assert.equal(result.current.phase,'LIVE')
    assert.equal(result.current.publishedAt,'2026-10-14T15:55:00.000Z')
    assert.equal(result.current.liveAt,'2026-10-14T16:05:00.000Z')
    assert.equal(result.analysisPosts.length,2)
})
