// File: /netlify/functions/fetchImages.js

const fetch = require('node-fetch');
const archiver = require('archiver');

// Main handler function for the serverless endpoint
exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ message: 'Method Not Allowed' }) };
    }

    // *** CORRECTED API VERSION ***
    const { SHOPIFY_STORE_NAME, ADMIN_API_ACCESS_TOKEN, API_VERSION = '2024-04' } = process.env;
    if (!SHOPIFY_STORE_NAME || !ADMIN_API_ACCESS_TOKEN) {
        return { statusCode: 500, body: JSON.stringify({ message: 'Server configuration error.' }) };
    }

    try {
        const body = JSON.parse(event.body);
        const credentials = { SHOPIFY_STORE_NAME, ADMIN_API_ACCESS_TOKEN, API_VERSION };
        let orders = [];

        if (body.type === 'date') {
            orders = await getOrdersByDate(body.date, credentials);
        } else if (body.type === 'order_range') {
            orders = await getOrdersByNumberRange(body.start, body.end, credentials);
        } else {
            return { statusCode: 400, body: JSON.stringify({ message: 'Invalid request type.' }) };
        }

        if (!orders.length) {
            return { statusCode: 200, body: JSON.stringify({ message: 'No unfulfilled orders found for the selected criteria.' }) };
        }

        const imageUrls = await getAllImageUrlsByQuantity(orders, credentials);
        
        if (!imageUrls.length) {
            return { statusCode: 200, body: JSON.stringify({ message: 'No product images found in these unfulfilled orders.' }) };
        }

        const zipBase64 = await createZipFromUrls(imageUrls);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: `Successfully bundled ${imageUrls.length} images from unfulfilled orders.`,
                zipData: zipBase64,
                fileName: `shopify-images-${new Date().toISOString().split('T')[0]}.zip`
            })
        };

    } catch (error) {
        console.error('Error:', error);
        return { statusCode: 500, body: JSON.stringify({ message: `An internal error occurred: ${error.message}` }) };
    }
};

// --- Helper Functions ---

async function createZipFromUrls(urls) {
    return new Promise(async (resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: 9 } });
        const chunks = [];

        archive.on('data', chunk => chunks.push(chunk));
        archive.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
        archive.on('error', reject);

        for (let i = 0; i < urls.length; i++) {
            try {
                const response = await fetch(urls[i]);
                if (response.ok) {
                    const buffer = await response.buffer();
                    archive.append(buffer, { name: `image-${i + 1}.jpg` });
                }
            } catch (e) {
                console.error(`Could not download ${urls[i]}: ${e.message}`);
            }
        }
        
        archive.finalize();
    });
}

async function getAllImageUrlsByQuantity(orders, creds) {
    const finalImageUrlList = [];
    const productImageCache = new Map();
    for (const order of orders) {
        for (const item of order.line_items) {
            if (!item.product_id) continue;
            let imageUrl = '';
            if (productImageCache.has(item.product_id)) {
                imageUrl = productImageCache.get(item.product_id);
            } else {
                const url = `https://${creds.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/${creds.API_VERSION}/products/${item.product_id}.json`;
                try {
                    const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': creds.ADMIN_API_ACCESS_TOKEN } });
                    if (response.ok) {
                        const { product } = await response.json();
                        if (product && product.image && product.image.src) {
                            imageUrl = product.image.src;
                            productImageCache.set(item.product_id, imageUrl);
                        } else {
                            productImageCache.set(item.product_id, null);
                        }
                    }
                } catch (e) { console.error(`Failed to fetch product ${item.product_id}:`, e); }
            }
            if (imageUrl) {
                for (let i = 0; i < item.quantity; i++) {
                    finalImageUrlList.push(imageUrl);
                }
            }
        }
    }
    return finalImageUrlList;
}

async function getOrdersByDate(date, creds) {
    const startDate = new Date(date);
    startDate.setUTCHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setUTCHours(23, 59, 59, 999);

    const params = new URLSearchParams({
        status: 'open',
        created_at_min: startDate.toISOString(),
        created_at_max: endDate.toISOString(),
        limit: '250'
    });

    const url = `https://${creds.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/${creds.API_VERSION}/orders.json?${params.toString()}`;
    const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': creds.ADMIN_API_ACCESS_TOKEN } });
    if (!response.ok) throw new Error(`Shopify API error: ${response.statusText}`);
    const data = await response.json();
    return data.orders || [];
}

async function getOrdersByNumberRange(startNum, endNum, creds) {
    let allOrders = [];
    // Start with the initial URL for the first page of open orders
    let nextUrl = `https://${creds.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/${creds.API_VERSION}/orders.json?status=open&limit=250`;

    // Loop as long as Shopify provides a URL for the next page
    while (nextUrl) {
        const response = await fetch(nextUrl, {
            headers: { 'X-Shopify-Access-Token': creds.ADMIN_API_ACCESS_TOKEN }
        });

        if (!response.ok) {
            // Improved error logging to see details from Shopify
            const errorBody = await response.text();
            throw new Error(`Shopify API error: ${response.statusText}. Details: ${errorBody}`);
        }
        
        const data = await response.json();
        const ordersPage = data.orders || [];

        if (ordersPage.length === 0) break;

        allOrders.push(...ordersPage);
        
        // Optimization: Stop fetching if the oldest order on the page is already below our start number
        const oldestOrderNumInPage = ordersPage[ordersPage.length - 1].order_number;
        if (oldestOrderNumInPage < startNum) {
            break; 
        }

        // --- New Cursor-Based Pagination Logic ---
        const linkHeader = response.headers.get('link');
        nextUrl = null; // Reset for the next loop

        if (linkHeader) {
            const links = linkHeader.split(',');
            const nextLink = links.find(s => s.includes('rel="next"'));
            if (nextLink) {
                // Extract the URL for the next page provided by Shopify
                nextUrl = nextLink.match(/<(.*?)>/)[1];
            }
        }
    }
    
    // Finally, filter the collected orders to match the exact number range
    return allOrders.filter(order => {
        const orderNum = order.order_number; // Use the more reliable 'order_number' field
        return orderNum >= startNum && orderNum <= endNum;
    });
}