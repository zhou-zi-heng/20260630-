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
    let targetUrl = targetBase.replace(/\/+$/, '') + '/' + subPath + url.search;

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

    // ★ 关键修复：把 body 读成可重发的 buffer（解决一次性流遇重定向报错）
    let bodyBuf = undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        try {
            bodyBuf = await request.arrayBuffer();
        } catch (e) {
            bodyBuf = undefined;
        }
    }

    // ★ 手动处理重定向（最多 5 次），每次都用 buffer 重发，避免流报错
    async function fetchFollow(u, maxRedirect) {
        let curUrl = u;
        const chain = [];
        for (let i = 0; i <= maxRedirect; i++) {
            const resp = await fetch(curUrl, {
                method: request.method,
                headers: headers,
                body: bodyBuf,
                redirect: 'manual',
            });
            if (resp.status >= 300 && resp.status < 400) {
                const loc = resp.headers.get('location');
                chain.push(resp.status + ' → ' + (loc || '(无location)') + ' [from: ' + curUrl + ']');
                if (loc) {
                    curUrl = new URL(loc, curUrl).toString();
                    continue;
                }
            }
            return resp;
        }
        throw new Error('重定向次数过多。跳转链路：\n' + chain.join('\n'));
    }


    try {
        const resp = await fetchFollow(targetUrl, 5);
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
