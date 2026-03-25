// scrape.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveAgentBrowser() {
    const appData = process.env.APPDATA || '';
    const candidates = [
        path.join(appData, 'npm', 'agent-browser.cmd'),
        path.join(appData, 'npm', 'agent-browser.exe'),
        'agent-browser.cmd',
        'agent-browser'
    ];

    for (const candidate of candidates) {
        if (candidate.includes(path.sep) && !fs.existsSync(candidate)) {
            continue;
        }
        return candidate;
    }

    throw new Error('agent-browser executable not found.');
}

const AGENT_BROWSER = resolveAgentBrowser();
const OUTPUT_PATH = path.join(__dirname, 'results.json');

function runBatchSingle(args) {
    const payload = JSON.stringify([args]);
    try {
        // Use cmd.exe to avoid PowerShell ExecutionPolicy blocking *.ps1 shims.
            return execFileSync('cmd.exe', ['/d', '/s', '/c', `${AGENT_BROWSER} batch --bail`], {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            input: payload
        });
    } catch (e) {
        const details = e.stderr || e.message;
        throw new Error(`agent-browser command failed: ${details}`);
    }
}

function runCommand(args) {
    console.warn(`Running: ${args.join(' ')}`);
    return runBatchSingle(args);
}

function parseFirstJsonObject(raw) {
    const lines = (raw || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        if (line.startsWith('{') && line.endsWith('}')) {
            try {
                return JSON.parse(line);
            } catch {
                continue;
            }
        }
    }

    return null;
}

function parseFirstJsonValue(raw) {
    const text = (raw || '').trim();
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        // ignore
    }

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        if ((line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))) {
            try {
                return JSON.parse(line);
            } catch {
                continue;
            }
        }
    }

    return null;
}

function runEval(evalCmd) {
    const output = runBatchSingle(['eval', evalCmd]);
    const parsedValue = parseFirstJsonValue(output);

    if (Array.isArray(parsedValue)) {
        return parsedValue;
    }

    const parsed = parseFirstJsonObject(output);
    if (parsed && parsed.success && parsed.data && Array.isArray(parsed.data.result)) {
        return parsed.data.result;
    }

    return [];
}

async function scrape() {
    console.log("Starting scraping process...");
    
    // 1. Open the page
    runCommand(['open', 'https://inmobiliariaiparralde.com/']);
    runCommand(['wait', '2000']);
    
    // 2. Accept cookies if not accepted yet
    runEval("Array.from(document.querySelectorAll('a')).find(el => el.innerText.includes('ACEPTAR COOKIES'))?.click(); [];");
    
    // 3. Search: Comprar/Alquilar, Piso, Hendaye
    runEval([
        "(() => {",
        "  const clickByText = (text) => {",
        "    const el = Array.from(document.querySelectorAll('a,button')).find(x => x.innerText && x.innerText.trim() === text);",
        "    if (el) { el.click(); return true; }",
        "    return false;",
        "  };",
        "  const setSelectByText = (optionText) => {",
        "    const wanted = optionText.toLowerCase();",
        "    const selects = Array.from(document.querySelectorAll('select'));",
        "    for (const sel of selects) {",
        "      const opt = Array.from(sel.options).find(o => (o.textContent || '').trim().toLowerCase() === wanted);",
        "      if (opt) {",
        "        sel.value = opt.value;",
        "        sel.dispatchEvent(new Event('change', { bubbles: true }));",
        "        return true;",
        "      }",
        "    }",
        "    return false;",
        "  };",
        "  clickByText('Alquilar');",
        "  const setType = setSelectByText('Piso');",
        "  const setTown = setSelectByText('Hendaye');",
        "  const search = Array.from(document.querySelectorAll('button,a,input[type=\"submit\"]')).find(el => {",
        "    const txt = ((el.innerText || el.value || '') + '').toLowerCase();",
        "    return txt.includes('buscar') || txt.includes('search') || !!el.querySelector?.('.fa-search');",
        "  });",
        "  if (search) search.click();",
        "  return [{ setType, setTown, clicked: !!search, url: location.href }];",
        "})()"
    ].join(' '));
    
    // Wait for the results load
    runCommand(['wait', '2500']);

    // If search UI did not navigate, force open listing page.
    const currentUrlResult = runEval("[{ url: location.href }]");
    const currentUrl = Array.isArray(currentUrlResult) && currentUrlResult[0] ? currentUrlResult[0].url : '';
    if (!String(currentUrl).includes('/inmuebles/listado_de_inmuebles')) {
        runCommand(['open', 'https://inmobiliariaiparralde.com/inmuebles/listado_de_inmuebles']);
        runCommand(['wait', '2000']);
    }
    
    let allResults = [];
    const extractEval = `
        Array.from(document.querySelectorAll('div.col-sm-9 h3')).map(h3 => {
            const grandpa = h3.parentElement?.parentElement?.parentElement;
            const fullText = grandpa?.innerText;
            const lines = fullText ? fullText.split(/\\r?\\n/).map(l => l.trim()).filter(Boolean) : [];
            const price = lines.find(l => l.match(/€/)) || lines.find(l => l.toLowerCase().includes('precio consultar')) || 'N/A';
            const loc = lines.find(l => l.match(/\\d{5}/)) || 'N/A';
            const url = h3.parentElement?.href;
            return {
                title: h3.innerText.trim(),
                price: price,
                location: loc,
                url: url,
                id: url ? url.split('/').pop() : null,
                timestamp: new Date().toISOString()
            };
        })
    `.replace(/\n/g, ' ');

    let currentPage = 1;
    let hasNextPage = true;

    while (hasNextPage && currentPage <= 3) { // Pagination (usually 2-3 pages max)
        console.log(`Extracting page ${currentPage}...`);
        const pageResults = runEval(extractEval);
        allResults = allResults.concat(pageResults);

        // Try to go to next page
        const nextPageNum = currentPage + 1;
        const pageClickedResult = runEval(`
            (() => {
                const nextLink = Array.from(document.querySelectorAll('a')).find(a => a.innerText.trim() === '${nextPageNum}');
                if (nextLink) {
                    nextLink.click();
                    return [{ clicked: true }];
                }
                return [{ clicked: false }];
            })()
        `.replace(/\n/g, ' '));
        const pageClicked = Array.isArray(pageClickedResult) && pageClickedResult[0] && pageClickedResult[0].clicked === true;
        
        if (pageClicked === true) {
            runCommand(['wait', '1800']);
            currentPage++;
        } else {
            hasNextPage = false;
        }
    }
    
    // Deduplicate results by id 
    const uniqueResultsMap = new Map();
    allResults.forEach(r => uniqueResultsMap.set(r.id, r));
    const uniqueResults = Array.from(uniqueResultsMap.values());

    // Keep only target criteria when UI filtering is unreliable: municipio Hendaye.
    const filteredResults = uniqueResults.filter((r) => {
        const location = (r.location || '').toLowerCase();
        return location.includes('hendaye');
    });

    // Save final output
    const jsonOutput = JSON.stringify(filteredResults, null, 2);
    fs.writeFileSync(OUTPUT_PATH, jsonOutput);
    console.log(`\nSaved ${filteredResults.length} records to ${OUTPUT_PATH}`);
    
    runCommand(['close']);
}

scrape();