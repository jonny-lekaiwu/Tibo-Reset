# Tibo-Reset

为了等一次重置，我做了个小工具。

它会读取 Tibo 的公开动态，区分 RESET 公告和后续进展，通过邮件提醒订阅者。原先集成在乐开物网站中，这里整理为可以独立运行的版本。

在线体验：<https://lekaiwu.cn/tools/tibo-monitor/>

## 本地运行

需要 Node.js 22 或更新版本，无第三方运行依赖。

```sh
git clone https://github.com/jonny-lekaiwu/Tibo-Reset.git
cd Tibo-Reset
cp .env.example .env
npm start
```

Windows PowerShell 使用 `Copy-Item .env.example .env`。打开 `http://localhost:3000/`。

不配置邮件也可以查看状态；发送邮件需要在 `.env` 填入 SMTP 用户、授权码及发件人。默认监听本机，部署时通过反向代理提供 HTTPS，按需调整 HOST 与 PUBLIC_URL。不要提交 `.env` 或 `data/`。

## 功能

- 展示公开动态与往日 RESET / UPDATE 记录。
- 邮箱订阅、确认邮件、按轮次和阶段去重提醒。
- 同一轮可跨天继续追踪；无关动态不当作 RESET 完成证据。
- 可选 Cloudflare Workers AI 辅助理解后续动态。未启用、调用失败或证据不足时按现有规则处理，不把错误当作完成。
- 可选逐条 AI 诊断接口，默认关闭。

这不是官方额度查询接口，不读取你的账号额度，也不能保证实时通知或重置到账。RSS 可用性、作者表述、网络与邮件投递都会影响结果。默认每五分钟轮询，AI 服务可能产生调用费用。

## 配置

全部配置见 `.env.example`。AI 功能需要自己的 Cloudflare Account ID 和 API Token，仅后端读取；不会把订阅邮箱发给 AI。`TIBO_MONITOR_ENABLED=false` 可禁用后台轮询。`TIBO_DIAGNOSTICS_ENABLED=true` 会启用公开诊断接口，部署时自行限制访问。

## 数据与部署边界

订阅邮箱、通知记录和 AI 缓存存储在本机 `data/`，不在开源文件内。当前版本适合个人单实例使用；不要多进程并发写同一个数据目录。公网开放订阅前，应按自己的服务规模增加限流、邮箱验证、退订及数据管理措施。当前版本没有完整的自助退订流程，运营者应响应删除请求，并备份及限制数据目录权限。

## 测试

```sh
npm test
```

覆盖邮件内容、RESET 判断、跨天与上下文缺失、AI 返回和诊断逻辑。测试使用模拟数据，不发送真实邮件。

## 来源与协议

作者：Jonny。

按用户指定，以 **GNU GPL v3.0 only（GPL-3.0-only）** 发布，完整协议见 [LICENSE](LICENSE)。源模块的出处和原仓库协议信息见 [NOTICE.md](NOTICE.md)。项目与 Tibo 及其所属平台无隶属关系；上游动态内容及商标不因本代码协议而授权。
