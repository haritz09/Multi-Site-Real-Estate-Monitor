const fs = require('fs');
const path = require('path');
const IparraldeAdapter = require('./adapters/iparralde');
const { openDb, close, initSchema, upsertApartments, getStatus } = require('./db');

const adapters = {
    iparralde: new IparraldeAdapter(),
};

function parseArgs(argv) {
    const options = {
        site: 'iparralde',
        out: null,
        persist: false,
        status: false,
        db: 'apartments.db',
        maxPages: undefined,
        filters: {},
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === '--site') {
            options.site = argv[i + 1];
            i += 1;
        } else if (arg === '--out') {
            options.out = argv[i + 1];
            i += 1;
        } else if (arg === '--persist') {
            options.persist = true;
        } else if (arg === '--status') {
            options.status = true;
        } else if (arg === '--db') {
            options.db = argv[i + 1];
            i += 1;
        } else if (arg === '--max-pages') {
            const parsed = Number.parseInt(argv[i + 1], 10);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                throw new Error('--max-pages debe ser un entero positivo.');
            }
            options.maxPages = parsed;
            i += 1;
        } else if (arg.startsWith('--filters.')) {
            const key = arg.replace('--filters.', '').trim();
            if (!key) {
                throw new Error(`Filtro invalido: ${arg}`);
            }
            options.filters[key] = argv[i + 1];
            i += 1;
        }
    }

    return options;
}

function validateSite(site) {
    const adapter = adapters[site];
    if (!adapter) {
        throw new Error(`No se encontro adapter para '${site}'. Sitios disponibles: ${Object.keys(adapters).join(', ')}`);
    }
    return adapter;
}

async function printStatus(dbPath) {
    const { db } = await openDb(dbPath);
    try {
        await initSchema(db);
        const status = await getStatus(db);

        console.log(`Total listings: ${status.total}`);
        console.log('  Database: Turso (libsql)');
        console.log('  By site:');
        for (const site of status.bySite) {
            console.log(`    ${site.siteId}: ${site.total} listings`);
        }
    } finally {
        await close(db);
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.status) {
        await printStatus(options.db);
        return;
    }

    const adapter = validateSite(options.site);
    console.error(`Scraping ${adapter.siteId}...`);

    const listings = await adapter.list({
        filters: options.filters,
        maxPages: options.maxPages,
    });

    if (options.out) {
        const outPath = path.resolve(process.cwd(), options.out);
        fs.writeFileSync(outPath, JSON.stringify(listings, null, 2), 'utf-8');
        console.error(`Wrote ${listings.length} listings to ${outPath}`);
    }

    if (options.persist) {
        const { db } = await openDb(options.db);
        try {
            await initSchema(db);
            const result = await upsertApartments(db, listings, options.site);
            const status = await getStatus(db);
            console.error(`Persisted ${result.insertedOrUpdated} listings into Turso (libsql)`);
            console.error(`apartments rows: ${status.total}`);
        } finally {
            await close(db);
        }
    }

    if (!options.out && !options.persist) {
        console.log(JSON.stringify(listings, null, 2));
    }
}

main().catch((error) => {
    console.error('Error:', error.message || error);
    process.exit(1);
});
