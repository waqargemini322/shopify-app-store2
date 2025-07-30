// File: /netlify/functions/fetchImages.js

const fetch = require('node-fetch');
const archiver = require('archiver');
const { getStore } = require('@netlify/blobs');
const { v4: uuidv4 } = require('uuid');

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ message: 'Method Not Allowed' }) };
    }

    const { SHOPIFY_STORE_NAME, ADMIN_API_ACCESS_TOKEN, API_VERSION = '2024-04', NETLIFY_SITE_ID, NETLIFY_API_TOKEN } = process.env;
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

        // Pass manual credentials to the blob storage function
        const downloadUrl = await streamZipToBlobStorage(imageUrls, { siteID: NETLIFY_SITE_ID, token: NETLIFY_API_TOKEN });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: `Successfully bundled ${imageUrls.length} images. Your download is ready.`,
                downloadUrl: downloadUrl
            })
        };

    } catch (error) {
        console.error('Error:', error);
        return { statusCode: 500, body: JSON.stringify({ message: `An internal error occurred: ${error.message}` }) };
    }
};

async function streamZipToBlobStorage(urls, blobConfig) {
    // Manually configure the store with the siteID and token
    const imagesStore = getStore({
        name: 'shopify-images',
        siteID: blobConfig.siteID,
        token: blobConfig.token
    });

    const key = `${new Date().toISOString().split('T')[0]}-${uuidv4()}.zip`;
    const archive = archiver('zip', { zlib: { level: 9 } });

    const uploadPromise = imagesStore.set(key, archive, {
        metadata: { ttl: 900 }
    });

    for (let i = 0; i < urls.length; i++) {
        try {
            const response = await fetch(urls[i]);
            if (response.ok) {
                archive.append(response.body, { name: `image-${i + 1}.jpg` });
            }
        } catch (e) {
            console.error(`Could not download ${urls[i]}: ${e.message}`);
        }
    }

    await archive.finalize();
    await uploadPromise;

    const signedUrl = await imagesStore.get(key, { type: 'url' });
    return signedUrl;
}

// ... The rest of your helper functions (getAllImageUrlsByQuantity, etc.) remain unchanged ...

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
    let nextUrl = `https://${creds.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/${creds.API_VERSION}/orders.json?status=open&limit=250`;

    while (nextUrl) {
        const response = await fetch(nextUrl, {
            headers: { 'X-Shopify-Access-Token': creds.ADMIN_API_ACCESS_TOKEN }
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Shopify API error: ${response.statusText}. Details: ${errorBody}`);
        }
        
        const data = await response.json();
        const ordersPage = data.orders || [];

        if (ordersPage.length === 0) break;

        allOrders.push(...ordersPage);
        
        const oldestOrderNumInPage = ordersPage[ordersPage.length - 1].order_number;
        if (oldestOrderNumInPage < startNum) {
            break; 
        }

        const linkHeader = response.headers.get('link');
        nextUrl = null; 

        if (linkHeader) {
            const links = linkHeader.split(',');
            const nextLink = links.find(s => s.includes('rel="next"'));
            if (nextLink) {
                nextUrl = nextLink.match(/<(.*?)>/)[1];
            }
        }
    }
    
    return allOrders.filter(order => {
        const orderNum = order.order_number;
        return orderNum >= startNum && orderNum <= endNum;
    });
}