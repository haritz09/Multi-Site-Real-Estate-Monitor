function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function buildListingsMap(listings) {
    const map = new Map();
    for (const item of listings || []) {
        if (item && item.id) {
            map.set(item.id, item);
        }
    }
    return map;
}

function buildMessageForChange(siteId, change, listing) {
    const title = escapeHtml(listing?.title || 'Sin titulo');
    const price = escapeHtml(listing?.price || 'N/A');
    const location = escapeHtml(listing?.location || 'N/A');
    const url = listing?.detailUrl || listing?.url || null;

    if (change.change_type === 'new') {
        return [
            '<b>Nueva vivienda detectada</b>',
            `<b>Site:</b> ${escapeHtml(siteId)}`,
            `<b>ID:</b> ${escapeHtml(change.listing_id)}`,
            `<b>Titulo:</b> ${title}`,
            `<b>Precio:</b> ${price}`,
            `<b>Ubicacion:</b> ${location}`,
            url ? `<b>URL:</b> <a href="${url}">Ver anuncio</a>` : '<b>URL:</b> N/A'
        ].join('\n');
    }

    return [
        '<b>Cambio detectado</b>',
        `<b>Tipo:</b> ${escapeHtml(change.change_type)}`,
        `<b>Site:</b> ${escapeHtml(siteId)}`,
        `<b>ID:</b> ${escapeHtml(change.listing_id)}`,
        `<b>Titulo:</b> ${title}`,
        `<b>Precio:</b> ${price}`,
        `<b>Ubicacion:</b> ${location}`
    ].join('\n');
}

async function sendTelegramMessage(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        throw new Error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en milestone4/.env');
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: 'true'
        })
    });

    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Telegram API ${response.status}: ${details}`);
    }

    const payload = await response.json();
    if (!payload.ok) {
        throw new Error(`Telegram API error: ${JSON.stringify(payload)}`);
    }
}

async function sendChangesNotification({ siteId, changes, listings }) {
    const listingsMap = buildListingsMap(listings);
    const newChanges = (changes || []).filter((change) => change.change_type === 'new');

    if (newChanges.length === 0) {
        return;
    }

    for (const change of newChanges) {
        const listing = listingsMap.get(change.listing_id);
        const text = buildMessageForChange(siteId, change, listing);
        await sendTelegramMessage(text);
    }
}

module.exports = {
    sendChangesNotification,
    sendTelegramMessage
};
