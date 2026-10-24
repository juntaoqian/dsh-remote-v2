# dsh-remote-v2

Remote access for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), rebuilt for **isolation and stability**:

- **Sidecar process** — the tunnel + authenticated gateway run in their own Node process, so a tunnel restart or crash never takes DSH down and sidecar updates do not require restarting the app.
- **Pluggable transport** — Cloudflare Quick Tunnel (zero-config), a Named Tunnel with your own stable hostname, or **Tailscale Serve** (tailnet-only).
- **One-time pairing** — 256-bit QR secret plus an 8-character manual code, single use, 5-minute TTL, per-ticket attempt cap and global rate limit.
- **Device sessions** — 7-day sliding sessions, revocable individually or all at once, only SHA-256 hashes persisted.
- **Loopback gateway** — binds `127.0.0.1` only, exact Host/Origin policy, decode-safe deny of the management plane, hop-by-hop/edge headers stripped before reaching DSH.
- **No build step, no runtime npm dependencies** — plain ESM JavaScript; the QR generator is vendored.

> Status: **v0.1.0** — Quick / Named / Tailscale transports, pairing, devices, settings UI and diagnostics are implemented.
>
> 📖 **中文使用指南：[docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md)** — 安装/配对/Tailscale/Named/Quick Tunnel/常见问题，含「一句话让 AI 安装」提示词。

## Architecture

```
Phone browser / PWA
        │ HTTPS
        ▼
Transport (Cloudflare Quick Tunnel / Named Tunnel)
        ▼
Remote Core (sidecar, own process)
  ├─ tunnel manager (ready via metrics /ready, backoff reconnect)
  ├─ authenticated gateway (/pair, /pair/claim, reverse proxy HTTP+WS)
  ├─ pairing tickets + device sessions
  └─ control API (loopback + Bearer token)
        ▲
        │ loopback control API
DSH plugin (lib/index.js, thin adapter)
  └─ settings section "远程访问" (lib/client.js)
        ▼
DSH Web Server (127.0.0.1)
```

## Requirements

- DSH Desktop / Web `>= 0.2.1-rc.2` (bundles `connection` + `webServer` services).
- Windows x64 (MVP): `cloudflared` is auto-downloaded (pinned version + SHA-256) on first start; macOS/Linux support is planned.
- No extra Node runtime: the sidecar is launched with DSH's own Electron-as-Node runtime.

> **Network note (important):** Cloudflare Quick Tunnel uses `*.trycloudflare.com`.
> On some networks (notably parts of mainland China) that hostname does not
> resolve, so the public URL is unreachable even though `cloudflared` reports
> ready. For stable/production use prefer the **Named Tunnel** transport with
> your own domain (fixed hostname), or put the Quick Tunnel behind a working
> proxy. The loopback path (gateway, pairing, proxy) is unaffected.


## Install

```powershell
# from this repository
node scripts/install.mjs --profile desktop
# then fully quit and reopen DeepSeek Harness
```

See `docs/contracts.md` for module and API contracts.

## Usage

1. Open **设置 → 远程访问** (loopback only).
2. Choose a transport:
   - **Quick Tunnel** — zero config; URL changes on every start.
   - **Named Tunnel** — paste a Cloudflare Tunnel token and the public hostname you configured.
3. Click **开启**, wait until the status shows **ready** and a public URL.
4. Click **生成配对码**, scan the QR with your phone (or type the 8-character code).
5. Manage/revoke paired devices in the same page; stop remote access with **关闭**.

## Named Tunnel (stable URL) — token and hostname setup

A Named Tunnel keeps the same public hostname across restarts. It needs a domain
whose nameservers point at Cloudflare (the free plan is enough) and a fixed local
port, because the Cloudflare **Public Hostname** is configured to forward to
`http://127.0.0.1:<gatewayPort>`.

1. **Create the tunnel** — Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** → connector **Cloudflared** → name it (e.g. `dsh-remote`) → Save.
2. **Copy the token** — the connector-install page shows a command like
   `cloudflared service install eyJhIjoi...`. The long string after `install` **is the token**.
   CLI alternative: `cloudflared tunnel token dsh-remote` (after `cloudflared tunnel login` and `cloudflared tunnel create`).
3. **Add a Public Hostname** — tunnel → **Public Hostname → Add**:
   - Subdomain: `dsh`, Domain: `example.com`
   - Service: **HTTP**, URL: `127.0.0.1:26001` (must equal the plugin's local gateway port)
   - Save (DNS is created automatically).
4. **Configure the plugin** — 设置 → 远程访问:
   - 传输方式: **Named Tunnel**
   - Tunnel token: paste the token
   - 公网地址: `https://dsh.example.com`
   - 本地网关端口: `26001` (same as step 3)
   - 保存配置 → 开启.
5. Optional defense in depth: put **Cloudflare Access** in front of the hostname (email/SSO); the plugin's own pairing still applies on top.

> The token is a machine credential for the tunnel (tunnel id + secret). Treat it
> like a password: it is stored only in the plugin state directory
> (`~/.dsh/plugins/dsh-remote-v2/config.json`, mode 0600), never logged. Delete
> and recreate the tunnel to rotate it.

## Tailscale (tailnet-only, no public exposure)

If both the computer and the phone are in the same Tailscale tailnet, `tailscale
serve` can terminate HTTPS and forward to the plugin gateway. Nothing is exposed
to the public internet (use `tailscale funnel` instead if you want that), and
Tailscale ACLs still apply.

1. **Get the machine DNS name**
   ```powershell
   & 'C:\Program Files\Tailscale\tailscale.exe' status --json |
     ConvertFrom-Json | ForEach-Object { $_.Self.DNSName.TrimEnd('.') }
   # e.g. cxqjt.tail7cbe8.ts.net
   ```
2. **Enable Serve once** (tailnet owner): run
   ```powershell
   & 'C:\Program Files\Tailscale\tailscale.exe' serve --bg 26001
   ```
   If Serve is not enabled yet, the command prints a
   `https://login.tailscale.com/f/serve?node=...` link — open it and enable Serve
   for the tailnet. Re-run the command afterwards.
3. **Configure the plugin** — 设置 → 远程访问:
   - 传输方式: **Tailscale（tailscale serve）**
   - 公网地址: `https://cxqjt.tail7cbe8.ts.net`
   - 本地网关端口: `26001` (same port as step 2)
   - 保存配置 → 开启.
4. **Open from the phone** (must be in the tailnet): scan the pairing QR, or open
   `https://cxqjt.tail7cbe8.ts.net/pair` and type the 8-character code.

`tailscale serve --bg 26001` persists in tailscaled's state and keeps forwarding
`https://<dns-name>/` → `http://127.0.0.1:26001`. The plugin gateway still checks
the exact Host (`cxqjt.tail7cbe8.ts.net`) and requires device pairing, so a tailnet
peer that has not paired gets 401. To stop serving: stop remote access in the
plugin and run `tailscale serve reset`.



## Security model

- Public entry is CLOSED (503) until the tunnel reports a validated origin; stop clears the origin before killing the tunnel.
- Every proxied HTTP/WS request is authenticated by a device-session cookie; the management prefix (`/dsh-remote-v2`) is denied publicly (percent-decoding safe).
- Pairing page allows only a one-time secret/code claim, sets `HttpOnly; SameSite=Lax` cookies, and has a strict CSP.
- Only device-token hashes are persisted; no standing pairing code is stored in plaintext (unlike v1).
- The gateway rewrites `Host`/`Origin` to the loopback DSH server and strips `authorization`, `cf-*`, `x-forwarded-*`, `forwarded` and the device cookie before forwarding.

A paired device has the same power as a local DSH browser (tool execution included) — this is the product by design. Keep pairing codes private and revoke devices you no longer use.

## Development

```powershell
node --test test/
```

## License

MIT. See `LICENSE` and third-party notices in `NOTICE`.
