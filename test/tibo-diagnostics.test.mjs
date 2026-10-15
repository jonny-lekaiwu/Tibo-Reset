import test from 'node:test'
import assert from 'node:assert/strict'
import { createRecentPostDiagnostics } from '../src/service/tibo-diagnostics.js'
import { diagnostics } from '../src/service/tibo-monitor.js'
const post = { url: 'https://x.com/thsottiaux/status/123', text: 'Day 10/ Reset', publishedAt: '2026-10-15T04:55:00Z', references: [] }
const settings = { enabled: true, token: 'secret-test-token', accountId: 'a'.repeat(32), model: 'model', minConfidence: .9 }
test('diagnostic endpoint defaults to 404 before upstream/AI access',async()=>{
    const old = process.env.TIBO_DIAGNOSTICS_ENABLED
    delete process.env.TIBO_DIAGNOSTICS_ENABLED
    try {
        const c={req:{header:()=>''},header:()=>{},json:(body,code)=>({body,code})}
        assert.equal((await diagnostics(c)).code,404)
    } finally { if(old===undefined) delete process.env.TIBO_DIAGNOSTICS_ENABLED; else process.env.TIBO_DIAGNOSTICS_ENABLED=old }
})
test('recent diagnostics preserve original text, validate rows and reuse cached requests',async()=>{
    let calls=0
    const diagnose=createRecentPostDiagnostics({getSettings:()=>settings,fetchImpl:async()=>{
        calls++
        return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({posts:[{id:'123',category:'RESET公告',confidence:.99,reason:'仅公告'}]})}}]})}
    }})
    const input={recentPosts:[post]}
    const [a,b]=await Promise.all([diagnose(input),diagnose(input)])
    assert.equal(calls,1)
    assert.equal(a.status,'ready')
    assert.equal(a.posts[0].text,post.text)
    assert.equal(b.count,1)
    assert.equal((await diagnose(input)).cached,true)
    assert.equal(JSON.stringify(a).includes(settings.token),false)
})
test('bad or incomplete model output fails without becoming a completion verdict',async()=>{
    const diagnose=createRecentPostDiagnostics({getSettings:()=>settings,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:'{"posts":[]}'}}]})})})
    const result=await diagnose({recentPosts:[post]})
    assert.equal(result.status,'fallback')
    assert.deepEqual(result.posts,[])
})
test('a confident completion without captured announcement becomes insufficient context',async()=>{
    const diagnose=createRecentPostDiagnostics({getSettings:()=>settings,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({posts:[{id:'123',category:'RESET完成',confidence:1,reason:'done'}]})}}]})})})
    const result=await diagnose({recentPosts:[{...post,text:'Done and dusted'}]})
    assert.equal(result.posts[0].ai.category,'不确定')
    assert.match(result.posts[0].ai.reason,/上下文不足/)
})
