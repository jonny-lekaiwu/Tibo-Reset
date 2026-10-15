import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildTiboStatus } from '../src/service/tibo-status.js'
import { createResetAnalyzer, readTiboAiSettings } from '../src/service/tibo-ai.js'

const settings={enabled:true,accountId:'a'.repeat(32),token:'private-test-token',model:'@cf/meta/llama-3.3-70b-instruct-fp8-fast',timeoutMs:1000,minConfidence:.9}
const item=(id,time,text)=>`<item><link>https://x.com/thsottiaux/status/${id}</link><pubDate>${time}</pubDate><description><![CDATA[<p>${text}</p>]]></description></item>`
function state({text='The quota refill has finished for every account.',result='RESET',extra=''}={}) {
    return buildTiboStatus(`<rss>${item('10','Thu, 15 Oct 2026 04:55:00 GMT',`Day 10/ ${result==='RESET'?'Reset':'New update shipped'}`)}${item('11','Thu, 15 Oct 2026 06:28:00 GMT',text)}${extra}</rss>`,new Date('2026-10-15T07:00:00Z'))
}
const decision=(extra={})=>({landed:true,confidence:.97,evidence_url:'https://x.com/thsottiaux/status/11',evidence_quote:'The quota refill has finished',reason:'The author confirms the reset is complete.',...extra})
const response=value=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(value)}}]})})
const analyzer=options=>createResetAnalyzer({getSettings:()=>settings,warn:()=>{},log:()=>{},...options})
test('configured credentials enable AI without a new switch; explicit false still disables',()=>{
    const keys=['TIBO_AI_ENABLED','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN']
    const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]))
    try {
        delete process.env.TIBO_AI_ENABLED
        process.env.CLOUDFLARE_ACCOUNT_ID=settings.accountId
        process.env.CLOUDFLARE_API_TOKEN=settings.token
        assert.equal(readTiboAiSettings().enabled,true)
        process.env.TIBO_AI_ENABLED='false'
        assert.equal(readTiboAiSettings().enabled,false)
        delete process.env.TIBO_AI_ENABLED
        delete process.env.CLOUDFLARE_API_TOKEN
        assert.equal(readTiboAiSettings().enabled,false)
    } finally { for(const key of keys) { if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key] } }
})

test('semantic completion updates phase/history but never filters display posts or exposes internal context',async()=>{
    let calls=0
    const analyze=analyzer({fetchImpl:async(url,options)=>{
        calls++
        assert.match(url,/api\.cloudflare\.com\/client\/v4\/accounts\/a{32}\/ai\/v1\/chat\/completions$/)
        assert.equal(options.headers.Authorization,'Bearer private-test-token')
        assert.equal(options.signal.aborted,false)
        const payload=JSON.parse(options.body)
        assert.equal(payload.response_format.type,'json_object')
        assert.equal(payload.temperature,0)
        assert.equal(options.body.includes('private-test-token'),false)
        assert.equal(JSON.parse(payload.messages[1].content).posts.length,2)
        assert.equal(JSON.parse(payload.messages[1].content).posts[1].id,'11')
        return response(decision())
    }})
    const input=state();assert.equal(input.current.phase,'RESET')
    const posts=JSON.stringify(input.currentPosts)
    const result=await analyze(input)
    assert.equal(result.current.phase,'LIVE')
    assert.equal(result.history[0].phase,'LIVE')
    assert.equal(result.semantic.status,'confirmed')
    assert.equal(result.current.liveUrl,'https://x.com/thsottiaux/status/11')
    assert.equal(JSON.stringify(result.currentPosts),posts)
    assert.equal(JSON.stringify(result).includes('analysisPosts'),false)
    assert.equal(calls,1)
})
test('diagnostic logs original posts and verdict, without secrets or duplicate polls',async()=>{
    const records=[]
    const analyze=analyzer({fetchImpl:async()=>response(decision()),log:record=>records.push(record)})
    await analyze(state())
    await analyze(state())
    assert.equal(records.length,1)
    assert.equal(records[0].source,'model')
    assert.equal(records[0].rulePhase,'RESET')
    assert.equal(records[0].finalPhase,'LIVE')
    assert.equal(records[0].ai.aiLanded,true)
    assert.equal(records[0].ai.reason,'The author confirms the reset is complete.')
    assert.equal(records[0].recentPosts.length,2)
    assert.ok(records[0].recentPosts.some(post=>post.text.includes('quota refill')))
    assert.equal(JSON.stringify(records).includes(settings.token),false)
    const result=state()
    assert.equal(JSON.stringify(result).includes('recentPosts'),false)
})
test('UPDATE and disabled/missing configuration never call AI',async()=>{
    const fetchImpl=()=>{throw Error('must not be called')}
    const update=await analyzer({fetchImpl})(state({result:'UPDATE'}))
    assert.equal(update.current.phase,'UPDATE')
    const disabled=await analyzer({fetchImpl,getSettings:()=>({...settings,enabled:false})})(state())
    assert.equal(disabled.semantic,undefined)
    const missing=await analyzer({fetchImpl,getSettings:()=>({...settings,token:''})})(state())
    assert.equal(missing.semantic.status,'not-configured')
})
test('today has unrelated posts only: old RESET cannot trigger an AI completion check',async()=>{
    let calls=0
    const analyze=analyzer({fetchImpl:async()=>{calls++;throw Error('unrelated posts must not call AI')}})
    const xml=`<rss>${item('10','Wed, 14 Oct 2026 04:55:00 GMT','Day 10/ Reset')}${item('11','Thu, 15 Oct 2026 06:28:00 GMT','The documentation rewrite is done and dusted.')}</rss>`
    const input=buildTiboStatus(xml,new Date('2026-10-15T07:00:00Z'))
    const result=await analyze(input)
    assert.equal(calls,0)
    assert.equal(result.current.phase,'RESET')
    assert.ok(result.currentPosts[0].text.includes('documentation'))
})
test('unrelated completion quoting RESET does not enter the reset evidence chain',async()=>{
    let calls=0
    const analyze=analyzer({fetchImpl:async()=>{calls++;throw Error('must skip')}})
    const input=state({text:'The documentation rewrite is done and dusted.<blockquote><a href="https://x.com/thsottiaux/status/10">Day 10/ Reset</a></blockquote>'})
    await analyze(input)
    assert.equal(calls,0)
    assert.equal(input.current.phase,'RESET')
})
test('future wording cannot become LIVE even if AI claims high confidence',async()=>{
    const analyze=analyzer({fetchImpl:async()=>response(decision({evidence_quote:'Landing within the next 2 hours'}))})
    const result=await analyze(state({text:'Global reset: Landing within the next 2 hours'}))
    assert.equal(result.current.phase,'RESET')
    assert.equal(result.semantic.status,'fallback')
})
test('low confidence, malformed JSON and invented evidence fall back safely',async()=>{
    for(const content of [decision({confidence:.6}),decision({evidence_url:'https://example.com/invented'}),decision({evidence_quote:'an invented quote'}),{landed:'true',confidence:.99}]){
        const result=await analyzer({fetchImpl:async()=>response(content)})(state())
        assert.equal(result.current.phase,'RESET')
    }
    const bad=await analyzer({fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:'not JSON'}}]})})})(state())
    assert.equal(bad.semantic.status,'fallback')
})
test('provider errors do not log a response body or token and retry is throttled',async()=>{
    const logs=[];let calls=0;let clock=1000
    const analyze=analyzer({now:()=>clock,warn:code=>logs.push(code),fetchImpl:async()=>{calls++;return {ok:false,status:429,json:()=>{throw Error('do not read private provider errors')}}}})
    assert.equal((await analyze(state())).current.phase,'RESET')
    await analyze(state());assert.equal(calls,1)
    clock+=61000;await analyze(state());assert.equal(calls,2)
    assert.deepEqual(logs,['provider-http-429','provider-http-429'])
})
test('concurrent and unchanged inputs share one call; changed pending input is reevaluated',async()=>{
    let calls=0
    const analyze=analyzer({fetchImpl:async()=>{calls++;return response(decision({landed:null,confidence:.4,evidence_url:'',evidence_quote:''}))}})
    await Promise.all([analyze(state()),analyze(state()),analyze(state())]);assert.equal(calls,1)
    await analyze(state());assert.equal(calls,1)
    await analyze(state({extra:item('12','Thu, 15 Oct 2026 06:30:00 GMT','Another public post')}));assert.equal(calls,1)
    await analyze(state({extra:item('12','Thu, 15 Oct 2026 06:30:00 GMT','Global reset is still pending')}));assert.equal(calls,2)
})
test('pending verdict with real evidence leaves RESET and timeout uses rules',async()=>{
    const pending=await analyzer({fetchImpl:async()=>response(decision({landed:false,evidence_quote:'Landing within the next 2 hours'}))})(state({text:'Global reset: Landing within the next 2 hours'}))
    assert.equal(pending.semantic.status,'pending')
    assert.equal(pending.current.phase,'RESET')
    const fallback=await analyzer({fetchImpl:async()=>{throw new DOMException('time expired','TimeoutError')}})(state())
    assert.equal(fallback.current.phase,'RESET')
})
test('cache persists across restart; confirmed reset does not flip on unrelated new posts',async t=>{
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tibo-ai-test-'))
    const cacheFile=path.join(directory,'cache.json')
    t.after(async()=>{await fs.unlink(cacheFile);await fs.rmdir(directory)})
    let calls=0
    await analyzer({cacheFile,fetchImpl:async()=>{calls++;return response(decision())}})(state())
    const restarted=analyzer({cacheFile,fetchImpl:async()=>{calls++;throw Error('must not need another paid call')}})
    const result=await restarted(state({extra:item('12','Thu, 15 Oct 2026 06:30:00 GMT','A separate product announcement')}))
    assert.equal(result.current.phase,'LIVE');assert.equal(calls,1)
    const persisted=await fs.readFile(cacheFile,'utf8')
    assert.equal(persisted.includes('private-test-token'),false)
})
