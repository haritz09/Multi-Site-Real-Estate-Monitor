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

    // Ejemplo: "Hendaya (64) – Magnífico piso..." -> "Hendaya (64)"
    const splitByDash = title.split('–');
    if (splitByDash.length > 1) {
        const firstChunk = normalizeWhitespace(splitByDash[0]);
        if (firstChunk) return firstChunk;
    }

    // Fallback: si no hay guion largo, tomamos hasta el primer ':'
    const splitByColon = title.split(':');
    if (splitByColon.length > 1) {
        const firstChunk = normalizeWhitespace(splitByColon[0]);
        if (firstChunk) return firstChunk;
    }

    // Fallback por patrón de topónimos frecuentes en el catálogo.
    const municipalityRegex = /\b(Hendaye|Hendaia|Hendaya|Irun|Irún|Arantza|Arcangues|Bagn[eè]res-de-Bigorre)\b/i;
    const municipalityMatch = title.match(municipalityRegex);
    if (municipalityMatch && municipalityMatch[1]) {
        return municipalityMatch[1];
    }

    // Fallback genérico: "... en <Lugar>"
    const inPlaceMatch = title.match(/\ben\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ\-\s]{2,40})/);
    if (inPlaceMatch && inPlaceMatch[1]) {
        return normalizeWhitespace(inPlaceMatch[1]);
    }

    return null;
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        console.error('Navegando a inmobiliariaiparralde.com...');
        await page.goto('https://inmobiliariaiparralde.com/', { waitUntil: 'domcontentloaded' });

        console.error('Aplicando filtros (Alquilar, Piso, Hendaye) y enviando búsqueda...');
        await page.evaluate(() => {
            const form = document.querySelector('form.findus');
            if (!form) {
                throw new Error('No se encontró el formulario principal (form.findus).');
            }

            const modalidad = form.querySelector('input[name="modalidad"]');
            if (modalidad) modalidad.value = 'alquiler';

            const tipo = form.querySelector('select[name="tipoInmueble[]"]');
            if (tipo) tipo.value = 'piso';

            const municipio = form.querySelector('select[name="municipio[]"]');
            if (municipio) municipio.value = 'Hendaye';

            const ref = form.querySelector('input[name="ref"]');
            if (ref) ref.value = '';

            form.submit();
        });

        await page.waitForURL('**/inmuebles/listado_de_inmuebles**', { timeout: 30000 });
        await page.waitForLoadState('networkidle');

        const resultsById = new Map();
        const visitedPageKeys = new Set();
        const maxPages = 10;

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
                        const titleAnchor = card.querySelector('h2 a[href*="/inmuebles/inmueble_detalles/"], h3 a[href*="/inmuebles/inmueble_detalles/"], h4 a[href*="/inmuebles/inmueble_detalles/"]');

                        const title = (titleAnchor?.textContent || detailAnchor.textContent || '').replace(/\s+/g, ' ').trim();
                        const priceNode = card.querySelector('.price, .precio, [class*="price"], [class*="precio"]');
                        const locationNode = card.querySelector('.location, .direccion, .address, .poblacion');

                        return {
                            title,
                            price: priceNode ? priceNode.textContent.replace(/\s+/g, ' ').trim() : null,
                            location: locationNode ? locationNode.textContent.replace(/\s+/g, ' ').trim() : null,
                            detailUrl,
                            scrapedAt: timestamp,
                        };
                    })
                    .filter((x) => x && x.detailUrl && x.title);

                const paginationLinks = Array.from(document.querySelectorAll('.pagination a, .easyPaginateNav a'))
                    .map((a) => ({
                        text: (a.textContent || '').replace(/\s+/g, ' ').trim(),
                        className: a.className || '',
                        href: a.getAttribute('href') || '',
                    }));

                const pageKey = `${location.pathname}${location.search}::${extracted.length}`;

                return {
                    extracted,
                    paginationLinks,
                    pageKey,
                    currentUrl: location.href,
                };
            });

            if (visitedPageKeys.has(pageData.pageKey)) {
                break;
            }
            visitedPageKeys.add(pageData.pageKey);

            for (const row of pageData.extracted) {
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

            console.error(`Página ${pageIndex}: ${pageData.extracted.length} fichas detectadas, acumuladas ${resultsById.size}.`);

            const hasServerPagination = pageData.paginationLinks.length > 0;
            if (!hasServerPagination) {
                break;
            }

            const nextClicked = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('.pagination a, .easyPaginateNav a'));

                const isDisabled = (el) => {
                    const cls = `${el.className || ''} ${el.parentElement?.className || ''}`.toLowerCase();
                    return cls.includes('disabled') || cls.includes('active') || cls.includes('current');
                };

                const nextLink = links.find((a) => {
                    const text = (a.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    const rel = (a.getAttribute('rel') || '').toLowerCase();
                    const href = (a.getAttribute('href') || '').toLowerCase();

                    if (isDisabled(a)) return false;
                    if (rel === 'next') return true;
                    if (text === '>' || text === '>>' || text.includes('siguiente') || text.includes('next')) return true;
                    if (href.includes('page=')) return true;
                    return false;
                });

                if (!nextLink) return false;
                nextLink.click();
                return true;
            });

            if (!nextClicked) {
                break;
            }

            await Promise.race([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null),
                page.waitForTimeout(1200),
            ]);
            await page.waitForLoadState('networkidle').catch(() => null);
        }

        const allResults = Array.from(resultsById.values());
        console.error(`Proceso completado. Total extraído: ${allResults.length} inmuebles.`);

        // JSON limpio por stdout.
        console.log(JSON.stringify(allResults, null, 2));
    } finally {
        await browser.close();
    }
})();