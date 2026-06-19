export function fmtDate(iso) {
  if (!iso) return '<span class="muted">—</span>'
  const d = new Date(iso)
  return `<span title="${iso}">${d.toLocaleDateString()} ${d.toLocaleTimeString()}</span>`
}

export function adminHTML(tokens, settings, adminToken) {
  const active = tokens.filter(t => !t.revokedAt)
  const revoked = tokens.filter(t => t.revokedAt)
  const skipDebug = !!settings.skipDebugPackages

  const rows = tokens.map(t => {
    const isActive = !t.revokedAt
    const isDebug = t.packageName?.endsWith('.debug')
    const badge = isActive
      ? '<span class="badge active">Active</span>'
      : '<span class="badge revoked">Revoked</span>'
    const debugTag = isDebug ? ' <span class="badge debug">debug</span>' : ''
    const action = isActive
      ? `<button class="btn-revoke" onclick="revoke('${t.hash}')">Revoke</button>`
      : '<span class="muted">—</span>'
    return `
      <tr class="${isActive ? '' : 'row-revoked'}${isDebug && skipDebug ? ' row-skipped' : ''}">
        <td class="hash" title="${t.hash}">${t.hash.slice(0, 12)}…</td>
        <td class="pkg">${t.packageName ? `<span title="${t.packageName}">${t.packageName}${debugTag}</span>` : '<span class="muted">—</span>'}</td>
        <td class="hits">${t.hitCount > 0 ? `<span class="hit-count">${t.hitCount.toLocaleString()}</span>` : '<span class="muted">0</span>'}</td>
        <td>${fmtDate(t.createdAt)}</td>
        <td>${fmtDate(t.lastSeenAt)}</td>
        <td>${badge}</td>
        <td>${action}</td>
      </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Relay Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #cbd5e1; min-height: 100vh; }
    header { background: #1e293b; border-bottom: 1px solid #334155; padding: 18px 32px; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 1.1rem; font-weight: 600; color: #f1f5f9; }
    header .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 6px #22c55e; }
    main { padding: 32px; max-width: 1200px; margin: 0 auto; }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 20px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 20px 24px; }
    .card .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin-bottom: 8px; }
    .card .value { font-size: 2rem; font-weight: 700; color: #f1f5f9; }
    .card.active-card .value { color: #22c55e; }
    .card.revoked-card .value { color: #f87171; }
    .settings-bar { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 16px 24px; margin-bottom: 32px; display: flex; align-items: center; justify-content: space-between; }
    .settings-bar .setting-label { font-size: 0.875rem; color: #e2e8f0; }
    .settings-bar .setting-desc { font-size: 0.75rem; color: #64748b; margin-top: 2px; }
    .toggle-wrap { display: flex; align-items: center; gap: 10px; }
    .toggle { position: relative; width: 44px; height: 24px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; inset: 0; background: #334155; border-radius: 24px; cursor: pointer; transition: background 0.2s; }
    .slider::before { content: ''; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; background: white; border-radius: 50%; transition: transform 0.2s; }
    input:checked + .slider { background: #f59e0b; }
    input:checked + .slider::before { transform: translateX(20px); }
    .toggle-status { font-size: 0.8rem; color: #94a3b8; min-width: 28px; }
    .section-title { font-size: 0.85rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 14px; }
    .table-wrap { background: #1e293b; border: 1px solid #334155; border-radius: 10px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    th { background: #0f172a; padding: 12px 16px; text-align: left; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: #475569; font-weight: 600; border-bottom: 1px solid #334155; }
    td { padding: 12px 16px; border-bottom: 1px solid #1e293b; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #243044; }
    .row-revoked td { opacity: 0.5; }
    .row-skipped td { opacity: 0.4; background: repeating-linear-gradient(45deg, transparent, transparent 4px, #1a1a0a 4px, #1a1a0a 8px); }
    .hash { font-family: 'Courier New', monospace; font-size: 0.8rem; color: #94a3b8; }
    .pkg { font-size: 0.8rem; color: #94a3b8; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; }
    .badge.active { background: #14532d; color: #4ade80; }
    .badge.revoked { background: #2d1515; color: #f87171; }
    .badge.debug { background: #451a03; color: #fb923c; margin-left: 4px; padding: 2px 7px; font-size: 0.7rem; }
    .btn-revoke { background: #7f1d1d; color: #fca5a5; border: none; border-radius: 6px; padding: 5px 12px; font-size: 0.8rem; cursor: pointer; transition: background 0.15s; }
    .btn-revoke:hover { background: #991b1b; }
    .hits { text-align: right; width: 80px; }
    .hit-count { font-variant-numeric: tabular-nums; font-weight: 600; color: #38bdf8; }
    .muted { color: #475569; }
    .empty { text-align: center; padding: 48px; color: #475569; }
    #toast { position: fixed; bottom: 24px; right: 24px; background: #166534; color: #bbf7d0; padding: 12px 20px; border-radius: 8px; font-size: 0.875rem; display: none; }
  </style>
</head>
<body>
  <header>
    <div class="dot"></div>
    <h1>Notification Relay — Admin</h1>
  </header>
  <main>
    <div class="stats">
      <div class="card active-card">
        <div class="label">Active Devices</div>
        <div class="value">${active.length}</div>
      </div>
      <div class="card">
        <div class="label">Total Registered</div>
        <div class="value">${tokens.length}</div>
      </div>
      <div class="card revoked-card">
        <div class="label">Revoked</div>
        <div class="value">${revoked.length}</div>
      </div>
    </div>

    <div class="settings-bar">
      <div>
        <div class="setting-label">Skip .debug packages</div>
        <div class="setting-desc">When enabled, alerts from tokens registered with a <code>.debug</code> package name are received but not forwarded to FCM.</div>
      </div>
      <div class="toggle-wrap">
        <span class="toggle-status" id="toggle-status">${skipDebug ? 'ON' : 'OFF'}</span>
        <label class="toggle">
          <input type="checkbox" id="skip-debug-toggle" ${skipDebug ? 'checked' : ''} onchange="toggleSkipDebug(this.checked)">
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <div class="section-title">Integration Tokens — sorted by created date</div>
    <div class="table-wrap">
      ${tokens.length === 0
        ? '<div class="empty">No tokens registered yet.</div>'
        : `<table>
            <thead>
              <tr>
                <th>Token Hash</th>
                <th>Package Name</th>
                <th>Hits</th>
                <th>Created</th>
                <th>Last Seen</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`
      }
    </div>
  </main>

  <div id="toast"></div>

  <script>
    const ADMIN_TOKEN = '${adminToken}'

    async function revoke(hash) {
      if (!confirm('Revoke this token? The agent using it will stop receiving notifications.')) return
      const res = await fetch('/integrations/token', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: hash })
      })
      if (res.ok) {
        showToast('Token revoked.')
        setTimeout(() => location.reload(), 1000)
      } else {
        alert('Failed to revoke token.')
      }
    }

    async function toggleSkipDebug(enabled) {
      document.getElementById('toggle-status').textContent = enabled ? 'ON' : 'OFF'
      const res = await fetch('/admin/settings?token=' + ADMIN_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skipDebugPackages: enabled })
      })
      if (res.ok) {
        showToast('Setting saved: skip .debug packages ' + (enabled ? 'enabled' : 'disabled'))
      } else {
        alert('Failed to save setting.')
        document.getElementById('skip-debug-toggle').checked = !enabled
        document.getElementById('toggle-status').textContent = !enabled ? 'ON' : 'OFF'
      }
    }

    function showToast(msg) {
      const t = document.getElementById('toast')
      t.textContent = msg
      t.style.display = 'block'
      setTimeout(() => { t.style.display = 'none' }, 3000)
    }
  </script>
</body>
</html>`
}
