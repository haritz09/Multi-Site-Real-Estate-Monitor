const { chromium } = require('playwright');

function normalizeWhitespace(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function extractStableIdFromUrl(url) {
    const match = url.match(/\/inmueble_detalles\/(\d+)/i);
    return match ? match[1] : '';
}

function inferLocationFromTitle(title) {
    if (!title) return null;

    const splitByDash = title.split('–');
    if (splitByDash.length > 1) {
        const firstChunk = normalizeWhitespace(splitByDash[0]);
        if (firstChunk) return firstChunk;
    }

    const splitByColon = title.split(':');
    if (splitByColon.length > 1) {
        const firstChunk = normalizeWhitespace(splitByColon[0]);
        if (firstChunk) return firstChunk;
    }

    const municipalityRegex = /\b(Hendaye|Hendaia|Hendaya|Irun|Irún|Arantza|Arcangues|Bagn[eè]res-de-Bigorre)\b/i;
    const municipalityMatch = title.match(municipalityRegex);
    if (municipalityMatch && municipalityMatch[1]) {
        return municipalityMatch[1];
    }

    const inPlaceMatch = title.match(/\ben\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ\-\s]{2,40})/);
    if (inPlaceMatch && inPlaceMatch[1]) {
        return normalizeWhitespace(inPlaceMatch[1]);
    }

    return null;
}

class IparraldeAdapter {
    constructor() {
        this.siteId = 'iparralde';
    }

    async list(params = {}) {
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext();
        const page = await context.newPage();

        const resultsById = new Map();
        const maxPages = 10;

        try {
            console.error(`[${this.siteId}] Navegando a inmobiliariaiparralde.com...`);
            await page.goto('https://inmobiliariaiparralde.com/', { waitUntil: 'networkidle' });

            console.error(`[${this.siteId}] Aplicando filtros y buscando (Comprar, Piso, Hendaye)...`);
            
            // Hacer el filtrado EXCLUSIVAMENTE en la búsqueda nativa, simulando clicks humanos
            await page.goto('https://inmobiliariaiparralde.com', { waitUntil: 'load' });
            
            // Aceptar cookies
            try { await page.locator('text=ACEPTAR COOKIES').click({ timeout: 2000 }); } catch(e) {}

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
                page.locator('.nav-tabs a').filter({ hasText: 'Comprar' }).first().click()
            ]);

            const activeTab = page.locator('.tab-content .active form.findus').first();
            await activeTab.locator('select[name="tipoInmueble[]"]').selectOption({ label: 'Piso' });
            await activeTab.locator('select[name="municipio[]"]').selectOption({ label: 'Hendaye' });

            await page.waitForTimeout(500);
            
            // Click en buscar
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
                activeTab.locator('button.submit, .query-submit-button button, button[type="submit"]').first().click()
            ]);
            await page.waitForTimeout(2000);
            await page.waitForLoadState('networkidle');

            const extractVisiblePage = async () => {
                await page.waitForSelector('.row.contratos-venta .col-md-8 a[href*="inmueble_detalles"]', { timeout: 10000 });

                return page.evaluate(() => {
                    const timestamp = new Date().toISOString();
                    const anchors = Array.from(document.querySelectorAll('.row.contratos-venta .col-md-8 a[href*="inmueble_detalles"]'));
                    const byUrl = new Map();

                    const clean = (str) => (str || '').replace(/\s+/g, ' ').trim();
                    const isGenericLinkText = (str) => /^ver\s+detalles?$/i.test(clean(str));

                    for (const anchor of anchors) {
                        const detailUrl = anchor.href;
                        if (!detailUrl) continue;

                        const card = anchor.closest('.property-list-list') || anchor.closest('.row') || anchor.parentElement;
                        const text = clean(card?.textContent || anchor.textContent || '');

                        const preferredTitle = clean(card?.querySelector('h4 a[href*="inmueble_detalles"], h4 a, h3 a, h2 a')?.textContent || '');
                        const anchorText = clean(anchor.textContent || '');
                        const bestTitleCandidate = preferredTitle || (!isGenericLinkText(anchorText) ? anchorText : '');

                        const priceMatch = text.match(/\d{1,3}(?:\.\d{3})*(?:,\d{2})?\s*€/);
                        const addressMatch = text.match(/\b\d{5}\s+[A-Za-zÀ-ÿ'\- ]+,\s*[A-Z]{2}\b/);

                        const existing = byUrl.get(detailUrl) || {
                            title: '',
                            price: null,
                            location: null,
                            detailUrl,
                            scrapedAt: timestamp,
                        };

                        if (!existing.title && bestTitleCandidate) {
                            existing.title = bestTitleCandidate;
                        }
                        if (!existing.price && priceMatch) {
                            existing.price = priceMatch[0].trim();
                        }
                        if (!existing.location && addressMatch) {
                            existing.location = addressMatch[0].trim();
                        }

                        byUrl.set(detailUrl, existing);
                    }

                    return Array.from(byUrl.values()).filter((x) => x && x.detailUrl && x.title);
                });
            };

            const mergeRows = (rows) => {
                for (const row of rows) {
                    const id = extractStableIdFromUrl(row.detailUrl);
                    if (!id) continue;

                    if (!resultsById.has(id)) {
                        resultsById.set(id, {
                            id,
                            title: normalizeWhitespace(row.title),
                            price: row.price ? normalizeWhitespace(row.price) : null,
                            location: row.location ? normalizeWhitespace(row.location) : inferLocationFromTitle(normalizeWhitespace(row.title)),
                            detailUrl: row.detailUrl,
                            scrapedAt: row.scrapedAt,
                        });
                    }
                }
            };

            mergeRows(await extractVisiblePage());

            const pageRefs = await page.locator('a.page[href^="#page:"]').evaluateAll((anchors) => {
                const hrefs = anchors
                    .map((a) => (a.getAttribute('href') || '').trim())
                    .filter((h) => /^#page:\d+$/i.test(h));

                return Array.from(new Set(hrefs));
            });

            for (const ref of pageRefs.slice(0, maxPages)) {
                if (ref === '#page:1') continue;
                const pageLink = page.locator(`a.page[href="${ref}"]`).first();
                await pageLink.click({ timeout: 10000 });
                await page.waitForTimeout(1000);
                mergeRows(await extractVisiblePage());
            }
        } finally {
            await browser.close();
        }

        return Array.from(resultsById.values());
    }
}

module.exports = IparraldeAdapter;