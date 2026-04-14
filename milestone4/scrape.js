const path = require('path');
const fs = require('fs');
const dbModule = require('./db');
const { sendChangesNotification } = require('./notifications');

async function main() {
    const args = process.argv.slice(2);
    const siteArgIndex = args.indexOf('--site');
    const outArgIndex = args.indexOf('--out');
    const isDryRun = args.includes('--dry-run');
    const notificationsEnabled = process.env.ENABLE_NOTIFICATIONS === 'true' && !isDryRun;

    if (siteArgIndex === -1 || !args[siteArgIndex + 1]) {
        console.error('Uso: node scrape.js --site <siteId> [--out <fichero.json>] [--dry-run]');
        process.exit(1);
    }

    const siteId = args[siteArgIndex + 1];
    const outFile = outArgIndex !== -1 ? args[outArgIndex + 1] : null;

    let AdapterClass;
    try {
        AdapterClass = require(path.join(__dirname, 'adapters', `${siteId}.js`));
    } catch (e) {
        console.error(`No se encontró el adaptador para el sitio: ${siteId}`);
        process.exit(1);
    }

    let db;
    try {
        const dbCtx = dbModule.openDb();
        db = dbCtx.db;
        console.error(`Conectado a la base de datos Turso: ${dbCtx.resolvedPath}`);
    } catch (err) {
        console.error(`Error abriendo BBDD: ${err.message}`);
        process.exit(1);
    }

    const adapter = new AdapterClass();
    
    // Init Schema first
    await dbModule.initSchema(db);

    console.error(`Iniciando scrape run para el sitio: ${siteId}... ${isDryRun ? '(DRY RUN)' : ''}`);
    const runId = await dbModule.startScrapeRun(db, siteId);
    
    let listings = [];
    try {
        listings = await adapter.list();
    } catch (err) {
        console.error(`Error en el scrape: ${err.message}`);
        if (!isDryRun) {
            await dbModule.finishScrapeRun(db, runId, 'failed', 0);
        }
        process.exit(1);
    }

    console.error(`Procesando ${listings.length} listings...`);
    const changes = await dbModule.processListings(db, runId, siteId, listings, isDryRun);

    if (notificationsEnabled) {
        try {
            await sendChangesNotification({ siteId, changes, listings });
        } catch (err) {
            console.error(`Error enviando notificaciones: ${err.message}`);
        }
    } else {
        console.error(`Notificaciones desactivadas ${isDryRun ? '(dry-run)' : '(ENABLE_NOTIFICATIONS != true)'}`);
    }

    if (!isDryRun) {
        await dbModule.finishScrapeRun(db, runId, 'ok', listings.length);
        console.error(`Scrape run completado con éxito. ID: ${runId}`);
    } else {
        console.log("=== DRY RUN CHANGES DETECTED ===");
        console.log(JSON.stringify(changes, null, 2));
    }

    if (outFile) {
        const outPath = path.resolve(process.cwd(), outFile);
        fs.writeFileSync(outPath, JSON.stringify(listings, null, 2), 'utf-8');
        console.error(`Resultados en crudo guardados en ${outFile}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});