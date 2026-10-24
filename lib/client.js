/**
 * dsh-remote-v2 — browser half (hand-written CJS factory).
 *
 * The DSH web page loads this file through the client module loader:
 *
 *   window.__ModuleLoader__.load({ id: 'dsh-remote-v2', factory: (require) => { ... } })
 *
 * The factory receives the platform module table (`react`, and whatever else
 * the manifest declares) and returns the client plugin object
 * `{ inject: ['slots','locale','connection'], apply(ctx) }`.
 *
 * It registers a 远程访问 section under `settings.section` and talks to the host
 * adapter exclusively through the same-origin management endpoint:
 *
 *   POST /dsh-remote-v2/api  { method, payload }  →  { ok, value } | { ok:false, error }
 *
 * On a remote (non-loopback) page the section never renders pairing material;
 * it only explains that management must happen on the computer.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-v2',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement

    /** Namespace for the client locale dictionary. */
    var NS = 'dsh-remote-v2'

    /** Loopback management endpoint mounted by lib/index.js. */
    var API_PATH = '/dsh-remote-v2/api'

    /** How often read-only state is polled. */
    var POLL_MS = 3000

    /** How often the pairing countdown ticks. */
    var TICK_MS = 1000

    /** Chinese-first UI dictionary (also registered with the locale service). */
    var zh = {
      nav: '远程访问',
      title: '远程访问',
      subtitle: '在手机上通过安全隧道访问当前 DSH。远程服务只监听本机，公网入口由 Cloudflare Tunnel 提供。',
      remoteOnlyTitle: '远程管理需在电脑端操作',
      remoteOnlyBody: '请在本机打开 DSH 设置页面，管理远程访问、配对和已授权设备。',
      loading: '正在读取远程访问状态…',
      status: '状态',
      running: '运行中',
      stopped: '已关闭',
      starting: '正在启动',
      reconnecting: '正在重连',
      errorState: '出错',
      idle: '未启动',
      transport: '传输方式',
      publicUrl: '公网地址',
      notAssigned: '未分配',
      reconnects: '重连次数',
      lastError: '最后错误',
      noError: '无',
      version: '版本',
      transportTitle: '传输配置',
      transportHint: 'Quick Tunnel 无需配置，地址在每次启动后变化；Named Tunnel 需要 Cloudflare token 和固定公网地址。',
      quick: 'Quick Tunnel（临时地址，免配置）',
      named: 'Named Tunnel（固定地址，需 token）',
      namedToken: 'Tunnel token',
      namedTokenPlaceholder: '粘贴 Cloudflare Tunnel token',
      gatewayPortLabel: '本地网关端口',
      gatewayPortHint: 'Named Tunnel 必须固定端口：在 Cloudflare 控制台把 Public Hostname 指向 http://127.0.0.1:<端口>。Quick Tunnel 可留空（自动分配）。',
      gatewayPortStatus: '本地端口',
      publicUrlLabel: '公网地址',
      publicUrlPlaceholder: 'https://remote.example.com',
      saveConfig: '保存配置',
      start: '启动远程访问',
      stop: '停止远程访问',
      configSaved: '配置已保存',
      startNotice: '远程访问已开启',
      stopNotice: '远程访问已关闭',
      pairingTitle: '设备配对',
      rotate: '生成新的配对码',
      refresh: '刷新配对码',
      pairActiveHint: '用手机扫描二维码，或访问链接后输入 8 位配对码。配对码一次性有效，过期后请重新生成。',
      pairConsumed: '设备已成功配对。',
      pairExpired: '配对码已过期。',
      pairNone: '尚未生成配对码。',
      pairNotReady: '配对链接尚未就绪，请先启动远程访问。',
      pairStoppedHint: '远程访问尚未开启，生成配对码前请先启动。',
      codeLabel: '配对码',
      linkLabel: '配对链接',
      copyLink: '复制链接',
      copied: '链接已复制',
      copyFailed: '复制失败，请手动选择链接复制',
      expiresIn: '剩余时间',
      devicesTitle: '已授权设备',
      devicesEmpty: '尚无已配对设备。',
      deviceUnnamed: '未命名设备',
      createdAt: '配对时间',
      lastSeen: '最近使用',
      revoke: '撤销',
      revokeAll: '全部撤销',
      confirmRevokeAll: '确定撤销全部已授权设备？撤销后这些设备需要重新配对。',
      diagnosticsTitle: '诊断',
      diagnosticsEmpty: '暂无诊断信息。',
      errorCode: '错误码',
      clearError: '关闭',
      footer: '远程服务仅监听本机；公网入口仅在启动后由 Cloudflare Tunnel 提供。',
      requestFailed: '操作失败，请稍后重试',
      networkError: '无法连接到 DSH 服务，请确认页面仍在本机打开',
      unsupported: '当前 DSH 版本不支持该操作',
    }

    /** English dictionary (same key set). */
    var en = {
      nav: 'Remote Access',
      title: 'Remote Access',
      subtitle: 'Access this DSH from your phone through a secure tunnel. The remote service only listens on this computer; the public entry is provided by a Cloudflare Tunnel.',
      remoteOnlyTitle: 'Manage remote access on the computer',
      remoteOnlyBody: 'Open the DSH settings page on the computer to manage remote access, pairing, and authorized devices.',
      loading: 'Reading remote access status…',
      status: 'Status',
      running: 'Running',
      stopped: 'Stopped',
      starting: 'Starting',
      reconnecting: 'Reconnecting',
      errorState: 'Error',
      idle: 'Not started',
      transport: 'Transport',
      publicUrl: 'Public URL',
      notAssigned: 'Not assigned',
      reconnects: 'Reconnects',
      lastError: 'Last error',
      noError: 'None',
      version: 'Version',
      transportTitle: 'Transport',
      transportHint: 'Quick Tunnel needs no configuration and gets a new URL each start; Named Tunnel needs a Cloudflare token and a stable public URL.',
      quick: 'Quick Tunnel (temporary URL)',
      named: 'Named Tunnel (stable URL, token required)',
      namedToken: 'Tunnel token',
      namedTokenPlaceholder: 'Paste the Cloudflare Tunnel token',
      gatewayPortLabel: 'Local gateway port',
      gatewayPortHint: 'A Named Tunnel needs a fixed port: point the Cloudflare Public Hostname at http://127.0.0.1:<port>. Leave empty for Quick Tunnel (random port).',
      gatewayPortStatus: 'Local port',
      publicUrlLabel: 'Public URL',
      publicUrlPlaceholder: 'https://remote.example.com',
      saveConfig: 'Save configuration',
      start: 'Start remote access',
      stop: 'Stop remote access',
      configSaved: 'Configuration saved',
      startNotice: 'Remote access started',
      stopNotice: 'Remote access stopped',
      pairingTitle: 'Pair a device',
      rotate: 'Generate new pairing code',
      refresh: 'Refresh pairing code',
      pairActiveHint: 'Scan the QR code with your phone, or open the link and enter the 8-character code. The code is single-use; generate a new one after it expires.',
      pairConsumed: 'Device paired successfully.',
      pairExpired: 'The pairing code expired.',
      pairNone: 'No pairing code yet.',
      pairNotReady: 'The pairing link is not ready yet. Start remote access first.',
      pairStoppedHint: 'Remote access is not running. Start it before generating a pairing code.',
      codeLabel: 'Pairing code',
      linkLabel: 'Pairing link',
      copyLink: 'Copy link',
      copied: 'Link copied',
      copyFailed: 'Copy failed; select the link and copy it manually',
      expiresIn: 'Expires in',
      devicesTitle: 'Authorized devices',
      devicesEmpty: 'No paired devices yet.',
      deviceUnnamed: 'Unnamed device',
      createdAt: 'Paired at',
      lastSeen: 'Last seen',
      revoke: 'Revoke',
      revokeAll: 'Revoke all',
      confirmRevokeAll: 'Revoke all authorized devices? They will need to pair again.',
      diagnosticsTitle: 'Diagnostics',
      diagnosticsEmpty: 'No diagnostics yet.',
      errorCode: 'Error code',
      clearError: 'Dismiss',
      footer: 'The remote service only listens on this computer; the public entry is provided by a Cloudflare Tunnel after you start it.',
      requestFailed: 'The operation failed. Please try again.',
      networkError: 'Cannot reach the DSH service. Make sure this page is still open on the computer.',
      unsupported: 'This DSH version does not support the operation',
    }

    /** Stable error codes mapped to readable (Chinese-first) copy. */
    var ERROR_TEXT = {
      'sidecar-unavailable': '远程服务尚未就绪，请稍后重试',
      'host-disposed': '远程访问插件已关闭',
      'control-unreachable': '无法连接远程服务进程，请重启 DSH 后重试',
      'control-timeout': '远程服务响应超时，请重试',
      'control-bad-response': '远程服务返回了意外的响应',
      'control-unreadable': '无法读取远程服务响应',
      'unknown-method': '不支持的远程操作',
      'invalid-payload': '请求参数无效',
      'invalid-transport': '传输方式无效',
      'named-token-required': 'Named 传输需要 Cloudflare Tunnel token',
      'public-url-required': 'Named 传输需要有效的 https 公网地址',
      'invalid-device-id': '缺少要撤销的设备 id',
      'invalid-config': '配置格式无效',
      'qr-text-required': '缺少二维码内容',
      'qr-text-too-long': '二维码内容过长',
      'qr-generation-failed': '二维码生成失败，请刷新配对码后重试',
      'body-too-large': '请求内容过大',
      'invalid-json': '请求格式无效',
      'invalid-body': '请求格式无效',
      'missing-method': '请求缺少操作名称',
      'method-not-allowed': '请求方式不正确',
      'content-type-required': '请求格式不正确',
      'network-error': '无法连接到 DSH 服务，请确认页面仍在本机打开',
      'bad-response': '服务返回了无法解析的响应',
      'request-failed': '操作失败，请稍后重试',
      'unsupported-platform': '当前平台暂不支持远程访问（MVP 仅支持 Windows x64）',
      'tunnel-start-failed': '隧道启动失败，请查看诊断信息',
    }

    /**
     * Build an Error carrying a stable code for UI mapping.
     * @param {string} code stable error code.
     * @param {string} message fallback message.
     * @returns {Error & { code: string }} coded error.
     */
    function apiError(code, message) {
      var error = new Error(message)
      error.code = code
      error.message = message
      return error
    }

    /**
     * Human-readable copy for any failure object.
     * @param {unknown} error failure.
     * @param {(key: string) => string} t translator.
     * @returns {string} readable copy.
     */
    function friendlyError(error, t) {
      var code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
      if (code !== '' && ERROR_TEXT[code] !== undefined) return ERROR_TEXT[code]
      if (error && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message
      return t('requestFailed')
    }

    /**
     * Create the management API caller bound to the current page.
     * All requests are same-origin relative paths; cookies ride along.
     * @returns {(method: string, payload?: unknown) => Promise<any>} API function.
     */
    function createApi() {
      return async function api(method, payload) {
        var response
        try {
          response = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ method: method, payload: payload }),
          })
        } catch (error) {
          throw apiError('network-error', '无法连接到 DSH 服务')
        }
        var envelope
        try {
          envelope = await response.json()
        } catch (error) {
          throw apiError('bad-response', '服务返回了无法解析的响应')
        }
        if (envelope && envelope.ok === true) return envelope.value
        var info = envelope && envelope.error && typeof envelope.error === 'object' ? envelope.error : {}
        throw apiError(
          typeof info.code === 'string' && info.code !== '' ? info.code : 'request-failed',
          typeof info.message === 'string' && info.message !== '' ? info.message : '管理请求失败',
        )
      }
    }

    /**
     * Register an effect with a fallback for hosts without `ctx.effect`.
     * @param {any} ctx client plugin context.
     * @param {() => any} callback effect body returning a disposer.
     * @param {string} label effect label.
     * @returns {void}
     */
    function addClientEffect(ctx, callback, label) {
      if (ctx && typeof ctx.effect === 'function') {
        try {
          ctx.effect(callback, label)
          return
        } catch (error) {
          // Fall through to the direct invocation below.
        }
      }
      try {
        callback()
      } catch (error) {
        // A missing service must never break the page.
      }
    }

    /**
     * Two-digit zero padding.
     * @param {number} value number.
     * @returns {string} `05`-style text.
     */
    function pad2(value) {
      return value < 10 ? '0' + String(value) : String(value)
    }

    /**
     * Format a countdown as `mm:ss`.
     * @param {number} milliseconds remaining milliseconds.
     * @returns {string} formatted countdown.
     */
    function formatRemaining(milliseconds) {
      var total = Math.max(0, Math.ceil(milliseconds / 1000))
      var minutes = Math.floor(total / 60)
      var seconds = total % 60
      return pad2(minutes) + ':' + pad2(seconds)
    }

    /**
     * Format a timestamp as local `YYYY-MM-DD HH:mm`.
     * @param {unknown} timestamp epoch milliseconds.
     * @returns {string} formatted timestamp or an em dash.
     */
    function formatTimestamp(timestamp) {
      if (typeof timestamp !== 'number' || !isFinite(timestamp)) return '—'
      var date = new Date(timestamp)
      return String(date.getFullYear()) + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
        ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    /**
     * Map a status phase to a localized label key.
     * @param {string} phase phase from the sidecar status document.
     * @returns {string} dictionary key.
     */
    function phaseKey(phase) {
      if (phase === 'ready') return 'running'
      if (phase === 'starting') return 'starting'
      if (phase === 'reconnecting') return 'reconnecting'
      if (phase === 'error') return 'errorState'
      return 'idle'
    }

    /**
     * Normalize a pairing status value from either `status.pairing` or the
     * `pairingStatus` method.
     * @param {unknown} pairingValue `pairingStatus` result.
     * @param {unknown} statusValue `status` result.
     * @returns {{ state: 'none'|'active'|'consumed'|'expired', code?: string, url?: string, expiresAt?: number, consumedAt?: number }} pairing state.
     */
    function normalizePairing(pairingValue, statusValue) {
      var source = pairingValue
      if ((source === null || source === undefined) && statusValue && typeof statusValue === 'object') {
        source = statusValue.pairing
      }
      if (!source || typeof source !== 'object') return { state: 'none' }
      var state = source.state
      if (state !== 'active' && state !== 'consumed' && state !== 'expired') state = 'none'
      return {
        state: state,
        code: typeof source.code === 'string' ? source.code : undefined,
        url: typeof source.url === 'string' ? source.url : undefined,
        expiresAt: typeof source.expiresAt === 'number' ? source.expiresAt : undefined,
        consumedAt: typeof source.consumedAt === 'number' ? source.consumedAt : undefined,
      }
    }

    /**
     * Extract a device array from the several shapes the control API may use.
     * @param {unknown} value `devices` result.
     * @returns {Array<Record<string, unknown>>} devices.
     */
    function deviceList(value) {
      var list = []
      if (Array.isArray(value)) list = value
      else if (value && typeof value === 'object' && Array.isArray(value.devices)) list = value.devices
      else if (value && typeof value === 'object' && Array.isArray(value.items)) list = value.items
      return list.filter((item) => item !== null && typeof item === 'object')
    }

    /**
     * Render one diagnostics entry as a single readable line.
     * @param {unknown} entry diagnostics entry.
     * @returns {string} readable line.
     */
    function diagnosticLine(entry) {
      if (typeof entry === 'string') return entry
      if (!entry || typeof entry !== 'object') {
        try {
          return String(entry)
        } catch (error) {
          return '—'
        }
      }
      var parts = []
      var time = entry.time || entry.ts || entry.timestamp || entry.at
      if (typeof time === 'number') parts.push(formatTimestamp(time))
      else if (typeof time === 'string' && time !== '') parts.push(time.slice(0, 19).replace('T', ' '))
      var level = entry.level || entry.severity
      if (typeof level === 'string') parts.push('[' + level + ']')
      var code = entry.code
      if (typeof code === 'string' && code !== '') parts.push('(' + code + ')')
      var message = entry.message || entry.msg || entry.error || entry.text || entry.event
      if (typeof message === 'string' && message !== '') {
        parts.push(message.length > 300 ? message.slice(0, 300) + '…' : message)
      } else {
        try {
          var json = JSON.stringify(entry)
          parts.push(json.length > 300 ? json.slice(0, 300) + '…' : json)
        } catch (error) {
          parts.push('—')
        }
      }
      // Keep a few structured fields (port, phase, error code …) if present.
      var extra = []
      Object.keys(entry).forEach(function (key) {
        if (key === 'time' || key === 'ts' || key === 'timestamp' || key === 'at' ||
          key === 'level' || key === 'severity' || key === 'message' || key === 'msg' ||
          key === 'code' || key === 'error' || key === 'text' || key === 'event') {
          return
        }
        var value = entry[key]
        if (value === undefined || value === null) return
        if (typeof value === 'object') {
          try { value = JSON.stringify(value) } catch (failure) { value = '[object]' }
        }
        var text = String(value)
        extra.push(key + '=' + (text.length > 120 ? text.slice(0, 120) + '…' : text))
      })
      if (extra.length > 0) {
        var suffix = extra.join(' ')
        parts.push(suffix.length > 300 ? suffix.slice(0, 300) + '…' : suffix)
      }
      return parts.join(' ')
    }

    /**
     * Extract the last 20 diagnostics lines.
     * @param {unknown} value `diagnostics` result.
     * @returns {string[]} readable lines.
     */
    function diagnosticLines(value) {
      var list = []
      if (Array.isArray(value)) list = value
      else if (value && typeof value === 'object' && Array.isArray(value.logs)) list = value.logs
      else if (value && typeof value === 'object' && Array.isArray(value.entries)) list = value.entries
      else if (value && typeof value === 'object' && Array.isArray(value.items)) list = value.items
      return list.slice(-20).map(diagnosticLine)
    }

    /**
     * Inline an SVG string as an image data URL (no raw-HTML injection).
     * @param {string} svg SVG markup.
     * @returns {string} data URL.
     */
    function svgDataUrl(svg) {
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    }

    /**
     * Copy text to the clipboard, tolerating browsers without the async API.
     * @param {string} text text to copy.
     * @returns {Promise<boolean>} true when copied.
     */
    async function copyText(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch (error) {
        // Fall through to the legacy path.
      }
      try {
        var area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', 'readonly')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        var copied = document.execCommand('copy')
        document.body.removeChild(area)
        return copied === true
      } catch (error) {
        return false
      }
    }

    /** Inline styles; no external stylesheet or ui-primitives dependency. */
    var UI = {
      section: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0', color: 'inherit', fontSize: '14px' },
      title: { margin: '0', fontSize: '20px', fontWeight: '600' },
      subtitle: { margin: '0', color: 'var(--dsw-alias-text-secondary, #6b7280)', lineHeight: '1.5' },
      card: { border: '1px solid var(--dsw-alias-border-color, rgba(127,127,127,0.25))', borderRadius: '10px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
      cardTitle: { fontSize: '15px', fontWeight: '600' },
      row: { display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' },
      rowLabel: { minWidth: '84px', color: 'var(--dsw-alias-text-secondary, #6b7280)' },
      rowValue: { wordBreak: 'break-all', flex: '1 1 auto' },
      muted: { color: 'var(--dsw-alias-text-secondary, #6b7280)', lineHeight: '1.5' },
      error: { border: '1px solid rgba(220, 38, 38, 0.5)', background: 'rgba(220, 38, 38, 0.08)', borderRadius: '8px', padding: '10px 12px', color: '#b91c1c', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      notice: { border: '1px solid rgba(22, 163, 74, 0.4)', background: 'rgba(22, 163, 74, 0.08)', borderRadius: '8px', padding: '10px 12px', color: '#15803d' },
      buttonRow: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      button: { appearance: 'none', border: '1px solid var(--dsw-alias-border-color, rgba(127,127,127,0.4))', background: 'transparent', color: 'inherit', borderRadius: '8px', padding: '7px 14px', fontSize: '13px', cursor: 'pointer', lineHeight: '1.4' },
      buttonPrimary: { background: 'var(--dsw-alias-accent-color, #2563eb)', borderColor: 'transparent', color: '#ffffff' },
      buttonDanger: { color: '#b91c1c', borderColor: 'rgba(220, 38, 38, 0.5)' },
      buttonDisabled: { opacity: '0.5', cursor: 'not-allowed' },
      field: { display: 'flex', flexDirection: 'column', gap: '6px' },
      label: { color: 'var(--dsw-alias-text-secondary, #6b7280)', fontSize: '13px' },
      input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-color, rgba(127,127,127,0.35))', borderRadius: '8px', padding: '8px 10px', background: 'transparent', color: 'inherit', fontSize: '13px' },
      select: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-color, rgba(127,127,127,0.35))', borderRadius: '8px', padding: '8px 10px', background: 'transparent', color: 'inherit', fontSize: '13px' },
      qrBox: { display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' },
      qrImage: { width: '180px', height: '180px', background: '#ffffff', borderRadius: '8px', padding: '4px', border: '1px solid var(--dsw-alias-border-color, rgba(127,127,127,0.25))' },
      qrSide: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '200px' },
      code: { fontSize: '26px', fontWeight: '700', letterSpacing: '4px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      link: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #6b7280)', wordBreak: 'break-all' },
      device: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', borderTop: '1px solid var(--dsw-alias-border-color, rgba(127,127,127,0.18))', paddingTop: '8px' },
      deviceMain: { flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: '2px' },
      deviceMeta: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #6b7280)' },
      diagnostics: { margin: '0', padding: '10px', borderRadius: '8px', background: 'rgba(127,127,127,0.08)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '11px', lineHeight: '1.6', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '220px', overflow: 'auto' },
      footer: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #6b7280)', lineHeight: '1.5' },
      codeTag: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12px' },
    }

    /**
     * Build a styled button element.
     * @param {string} label button label.
     * @param {() => void} onClick click handler.
     * @param {boolean} [primary] primary styling.
     * @param {boolean} [danger] danger styling.
     * @param {boolean} [disabled] disabled state.
     * @returns {any} React element.
     */
    function button(label, onClick, primary, danger, disabled) {
      var style = Object.assign({}, UI.button)
      if (primary) style = Object.assign(style, UI.buttonPrimary)
      if (danger) style = Object.assign(style, UI.buttonDanger)
      if (disabled) style = Object.assign(style, UI.buttonDisabled)
      return h('button', { type: 'button', style: style, disabled: disabled === true, onClick: onClick }, label)
    }

    /**
     * One labelled status row.
     * @param {string} label row label.
     * @param {any} value row value (string or element).
     * @returns {any} React element.
     */
    function row(label, value) {
      return h('div', { style: UI.row }, h('span', { style: UI.rowLabel }, label), h('span', { style: UI.rowValue }, value))
    }

    /**
     * The 远程访问 settings section component.
     * @param {any} props slot props plus `{ api, isLoopback }` injected by apply().
     * @returns {any} React element.
     */
    function Section(props) {
      var t = typeof props.t === 'function' ? props.t : function (key) { return zh[key] !== undefined ? zh[key] : key }
      var api = props.api
      var isLoopback = props.isLoopback !== false

      if (!isLoopback) {
        return h('div', { style: UI.section },
          h('h2', { style: UI.title }, t('nav')),
          h('div', { style: UI.card },
            h('div', { style: UI.cardTitle }, t('remoteOnlyTitle')),
            h('div', { style: UI.muted }, t('remoteOnlyBody')),
          ),
        )
      }

      var statusState = React.useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]
      var configState = React.useState(null)
      var config = configState[0]
      var setConfig = configState[1]
      var draftState = React.useState({ transport: 'quick', namedToken: '', publicUrl: '' })
      var draft = draftState[0]
      var setDraft = draftState[1]
      var gatewayPortState = React.useState(0)
      var gatewayPort = gatewayPortState[0]
      var setGatewayPort = gatewayPortState[1]
      var pairingState = React.useState({ state: 'none' })
      var pairing = pairingState[0]
      var setPairing = pairingState[1]
      var qrState = React.useState('')
      var qr = qrState[0]
      var setQr = qrState[1]
      var devicesState = React.useState([])
      var devices = devicesState[0]
      var setDevices = devicesState[1]
      var diagnosticsState = React.useState([])
      var diagnostics = diagnosticsState[0]
      var setDiagnostics = diagnosticsState[1]
      var busyState = React.useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var errorState = React.useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var noticeState = React.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var nowState = React.useState(Date.now())
      var now = nowState[0]
      var setNow = nowState[1]
      var expiredHandledRef = React.useRef('')

      /**
       * Translate a dictionary key.
       * @param {string} key key.
       * @returns {string} text.
       */
      function tr(key) {
        return t(key)
      }

      /**
       * Run one user action with busy state and error mapping.
       * @param {string} label busy marker.
       * @param {() => Promise<void>} action action body.
       * @returns {Promise<void>} resolves when done.
       */
      async function run(label, action) {
        setBusy(label)
        setError(null)
        setNotice('')
        try {
          await action()
        } catch (failure) {
          setError({ code: failure && failure.code, message: friendlyError(failure, tr) })
        } finally {
          setBusy('')
        }
      }

      /**
       * Read-only status + pairing poll (silent on transient failure).
       * @returns {Promise<void>} resolves when the poll finished.
       */
      async function pollStatus() {
        try {
          var next = await api('status')
          setStatus(next)
        } catch (failure) {
          // Read-only polling never surfaces transient errors.
        }
        try {
          var nextPairing = await api('pairingStatus')
          setPairing(normalizePairing(nextPairing, undefined))
        } catch (failure) {
          // Read-only polling never surfaces transient errors.
        }
      }

      /**
       * Initial load: status, config, pairing, devices, diagnostics.
       * @returns {Promise<void>} resolves when finished.
       */
      async function loadInitial() {
        try {
          var nextStatus = await api('status')
          setStatus(nextStatus)
          setPairing(normalizePairing(undefined, nextStatus))
        } catch (failure) {
          setError({ code: failure && failure.code, message: friendlyError(failure, tr) })
        }
        try {
          var nextConfig = await api('configGet')
          var normalized = nextConfig && typeof nextConfig === 'object' ? nextConfig : {}
          setConfig(normalized)
          setDraft({
            transport: normalized.transport === 'named' ? 'named' : 'quick',
            namedToken: typeof normalized.namedToken === 'string' ? normalized.namedToken : '',
            publicUrl: typeof normalized.publicUrl === 'string' ? normalized.publicUrl : '',
          })
          setGatewayPort(typeof normalized.gatewayPort === 'number' ? normalized.gatewayPort : 0)
        } catch (failure) {
          // Defaults already cover an unavailable config document.
        }
        try {
          setPairing(normalizePairing(await api('pairingStatus'), undefined))
        } catch (failure) {
          // Keep the status-derived pairing document.
        }
        try {
          setDevices(deviceList(await api('devices')))
        } catch (failure) {
          // Device list failures are non-fatal.
        }
        try {
          setDiagnostics(diagnosticLines(await api('diagnostics')))
        } catch (failure) {
          // Diagnostics failures are non-fatal.
        }
      }

      /**
       * Reload pairing + devices + diagnostics (after an action changed them).
       * @returns {Promise<void>} resolves when finished.
       */
      async function reloadAfterAction() {
        try {
          setPairing(normalizePairing(await api('pairingStatus'), undefined))
        } catch (failure) {
          // Non-fatal.
        }
        try {
          setDevices(deviceList(await api('devices')))
        } catch (failure) {
          // Non-fatal.
        }
        try {
          setDiagnostics(diagnosticLines(await api('diagnostics')))
        } catch (failure) {
          // Non-fatal.
        }
        try {
          setStatus(await api('status'))
        } catch (failure) {
          // Non-fatal.
        }
      }

      React.useEffect(function () {
        void loadInitial()
        var pollTimer = setInterval(function () { void pollStatus() }, POLL_MS)
        var tickTimer = setInterval(function () { setNow(Date.now()) }, TICK_MS)
        return function () {
          clearInterval(pollTimer)
          clearInterval(tickTimer)
        }
      }, [])

      // Fetch the QR SVG locally through the host API whenever the pairing URL
      // changes (the secret stays in page state; the QR is never rendered from
      // raw HTML).
      React.useEffect(function () {
        if (pairing.state !== 'active' || typeof pairing.url !== 'string' || pairing.url === '') {
          setQr('')
          return undefined
        }
        var cancelled = false
        void (async function () {
          try {
            var svg = await api('qrSvg', { text: pairing.url, label: '配对二维码' })
            if (!cancelled) setQr(typeof svg === 'string' ? svg : svg && typeof svg.svg === 'string' ? svg.svg : '')
          } catch (failure) {
            if (!cancelled) setQr('')
          }
        })()
        return function () { cancelled = true }
      }, [pairing.state === 'active' ? pairing.url : ''])

      // When the countdown reaches zero, refresh the authoritative pairing
      // state once; never generate a ticket implicitly.
      React.useEffect(function () {
        if (
          pairing.state !== 'active' ||
          typeof pairing.expiresAt !== 'number' ||
          pairing.expiresAt > now ||
          expiredHandledRef.current === pairing.url
        ) {
          return
        }
        expiredHandledRef.current = pairing.url || ''
        void (async function () {
          try {
            setPairing(normalizePairing(await api('pairingStatus'), undefined))
          } catch (failure) {
            // The next poll will retry.
          }
        })()
      }, [now, pairing.state, pairing.expiresAt, pairing.url])

      var running = status !== null && status !== undefined && status.running === true
      var phase = status && typeof status.phase === 'string' ? status.phase : 'idle'
      var activeTransport = status && typeof status.transport === 'string' ? status.transport : draft.transport
      var publicUrl = status && typeof status.publicUrl === 'string' ? status.publicUrl : ''
      var reconnects = status && status.edge && typeof status.edge.reconnects === 'number' ? status.edge.reconnects : 0
      var lastError = ''
      if (status && typeof status.lastError === 'string' && status.lastError !== '') lastError = status.lastError
      else if (status && status.edge && typeof status.edge.lastError === 'string') lastError = status.edge.lastError
      var version = status && typeof status.version === 'string' ? status.version : ''

      var remaining = pairing.state === 'active' && typeof pairing.expiresAt === 'number'
        ? formatRemaining(pairing.expiresAt - now)
        : ''

      /**
       * Start remote access with the current draft configuration.
       * @returns {Promise<void>} resolves when done.
       */
      function onStart() {
        return run('start', async function () {
          await api('start', {
            transport: draft.transport,
            namedToken: draft.namedToken,
            publicUrl: draft.publicUrl,
            gatewayPort: gatewayPort,
          })
          try {
            await api('configSet', {
              config: {
                transport: draft.transport,
                namedToken: draft.namedToken,
                publicUrl: draft.publicUrl,
                gatewayPort: gatewayPort,
                autoStart: false,
              },
            })
            setNotice(tr('startNotice'))
          } catch (failure) {
            setNotice(tr('startNotice'))
          }
          await reloadAfterAction()
        })
      }

      /**
       * Stop remote access.
       * @returns {Promise<void>} resolves when done.
       */
      function onStop() {
        return run('stop', async function () {
          await api('stop')
          setNotice(tr('stopNotice'))
          await reloadAfterAction()
        })
      }

      /**
       * Persist the draft configuration.
       * @returns {Promise<void>} resolves when done.
       */
      function onSaveConfig() {
        return run('save', async function () {
          await api('configSet', {
            config: {
              transport: draft.transport,
              namedToken: draft.namedToken,
              publicUrl: draft.publicUrl,
              gatewayPort: gatewayPort,
              autoStart: false,
            },
          })
          setConfig({ transport: draft.transport })
          setNotice(tr('configSaved'))
        })
      }

      /**
       * Rotate the one-time pairing ticket.
       * @returns {Promise<void>} resolves when done.
       */
      function onRotate() {
        return run('rotate', async function () {
          await api('pairingRotate')
          expiredHandledRef.current = ''
          await reloadAfterAction()
          setNotice(tr('pairActiveHint'))
        })
      }

      /**
       * Revoke one device.
       * @param {string} id device id.
       * @returns {Promise<void>} resolves when done.
       */
      function onRevoke(id) {
        return run('revoke:' + id, async function () {
          await api('revoke', { id: id })
          await reloadAfterAction()
        })
      }

      /**
       * Revoke every device after an explicit confirmation.
       * @returns {Promise<void>} resolves when done.
       */
      function onRevokeAll() {
        var confirmed = true
        try {
          confirmed = typeof window.confirm === 'function' ? window.confirm(tr('confirmRevokeAll')) : true
        } catch (failure) {
          confirmed = true
        }
        if (!confirmed) return Promise.resolve()
        return run('revokeAll', async function () {
          await api('revokeAll')
          await reloadAfterAction()
        })
      }

      /**
       * Copy the active pairing link.
       * @returns {Promise<void>} resolves when done.
       */
      async function onCopyLink() {
        if (typeof pairing.url !== 'string' || pairing.url === '') return
        var copied = await copyText(pairing.url)
        setNotice(copied ? tr('copied') : tr('copyFailed'))
      }

      var children = [
        h('h2', { style: UI.title, key: 'title' }, tr('title')),
        h('p', { style: UI.subtitle, key: 'subtitle' }, tr('subtitle')),
      ]

      if (error !== null && error !== undefined) {
        children.push(h('div', { style: UI.error, key: 'error' },
          h('span', null, '⚠ ' + error.message),
          typeof error.code === 'string' && error.code !== ''
            ? h('span', { style: UI.codeTag }, '(' + tr('errorCode') + ': ' + error.code + ')')
            : null,
          button(tr('clearError'), function () { setError(null) }),
        ))
      }
      if (notice !== '') {
        children.push(h('div', { style: UI.notice, key: 'notice' }, notice))
      }
      if (status === null || status === undefined) {
        children.push(h('p', { style: UI.muted, key: 'loading' }, tr('loading')))
      }

      // Status card.
      children.push(h('div', { style: UI.card, key: 'status' },
        h('div', { style: UI.cardTitle }, tr('status')),
        row(tr('status'), running ? tr(phaseKey(phase)) : tr('stopped')),
        row(tr('transport'), activeTransport === 'named' ? 'Named Tunnel' : 'Quick Tunnel'),
        status && typeof status.gatewayPort === 'number' && status.gatewayPort > 0
          ? row(tr('gatewayPortStatus'), String(status.gatewayPort))
          : null,
        row(tr('publicUrl'), publicUrl !== ''
          ? h('a', { href: publicUrl, target: '_blank', rel: 'noreferrer noopener', style: { color: 'inherit' } }, publicUrl)
          : tr('notAssigned')),
        row(tr('reconnects'), String(reconnects)),
        row(tr('lastError'), lastError !== '' ? lastError : tr('noError')),
        version !== '' ? row(tr('version'), version) : null,
      ))

      // Transport configuration card.
      var transportChildren = [
        h('div', { style: UI.cardTitle, key: 'header' }, tr('transportTitle')),
        h('div', { style: UI.muted, key: 'hint' }, tr('transportHint')),
        h('div', { style: UI.field, key: 'field' },
          h('label', { style: UI.label }, tr('transport')),
          h('select', {
            style: UI.select,
            value: draft.transport,
            disabled: busy !== '',
            onChange: function (event) {
              var nextTransport = event.target.value
              if (nextTransport === 'named' && gatewayPort === 0) setGatewayPort(26001)
              setDraft({ transport: nextTransport, namedToken: draft.namedToken, publicUrl: draft.publicUrl })
            },
          },
            h('option', { value: 'quick' }, tr('quick')),
            h('option', { value: 'named' }, tr('named')),
          ),
        ),
      ]
      if (draft.transport === 'named') {
        transportChildren.push(h('div', { style: UI.field, key: 'token' },
          h('label', { style: UI.label }, tr('namedToken')),
          h('input', {
            style: UI.input,
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: tr('namedTokenPlaceholder'),
            value: draft.namedToken,
            disabled: busy !== '',
            onChange: function (event) {
              setDraft({ transport: draft.transport, namedToken: event.target.value, publicUrl: draft.publicUrl })
            },
          }),
        ))
        transportChildren.push(h('div', { style: UI.field, key: 'publicUrl' },
          h('label', { style: UI.label }, tr('publicUrlLabel')),
          h('input', {
            style: UI.input,
            type: 'url',
            placeholder: tr('publicUrlPlaceholder'),
            value: draft.publicUrl,
            disabled: busy !== '',
            onChange: function (event) {
              setDraft({ transport: draft.transport, namedToken: draft.namedToken, publicUrl: event.target.value })
            },
          }),
        ))
        transportChildren.push(h('div', { style: UI.field, key: 'gatewayPort' },
          h('label', { style: UI.label }, tr('gatewayPortLabel')),
          h('input', {
            style: UI.input,
            type: 'number',
            min: 1024,
            max: 65535,
            step: 1,
            placeholder: '26001',
            value: gatewayPort === 0 ? '' : String(gatewayPort),
            disabled: busy !== '',
            onChange: function (event) {
              var parsed = Number(event.target.value)
              setGatewayPort(Number.isInteger(parsed) && parsed > 0 ? parsed : 0)
            },
          }),
          h('div', { style: UI.muted }, tr('gatewayPortHint')),
        ))
      }
      transportChildren.push(h('div', { style: UI.buttonRow, key: 'buttons' },
        button(tr('saveConfig'), onSaveConfig, false, false, busy !== ''),
        running
          ? button(tr('stop'), onStop, false, true, busy !== '')
          : button(tr('start'), onStart, true, false, busy !== ''),
      ))
      children.push(h('div', { style: UI.card, key: 'transport' }, transportChildren))

      // Pairing card.
      var pairingChildren = [h('div', { style: UI.cardTitle, key: 'header' }, tr('pairingTitle'))]
      if (pairing.state === 'active') {
        pairingChildren.push(h('div', { style: UI.muted, key: 'hint' }, tr('pairActiveHint')))
        pairingChildren.push(h('div', { style: UI.qrBox, key: 'qrbox' },
          qr !== ''
            ? h('img', { src: svgDataUrl(qr), alt: '配对二维码', style: UI.qrImage })
            : h('div', { style: UI.muted }, typeof pairing.url === 'string' && pairing.url !== '' ? tr('loading') : tr('pairNotReady')),
          h('div', { style: UI.qrSide },
            h('div', { style: UI.label }, tr('codeLabel')),
            h('div', { style: UI.code }, typeof pairing.code === 'string' ? pairing.code : '—'),
            h('div', { style: UI.label }, tr('expiresIn') + ': ' + remaining),
            typeof pairing.url === 'string' && pairing.url !== ''
              ? h('div', { style: UI.link }, pairing.url)
              : null,
            h('div', { style: UI.buttonRow },
              button(tr('copyLink'), function () { void onCopyLink() }, false, false, busy !== ''),
              button(tr('rotate'), onRotate, false, false, busy !== ''),
            ),
          ),
        ))
        if (!running) {
          pairingChildren.push(h('div', { style: UI.muted, key: 'stopped' }, tr('pairStoppedHint')))
        }
      } else {
        pairingChildren.push(h('div', { style: UI.muted, key: 'state' },
          pairing.state === 'consumed' ? tr('pairConsumed') : pairing.state === 'expired' ? tr('pairExpired') : tr('pairNone'),
        ))
        pairingChildren.push(h('div', { style: UI.buttonRow, key: 'buttons' },
          button(pairing.state === 'active' ? tr('refresh') : tr('rotate'), onRotate, true, false, busy !== ''),
        ))
      }
      children.push(h('div', { style: UI.card, key: 'pairing' }, pairingChildren))

      // Devices card.
      var deviceChildren = [h('div', { style: UI.cardTitle, key: 'header' }, tr('devicesTitle'))]
      if (devices.length === 0) {
        deviceChildren.push(h('div', { style: UI.muted, key: 'empty' }, tr('devicesEmpty')))
      } else {
        devices.forEach(function (device, index) {
          var id = typeof device.id === 'string' ? device.id : ''
          var name = typeof device.name === 'string' && device.name !== '' ? device.name : tr('deviceUnnamed')
          deviceChildren.push(h('div', { style: UI.device, key: 'device:' + (id !== '' ? id : String(index)) },
            h('div', { style: UI.deviceMain },
              h('span', null, name),
              h('span', { style: UI.deviceMeta }, tr('createdAt') + ': ' + formatTimestamp(device.createdAt) + ' · ' + tr('lastSeen') + ': ' + formatTimestamp(device.lastSeen)),
            ),
            button(tr('revoke'), function () { void onRevoke(id) }, false, true, busy !== '' || id === ''),
          ))
        })
        deviceChildren.push(h('div', { style: UI.buttonRow, key: 'buttons' },
          button(tr('revokeAll'), function () { void onRevokeAll() }, false, true, busy !== ''),
        ))
      }
      children.push(h('div', { style: UI.card, key: 'devices' }, deviceChildren))

      // Diagnostics card.
      var diagnosticsChildren = [h('div', { style: UI.cardTitle, key: 'header' }, tr('diagnosticsTitle'))]
      if (diagnostics.length === 0) {
        diagnosticsChildren.push(h('div', { style: UI.muted, key: 'empty' }, tr('diagnosticsEmpty')))
      } else {
        diagnosticsChildren.push(h('pre', { style: UI.diagnostics, key: 'logs' }, diagnostics.join('\n')))
      }
      children.push(h('div', { style: UI.card, key: 'diagnostics' }, diagnosticsChildren))

      children.push(h('div', { style: UI.footer, key: 'footer' }, tr('footer')))

      return h('div', { style: UI.section }, children)
    }

    /**
     * Mount every browser surface (locale dictionary + settings section).
     * @param {any} ctx the browser plugin context.
     * @returns {void}
     */
    function apply(ctx) {
      addClientEffect(ctx, function () {
        if (!ctx || !ctx.locale || typeof ctx.locale.register !== 'function') return function () {}
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'dsh-remote-v2: locale')

      var connection = ctx ? ctx.connection : undefined
      var isLoopback = !(connection && connection.isLoopback === false)
      var slots = ctx ? ctx.slots : undefined
      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        slots.inject('settings.section', function () {
          return slots.register({
            name: 'settings.section',
            id: 'remote-access-v2',
            order: 2,
            label: function () { return zh.nav },
            locale: NS,
            inject: function () {
              return { api: createApi(), isLoopback: isLoopback }
            },
          }, Section)
        })
      }
    }

    module.exports.inject = ['slots', 'locale', 'connection']
    module.exports.apply = apply
    return module.exports
  },
});
