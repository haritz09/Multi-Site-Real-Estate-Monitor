const fs = require('fs');
const path = require('path');
const IparraldeAdapter = require('./adapters/iparralde');

const adapters = {
    'iparralde': new IparraldeAdapter(),
};

async function main() {
    const args = process.argv.slice(2);
    let site = 'iparralde';
    let outFile = 'listings.json';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--site') {
            site = args[i + 1];
            i++;
        } else if (args[i] === '--out') {
            outFile = args[i + 1];
            i++;
        }
    }

    const adapter = adapters[site];
    if (!adapter) {
        console.error(`Error: No se encontró ningún adapter para el sitio '${site}'.`);
        console.error(`Sitios disponibles: ${Object.keys(adapters).join(', ')}`);
        process.exit(1);
    }

    console.error(`Iniciando scraping para el sitio: ${adapter.siteId}...`);
    
    try {
        const listings = await adapter.list({});
        
        // Validación: Asegurar que los IDs son válidos y no vacíos
        const validListings = listings.filter(item => item.id && item.id.trim() !== '');

        const outPath = path.resolve(process.cwd(), outFile);
        fs.writeFileSync(outPath, JSON.stringify(validListings, null, 2));
        
        console.error(`Éxito! Guardados ${validListings.length} listados válidos en ${outPath}`);
        
    } catch (error) {
        console.error(`Ocurrió un error scrapeando el sitio '${site}':`, error);
        process.exit(1);
    }
}

main();