const { openDb } = require('./milestone6/db.js');

async function testQuery() {
    const { db } = openDb();
    
    console.log("--- 1. Testing Histogram (listings_current) ---");
    try {
        const resListings = await db.execute('SELECT price_num FROM listings_current WHERE active = 1 LIMIT 5');
        console.log("Recent active prices:", resListings.rows);
    } catch(e) { console.error(e) }

    console.log("\n--- 2. Testing Last Run (scrape_runs) ---");
    try {
        const resRun = await db.execute('SELECT run_id, started_at, finished_at FROM scrape_runs ORDER BY finished_at DESC LIMIT 3');
        console.log("Last 3 runs:", resRun.rows);
    } catch(e) { console.error(e) }

    console.log("\n--- 3. Testing listing_changes ---");
    try {
        const resChanges = await db.execute('SELECT change_type, run_id FROM listing_changes LIMIT 5');
        console.log("Sample changes:", resChanges.rows);
    } catch(e) { console.error(e) }

    process.exit(0);
}

testQuery();