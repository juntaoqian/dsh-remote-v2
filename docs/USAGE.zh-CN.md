# dsh-remote-v2 使用指南

> 适用版本：**0.1.0** · Windows x64 · DSH Desktop `>= 0.2.1-rc.2`
> 仓库：<https://github.com/juntaoqian/dsh-remote-v2>（**公开仓库**，无需登录即可克隆）

这个插件让你的手机/平板通过 **Tailscale**、**Cloudflare Named Tunnel** 或 **Cloudflare Quick Tunnel** 安全访问电脑上的 DeepSeek Harness：

- 隧道和鉴权网关跑在独立 sidecar 进程里，崩溃不会拖垮 DSH；
- 手机必须一次性配对（二维码 / 8 位码）才能进入，设备可随时撤销；
- 网关只监听 `127.0.0.1`，并做 Host/Origin 校验、设备会话鉴权。

---

## 前置条件

| 项目 | 要求 |
|---|---|
| DSH | Desktop 或 `dsh web`，版本 `>= 0.2.1-rc.2` |
| 系统 | Windows x64（MVP；macOS/Linux 规划中） |
| Node | 安装脚本用系统 Node `>= 22`（运行时不依赖 npm 包） |
| 手机 | 与电脑同一 Tailscale tailnet，或能访问你的 Cloudflare 域名 |
| 可选 | 一个托管在 Cloudflare 的域名（仅 Named Tunnel 需要） |

---

## 一、一句话让 AI 安装

把下面这段话**整段复制**给能操作你电脑的 AI（DSH 里的编码 Agent、Claude Code、Cursor 等）：

```text
请帮我安装 DSH 插件 dsh-remote-v2（仓库 https://github.com/juntaoqian/dsh-remote-v2）。
步骤：
1) 把仓库克隆/下载到本地任意目录（如果访问 GitHub 受限，用我提供的本地路径）；
2) 在该目录执行 `node scripts/install.mjs --profile desktop`；
3) 完全退出并重新打开 DeepSeek Harness；
4) 确认「设置 → 远程访问」出现，然后根据我的网络环境指导我选择 Tailscale / Named Tunnel / Quick Tunnel 并完成手机配对；
5) 安装前备份 DSH profile 的 package.json，不要改动 ~/.dsh 之外的文件。
如果其中任何一步失败，把报错原文贴给我，不要自行删除我的插件状态目录。
```

### 极简版（一句话）

```text
安装 DSH 插件：https://github.com/juntaoqian/dsh-remote-v2，进目录跑 `node scripts/install.mjs --profile desktop`，重启 DSH，然后告诉我怎么在「设置 → 远程访问」里配对手机。
```

### 如果 AI 所在机器访问 GitHub 受限

1. 先在能访问的机器上下载仓库 zip，或让 AI 使用你本机的插件目录（例如 `D:\知识库\Test\dsh-remote-v2`）；
2. 把提示词里的仓库地址替换成该本地路径；
3. 其余步骤完全一样。

> 仓库已公开，`git clone` 不需要任何凭据；只有所在网络无法访问 GitHub 时才需要上面的替代方案。

---

## 二、手动安装

```powershell
# 1) 获取代码（任选其一）
git clone https://github.com/juntaoqian/dsh-remote-v2.git
# 或解压下载的 zip

cd dsh-remote-v2

# 2) 安装到 desktop profile
node scripts/install.mjs --profile desktop
```

脚本会做这些事（都可重复执行）：

- 把 `lib/`、`core/`、`cordis.patch.yml` 等复制到
  `~/.dsh/profiles/desktop/node_modules/dsh-remote-v2`；
- 在 profile 的 `package.json` 里登记依赖和 `dsh.profile.bundles`；
- 修改前备份原 `package.json`（文件名带时间戳）。

### 验证安装

```powershell
# 用 DSH 自带的 Electron 作为 Node 运行
$env:ELECTRON_RUN_AS_NODE = '1'
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" scripts/validate-profile.mjs --profile desktop
```

看到 `dsh-remote-v2 packageDir: ...` 且 `skippedBundles: []` 即安装成功。

---

## 三、打开设置页

**完全退出 DeepSeek Harness 再重新打开**（不是关闭窗口），然后：

> 设置 → 远程访问

页面包含：状态、传输方式、启停、配对二维码/8 位码、设备列表、诊断信息。

> 如果看不到「远程访问」：确认已完全重启、profile 中 bundle 已登记；
> 仍不行就把 `validate-profile.mjs` 的输出发我。

---

## 四、选择访问方式

### 方式 A：Tailscale（推荐，只有你自己的设备能访问）

适合已经有 Tailscale、手机和电脑在同一 tailnet 的情况。**不暴露公网、不开路由器端口。**

1. **确认手机和电脑在同一个 tailnet**（Tailscale App 已登录、已连接）。
2. 在电脑上取得本机的 tailnet 名称：

   ```powershell
   & 'C:\Program Files\Tailscale\tailscale.exe' status --json |
     ConvertFrom-Json | ForEach-Object { $_.Self.DNSName.TrimEnd('.') }
   # 例：my-pc.tailXXXX.ts.net
   ```

3. **启用 Serve（每台机器只需一次）**：

   ```powershell
   & 'C:\Program Files\Tailscale\tailscale.exe' serve --bg 26001
   ```

   如果提示 `Serve is not enabled on your tailnet`，打开它给出的
   `https://login.tailscale.com/f/serve?...` 链接启用，然后重新执行上面的命令。
   验证：

   ```powershell
   & 'C:\Program Files\Tailscale\tailscale.exe' serve status
   # https://my-pc.tailXXXX.ts.net → http://127.0.0.1:26001
   ```

4. 插件里填写：

   | 字段 | 值 |
   |---|---|
   | 传输方式 | **Tailscale（tailscale serve）** |
   | 公网地址 | `https://my-pc.tailXXXX.ts.net` |
   | 本地网关端口 | `26001`（与第 3 步一致） |

   保存配置 → **开启**，状态变为 **ready**。

5. 手机（同一 tailnet）打开 `https://my-pc.tailXXXX.ts.net/pair`，或扫二维码。

> 换端口时，插件里的「本地网关端口」和 `tailscale serve --bg <端口>` 必须同时改。
> 停止入口：插件点「关闭」，必要时执行 `tailscale serve reset`。

### 方式 B：Cloudflare Named Tunnel（固定公网地址）

需要：Cloudflare 账号、一个已托管在 Cloudflare 的域名（免费套餐即可）。

1. **创建隧道**：Cloudflare Dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** → 连接器选 **Cloudflared** → 命名（如 `dsh-remote`）→ Save。
2. **复制 token**：安装页命令里的长串 `eyJ...` 就是 token；
   或用 CLI：`cloudflared tunnel token dsh-remote`。
3. **配置 Public Hostname**：该隧道 → Public Hostname → Add：
   - Subdomain `dsh`、Domain `example.com`
   - Service：**HTTP** → `127.0.0.1:26001`（必须和插件端口一致）
4. 插件里填写：

   | 字段 | 值 |
   |---|---|
   | 传输方式 | **Named Tunnel** |
   | Tunnel token | `eyJ...` |
   | 公网地址 | `https://dsh.example.com` |
   | 本地网关端口 | `26001` |

   保存 → 开启。

> token 等同机器凭据，只保存在本机 `~/.dsh/plugins/dsh-remote-v2/config.json`（0600），不会写日志。
> 想更稳可以在 Cloudflare Zero Trust → Access 里再加一层邮箱/SSO 校验（插件配对仍然生效）。

### 方式 C：Cloudflare Quick Tunnel（临时地址，免配置）

1. 传输方式选 **Quick Tunnel**，直接点 **开启**；
2. 状态 ready 后会出现 `https://xxxx.trycloudflare.com`，把这个地址用于配对。

特点：零配置、地址每次启动都变；**部分网络（尤其中国大陆）无法解析 `*.trycloudflare.com`**，
这时请改用 Tailscale 或 Named Tunnel。首次启动会下载约 55 MB 的 cloudflared（固定版本 + SHA-256 校验）。

---

## 五、手机配对

1. 电脑上「设置 → 远程访问」→ 点 **生成配对码**；
2. 手机上（**必须已连接 Tailscale**，或能访问你的 Cloudflare 域名）：
   - **系统相机**扫码 → 选「在浏览器中打开」；或
   - **微信扫一扫** → 扫完点右上角「在浏览器中打开」（不建议停留在微信内置浏览器）；或
   - 点电脑上的 **复制链接**，发到手机，用 Safari/Chrome 打开；或
   - 手机浏览器打开 `https://<你的地址>/pair`，输入页面上的 **8 位配对码**。

配对规则：

- 二维码链接 **5 分钟内有效、只能使用一次**；过期或被用过就重新生成；
- 配对成功会授予该设备 **7 天** 会话，期间打开 `https://<你的地址>/` 可直接进入；
- 手机浏览器需允许 Cookie（无痕窗口关闭后会丢失会话，需要重新配对）。

---

## 六、日常使用与重启 DSH

- **电脑重启 / DSH 重启后**：手机直接刷新 `https://<你的地址>/` 即可。
  最新版本会自动用新 token 重新登录；旧版本若显示 401/打不开，在电脑上重新生成配对码扫一次即可。
- **换网络/换端口**：Tailscale Serve 端口、插件「本地网关端口」、Cloudflare Public Hostname 三处保持一致。
- **不用时**：设置页点「关闭」，隧道和网关立即停止对外服务。

---

## 七、设备管理

设置页「设备」列表会显示已配对设备（名称、UA、最后活跃时间）：

- 单台撤销：点该设备的「撤销」；
- 全部撤销：点「全部撤销」（所有手机都需要重新配对）；
- 手机丢失：**先在电脑上撤销该设备**，必要时再 `tailscale serve reset`。

---

## 八、常见问题

| 现象 | 排查 |
|---|---|
| 设置页没有「远程访问」 | DSH 没有**完全退出**重启；或安装未生效（跑 `validate-profile.mjs` 检查 `skippedBundles`） |
| 二维码/链接打不开 | 手机 Tailscale 是否已连接；先试手机浏览器打开 `https://<地址>/pair`；Serve 是否 `serve --bg` 已运行 |
| 配对后一直转圈 | 旧版本 WebSocket 转发缺陷，更新到最新代码并重启 DSH（本仓库已修复） |
| 显示 `Unauthorized` / 连不上 | DSH 重启后旧登录 Cookie 失效：重新生成配对码扫一次；最新版本会自动重新登录 |
| 配对码无效/过期 | 5 分钟且一次性，重新生成 |
| `tailscale serve` 提示未启用 | 打开它给出的 `login.tailscale.com/f/serve?...` 链接启用，再重跑命令 |
| 端口 26001 被占用 | 换一个端口，并同步插件端口 / Serve 命令 / Cloudflare Service |
| cloudflared 下载很慢或失败 | 手动下载 `cloudflared 2026.8.2 win32-x64`，放到插件目录 `bin/cloudflared.exe`；SHA-256 必须是 `c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5` |
| 手机不在 tailnet | Tailscale App 登录**同一账号**并连接；或改用 Named Tunnel |
| 想验证链路 | 手机浏览器打开 `https://<地址>/healthz`：显示 `unauthorized` 属正常（说明 Serve→网关已通） |

---

## 九、安全说明

- 网关只监听 `127.0.0.1`；公网入口只能是 Tailscale Serve / Cloudflare Tunnel；
- 管理接口 `/dsh-remote-v2/api` 额外经过 DSH 的 `requestRejection` 准入，只供本机设置页调用；
- 配对：一次性 256-bit secret + 8 位码，5 分钟 TTL，单票错误次数上限 + 全局限流；
- 设备会话：7 天滑动，磁盘只存 SHA-256 哈希，可随时撤销；
- Cloudflare token、设备 Cookie、Authorization 等敏感头不会写入日志，也不会转发给 DSH；
- 建议：Tailscale 用 ACL 限制只有自己的设备可访问该节点；Cloudflare 可叠加 Access 邮箱/SSO 校验。

---

## 十、卸载

手动卸载（或让 AI 按此执行）：

1. 退出 DeepSeek Harness；
2. 编辑 `~/.dsh/profiles/desktop/package.json`：
   - 从 `dependencies` 删除 `dsh-remote-v2`
   - 从 `dsh.profile.bundles` 删除 `dsh-remote-v2`
3. 删除目录：
   - `~/.dsh/profiles/desktop/node_modules/dsh-remote-v2`
   - `~/.dsh/plugins/dsh-remote-v2`
4. （可选）清理入口：`& 'C:\Program Files\Tailscale\tailscale.exe' serve reset`
5. 重启 DSH。

一句话让 AI 卸载：

```text
帮我卸载 DSH 插件 dsh-remote-v2：从 ~/.dsh/profiles/desktop/package.json 的 dependencies 和 dsh.profile.bundles 中移除它，删除 node_modules/dsh-remote-v2 与 ~/.dsh/plugins/dsh-remote-v2，执行 tailscale serve reset，然后重启 DeepSeek Harness。操作前先备份 package.json。
```

---

## 十一、开发与测试

```powershell
node --test                    # 71 个单元/集成测试
node scripts/smoke.mjs         # 真 cloudflared + 配对 + 反代 E2E（需外网）
node scripts/validate-profile.mjs --profile desktop   # 需用 Electron 作为 Node 运行
```

目录结构：

```
core/   sidecar：config/log/cloudflared/tunnel/gateway/proxy/pairing/devices/control
lib/    DSH 插件：host 适配、控制客户端、launch broker、设置页、QR
docs/   开发契约（contracts.md）与本文档
test/   node --test 测试
```

---

## 十二、许可

MIT。第三方组件见 [NOTICE](../NOTICE)。
