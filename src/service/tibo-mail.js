const TOOL_URL = process.env.PUBLIC_URL || 'http://localhost:3000/'
const formatTime = value => {
    const date = new Date(value || '')
    return Number.isNaN(date.getTime()) ? '时间暂不可用' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）'
}
const sourceLine = value => {
    try {
        const url = new URL(value)
        if (url.protocol === 'https:' && ['x.com', 'twitter.com', 'fxtwitter.com', 'www.fxtwitter.com'].includes(url.hostname)) return `查看来源：${url.href}`
    } catch {}
    return ''
}

// Pure rendering: previews/tests never connect to SMTP or read subscribers.
export function buildTiboMail(status, { confirmation = false, test = false } = {}) {
    if (confirmation) return {
        subject: '【订阅成功】Tibo 动态邮件提醒已开启',
        body: ['你已订阅 Tibo 动态提醒。', '有新的状态公告或 RESET 完成进展时，我们会通过邮件提醒你。', '这是一封订阅确认邮件，不代表有新的 RESET。', `查看动态：${TOOL_URL}`, '乐开物 · Tibo RESET 提醒'].join('\r\n\r\n'),
    }
    if (test) return {
        subject: '【测试邮件】Tibo 提醒收信测试',
        body: ['这是一封测试邮件，用于确认你能正常收到提醒。', '本邮件不代表 Tibo 发布了新动态，也不代表 RESET 已完成。', `查看当前状态：${TOOL_URL}`, '乐开物 · Tibo RESET 提醒'].join('\r\n\r\n'),
    }
    const day = Number(status?.day)
    if (!Number.isInteger(day) || day < 1 || !['RESET', 'UPDATE'].includes(status?.result)) throw Error('Invalid Tibo mail status')
    const live = status.result === 'RESET' && status.phase === 'LIVE'
    // A completed notification must quote the completion post, never the announcement.
    if (live && !status.liveText) throw Error('Missing RESET completion evidence')
    const subject = live ? `【RESET 已确认完成】Tibo Day ${day}`
        : status.result === 'RESET' ? `【RESET 公告】Tibo Day ${day}，等待完成确认`
        : `【UPDATE】Tibo Day ${day} 有新动态`
    const intro = live ? `根据 Tibo 的后续公开动态，本轮 Day ${day} / RESET 已确认完成。`
        : status.result === 'RESET' ? `Tibo 发布了 Day ${day} / RESET 公告，目前尚未确认本轮 RESET 已完成。有完成进展时，我们会继续提醒你。`
        : `Tibo 发布了 Day ${day} / UPDATE 动态。`
    const body = [intro, `${live ? '确认依据' : '动态原文'}：\r\n${live ? status.liveText : status.text || ''}`,
        `发布时间：${formatTime(live ? status.liveAt : status.publishedAt)}`,
        sourceLine(live ? status.liveUrl : status.url),
        live ? '你的账户额度是否恢复，请以账户页面显示为准。' : '',
        `查看后续动态：${TOOL_URL}`, '乐开物 · Tibo RESET 提醒'].filter(Boolean).join('\r\n\r\n')
    return { subject, body }
}
