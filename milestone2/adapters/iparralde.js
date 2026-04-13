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
        const visitedPageKeys = new Set();
        const maxPages = Number.isInteger(params.maxPages) && params.maxPages > 0 ? params.maxPages : 10;

        try {
            await page.goto('https://inmobiliariaiparralde.com/', { waitUntil: 'domcontentloaded' });

            await page.evaluate((filters) => {
                const form = document.querySelector('form.findus');
                if (!form) throw new Error('No se encontro el formulario principal.');

                const modalidad = form.querySelector('input[name="modalidad"]');
                if (modalidad) modalidad.value = 'alquiler';

                const tipo = form.querySelector('select[name="tipoInmueble[]"]');
                if (tipo) tipo.value = filters.propertyType || 'piso';

                const municipio = form.querySelector('select[name="municipio[]"]');
                if (municipio && filters.municipality) municipio.value = filters.municipality;

                const ref = form.querySelector('input[name="ref"]');
                if (ref) ref.value = '';

                form.submit();
            }, params.filters || {});

            await page.waitForURL('**/inmuebles/listado_de_inmuebles**', { timeout: 30000 });
            await page.waitForLoadState('networkidle');

            for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
                await page.waitForLoadState('domcontentloaded');
                await page.waitForTimeout(500);

                const pageData = await page.evaluate(() => {
                    const timestamp = new Date().toISOString();
                    const cards = Array.from(document.querySelectorAll('.item'));

                    const extracted = cards
                        .map((card) => {
                            const detailAnchor = card.querySelector('a[href*="/inmuebles/inmueble_detalles/"]');
                            if (!detailAnchor) return null;

                            const detailUrl = detailAnchor.href;
                            const titleAnchor = card.querySelector('h2 a, h3 a, h4 a');

                            const title = (titleAnchor?.textContent || detailAnchor.textContent || '').replace(/\s+/g, ' ').trim();
                            const priceNode = card.querySelector('.price, .precio, [class*="price"], [class*="precio"]');

                            // Prefer real postal address lines like "64700 Hendaye, FR".
                            const textCandidates = [
                                ...Array.from(card.querySelectorAll('p, span, small, li')).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()),
                                (card.textContent || '').replace(/\s+/g, ' ').trim(),
                            ].filter(Boolean);

                            const addressRegex = /\b\d{5}\s+[A-Za-zÀ-ÿ'\- ]+,\s*[A-Z]{2}\b/;
                            const matchedAddress = textCandidates
                                .map((txt) => {
                                    const match = txt.match(addressRegex);
                                    return match ? match[0].trim() : null;
                                })
                                .find(Boolean);

                            const locationNode = card.querySelector('.location, .direccion, .address, .poblacion');
                            const locationValue = matchedAddress || (locationNode ? locationNode.textContent.replace(/\s+/g, ' ').trim() : null);

                            return {
                                title,
                                price: priceNode ? priceNode.textContent.replace(/\s+/g, ' ').trim() : null,
                                location: locationValue,
                                detailUrl,
                                scrapedAt: timestamp,
                            };
                        })
                        .filter((x) => x && x.detailUrl && x.title);

                    const nextPageLink = document.querySelector('.pagination a[rel="next"], .pagination-next a, a.next');
                    const nextPageUrl = nextPageLink ? nextPageLink.href : null;
                    const pageKey = `${location.pathname}${location.search}::${extracted.length}`;

                    return {
                        extracted,
                        pageKey,
                        nextPageUrl,
                    };
                });

                if (visitedPageKeys.has(pageData.pageKey)) {
                    break;
                }
                visitedPageKeys.add(pageData.pageKey);

                if (pageData.extracted.length === 0) {
                    break;
                }

                for (const row of pageData.extracted) {
                    const id = extractStableIdFromUrl(row.detailUrl);
                    if (!id || resultsById.has(id)) continue;

                    const title = normalizeWhitespace(row.title);
                    resultsById.set(id, {
                        id,
                        title,
                        price: row.price ? normalizeWhitespace(row.price) : null,
                        location: row.location ? normalizeWhitespace(row.location) : inferLocationFromTitle(title),
                        detailUrl: row.detailUrl,
                        scrapedAt: row.scrapedAt,
                    });
                }

                if (!pageData.nextPageUrl || pageIndex >= maxPages) {
                    break;
                }

                await page.goto(pageData.nextPageUrl, { waitUntil: 'domcontentloaded' });
            }
        } finally {
            await browser.close();
        }

        return Array.from(resultsById.values());
    }
}

module.exports = IparraldeAdapter;
