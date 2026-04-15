const path = require('path');
const fs = require('fs');
const http = require('http');
const dotenv = require('dotenv');
const cron = require('node-cron');

dotenv.config({ path: path.resolve(__dirname, '.env') });

const dbModule = require('./db');
const { sendChangesNotification } = require('./notifications');

function parseArgs(argv) {
    const args = argv.slice(2);
    const getValue = (flag) => {
        const idx = args.indexOf(flag);
        if (idx === -1) return null;
        return args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
    };

    return {
        site: getValue('--site'),
        out: getValue('--out'),
        schedule: getValue('--schedule'),
        dryRun: args.includes('--dry-run'),
        once: args.includes('--once'),
        healthPort: getValue('--health-port'),
        immediate: args.includes('--immediate'),
        dashboard: args.includes('--dashboard'),
        port: getValue('--port'),
        help: args.includes('--help')
    };
}

function usage() {
    return [
        'Uso:',
        '  node scrape.js --once [--site <siteId>] [--dry-run] [--out <fichero.json>]',
        '  node scrape.js --schedule "*/30 * * * *" [--site <siteId>] [--dry-run] [--immediate]',
        '',
        'Opciones:',
        '  --once            Ejecuta una corrida completa y termina (ideal para Task Scheduler)',
        '  --schedule <cron> Inicia scheduler en proceso largo (si no se pasa, usa SCRAPE_CRON)',
        '  --site <siteId>   Ejecuta solo un adapter/sitio concreto',
        '  --dry-run         No persiste en DB ni envia notificaciones',
        '  --out <file>      Guarda resultados crudos por sitio en JSON',
        '  --health-port <n> Activa health-check HTTP en ese puerto',
        '  --immediate       En modo schedule, ejecuta una corrida inmediata al arrancar',
        '  --help            Muestra esta ayuda'
    ].join('\n');
}

function isTooFrequentExpression(cronExpr) {
    if (!cronExpr) return false;
    const trimmed = cronExpr.trim();
    if (trimmed === '* * * * *') return true;
    const stepMatch = trimmed.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
    if (!stepMatch) return false;
    const mins = Number(stepMatch[1]);
    return Number.isFinite(mins) && mins > 0 && mins < 15;
}

function discoverAvailableSites() {
    const adaptersDir = path.join(__dirname, 'adapters');
    if (!fs.existsSync(adaptersDir)) return [];

    return fs
        .readdirSync(adaptersDir)
        .filter((name) => name.endsWith('.js'))
        .map((name) => name.replace(/\.js$/, ''));
}

function getConfiguredSites(siteFromCli) {
    if (siteFromCli) return [siteFromCli];

    const envSites = (process.env.SCRAPE_SITES || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    if (envSites.length > 0) return envSites;
    return discoverAvailableSites();
}

function loadAdapter(siteId) {
    try {
        const AdapterClass = require(path.join(__dirname, 'adapters', `${siteId}.js`));
        return AdapterClass;
    } catch (err) {
        return null;
    }
}

function writeRawOutput(outFile, siteId, listings) {
    if (!outFile) return;

    const basePath = path.resolve(process.cwd(), outFile);
    const parsed = path.parse(basePath);
    const safeSite = siteId.replace(/[^a-z0-9_-]/gi, '_');
    const outPath = path.join(parsed.dir, `${parsed.name}.${safeSite}${parsed.ext || '.json'}`);

    fs.writeFileSync(outPath, JSON.stringify(listings, null, 2), 'utf-8');
    console.error(`[${siteId}] Resultados en crudo guardados en ${outPath}`);
}

async function runSingleSite(db, siteId, options) {
    const { dryRun, notificationsEnabled, outFile } = options;

    const AdapterClass = loadAdapter(siteId);
    if (!AdapterClass) {
        console.error(`[${siteId}] No se encontro el adaptador para el sitio`);
        return {
            siteId,
            status: 'failed',
            listingsFound: 0,
            changesFound: 0,
            error: 'adapter_not_found'
        };
    }

    const adapter = new AdapterClass();
    let runId = null;

    console.error(`[${siteId}] Inicio de run ${dryRun ? '(DRY RUN)' : ''}`);

    if (!dryRun) {
        runId = await dbModule.startScrapeRun(db, siteId);
    } else {
        runId = `dryrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    let listings = [];
    try {
        listings = await adapter.list();
        const changes = await dbModule.processListings(db, runId, siteId, listings, dryRun);

        if (notificationsEnabled) {
            try {
                await sendChangesNotification({ siteId, changes, listings });
            } catch (notifyErr) {
                console.error(`[${siteId}] Error enviando notificaciones: ${notifyErr.message}`);
            }
        } else {
            console.error(`[${siteId}] Notificaciones desactivadas ${dryRun ? '(dry-run)' : '(ENABLE_NOTIFICATIONS != true)'}`);
        }

        if (!dryRun) {
            await dbModule.finishScrapeRun(db, runId, 'ok', listings.length);
        }

        writeRawOutput(outFile, siteId, listings);

        console.error(`[${siteId}] Fin de run: ok. listings=${listings.length}, cambios=${changes.length}`);
        return {
            siteId,
            status: 'ok',
            listingsFound: listings.length,
            changesFound: changes.length,
            runId
        };
    } catch (err) {
        console.error(`[${siteId}] Error en run: ${err.message}`);
        if (!dryRun && runId) {
            try {
                await dbModule.finishScrapeRun(db, runId, 'failed', 0);
            } catch (finishErr) {
                console.error(`[${siteId}] Error marcando run como failed: ${finishErr.message}`);
            }
        }
        return {
            siteId,
            status: 'failed',
            listingsFound: 0,
            changesFound: 0,
            runId,
            error: err.message
        };
    }
}

async function runAllSitesOnce(db, options) {
    const startedAt = new Date();
    const sites = getConfiguredSites(options.site);

    if (sites.length === 0) {
        throw new Error('No hay sitios configurados. Define SCRAPE_SITES o añade adapters en milestone5/adapters');
    }

    console.error(`[tick] Inicio ${startedAt.toISOString()} | sitios=${sites.join(', ')}`);

    const results = [];
    for (const siteId of sites) {
        const siteResult = await runSingleSite(db, siteId, options);
        results.push(siteResult);
    }

    const finishedAt = new Date();
    const okCount = results.filter((r) => r.status === 'ok').length;
    const failedCount = results.length - okCount;

    console.error(
        `[tick] Fin ${finishedAt.toISOString()} | ok=${okCount} failed=${failedCount} duration_ms=${finishedAt.getTime() - startedAt.getTime()}`
    );

    return {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        okCount,
        failedCount,
        totalSites: results.length,
        results
    };
}

function createHealthServer(getState, requestedPort) {
    const envEnabled = process.env.HEALTHCHECK_ENABLED === 'true';
    const resolvedPort = Number(requestedPort || process.env.HEALTHCHECK_PORT || 0);

    if (!envEnabled && !requestedPort) {
        return { server: null, port: null };
    }

    const port = Number.isFinite(resolvedPort) && resolvedPort > 0 ? resolvedPort : 8787;

    const server = http.createServer((req, res) => {
        if (req.url !== '/health') {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, message: 'not_found' }));
            return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, ...getState() }));
    });

    server.listen(port, () => {
        console.error(`[health] Endpoint activo en http://localhost:${port}/health`);
    });

    return { server, port };
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        console.log(usage());
        process.exit(0);
    }

    if (args.dashboard) {
        console.error(`[system] Iniciando dashboard...`);
        const { start } = require('./dashboard.js');
        await start(args.port ? Number(args.port) : 3000);
        return;
    }

    let db;
    try {
        const dbCtx = dbModule.openDb();
        db = dbCtx.db;
        console.error(`Conectado a la base de datos Turso: ${dbCtx.resolvedPath}`);
        await dbModule.initSchema(db);
    } catch (err) {
        console.error(`Error inicializando BBDD: ${err.message}`);
        process.exit(1);
    }

    const options = {
        site: args.site,
        outFile: args.out,
        dryRun: args.dryRun,
        notificationsEnabled: process.env.ENABLE_NOTIFICATIONS === 'true' && !args.dryRun
    };

    const runtimeState = {
        inProgress: false,
        shuttingDown: false,
        lastRunAt: null,
        lastSuccessfulRunAt: null,
        lastSummary: null
    };

    const health = createHealthServer(() => ({
        inProgress: runtimeState.inProgress,
        shuttingDown: runtimeState.shuttingDown,
        lastRunAt: runtimeState.lastRunAt,
        lastSuccessfulRunAt: runtimeState.lastSuccessfulRunAt,
        lastSummary: runtimeState.lastSummary
    }), args.healthPort);

    let cronTask = null;

    const runTick = async () => {
        if (runtimeState.inProgress) {
            console.error('[tick] Saltado: ejecucion previa en curso');
            return;
        }

        runtimeState.inProgress = true;
        try {
            const summary = await runAllSitesOnce(db, options);
            runtimeState.lastRunAt = summary.finishedAt;
            runtimeState.lastSummary = summary;
            if (summary.failedCount === 0) {
                runtimeState.lastSuccessfulRunAt = summary.finishedAt;
            }
        } catch (err) {
            runtimeState.lastRunAt = new Date().toISOString();
            runtimeState.lastSummary = { error: err.message };
            console.error(`[tick] Error en corrida: ${err.message}`);
        } finally {
            runtimeState.inProgress = false;
        }
    };

    const shutdown = async (signal) => {
        if (runtimeState.shuttingDown) return;
        runtimeState.shuttingDown = true;
        console.error(`[shutdown] Recibido ${signal}, cerrando...`);

        if (cronTask) {
            cronTask.stop();
            console.error('[shutdown] Scheduler detenido');
        }

        if (runtimeState.inProgress) {
            console.error('[shutdown] Esperando a que finalice la corrida en curso...');
            await new Promise((resolve) => {
                const interval = setInterval(() => {
                    if (!runtimeState.inProgress) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 500);
            });
        }

        if (health.server) {
            await new Promise((resolve) => health.server.close(resolve));
            console.error('[shutdown] Health server detenido');
        }

        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    if (args.once) {
        await runTick();
        const failed = runtimeState.lastSummary?.failedCount || 0;
        process.exit(failed === 0 ? 0 : 1);
    }

    const cronExpr = args.schedule || process.env.SCRAPE_CRON;
    if (!cronExpr) {
        console.error('Debe indicar --once o --schedule <cron>, o definir SCRAPE_CRON en .env');
        console.error(usage());
        process.exit(1);
    }

    if (!cron.validate(cronExpr)) {
        console.error(`Expresion cron invalida: ${cronExpr}`);
        process.exit(1);
    }

    if (isTooFrequentExpression(cronExpr)) {
        console.error('[warn] Cron mas frecuente que 15 minutos. Se recomienda >= 15 minutos para evitar sobrecarga del sitio.');
    }

    console.error(`[scheduler] Iniciando con cron "${cronExpr}"`);
    cronTask = cron.schedule(cronExpr, () => {
        runTick().catch((err) => {
            console.error(`[scheduler] Error no controlado en tick: ${err.message}`);
        });
    });

    if (args.immediate) {
        await runTick();
    }
}

main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});
