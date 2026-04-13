const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@libsql/client');

dotenv.config({ path: path.resolve(__dirname, '.env') });

function openDb() {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url || !authToken) {
        throw new Error('Faltan TURSO_DATABASE_URL o TURSO_AUTH_TOKEN en milestone2/.env');
    }

    const db = createClient({ url, authToken });
    return { db, resolvedPath: url };
}

async function close() {
    // @libsql/client no requiere close explicito.
}

async function initSchema(db) {
    await db.execute(
        `CREATE TABLE IF NOT EXISTS apartments (
            id TEXT PRIMARY KEY,
            siteId TEXT NOT NULL,
            title TEXT,
            price TEXT,
            location TEXT,
            url TEXT,
            scrapedAt TEXT,
            createdAt TEXT DEFAULT (datetime('now')),
            updatedAt TEXT DEFAULT (datetime('now'))
        )`
    );

    await db.execute('CREATE INDEX IF NOT EXISTS idx_apartments_siteId ON apartments(siteId)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_apartments_scrapedAt ON apartments(scrapedAt)');
}

async function upsertApartments(db, listings, siteId = 'iparralde') {
    if (!Array.isArray(listings) || listings.length === 0) {
        return { insertedOrUpdated: 0 };
    }

    for (const item of listings) {
        await db.execute({
            sql: `INSERT INTO apartments (id, siteId, title, price, location, url, scrapedAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET
                      siteId = excluded.siteId,
                      title = excluded.title,
                      price = excluded.price,
                      location = excluded.location,
                      url = excluded.url,
                      scrapedAt = excluded.scrapedAt,
                      updatedAt = datetime('now')`,
            args: [
                item.id,
                siteId,
                item.title || null,
                item.price || null,
                item.location || null,
                item.detailUrl || item.url || null,
                item.scrapedAt || null,
            ],
        });
    }

    return { insertedOrUpdated: listings.length };
}

async function getStatus(db) {
    const totalResult = await db.execute('SELECT COUNT(*) AS total FROM apartments');
    const total = totalResult.rows?.[0]?.total || 0;

    const bySiteResult = await db.execute(
        `SELECT
            siteId,
            COUNT(*) AS total,
            MIN(scrapedAt) AS firstScraped,
            MAX(scrapedAt) AS lastScraped
         FROM apartments
         GROUP BY siteId
         ORDER BY siteId`
    );

    const bySite = (bySiteResult.rows || []).map((row) => ({
        siteId: row.siteId,
        total: row.total,
        firstScraped: row.firstScraped,
        lastScraped: row.lastScraped,
    }));

    return { total, bySite };
}

module.exports = {
    openDb,
    close,
    initSchema,
    upsertApartments,
    getStatus,
};
