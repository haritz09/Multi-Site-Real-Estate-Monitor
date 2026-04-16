const fastify = require('fastify')({ logger: false });
const cors = require('@fastify/cors');
const path = require('path');
const { openDb } = require('./db');

fastify.register(cors, { origin: true });

fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'frontend/dist'),
  prefix: '/', 
});

let dbInstance = null;

const getDb = () => {
    if (!dbInstance) {
        const { db } = openDb();
        dbInstance = db;
    }
    return dbInstance;
}

// 1. Current listings table
fastify.get('/api/listings', async (request, reply) => {
    try {
        const db = getDb();
        const res = await db.execute(
            'SELECT id, siteId, title, price, price_num, location, url, first_seen, last_seen FROM listings_current WHERE active = 1 ORDER BY last_seen DESC'
        );
        return res.rows;
    } catch (e) {
        console.error(e);
        return reply.status(500).send({ error: e.message });
    }
});

// 2. Change log
fastify.get('/api/changes', async (request, reply) => {
    try {
        const db = getDb();
        const res = await db.execute(`
            SELECT c.change_id, c.listing_id, c.change_type, c.diff_json, c.created_at, 
                   l.title, l.url, l.price as current_price
            FROM listing_changes c
            LEFT JOIN listings_current l ON c.listing_id = l.id
            ORDER BY c.created_at DESC
            LIMIT 50
        `);
        return res.rows.map(r => ({
            ...r,
            diff_json: JSON.parse(r.diff_json || '{}')
        }));
    } catch (e) {
        console.error(e);
        return reply.status(500).send({ error: e.message });
    }
});

// 3. Summary stats
fastify.get('/api/stats', async (request, reply) => {
    try {
        const db = getDb();
        const activeRes = await db.execute('SELECT COUNT(*) as count FROM listings_current WHERE active = 1');
        
        // changes since last run (we search the latest run that generated changes, or the latest run overall if we strictly want 'the last run')
        // Given your screenshot shows changes from a specific run, let's find the last run that actually produced changes, or simply the last run in scrape_runs
        const lastRunWithChangesRes = await db.execute('SELECT run_id FROM listing_changes ORDER BY created_at DESC LIMIT 1');
        const lastRunId = lastRunWithChangesRes.rows.length > 0 ? lastRunWithChangesRes.rows[0].run_id : null;

        let changesList = [];
        if (lastRunId) {
            const changesRes = await db.execute({
                sql: 'SELECT change_type, COUNT(*) as count FROM listing_changes WHERE run_id = ? GROUP BY change_type',
                args: [lastRunId]
            });
            changesList = changesRes.rows;
        }

        // histogram
        const histRes = await db.execute(`
           SELECT
             CASE
               WHEN (price_num / 100) < 150000 THEN '< 150k'
               WHEN (price_num / 100) >= 150000 AND (price_num / 100) < 250000 THEN '150k-250k'
               WHEN (price_num / 100) >= 250000 AND (price_num / 100) < 350000 THEN '250k-350k'
               WHEN (price_num / 100) >= 350000 AND (price_num / 100) < 500000 THEN '350k-500k'
               ELSE '> 500k'
             END as range,
             COUNT(*) as count
           FROM listings_current
           WHERE active = 1 AND price_num IS NOT NULL
           GROUP BY range
        `);

        // Sort the histogram manually
        const sortOrder = { '< 150k': 1, '150k-250k': 2, '250k-350k': 3, '350k-500k': 4, '> 500k': 5 };
        const histogram = histRes.rows.sort((a, b) => sortOrder[a.range] - sortOrder[b.range]);

        return {
            total_active: activeRes.rows[0].count,
            recent_changes: changesList,
            histogram: histogram
        };
    } catch (e) {
        console.error(e);
        return reply.status(500).send({ error: e.message });
    }
});

// 4. Per-listing price history for sparkline rendering in frontend
fastify.get('/api/history', async (request, reply) => {
    try {
        const db = getDb();
        const res = await db.execute(`
            SELECT listing_id, change_type, diff_json, created_at
            FROM listing_changes
            WHERE change_type IN ('new', 'price_changed')
            ORDER BY created_at ASC
        `);

        const historyByListing = {};
        const parsePriceToEuros = (value) => {
            if (!value) return null;
            const raw = parseInt(String(value).replace(/[^\d]/g, ''), 10);
            if (Number.isNaN(raw)) return null;
            return raw / 100;
        };

        for (const row of res.rows) {
            const diff = JSON.parse(row.diff_json || '{}');

            if (!historyByListing[row.listing_id]) {
                historyByListing[row.listing_id] = [];
            }

            const series = historyByListing[row.listing_id];

            // For a single price change event, include old->new so sparkline has visible slope.
            if (row.change_type === 'price_changed') {
                const oldPrice = parsePriceToEuros(diff.old_price);
                const newPrice = parsePriceToEuros(diff.new_price);
                if (oldPrice !== null) {
                    const last = series[series.length - 1];
                    if (!last || last.price !== oldPrice) {
                        series.push({ date: row.created_at, price: oldPrice });
                    }
                }
                if (newPrice !== null) {
                    series.push({ date: row.created_at, price: newPrice });
                }
                continue;
            }

            const listingPrice = parsePriceToEuros(diff.new_price);
            if (listingPrice !== null) {
                series.push({ date: row.created_at, price: listingPrice });
            }
        }

        return historyByListing;
    } catch (e) {
        console.error(e);
        return reply.status(500).send({ error: e.message });
    }
});

const start = async (overridePort) => {
    const args = process.argv.slice(2);
    const portFlagIdx = args.indexOf('--port');
    const portFromArgs = portFlagIdx !== -1 ? Number(args[portFlagIdx + 1]) : 3000;
    const port = overridePort || portFromArgs;

    try {
        await fastify.listen({ port: port, host: '0.0.0.0' });
        console.log(`[dashboard] Dashboard API running on http://localhost:${port}`);
    } catch (err) {
        console.error("Error starting fastify:");
        console.error(err);
        process.exit(1);
    }
};

if (require.main === module) {
    start();
}

module.exports = { start };
