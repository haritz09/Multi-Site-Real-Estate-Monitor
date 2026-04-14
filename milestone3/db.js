const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@libsql/client');

dotenv.config({ path: path.resolve(__dirname, '.env') });

const MAX_MISS_COUNT = 3;

function openDb() {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url || !authToken) {
        throw new Error('Faltan TURSO_DATABASE_URL o TURSO_AUTH_TOKEN en milestone3/.env');
    }

    const db = createClient({ url, authToken });
    return { db, resolvedPath: url };
}

function normalizePrice(priceStr) {
    if (!priceStr) return null;
    const cleanStr = priceStr.replace(/[^\d]/g, '');
    const num = parseInt(cleanStr, 10);
    return isNaN(num) ? null : num;
}

function normalizeText(text) {
    if (!text) return null;
    return text.replace(/\s+/g, ' ').trim();
}

async function initSchema(db) {
    // scrape_runs
    await db.execute(`
        CREATE TABLE IF NOT EXISTS scrape_runs (
            run_id TEXT PRIMARY KEY,
            siteId TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            listings_found INTEGER DEFAULT 0,
            status TEXT NOT NULL
        )
    `);

    // listings_current
    await db.execute(`
        CREATE TABLE IF NOT EXISTS listings_current (
            id TEXT PRIMARY KEY,
            siteId TEXT NOT NULL,
            title TEXT,
            price TEXT,
            price_num INTEGER,
            location TEXT,
            url TEXT,
            active INTEGER DEFAULT 1,
            miss_count INTEGER DEFAULT 0,
            first_seen TEXT NOT NULL,
            last_seen TEXT NOT NULL
        )
    `);

    // listings_snapshot
    await db.execute(`
        CREATE TABLE IF NOT EXISTS listings_snapshot (
            id TEXT,
            run_id TEXT,
            siteId TEXT,
            title TEXT,
            price TEXT,
            price_num INTEGER,
            location TEXT,
            url TEXT,
            scraped_at TEXT,
            PRIMARY KEY (id, run_id)
        )
    `);

    // listing_changes
    await db.execute(`
        CREATE TABLE IF NOT EXISTS listing_changes (
            change_id TEXT PRIMARY KEY,
            listing_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            change_type TEXT NOT NULL,
            diff_json TEXT,
            created_at TEXT NOT NULL
        )
    `);
}

async function startScrapeRun(db, siteId) {
    const runId = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
    const startedAt = new Date().toISOString();
    
    await db.execute({
        sql: `INSERT INTO scrape_runs (run_id, siteId, started_at, status) VALUES (?, ?, ?, ?)`,
        args: [runId, siteId, startedAt, 'started']
    });

    return runId;
}

async function finishScrapeRun(db, runId, status, listingsFound) {
    const finishedAt = new Date().toISOString();
    await db.execute({
        sql: `UPDATE scrape_runs SET finished_at = ?, status = ?, listings_found = ? WHERE run_id = ?`,
        args: [finishedAt, status, listingsFound, runId]
    });
}

function generateUUID() {
    return Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
}

async function processListings(db, runId, siteId, listings, dryRun = false) {
    const scrapedIds = new Set();
    const timestamp = new Date().toISOString();

    const changesLog = [];

    // Get current state to compare
    const result = await db.execute({
        sql: `SELECT * FROM listings_current WHERE siteId = ?`,
        args: [siteId]
    });

    const currentMap = new Map();
    for (const row of result.rows) {
        currentMap.set(row.id, row);
    }

    for (const item of listings) {
        if (!item.id) continue;
        scrapedIds.add(item.id);

        const normTitle = normalizeText(item.title);
        const normLocation = normalizeText(item.location);
        const normPriceStr = normalizeText(item.price);
        const priceNum = normalizePrice(item.price);
        const url = item.detailUrl || item.url || null;

        const current = currentMap.get(item.id);

        if (!current) {
            // NEW LISTING
            changesLog.push({
                listing_id: item.id,
                change_type: 'new',
                diff_json: JSON.stringify([{ field: 'status', old: null, new: 'new' }])
            });

            if (!dryRun) {
                await db.execute({
                    sql: `INSERT INTO listings_current (id, siteId, title, price, price_num, location, url, active, miss_count, first_seen, last_seen)
                          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
                    args: [item.id, siteId, normTitle, normPriceStr, priceNum, normLocation, url, timestamp, timestamp]
                });
            }
        } else {
            // EXISTING LISTING
            const priceDiffs = [];
            const attrDiffs = [];
            
            if (current.price_num !== priceNum) {
                priceDiffs.push({ field: 'price_num', old: current.price_num, new: priceNum });
                priceDiffs.push({ field: 'price', old: current.price, new: normPriceStr });
            }
            if (current.title !== normTitle) {
                attrDiffs.push({ field: 'title', old: current.title, new: normTitle });
            }
            if (current.location !== normLocation) {
                attrDiffs.push({ field: 'location', old: current.location, new: normLocation });
            }

            if (current.active === 0) {
                // If it was removed and now reappeared, generate a 'new' event
                changesLog.push({
                    listing_id: item.id,
                    change_type: 'new',
                    diff_json: JSON.stringify([{ field: 'status', old: 'removed', new: 'active' }])
                });
            } else {
                if (priceDiffs.length > 0) {
                    changesLog.push({
                        listing_id: item.id,
                        change_type: 'price_changed',
                        diff_json: JSON.stringify(priceDiffs)
                    });
                }
                if (attrDiffs.length > 0) {
                    changesLog.push({
                        listing_id: item.id,
                        change_type: 'attributes_changed',
                        diff_json: JSON.stringify(attrDiffs)
                    });
                }
            }

            if (!dryRun) {
                await db.execute({
                    sql: `UPDATE listings_current 
                          SET title = ?, price = ?, price_num = ?, location = ?, url = ?, active = 1, miss_count = 0, last_seen = ? 
                          WHERE id = ?`,
                    args: [normTitle, normPriceStr, priceNum, normLocation, url, timestamp, item.id]
                });
            }
        }

        // SNAPSHOT (always record the state seen in this run)
        if (!dryRun) {
            await db.execute({
                sql: `INSERT INTO listings_snapshot (id, run_id, siteId, title, price, price_num, location, url, scraped_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [item.id, runId, siteId, normTitle, normPriceStr, priceNum, normLocation, url, timestamp]
            });
        }
    }

    // CHECK FOR REMOVALS
    for (const [id, current] of currentMap.entries()) {
        if (!scrapedIds.has(id)) {
            // It's missing
            const newMissCount = current.miss_count + 1;
            
            if (newMissCount >= MAX_MISS_COUNT && current.active === 1) {
                changesLog.push({
                    listing_id: id,
                    change_type: 'removed',
                    diff_json: JSON.stringify([{ field: 'status', old: 'active', new: 'removed' }])
                });

                if (!dryRun) {
                    await db.execute({
                        sql: `UPDATE listings_current SET active = 0, miss_count = ? WHERE id = ?`,
                        args: [newMissCount, id]
                    });
                }
            } else if (current.active === 1) {
                if (!dryRun) {
                    await db.execute({
                        sql: `UPDATE listings_current SET miss_count = ? WHERE id = ?`,
                        args: [newMissCount, id]
                    });
                }
            }
        }
    }

    // RECORD CHANGES
    if (!dryRun) {
        for (const change of changesLog) {
            await db.execute({
                sql: `INSERT INTO listing_changes (change_id, listing_id, run_id, change_type, diff_json, created_at)
                      VALUES (?, ?, ?, ?, ?, ?)`,
                args: [generateUUID(), change.listing_id, runId, change.change_type, change.diff_json, timestamp]
            });
        }
    }

    return changesLog;
}

module.exports = {
    openDb,
    initSchema,
    startScrapeRun,
    finishScrapeRun,
    processListings,
};