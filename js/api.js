/* ===== 飞凡AI - API 通信层 (v2.7.1) ===== */
/* 多协议：OpenAI / Anthropic 原生 / Gemini 原生 + 生图(images/generations)
   统一走 Cloudflare Functions 代理 + 流式 + 保活 + 重试 + 缓存 + token统计
   + 参数报错中文化 */

const API = (function () {

    const DEFAULT_PROFILES = {
        claude: {
            id: 'claude', name: 'Claude',
            engineType: 'chat', protocol: 'anthropic', authType: 'bearer',
            base: 'https://api.openai-proxy.org/v1', key: '', model: 'claude-opus-4-8',
            useTemp: true, temperature: 0.7, useMax: true, max_tokens: 4096,
            useTopP: false, top_p: 1, useFreq: false, frequency_penalty: 0,
            useCache: true, cacheTTL: '5m',
        },
        gemini: {
            id: 'gemini', name: 'Gemini',
            engineType: 'chat', protocol: 'gemini', authType: 'bearer',
            base: 'https://api.openai-proxy.org/v1', key: '', model: 'gemini-2.5-flash',
            useTemp: true, temperature: 0.7, useMax: true, max_tokens: 4096,
            useTopP: false, top_p: 1, useFreq: false, frequency_penalty: 0,
            useCache: false, cacheTTL: '5m',
        },
        openai: {
            id: 'openai', name: 'OpenAI',
            engineType: 'chat', protocol: 'openai', authType: 'bearer',
            base: 'https://api.openai-proxy.org/v1', key: '', model: 'gpt-4o-mini',
            useTemp: true, temperature: 0.7, useMax: true, max_tokens: 4096,
            useTopP: false, top_p: 1, useFreq: false, frequency_penalty: 0,
            useCache: false, cacheTTL: '5m',
        },
    };

    function getKeys(profile) {
        return [(profile.key || '').trim()];
    }

    function buildAuthHeaders(profile, key) {
        const h = { 'Authorization': 'Bearer ' + key };
        if ((profile.protocol || 'openai') === 'anthropic') {
            h['anthropic-version'] = '2023-06-01';
            if (profile.useCache && profile.cacheTTL === '1h') {
                h['anthropic-beta'] = 'extended-cache-ttl-2025-04-11';
            }
        }
        return h;
    }

    async function apiF(profile, path, options, key) {
        const opts = options || {};
        const url = '/api/' + path.replace(/^\//, '');
        const headers = Object.assign(
            { 'X-Target-Base': profile.base || '' },
            buildAuthHeaders(profile, key || ''),
            opts.headers || {}
        );
        if (!headers['Content-Type'] && opts.body) headers['Content-Type'] = 'application/json';
        return fetch(url, { method: opts.method || 'GET', headers: headers, body: opts.body, signal: opts.signal });
    }

    /* ---------- 参数报错中文化 ---------- */
    const PARAM_KEYS = ['temperature', 'top_p', 'max_tokens', 'frequency_penalty', 'presence_penalty'];
    function humanizeApiError(msg) {
        if (!msg) return msg;
        const low = msg.toLowerCase();
        const unsupported = /unsupported|not support|does not support|doesn't support|isn't supported|is not supported|unknown|invalid|unexpected|not allowed|不支持|无法识别/.test(low);
        if (!unsupported) return msg;
        for (const key of PARAM_KEYS) {
            if (low.includes(key.toLowerCase())) {
                return '此模型不适用 ' + key + ' 参数，请取消 ' + key + ' 参数的设置';
            }
        }
        return msg;
    }

    /* ============ 生图（images/generations） ============ */
    /* 返回 base64，非流式。handlers: onStart/onImage/onError */
    function generateImage(profile, prompt, opts, handlers) {
        opts = opts || {};
        const h = handlers || {};
        const ctrl = new AbortController();
        let aborted = false;

        (async () => {
            try {
                if (h.onStart) h.onStart();
                const key = getKeys(profile)[0];
                const payload = {
                    model: profile.model,
                    prompt: prompt,
                    n: opts.n || 1,
                    size: opts.size || '1024x1024',
                };
                // gpt-image 系列默认就返回 b64_json；dall-e 需显式指定
                if (/dall-e/i.test(profile.model || '')) payload.response_format = 'b64_json';

                const resp = await apiF(profile, 'images/generations', {
                    method: 'POST', body: JSON.stringify(payload), signal: ctrl.signal,
                }, key);

                if (!resp.ok) {
                    const errText = await resp.text();
                    throw new Error('HTTP ' + resp.status + ': ' + errText.slice(0, 300));
                }
                const data = await resp.json();
                const imgs = [];
                (data.data || []).forEach(item => {
                    if (item.b64_json) {
                        imgs.push('data:image/png;base64,' + item.b64_json);
                    } else if (item.url) {
                        imgs.push(item.url); // 兜底：万一返回 url
                    }
                });
                if (aborted) return;
                if (!imgs.length) throw new Error('未返回图片数据');
                if (h.onImage) h.onImage(imgs, data);
            } catch (err) {
                if (aborted || err.name === 'AbortError') return;
                if (h.onError) h.onError(err);
            }
        })();

        return { abort: function () { aborted = true; try { ctrl.abort(); } catch (e) {} } };
    }

    /* ============ OpenAI 协议 ============ */
    function buildPayloadOpenAI(profile, messages) {
        const payload = { model: profile.model, messages: messages, stream: true, stream_options: { include_usage: true } };
        if (profile.useTemp) payload.temperature = parseFloat(profile.temperature);
        if (profile.useMax)  payload.max_tokens  = parseInt(profile.max_tokens, 10);
        if (profile.useTopP) payload.top_p = parseFloat(profile.top_p);
        if (profile.useFreq) payload.frequency_penalty = parseFloat(profile.frequency_penalty);
        if (profile.useCache && /claude/i.test(profile.model || '')) applyOpenAICacheControl(payload.messages);
        return payload;
    }
    function applyOpenAICacheControl(messages) {
        const sysMsg = messages.find(m => m.role === 'system');
        if (sysMsg && typeof sysMsg.content === 'string' && sysMsg.content.length > 200) {
            sysMsg.content = [{ type: 'text', text: sysMsg.content, cache_control: { type: 'ephemeral' } }];
        }
        const userIdxs = [];
        messages.forEach((m, i) => { if (m.role === 'user') userIdxs.push(i); });
        if (userIdxs.length >= 2) {
            const m = messages[userIdxs[userIdxs.length - 2]];
            if (typeof m.content === 'string' && m.content.length > 200) {
                m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }];
            }
        }
    }
    function parseChunkOpenAI(jsonStr, usageBox) {
        try {
            const obj = JSON.parse(jsonStr);
            if (obj.usage) usageBox.usage = obj.usage;
            if (obj.choices && obj.choices[0]) {
                const c = obj.choices[0];
                if (c.delta && c.delta.content) return c.delta.content;
                if (c.message && c.message.content) return c.message.content;
            }
        } catch (e) {}
        return '';
    }

    /* ============ Anthropic 原生协议 ============ */
    function buildPayloadAnthropic(profile, messages) {
        let systemText = '';
        const conv = [];
        messages.forEach(m => {
            if (m.role === 'system') {
                const t = typeof m.content === 'string' ? m.content
                        : Array.isArray(m.content) ? m.content.map(p => p.text || '').join('\n') : '';
                systemText += (systemText ? '\n\n' : '') + t;
                return;
            }
            conv.push({ role: m.role, content: toAnthropicContent(m.content) });
        });
        const payload = { model: profile.model, stream: true,
            max_tokens: profile.useMax ? parseInt(profile.max_tokens, 10) : 4096, messages: conv };
        if (profile.useTemp) payload.temperature = parseFloat(profile.temperature);
        if (profile.useTopP) payload.top_p = parseFloat(profile.top_p);
        if (systemText) {
            if (profile.useCache) {
                const block = { type: 'text', text: systemText, cache_control: { type: 'ephemeral' } };
                if (profile.cacheTTL === '1h') block.cache_control.ttl = '1h';
                payload.system = [block];
            } else { payload.system = systemText; }
        }
        if (profile.useCache && conv.length >= 2) {
            const userIdxs = [];
            conv.forEach((m, i) => { if (m.role === 'user') userIdxs.push(i); });
            if (userIdxs.length >= 2) {
                const m = conv[userIdxs[userIdxs.length - 2]];
                const arr = Array.isArray(m.content) ? m.content : null;
                if (arr && arr.length) {
                    for (let j = arr.length - 1; j >= 0; j--) {
                        if (arr[j].type === 'text') {
                            arr[j].cache_control = { type: 'ephemeral' };
                            if (profile.cacheTTL === '1h') arr[j].cache_control.ttl = '1h';
                            break;
                        }
                    }
                }
            }
        }
        return payload;
    }
    function toAnthropicContent(content) {
        if (typeof content === 'string') return [{ type: 'text', text: content }];
        if (Array.isArray(content)) {
            return content.map(part => {
                if (part.type === 'text') {
                    const blk = { type: 'text', text: part.text || '' };
                    if (part.cache_control) blk.cache_control = part.cache_control;
                    return blk;
                }
                if (part.type === 'image_url') {
                    const url = (part.image_url && part.image_url.url) || '';
                    const m = url.match(/^data:(image\/\w+);base64,(.+)$/);
                    if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
                    return { type: 'text', text: '[图片]' };
                }
                return { type: 'text', text: '' };
            });
        }
        return [{ type: 'text', text: String(content || '') }];
    }
    function parseAnthropicEvent(eventName, dataStr, usageBox) {
        try {
            const obj = JSON.parse(dataStr);
            if (eventName === 'message_start' && obj.message && obj.message.usage)
                usageBox.usage = mergeAnthropicUsage(usageBox.usage, obj.message.usage);
            if (eventName === 'message_delta' && obj.usage)
                usageBox.usage = mergeAnthropicUsage(usageBox.usage, obj.usage);
            if (eventName === 'content_block_delta' && obj.delta) {
                if (obj.delta.type === 'text_delta') return obj.delta.text || '';
                if (typeof obj.delta.text === 'string') return obj.delta.text;
            }
        } catch (e) {}
        return '';
    }
    function mergeAnthropicUsage(prev, u) {
        const p = prev || {};
        return {
            input_tokens: u.input_tokens != null ? u.input_tokens : p.input_tokens,
            output_tokens: u.output_tokens != null ? u.output_tokens : p.output_tokens,
            cache_creation_input_tokens: u.cache_creation_input_tokens != null ? u.cache_creation_input_tokens : p.cache_creation_input_tokens,
            cache_read_input_tokens: u.cache_read_input_tokens != null ? u.cache_read_input_tokens : p.cache_read_input_tokens,
        };
    }

    /* ============ Gemini 原生协议 ============ */
    function buildPayloadGemini(profile, messages) {
        let systemText = '';
        const contents = [];
        messages.forEach(m => {
            if (m.role === 'system') {
                const t = typeof m.content === 'string' ? m.content
                        : Array.isArray(m.content) ? m.content.map(p => p.text || '').join('\n') : '';
                systemText += (systemText ? '\n\n' : '') + t;
                return;
            }
            const role = m.role === 'assistant' ? 'model' : 'user';
            contents.push({ role: role, parts: toGeminiParts(m.content) });
        });
        const payload = { contents: contents, generationConfig: {} };
        if (systemText) payload.systemInstruction = { parts: [{ text: systemText }] };
        if (profile.useTemp) payload.generationConfig.temperature = parseFloat(profile.temperature);
        if (profile.useMax)  payload.generationConfig.maxOutputTokens = parseInt(profile.max_tokens, 10);
        if (profile.useTopP) payload.generationConfig.topP = parseFloat(profile.top_p);
        return payload;
    }
    function toGeminiParts(content) {
        if (typeof content === 'string') return [{ text: content }];
        if (Array.isArray(content)) {
            return content.map(part => {
                if (part.type === 'text') return { text: part.text || '' };
                if (part.type === 'image_url') {
                    const url = (part.image_url && part.image_url.url) || '';
                    const m = url.match(/^data:(image\/\w+);base64,(.+)$/);
                    if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
                    return { text: '[图片]' };
                }
                return { text: '' };
            });
        }
        return [{ text: String(content || '') }];
    }
    function parseChunkGemini(jsonStr, usageBox) {
        try {
            const obj = JSON.parse(jsonStr);
            if (obj.usageMetadata) {
                usageBox.usage = {
                    prompt_tokens: obj.usageMetadata.promptTokenCount,
                    completion_tokens: obj.usageMetadata.candidatesTokenCount,
                    cached_tokens: obj.usageMetadata.cachedContentTokenCount || 0,
                };
            }
            const cand = obj.candidates && obj.candidates[0];
            if (cand && cand.content && cand.content.parts) return cand.content.parts.map(p => p.text || '').join('');
        } catch (e) {}
        return '';
    }

    /* ============ 协议分发 ============ */
    function buildRequest(profile, messages) {
        const proto = profile.protocol || 'openai';
        if (proto === 'anthropic')
            return { path: 'v1/messages', payload: buildPayloadAnthropic(profile, messages), mode: 'anthropic' };
        if (proto === 'gemini') {
            const model = encodeURIComponent(profile.model);
            return { path: 'v1beta/models/' + model + ':streamGenerateContent?alt=sse', payload: buildPayloadGemini(profile, messages), mode: 'gemini' };
        }
        return { path: 'chat/completions', payload: buildPayloadOpenAI(profile, messages), mode: 'openai' };
    }

    /* ============ 获取模型列表 ============ */
    async function fetchModels(profile) {
        const key = getKeys(profile)[0];
        const proto = profile.protocol || 'openai';
        let path = 'models';
        if (proto === 'anthropic') path = 'v1/models';
        if (proto === 'gemini') path = 'v1beta/models';
        const resp = await apiF(profile, path, { method: 'GET' }, key);
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
        const data = await resp.json();
        let list = [];
        if (Array.isArray(data.data)) list = data.data.map(m => m.id || m.name).filter(Boolean);
        else if (Array.isArray(data.models)) list = data.models.map(m => (m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
        else if (Array.isArray(data)) list = data.map(m => m.id || m.name || m).filter(Boolean);
        return list.sort();
    }

    /* ============ 测试连通 ============ */
    async function testConnection(profile) {
        try {
            const key = getKeys(profile)[0];
            const proto = profile.protocol || 'openai';
            let path = 'models';
            if (proto === 'anthropic') path = 'v1/models';
            if (proto === 'gemini') path = 'v1beta/models';
            const resp = await apiF(profile, path, { method: 'GET' }, key);
            if (resp.ok) return { ok: true, msg: '✅ 连接成功' };
            const body = (await resp.text()).slice(0, 150);
            return { ok: false, msg: '❌ HTTP ' + resp.status + ' ' + body };
        } catch (e) {
            return { ok: false, msg: '❌ ' + e.message };
        }
    }

    /* ============ 核心：流式对话 ============ */
    function streamChat(profile, messages, handlers) {
        const h = handlers || {};
        const ctrl = new AbortController();
        let lastChunkTime = Date.now();
        let aborted = false;
        let full = '';
        const usageBox = { usage: null };

        const HEARTBEAT_INTERVAL = 5000;
        const STALL_TIMEOUT = 60000;
        const heartbeat = setInterval(() => {
            if (aborted) return;
            if (Date.now() - lastChunkTime > STALL_TIMEOUT) {
                aborted = true; clearInterval(heartbeat);
                try { ctrl.abort(); } catch (e) {}
                if (h.onError) h.onError(new Error('网络无响应超过 60 秒，已自动中断'));
            }
        }, HEARTBEAT_INTERVAL);

        const onVisible = () => { if (!document.hidden && full && h.onDelta) h.onDelta('', full); };
        document.addEventListener('visibilitychange', onVisible);
        function cleanup() { clearInterval(heartbeat); document.removeEventListener('visibilitychange', onVisible); }

        (async () => {
            const req = buildRequest(profile, messages);
            const keys = getKeys(profile);
            const MAX_RETRY = 2;
            let lastErr = null;

            for (let ki = 0; ki < keys.length; ki++) {
                const key = keys[ki];
                if (aborted) break;
                for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
                    if (aborted) break;
                    try {
                        if (attempt > 0) { await sleep(1000 * Math.pow(2, attempt - 1)); if (aborted) break; }
                        if (h.onStart && ki === 0 && attempt === 0) h.onStart();

                        const resp = await apiF(profile, req.path, {
                            method: 'POST', body: JSON.stringify(req.payload), signal: ctrl.signal,
                        }, key);

                        if (!resp.ok) {
                            const errText = await resp.text();
                            let msg = 'HTTP ' + resp.status + ': ' + errText.slice(0, 300);
                            const human = humanizeApiError(errText);
                            if (human !== errText) msg = human;
                            if (resp.status >= 500 && attempt < MAX_RETRY) { lastErr = new Error(msg); continue; }
                            throw new Error(msg);
                        }

                        if (!resp.body) throw new Error('响应无 body 流');
                        const reader = resp.body.getReader();
                        const dec = new TextDecoder('utf-8');
                        let buffer = '';
                        let curEvent = '';
                        lastChunkTime = Date.now();

                        while (true) {
                            if (aborted) { try { reader.cancel(); } catch (e) {} break; }
                            const { done, value } = await reader.read();
                            if (done) { buffer += dec.decode(); break; }
                            lastChunkTime = Date.now();
                            buffer += dec.decode(value, { stream: true });
                            const lines = buffer.split('\n');
                            buffer = lines.pop();
                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (!trimmed) { curEvent = ''; continue; }
                                if (trimmed.startsWith('event:')) { curEvent = trimmed.slice(6).trim(); continue; }
                                if (!trimmed.startsWith('data:')) continue;
                                const dataStr = trimmed.slice(5).trim();
                                if (dataStr === '[DONE]') continue;
                                let delta = '';
                                if (req.mode === 'anthropic') delta = parseAnthropicEvent(curEvent, dataStr, usageBox);
                                else if (req.mode === 'gemini') delta = parseChunkGemini(dataStr, usageBox);
                                else delta = parseChunkOpenAI(dataStr, usageBox);
                                if (delta) { full += delta; if (h.onDelta) h.onDelta(delta, full); }
                            }
                        }
                        if (buffer.trim() && buffer.trim().startsWith('data:')) {
                            const dataStr = buffer.trim().slice(5).trim();
                            if (dataStr && dataStr !== '[DONE]') {
                                let delta = '';
                                if (req.mode === 'anthropic') delta = parseAnthropicEvent(curEvent, dataStr, usageBox);
                                else if (req.mode === 'gemini') delta = parseChunkGemini(dataStr, usageBox);
                                else delta = parseChunkOpenAI(dataStr, usageBox);
                                if (delta) { full += delta; if (h.onDelta) h.onDelta(delta, full); }
                            }
                        }

                        cleanup();
                        if (aborted) { if (h.onAbort) h.onAbort(full, normalizeUsage(req.mode, usageBox.usage)); }
                        else { if (h.onDone) h.onDone(full, normalizeUsage(req.mode, usageBox.usage)); }
                        return;
                    } catch (err) {
                        lastErr = err;
                        if (err.name === 'AbortError' || aborted) {
                            cleanup();
                            if (h.onAbort) h.onAbort(full, normalizeUsage(req.mode, usageBox.usage));
                            return;
                        }
                        if (attempt >= MAX_RETRY) break;
                        console.warn('[API] 重试', err.message);
                    }
                }
            }
            cleanup();
            if (h.onError) h.onError(lastErr || new Error('未知错误'));
        })();

        return { abort: function () { aborted = true; cleanup(); try { ctrl.abort(); } catch (e) {} }, get full() { return full; } };
    }

    function normalizeUsage(mode, usage) {
        if (!usage) return null;
        if (mode === 'anthropic') return {
            inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
            cacheWriteTokens: usage.cache_creation_input_tokens || 0, cacheReadTokens: usage.cache_read_input_tokens || 0,
        };
        if (mode === 'gemini') return {
            inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0,
            cacheWriteTokens: 0, cacheReadTokens: usage.cached_tokens || 0,
        };
        const details = usage.prompt_tokens_details || {};
        return {
            inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0,
            cacheWriteTokens: 0, cacheReadTokens: details.cached_tokens || 0,
        };
    }

    return {
        DEFAULT_PROFILES: DEFAULT_PROFILES,
        apiF: apiF, streamChat: streamChat, generateImage: generateImage,
        fetchModels: fetchModels, testConnection: testConnection, getKeys: getKeys,
    };
})();
