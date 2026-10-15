// Keep display posts separate from the state used for notification deduplication.
const decode = value => String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\n(?:[ \t]*\n){2,}/g, '\n\n').trim()
const rawTag = (block, name) => block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || ''
const timestamp = post => Date.parse(post.publishedAt) || 0
const dateKey = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
const idOf = value => String(value || '').match(/\/status\/(\d+)/)?.[1] || ''

function classifyDay(text) {
    const match = text.match(/day\s+(\d+)\s*\/\s*([^\r\n]*)/i)
    if (!match) return null
    const tail = match[2].trim()
    if (/^(?:global\s+)?reset\b/i.test(tail)) return { day: Number(match[1]), result: 'RESET' }
    const after = text.slice(match.index + match[0].length).trim()
    return tail || after.length > 10 ? { day: Number(match[1]), result: 'UPDATE' } : null
}

function future(text) {
    return /\b(?:landing|coming|arriving)\s+(?:within|in|by)\b|\b(?:will|should|going to|not yet)\b.{0,60}\b(?:land|reset|done|complete|roll\s*out)\b/i.test(text)
}
export function isResetPendingText(text) {
    return future(text) || /\b(?:not|isn't|isn’t|is not|hasn't|has not)\b.{0,30}\b(?:done|complete|completed|live|landed)\b/i.test(text)
}
function resetSubject(text) {
    // Operational resets of unrelated objects are not usage-limit resets.
    if (/\b(?:password|device|router|database|form|css|settings)\s+reset\b/i.test(text)) return false
    return /\breset\b|\b(?:quota|usage[ -]limits?|token[ -]limits?)\b.{0,80}\b(?:refill|reset|restor|replenish)/i.test(text)
}
function resetContext(cyclePosts, anchor) {
    const related = new Set([anchor.id].filter(Boolean))
    return cyclePosts.filter(post => {
        const linked = post.references.some(id => related.has(id))
        const shortFollowup = /^(?:done and dusted[.!]?|(?:it'?s|it is) done[.!]?|all propagated[.!]?|(?:landing|coming|arriving) (?:within|in|by) .{1,50})$/i.test(post.text.trim())
        // RSS sometimes omits reply metadata on the immediate timing reply.
        // Only a bare forecast immediately following the RESET anchor may bridge it.
        const immediateForecast = timestamp(post) - timestamp(anchor) <= 5*60000 && /^(?:landing|coming|arriving) (?:within|in|by) .{1,50}$/i.test(post.text.trim())
        const relevant = post === anchor || resetSubject(post.text) || (shortFollowup && (linked || immediateForecast))
        if (relevant && post.id) related.add(post.id)
        return relevant
    })
}
// Completion must belong to a captured announcement, not the edge of an RSS window.
export function hasResetCompletionContext(post, posts, anchor) {
    if (!anchor || !posts.some(item => item.url === anchor.url)) return false
    const byId = new Map(posts.map(item => [idOf(item.url), item]))
    const visited = new Set()
    function linked(item) {
        if (item.url === anchor.url) return true
        if (visited.has(item.url)) return false
        visited.add(item.url)
        if ((item.references || []).some(id => byId.has(id) && linked(byId.get(id)))) return true
        return timestamp(item) > timestamp(anchor) && timestamp(item)-timestamp(anchor) <= 5*60000 && /^(?:landing|coming|arriving) (?:within|in|by) .{1,50}$/i.test(item.text.trim())
    }
    if ((post.references || []).length) return linked(post)
    return resetSubject(post.text)
}
function completion(post, related) {
    const text = post.text
    if (isResetPendingText(text)) return false
    const explicit = /\b(?:reset\s+(?:is\s+)?(?:live|landed|complete|completed|done)|reset\s+has\s+(?:landed|completed)|global\s+reset\s+(?:is\s+)?(?:live|landed|complete|completed))\b/i.test(text)
    // Generic completion phrases require a reference to this cycle's reset thread.
    const linked = post.references.some(id => related.has(id))
    return explicit || (linked && /\b(?:done and dusted|(?:it'?s|it is)\s+done|all propagated|reset in the bag)\b/i.test(text))
}

export function buildTiboStatus(xml, now = new Date()) {
    const blocks = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(match => match[1])
    const posts = blocks.slice(0, 200).map(block => {
        const html = rawTag(block, 'description')
        // Quoted preview text must not change the meaning of the author's new post.
        const ownHtml = html.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, '')
        const text = decode(ownHtml) || decode(rawTag(block, 'title'))
        const url = decode(rawTag(block, 'link'))
        const published = Date.parse(decode(rawTag(block, 'pubDate')))
        const references = [...html.matchAll(/href=["']([^"']*\/status\/\d+)["']/gi)].map(match => idOf(match[1])).filter(Boolean)
        return { id: idOf(url), url, text, publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null, references, parsed: classifyDay(text) }
    }).filter(post => post.text && post.publishedAt).sort((a,b) => timestamp(a) - timestamp(b))
    const unique = new Map()
    for (const post of posts) if (post.parsed && !unique.has(post.parsed.day)) unique.set(post.parsed.day, post)
    const anchors = [...unique.values()].sort((a,b) => timestamp(a) - timestamp(b))
    if (!anchors.length) throw new Error('No Day status found in RSS')
    const display = post => ({ text: post.text, publishedAt: post.publishedAt, url: post.url })
    const cycles = anchors.map((anchor,index) => {
        const end = anchors[index + 1] ? timestamp(anchors[index + 1]) : Infinity
        const cyclePosts = posts.filter(post => timestamp(post) >= timestamp(anchor) && timestamp(post) < end)
        const state = { ...anchor.parsed, ...display(anchor), phase: anchor.parsed.result }
        const resetPosts = state.result === 'RESET' ? resetContext(cyclePosts, anchor) : []
        if (state.result === 'RESET') {
            const related = new Set([anchor.id].filter(Boolean))
            let livePost
            for (const post of resetPosts) {
                const linked = post.references.some(id => related.has(id))
                const preview = /\b(?:reset|landing|coming|arriving)\b/i.test(post.text)
                if (completion(post,related) && hasResetCompletionContext(post, resetPosts, anchor)) livePost = post
                if (post.id && (linked || preview)) related.add(post.id)
            }
            Object.assign(state, livePost ? { phase: 'LIVE', liveAt: livePost.publishedAt, liveText: livePost.text, liveUrl: livePost.url } : { liveAt: null, liveText: null, liveUrl: null })
        }
        return { state, cyclePosts, resetPosts }
    }).sort((a,b) => b.state.day - a.state.day)
    const current = cycles[0].state
    // Every post published today is visible, even when unrelated to reset/notification.
    const todayPosts = posts.filter(post => dateKey(post.publishedAt) === dateKey(now))
    const currentPosts = [...(todayPosts.length ? todayPosts : cycles[0].cyclePosts)].sort((a,b) => timestamp(b) - timestamp(a)).map(display)
    const result = { current, currentPosts, history: cycles.slice(0,7).map(cycle => cycle.state), source: 'FxTwitter RSS' }
    // Internal cycle context for semantic analysis, never serialized to the public API.
    Object.defineProperty(result, 'analysisPosts', { value: cycles[0].resetPosts.map(post => ({ ...display(post), references: post.references })) })
    Object.defineProperty(result, 'diagnosticContext', { value: posts.map(post => ({ ...display(post), references: post.references, day: post.parsed?.day, result: post.parsed?.result })) })
    Object.defineProperty(result, 'recentPosts', { value: posts.slice(-20).reverse().map(post => ({ ...display(post), references: post.references })) })
    return result
}
