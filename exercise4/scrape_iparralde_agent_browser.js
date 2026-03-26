#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const HTML_PATH = path.join(ROOT, 'results_body.html');
const OUTPUT_PATH = path.join(ROOT, 'results.json');
const AGENT_BROWSER_JS = (() => {
  if (process.env.AGENT_BROWSER_JS && process.env.AGENT_BROWSER_JS.trim()) {
    return process.env.AGENT_BROWSER_JS.trim();
  }
  const appData = process.env.APPDATA || '';
  const candidate = path.join(appData, 'npm', 'node_modules', 'agent-browser', 'bin', 'agent-browser.js');
  if (appData && fs.existsSync(candidate)) {
    return candidate;
  }
  return null;
})();

function run(cmd, args) {
  const proc = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
  });
  if (proc.status !== 0) {
    const detail = proc.stderr || proc.stdout || proc.error?.message || 'unknown error';
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${detail}`);
  }
  return proc.stdout;
}

function runAgentBrowser(args) {
  if (AGENT_BROWSER_JS) {
    return run('node', [AGENT_BROWSER_JS, ...args]);
  }
  return run('agent-browser', args);
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Intentional busy-wait to avoid extra runtime dependencies.
  }
}

function ensureLightpandaDocker() {
  const name = 'lightpanda';
  const list = run('docker', ['ps', '-a', '--format', '{{.Names}}']);
  const exists = list.split(/\r?\n/).some((n) => n.trim() === name);
  if (exists) {
    run('docker', ['rm', '-f', name]);
  }
  run('docker', ['run', '-d', '--name', name, '-p', '9222:9222', 'lightpanda/browser:nightly']);
  sleep(5000);
}

function browserStep(args) {
  let lastErr;
  for (let i = 0; i < 20; i += 1) {
    try {
      return runAgentBrowser(['--cdp', '9222', ...args]);
    } catch (err) {
      lastErr = err;
      sleep(1000);
    }
  }
  throw lastErr;
}

function applyFilters() {
  browserStep(['tab', 'list']);
  browserStep(['open', 'https://inmobiliariaiparralde.com/']);
  browserStep(['wait', '4000']);

  const js = [
    '(function () {',
    '  var form = document.forms[0];',
    '  if (form == null) return { ok: false, reason: "no-form" };',
    '  var tipo = form.elements.namedItem("tipoInmueble[]");',
    '  var muni = form.elements.namedItem("municipio[]");',
    '  if (tipo == null || muni == null) return { ok: false, reason: "no-selects" };',
    '  tipo.value = "piso";',
    '  muni.value = "Hendaye";',
    '  tipo.dispatchEvent(new Event("change", { bubbles: true }));',
    '  muni.dispatchEvent(new Event("change", { bubbles: true }));',
    '  form.submit();',
    '  return { ok: true, tipo: tipo.value, municipio: muni.value };',
    '})()'
  ].join(' ');

  browserStep(['eval', js]);
  browserStep(['wait', '6000']);
}

function discoverPageCount() {
  const js = [
    '(() => {',
    '  const nums = [...document.querySelectorAll("a")]',
    '    .map((a) => (a.textContent || "").trim())',
    '    .filter((t) => /^\\d+$/.test(t))',
    '    .map((t) => Number(t));',
    '  return nums.length ? Math.max(...nums) : 1;',
    '})()'
  ].join(' ');
  const raw = browserStep(['eval', js]).trim();
  const parsed = Number(raw.replace(/[^0-9]/g, ''));
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(parsed, 10);
  }
  return 1;
}

function extractFilteredHtmlPages() {
  applyFilters();
  const pages = discoverPageCount();
  const htmlPages = [];

  const baseUrl = 'https://inmobiliariaiparralde.com/inmuebles/listado_de_inmuebles';
  for (let p = 1; p <= pages; p += 1) {
    if (p === 1) {
      browserStep(['open', baseUrl]);
    } else {
      browserStep(['open', `${baseUrl}#page:${p}`]);
    }
    browserStep(['wait', '2500']);

    const html = runAgentBrowser(['--cdp', '9222', '--max-output', '500000', 'get', 'html', 'body']);
    htmlPages.push(html);
  }

  fs.writeFileSync(HTML_PATH, htmlPages.join('\n<!-- PAGE BREAK -->\n'), 'utf8');
  return htmlPages;
}

function normalizeSpaces(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function stableId(url) {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function parseListings(htmlPages) {
  const rowsByUrl = new Map();

  const blockRe = /<span class="nav_tag price[\s\S]*?<\/span>[\s\S]*?<h4>\s*<a href="(https:\/\/inmobiliariaiparralde\.com\/inmuebles\/inmueble_detalles\/\d+)">([\s\S]*?)<\/a>\s*<\/h4>\s*<p>([\s\S]*?)<\/p>/gi;

  let m;
  const now = new Date().toISOString();

  for (const html of htmlPages) {
    while ((m = blockRe.exec(html)) !== null) {
      const sliceStart = Math.max(0, m.index - 300);
      const snippet = html.slice(sliceStart, m.index + 800);
      const priceMatch = snippet.match(/(\d{1,3}(?:\.\d{3})*,\d{2})\s*&nbsp;[^<]*/i);

      const detailUrl = normalizeSpaces(m[1]);
      const title = normalizeSpaces(m[2].replace(/<[^>]*>/g, ''));
      const location = normalizeSpaces(m[3].replace(/<[^>]*>/g, ''));
      const price = priceMatch ? `${priceMatch[1]} EUR` : null;

      if (!rowsByUrl.has(detailUrl)) {
        rowsByUrl.set(detailUrl, {
          id: stableId(detailUrl),
          title,
          price,
          location,
          detail_url: detailUrl,
          scraped_at: now
        });
      }
    }
    blockRe.lastIndex = 0;
  }

  return [...rowsByUrl.values()];
}

function main() {
  ensureLightpandaDocker();
  const htmlPages = extractFilteredHtmlPages();
  const rows = parseListings(htmlPages);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(rows, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

main();
