// Report writing for the Workspace verification harness.
//
// Two artifacts per run, both inside review/harness/<run-id>/:
//   report.json — machine-readable, timestamped, sanitized
//   report.html — readable summary with check table and embedded screenshots
//
// Sanitization is layered: the whole report tree passes through the vault's
// redactDeep (key-pattern based) and value redaction, then the serialized
// JSON is audited for any registered secret. If a leak is somehow still
// present, it is string-replaced and a sanitizeWarning is attached — the
// report never ships a secret.

import fs from 'node:fs';
import path from 'node:path';

function esc(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

const STATUS_ICON = { passed: '✔', failed: '✘', skipped: '–' };

function checkRowHtml(check) {
  const rows = [];
  const artifacts = (check.artifacts || [])
    .map((a) => `<a href="${esc(a)}">${esc(a)}</a>`)
    .join(' ');
  rows.push(`<tr class="st-${esc(check.status)}">`);
  rows.push(`<td class="c">${STATUS_ICON[check.status] || '?'}</td>`);
  rows.push(`<td><span class="phase">${esc(check.phase)}</span></td>`);
  rows.push(`<td class="t">${esc(check.title)}${check.conditional ? ' <span class="cond" title="runs only when its precondition (e.g. live credentials) is present">conditional</span>' : ''}</td>`);
  rows.push(`<td><span class="pill pill-${esc(check.status)}">${esc(check.status)}</span></td>`);
  rows.push(`<td class="d">${esc(check.durationMs != null ? fmtDuration(check.durationMs) : '—')}</td>`);
  rows.push(`<td class="detail">${esc(check.detail || '')}${artifacts ? `<div class="art">${artifacts}</div>` : ''}</td>`);
  rows.push('</tr>');
  return rows.join('');
}

function sectionScreenshotHtml(checks, phase) {
  const shots = [];
  for (const check of checks) {
    for (const artifact of check.artifacts || []) {
      if (artifact.endsWith('.png')) shots.push({ check, artifact });
    }
  }
  if (!shots.length) return '';
  const title = phase === 'live' ? 'Live evidence (read-only, labeled separately from fixture runs)' : 'Fixture evidence (offline, fake providers)';
  const figures = shots.map(({ check, artifact }) => (
    `<figure><img src="${esc(artifact)}" alt="${esc(check.title)}" loading="lazy" />`
    + `<figcaption><span class="phase">${esc(check.phase)}</span> ${esc(artifact)} — ${esc(check.title)}</figcaption></figure>`
  )).join('\n');
  return `<section><h2>${esc(title)}</h2><div class="shots">${figures}</div></section>`;
}

function renderHtml(report) {
  const s = report.summary;
  const v = report.versions || {};
  const g = report.git || {};
  const phaseNames = [...new Set(report.checks.map((c) => c.phase))];
  const byPhase = phaseNames.map((phase) => {
    const checks = report.checks.filter((c) => c.phase === phase);
    const passed = checks.filter((c) => c.status === 'passed').length;
    const failed = checks.filter((c) => c.status === 'failed').length;
    const skipped = checks.filter((c) => c.status === 'skipped').length;
    return { phase, checks, passed, failed, skipped };
  });

  const metaRows = [
    ['Run ID', report.runId],
    ['Mode', report.mode],
    ['Started', report.startedAt],
    ['Finished', report.finishedAt || '—'],
    ['Duration', fmtDuration(report.durationMs)],
    ['Exit code', String(report.exitCode)],
    ['Node / npm', `${v.node || '?'} / ${v.npm || '?'}`],
    ['App version', v.app || '?'],
    ['Playwright / Chromium', `${v.playwright || 'not installed'} / ${v.chromium || 'not launched'}`],
    ['Git', g.available ? `${g.revision}${g.branch ? ` (${g.branch})` : ''}${g.dirty ? ', dirty worktree' : ''}` : 'unavailable']
  ];
  if (report.live) {
    metaRows.push(['Live target', `${report.live.origin}${report.live.path}`]);
    metaRows.push(['Live credentials', report.live.credentialed ? 'supplied in env (values never recorded)' : 'not supplied — public checks only']);
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Workspace verification report ${esc(report.runId)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 15px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; background: #f5f7fb; color: #1c2333; }
  main { max-width: 1100px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 10px; }
  .sub { color: #5a6478; margin: 0 0 20px; }
  .summary { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0 8px; }
  .stat { background: #fff; border: 1px solid #dfe4ef; border-radius: 10px; padding: 12px 18px; min-width: 90px; }
  .stat b { display: block; font-size: 22px; }
  .stat.pass b { color: #14804a; } .stat.fail b { color: #c0392b; } .stat.skip b { color: #8a6d1a; }
  table { border-collapse: collapse; width: 100%; background: #fff; border: 1px solid #dfe4ef; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eef1f7; vertical-align: top; font-size: 13.5px; }
  th { background: #f0f3fa; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #56617a; }
  tr:last-child td { border-bottom: none; }
  tr.st-failed { background: #fdf3f2; } tr.st-skipped { background: #fdf9ef; }
  td.c { width: 26px; } td.d { white-space: nowrap; }
  .pill { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .pill-passed { background: #e2f5ea; color: #14804a; } .pill-failed { background: #fde8e6; color: #c0392b; } .pill-skipped { background: #fbf1d8; color: #8a6d1a; }
  .phase { display: inline-block; background: #e9eef9; color: #33508f; border-radius: 6px; padding: 0 6px; font-size: 11.5px; font-weight: 600; }
  .cond { font-size: 11px; color: #8a6d1a; border: 1px dashed #d9c68a; border-radius: 6px; padding: 0 5px; margin-left: 6px; }
  .detail { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #414c66; }
  .art a { color: #2d5fc2; }
  pre { background: #10182b; color: #dbe4f5; padding: 14px; border-radius: 10px; overflow: auto; font-size: 12px; }
  figure { margin: 0 0 18px; }
  figure img { max-width: 100%; border: 1px solid #dfe4ef; border-radius: 8px; }
  figcaption { font-size: 12.5px; color: #5a6478; margin-top: 4px; }
  .shots { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 800px) { .shots { grid-template-columns: 1fr; } }
  .note { background: #fff8e6; border: 1px solid #eadfae; border-radius: 8px; padding: 10px 12px; font-size: 13px; }
</style>
</head>
<body>
<main>
<h1>Workspace verification report</h1>
<p class="sub">Offline/fixture run with fake providers unless a live section is present. Generated ${esc(report.finishedAt || report.startedAt)}.</p>

<div class="summary">
  <div class="stat"><span>Checks</span><b>${s.total}</b></div>
  <div class="stat pass"><span>Passed</span><b>${s.passed}</b></div>
  <div class="stat fail"><span>Failed</span><b>${s.failed}</b></div>
  <div class="stat skip"><span>Skipped</span><b>${s.skipped}</b></div>
  <div class="stat"><span>Exit code</span><b>${s.exitCode}</b></div>
</div>

<h2>Run metadata</h2>
<table>
${metaRows.map(([k, val]) => `<tr><th>${esc(k)}</th><td>${esc(val)}</td></tr>`).join('\n')}
</table>

${report.sanitizeWarning ? `<p class="note">Sanitizer note: ${esc(report.sanitizeWarning)}</p>` : ''}

${byPhase.map(({ phase, checks, passed, failed, skipped }) => `
<h2>Phase: ${esc(phase)} <span class="sub">(${passed} passed, ${failed} failed, ${skipped} skipped)</span></h2>
<table>
<tr><th></th><th>Phase</th><th>Check</th><th>Status</th><th>Time</th><th>Detail</th></tr>
${checks.map(checkRowHtml).join('\n')}
</table>
`).join('\n')}

${sectionScreenshotHtml(report.checks, 'fixture')}
${sectionScreenshotHtml(report.checks, 'live')}

${
  report.logs && (report.logs.unitTests || report.logs.build)
    ? `<h2>Command output (tails)</h2>
${report.logs.unitTests ? `<h3>npm test</h3><pre>${esc(report.logs.unitTests)}</pre>` : ''}
${report.logs.build ? `<h3>npm run build</h3><pre>${esc(report.logs.build)}</pre>` : ''}`
    : ''
}

<p class="sub">Passwords, cookies, tokens, private env values, raw auth responses and other users' data are never written to this report.</p>
</main>
</body>
</html>
`;
}

// Sanitize → serialize → audit → (emergency redact) → write.
export function writeReports({ outDir, report, vault }) {
  fs.mkdirSync(outDir, { recursive: true });

  let sanitized = vault.redactDeep(report);
  let json = JSON.stringify(sanitized, null, 2);
  const leaks = vault.audit(json);
  let sanitizeWarning = null;
  if (leaks.length > 0) {
    // Defense in depth: this should be unreachable, but never ship a secret.
    for (const leak of leaks) json = json.split(leak).join('[redacted]');
    sanitizeWarning = `Report sanitizer replaced ${leaks.length} leaked value(s) before writing.`;
    sanitized = JSON.parse(json);
    sanitized.sanitizeWarning = sanitizeWarning;
    json = JSON.stringify(sanitized, null, 2);
  }

  const jsonPath = path.join(outDir, 'report.json');
  const htmlPath = path.join(outDir, 'report.html');
  fs.writeFileSync(jsonPath, `${json}\n`);
  fs.writeFileSync(htmlPath, renderHtml(sanitized));
  return { jsonPath, htmlPath, sanitizeWarning };
}
