# dsh-remote-v2

Remote access for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), rebuilt for **isolation and stability**:

- **Sidecar process** — the tunnel + authenticated gateway run in their own Node process, so a tunnel restart or crash never takes DSH down and sidecar updates do not require restarting the app.
- **Pluggable transport** — Cloudflare Quick Tunnel (zero-config) or a Named Tunnel with your own stable hostname.
- **One-time pairing** — 256-bit QR secret plus an 8-character manual code, single use, 5-minute TTL, per-ticket attempt cap and global rate limit.
- **Device sessions** — 7-day sliding sessions, revocable individually or all at once, only SHA-256 hashes persisted.
- **Loopback gateway** — binds `127.0.0.1` only, exact Host/Origin policy, decode-safe deny of the management plane, hop-by-hop/edge headers stripped before reaching DSH.
- **No build step, no runtime npm dependencies** — plain ESM JavaScript; the QR generator is vendored.

> Status: **v0.1.0 MVP**. Quick/Named tunnel, pairing, devices, settings UI and diagnostics are implemented; Tailscale/frp transports and E2E chaos tests are on the roadmap.

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
