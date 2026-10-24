# dsh-remote-v2 模块契约（冻结版，实现以本文件为准）

仓库根：`D:\知识库\Test\dsh-remote-v2`。纯 ESM JavaScript（无构建步骤），Node >= 22.19。
所有模块用 JSDoc 注释；错误用 `Error` + `code` 属性。

## 0. 目录与归属

```
core/             # 独立 sidecar 进程（Node 24 运行，不依赖 DSH）
  gateway.js      # [Lead] 鉴权网关：/pair、/pair/claim、反代(HTTP+WS)
  proxy.js        # [Lead] 反向代理原语（HTTP/WS）
  pairing.js      # [Lead] 一次性票据
  devices.js      # [Lead] 设备会话存储
  http-util.js    # [Lead] 小工具（body 读取、cookie、JSON 响应）
  config.js       # [T1] 配置/状态目录、原子写
  log.js          # [T1] JSONL 日志 + 环形缓冲（诊断）
  cloudflared.js  # [T1] cloudflared 定位/下载/校验
  tunnel.js       # [T1] 传输管理器 quick/named
  control.js      # [T1] 本地控制 API（loopback + Bearer token）
  sidecar.js      # [T1] 入口：装配 runtime、写 control.json、watchdog
lib/
  index.js        # [T2] DSH host 插件：启动 sidecar、broker、管理 API
  control-client.js # [T2] 访问 sidecar 控制 API 的客户端
  launch-broker.js  # [T2] 给 sidecar 提供 DSH authenticatedUrl 的回调
  client.js         # [T2] 浏览器端 bundle（手写 CJS 包装 + React.createElement）
  qrcode-generator.js # [T2] vendored MIT QR 生成器
cordis.patch.yml  # [Lead] 已写好
package.json      # [Lead] 已写好
test/             # 各人写自己的测试
```

禁止修改他人文件；跨模块只依赖下面的导出契约。

## 1. 环境变量（host 启动 sidecar 时注入）

| 变量 | 含义 |
| --- | --- |
| `DSH_REMOTE_V2_STATE_DIR` | 绝对路径，默认 `~/.dsh/plugins/dsh-remote-v2` |
| `DSH_REMOTE_V2_UPSTREAM` | DSH web 地址，如 `http://127.0.0.1:12345` |
| `DSH_REMOTE_V2_CONTROL_TOKEN` | 32 字节 base64url，控制 API Bearer token |
| `DSH_REMOTE_V2_BROKER_URL` | `http://127.0.0.1:<port>/launch-url` |
| `DSH_REMOTE_V2_BROKER_TOKEN` | 访问 broker 的 Bearer token |
| `DSH_REMOTE_V2_PLUGIN_ROOT` | 插件包根目录（用于定位 cloudflared 缓存等） |
| `DSH_REMOTE_V2_VERSION` | 插件版本字符串 |
| `DSH_REMOTE_V2_HOST_PID` | DSH host 进程 pid（sidecar watchdog 用） |

sidecar 启动成功后**原子写** `<stateDir>/control.json`：
```json
{ "port": 12345, "pid": 999, "startedAt": 1790000000000, "version": "0.1.0" }
```
host 最多等 15s 读取该文件。

## 2. core/pairing.js

```js
export function createPairingService({
  ttlMs = 5 * 60_000,
  maxAttempts = 5,          // 每张票的错误尝试上限
  windowMs = 60_000,
  maxPerWindow = 120,       // 全局限流
  now = () => Date.now(),
} = {})
```
返回 `{ issue(), claim(credential), peek(), invalidateAll(), count() }`：
- `issue() -> { id, secret, code, createdAt, expiresAt }`
  - `secret`：32 字节 CSPRNG，base64url（43 字符）
  - `code`：8 字符，字母表 `ABCDEFGHJKMNPQRSTUVWXYZ23456789`（31 字符，拒绝采样无偏）
  - 同时只有一张“当前票”；issue 会作废旧票。
- `claim(credential) -> { ok:true, ticket } | { ok:false, reason }`
  - `reason ∈ 'rejected' | 'rate-limited' | 'locked'`
  - 常量时间比较；命中后立即删除（单次使用）；每票错误计数；超过 `maxAttempts` 该票作废并返回 `locked`；全局窗口计数超限返回 `rate-limited`。
- `peek() -> { state:'none' } | { state:'active', ticket } | { state:'consumed', id, consumedAt } | { state:'expired', id, expiresAt }`
- `invalidateAll()`、`count()`。

## 3. core/devices.js

```js
export async function createDeviceStore({
  file,                     // devices.json 绝对路径
  ttlMs = 7 * 24 * 3600_000,
  maxDevices = 20,
  now = () => Date.now(),
} = {})
```
返回：
- `create(name?, ua?) -> { id, token }`：`token` 43 字符 base64url（32 字节），磁盘只存 `sha256(token)`。
- `verify(token) -> device | undefined`：命中刷新 lastSeen（内存即可），过期返回 undefined。
- `revoke(id) -> boolean`、`revokeAll() -> Promise<void>`、`list() -> [{ id, createdAt, expiresAt, name?, ua?, lastSeen? }]`。
- 原子写（tmp + rename，`mode 0o600`）；文件损坏时抛错（fail closed）；不存明文 token。

## 4. core/gateway.js

```js
export function createGateway({
  upstream,                 // URL，http://127.0.0.1:<dshPort>
  devices, pairing, logger,
  getPublicOrigin,          // () => URL | undefined（未就绪返回 undefined）
  getLaunchUrl,             // async (origin:string) => string | undefined
  deniedPrefix = ['/dsh-remote-v2'],
  cookieName = 'dsh_remote_v2',
  cookieSecure = true,
  now = () => Date.now(),
})
```
返回 `{ start() -> Promise<{port}>, stop(), pairingPageInfo() }`，只监听 `127.0.0.1`。

行为：
1. `GET /pair`：返回 HTML（内联脚本）：
   - 若 `location.hash` 形如 `#s=<secret>`，自动 `POST /pair/claim {secret, name}`；
   - 否则展示 8 位码输入框 → 同样 POST；
   - 成功后 `location.replace(redirect)`，失败展示稳定错误文案（不泄露票据是否存在）。
   - 页面需带 `Cache-Control: no-store`、`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'`。
2. `POST /pair/claim`：JSON，body ≤ 4 KiB；字段 `{secret?, code?, name?}`；`pairing.claim(...)` 成功 → `devices.create(name, ua)`；设置 Cookie（`HttpOnly; Secure(取决于参数); SameSite=Lax; Path=/; Max-Age=604800`）；返回 `{ok:true, redirect}`，`redirect` 优先用 `getLaunchUrl(publicOrigin)`，失败回退 `publicOrigin.pathname`（`/`）。失败：`401 {ok:false, error:'pairing-failed'}` 或 `429 {ok:false,error:'rate-limited'}`。
3. 其他请求：
   - `getPublicOrigin()` 为 undefined → `503`（公网入口 CLOSED）；
   - `Host` 必须与 publicOrigin.host 完全一致，否则 403；
   - 非 GET/HEAD 必须有精确 `Origin`；`sec-fetch-site: cross-site` 拒绝；WS 必须有精确 Origin；
   - 路径先反复 `decodeURIComponent`（最多 3 次）+ 折叠 `\` + 去 dot-segments，再与 `deniedPrefix` 前缀比较，命中返回 404；
   - 设备 Cookie 校验失败 → 401（API/WS 纯文本；HTML 导航可给 401 页面）；
   - 通过后交给 `proxy.js` 反代，重写 `Host` 为 upstream.host、`Origin` 为 upstream.origin（有 Origin 时），剥离 hop-by-hop、`cf-*`、`x-forwarded-*`、`forwarded`、`x-real-ip`、`authorization`、设备 Cookie；其他 Cookie 保留；
   - 支持 HTTP 流式与 WebSocket upgrade。
4. `GET /healthz`：仅当 Host 是 loopback（127.0.0.1/localhost）时 200。

## 5. core/proxy.js

```js
export function createProxy({ upstream, agent?, logger? })
// => { web(req,res,onError), ws(req,socket,head,onError), close() }
```
纯 node:http/https，不引第三方依赖。流式转发；不缓冲整包；超时（连接/空闲 120s）；错误回调。

## 6. core/cloudflared.js

```js
export async function ensureCloudflared({ cacheDir, explicitPath, logger, fetchImpl = fetch })
// -> 可执行文件绝对路径
export const CLOUDFLARED_VERSION = '2026.8.2'
export const WIN32_X64_SHA256 = 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5'
```
顺序：explicitPath → PATH 中 `cloudflared`（仅当 `--version` 匹配 pinned 版本）→ 缓存文件（SHA-256 校验）→ 下载 `https://github.com/cloudflare/cloudflared/releases/download/2026.8.2/cloudflared-windows-amd64.exe` 并校验 SHA-256 后写缓存。
非 win32-x64 平台抛出 `unsupported-platform`（MVP 只保证 Windows x64；代码结构保留扩展点）。

## 7. core/tunnel.js

```js
export function createTunnelManager({
  cloudflaredPath,          // ensureCloudflared 结果
  gatewayPort,              // 网关实际端口
  logger,
  onState,                  // (state) => void
  spawnImpl = child_process.spawn,
  now = () => Date.now(),
})
```
`start(settings) -> Promise<{ publicUrl }>`，`settings`：
- `{ transport:'quick' }`
- `{ transport:'named', namedToken:'<token>', publicUrl:'https://remote.example.com' }`

行为：
- 每次启动分配随机 loopback metrics 端口，参数 `--metrics 127.0.0.1:<port>`；
- quick：`tunnel --url http://127.0.0.1:<gatewayPort> --no-autoupdate`；从 stderr 解析 `https://*.trycloudflare.com`；
- named：`tunnel run --token <token> --no-autoupdate`；publicUrl 用配置值；
- 就绪判定：`GET http://127.0.0.1:<metrics>/ready` 返回 200 **且** 已拿到 publicUrl；
- 状态机：`idle|starting|ready|reconnecting|error`；异常退出指数退避重连（1s→2s→…→30s，最多无限，用户 stop 后停止）；
- `stop()` 必须杀进程树（Windows `taskkill /T /F`），等待退出，清理计时器；
- `status() -> { phase, publicUrl?, reconnects, lastError?, startedAt?, metricsPort? }`；
- `onState(state)` 在每次状态变化时回调（sidecar 用它更新 gateway publicOrigin）。

## 8. core/control.js

```js
export function createControlServer({ token, runtime, logger })
// => { start():Promise<{port}>, stop() }
```
- 只绑 `127.0.0.1:0`；除 `GET /healthz` 外都要求 `Authorization: Bearer <token>`（timing-safe 比较）。
- 路由（JSON）：
  - `GET  /status`
  - `POST /start` `{transport, namedToken?, publicUrl?}`
  - `POST /stop`
  - `POST /pairing/rotate`
  - `GET  /pairing`
  - `GET  /devices`
  - `POST /devices/revoke` `{id}`
  - `POST /devices/revokeAll`
  - `GET  /config`、`POST /config` `{config}`
  - `GET  /diagnostics`
- 错误统一 `{ok:false,error:{code,message}}`；成功 `{ok:true,value}`。
- `runtime` 接口由 sidecar 提供：`status/start/stop/pairingRotate/pairingStatus/devices/revoke/revokeAll/configGet/configSet/diagnostics`。

## 9. core/sidecar.js

入口文件。流程：
1. 读环境变量，创建 `<stateDir>/{logs}`；
2. 初始化 devices（`<stateDir>/devices.json`）、pairing、tunnel；
3. 创建 gateway（`upstream`、`getPublicOrigin` 由 tunnel 状态维护、`getLaunchUrl` 调 broker）；
4. 创建 runtime（status/start/stop/...，`start` 调用 tunnel.start 并设置 origin；`stop` 先清 origin 再停隧道）；config 持久化到 `<stateDir>/config.json`；
5. 启动 control server，写 `control.json`；
6. SIGINT/SIGTERM → 优雅关闭；watchdog 每 2s 检查 `DSH_REMOTE_V2_HOST_PID`，父进程消失则退出；
7. 未捕获异常写日志后退出（host 会重启 sidecar）。

`status()` 返回：
```js
{
  running: boolean,
  phase: 'idle'|'starting'|'ready'|'reconnecting'|'error',
  transport: 'quick'|'named',
  publicUrl?: string,
  version: string,
  devices: [...],
  pairing: { state, code?, url?, expiresAt?, consumedAt? },
  edge: { ready: boolean, reconnects: number, lastError?: string, since?: number },
  lastError?: string,
}
```
`pairing.url` = `${publicUrl}/pair#s=${secret}`（仅 state=active 时）。

## 10. lib/index.js（host 插件）

- `export const name = 'dsh-remote-v2'`，`export const inject = ['connection','webServer']`，`export function apply(ctx, config)`。
- 解析 stateDir（`$DSH_HOME` 或 `~/.dsh` 下 `plugins/dsh-remote-v2`），启动 sidecar：
  `spawn(process.execPath, [join(pluginRoot,'core/sidecar.js')], { env:{...process.env, ELECTRON_RUN_AS_NODE:'1', DSH_REMOTE_V2_*}, stdio:['ignore','pipe','pipe'], windowsHide:true })`；
  stdout/stderr 转发到 `ctx.logger`（截断）。
- 启动 broker（loopback HTTP，Bearer token）：`POST /launch-url {origin}` → `ctx.connection.authenticatedUrl(origin)`（try/catch，失败返回 `origin + '/'`）。
- 在 DSH web 上挂 `POST /dsh-remote-v2/api` 前缀路由（`ctx.webServer.register({kind:'prefix', ...})`），先 `ctx.connection.requestRejection(req)`，再 JSON `{method,payload}` 分发：读 `control-client.js` 调 sidecar；返回 `{ok,value}`/`{ok:false,error}`。
- `ctx.effect` 负责 dispose：kill sidecar、关 broker。
- 必须容忍 DSH 版本差异：`webServer.register`/`requestRejection` 不存在时只打日志、不崩溃。

## 11. lib/client.js（浏览器 bundle）

手写 CJS 包装，格式：
```js
window.__ModuleLoader__.load({ id: 'dsh-remote-v2', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  // ... require('react')、require('react/jsx-runtime')；用 React.createElement（不用 JSX）
  return module.exports;
} });
```
- `export const inject = ['slots','locale','connection']`
- `apply(ctx)`：
  - `ctx.locale.register('dsh-remote-v2', {zh,en})`
  - 注册 `settings.section`：`{ name:'settings.section', id:'remote-access-v2', order:2, label:()=>'远程访问', locale:'dsh-remote-v2', inject:()=>({api}) }`
  - UI：状态（运行/关闭、传输、公网地址、重连次数、最后错误）、传输选择（quick / named + token + publicUrl）、启动/停止、配对（生成/刷新 → 二维码 + 8 位码 + 链接）、设备列表 + 撤销、诊断（最近日志）。
  - 管理 API 调用：`fetch('/dsh-remote-v2/api', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({method,payload})})`，同源 Cookie 自动携带。
  - `connection.isLoopback === false` 时只显示“请在电脑端管理”的说明，不渲染二维码。
  - 二维码：host API `qrSvg` 返回 SVG 字符串，用 `<img src="data:image/svg+xml;charset=utf-8,...">`；不要用 `dangerouslySetInnerHTML`。
- 所有 UI 文案中文优先；错误码映射为可读文案。

## 12. 控制 API 的配置对象

```js
// config.json
{
  "transport": "quick",
  "namedToken": "",        // 仅 named
  "publicUrl": "",         // 仅 named，https URL
  "gatewayPort": 0,        // 0=随机；named 必须固定端口（1024-65535），
                           // Cloudflare Public Hostname 指向 http://127.0.0.1:<gatewayPort>
  "autoStart": false
}
```
MVP 不做自动启动（避免开机即暴露公网）。

## 13. 测试约定

- `node --test test/`；每个模块自带 `test/<module>.test.js`。
- 网络测试用 `http.createServer` 假上游，禁止访问真实互联网。
- 端口用 0；临时目录用 `fs.mkdtemp` 并清理。
- 不依赖第三方 npm 包。
