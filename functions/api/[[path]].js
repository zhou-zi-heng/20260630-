export async function onRequest(context) {
    const { request } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Max-Age': '86400',
            }
        });
    }

    const targetBase = request.headers.get('X-Target-Base');
    if (!targetBase) {
        return new Response(JSON.stringify({ error: 'Missing X-Target-Base header' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    const url = new URL(request.url);
    const subPath = url.pathname.replace(/^\/api\//, '');
    const targetUrl = targetBase.replace(/\/+$/, '') + '/' + subPath + url.search;

    const headers = new Headers();
    const skipHeaders = [
        'host', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-worker',
        'cf-ipcountry', 'cf-ew-via', 'x-target-base', 'content-length',
    ];
    for (const [key, value] of request.headers) {
        if (!skipHeaders.includes(key.toLowerCase())) headers.set(key, value);
    }

    const isAnthropicPath = /\/messages\b/.test(targetUrl) || /anthropic/i.test(targetBase);
    if (isAnthropicPath && !headers.has('anthropic-version')) {
        headers.set('anthropic-version', '2023-06-01');
    }

    try {
        const resp = await fetch(targetUrl, {
            method: request.method,
            headers: headers,
            body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
        });
        const newHeaders = new Headers(resp.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Access-Control-Expose-Headers', '*');
        return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: newHeaders });
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Proxy failed: ' + e.message }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}