/* ===== 飞凡AI - UI 渲染层 ===== */

const UI = (function () {

    /* ---------- Markdown 渲染器 ---------- */
    let _md = null;
    function getMD() {
        if (_md) return _md;
        if (typeof markdownit === 'undefined') return null;
        _md = markdownit({
            html: false,
            linkify: true,
            breaks: true,
            highlight: function (str, lang) {
                if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
                    try {
                        return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
                    } catch (e) {}
                }
                return '';
            },
        });
        // 插件
        try {
            if (window.markdownitSub) _md.use(window.markdownitSub);
            if (window.markdownitSup) _md.use(window.markdownitSup);
            if (window.markdownitMark) _md.use(window.markdownitMark);
            if (window.markdownitFootnote) _md.use(window.markdownitFootnote);
            if (window.markdownitTaskLists) _md.use(window.markdownitTaskLists, { enabled: false });
            if (window.markdownitEmoji && window.markdownitEmoji.full) _md.use(window.markdownitEmoji.full);
        } catch (e) {
            console.warn('[MD plugin]', e);
        }
        return _md;
    }

    /* ---------- 渲染 Markdown 文本 → HTML（含数学/Mermaid） ---------- */
    function renderMarkdown(text) {
        const md = getMD();
        let html;
        if (md) {
            html = md.render(text || '');
        } else {
            html = '<p>' + esc(text) + '</p>';
        }

        // DOMPurify 清洗
        if (window.DOMPurify) {
            html = window.DOMPurify.sanitize(html, {
                ADD_TAGS: ['mark', 'sub', 'sup'],
                ADD_ATTR: ['target'],
            });
        }

        return html;
    }

    /* ---------- 渲染数学公式（KaTeX） ---------- */
    function renderMath(container) {
        if (!window.katex) return;
        // 块公式 $$...$$
        const blockRegex = /\$\$([\s\S]+?)\$\$/g;
        // 行内公式 $...$
        const inlineRegex = /\$([^\$\n]+?)\$/g;

        function processNode(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent;
                if (!text.includes('$')) return;
                const parent = node.parentNode;
                if (!parent || parent.tagName === 'CODE' || parent.tagName === 'PRE') return;

                let html = esc(text);
                html = html.replace(blockRegex, (_, expr) => {
                    try {
                        return katex.renderToString(expr, { displayMode: true, throwOnError: false });
                    } catch (e) { return _; }
                });
                html = html.replace(inlineRegex, (_, expr) => {
                    try {
                        return katex.renderToString(expr, { displayMode: false, throwOnError: false });
                    } catch (e) { return _; }
                });
                if (html !== esc(text)) {
                    const span = document.createElement('span');
                    span.innerHTML = html;
                    parent.replaceChild(span, node);
                }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.tagName === 'CODE' || node.tagName === 'PRE') return;
                const children = Array.from(node.childNodes);
                children.forEach(processNode);
            }
        }
        processNode(container);
    }

    /* ---------- 渲染 Mermaid 图表 ---------- */
    function renderMermaid(container) {
        if (!window.mermaid) return;
        const blocks = container.querySelectorAll('pre code.language-mermaid, pre code.language-mmd');
        blocks.forEach((codeEl, i) => {
            const code = codeEl.textContent;
            const wrap = document.createElement('div');
            wrap.className = 'mermaid-wrap';
            wrap.id = 'mer-' + Date.now() + '-' + i;
            wrap.textContent = code;
            const pre = codeEl.closest('pre');
            if (pre && pre.parentNode) pre.parentNode.replaceChild(wrap, pre);
            try {
                mermaid.run({ nodes: [wrap] });
            } catch (e) {
                console.warn('[Mermaid]', e);
            }
        });
    }

    /* ---------- 包装代码块（添加复制按钮 + 折叠） ---------- */
    function wrapCodeBlocks(container) {
        const pres = container.querySelectorAll('pre');
        pres.forEach(pre => {
            if (pre.parentNode.classList.contains('code-wrap')) return;
            const code = pre.querySelector('code');
            if (!code) return;
            const langClass = (code.className || '').match(/language-(\w+)/);
            const lang = langClass ? langClass[1] : '';
            const text = code.textContent;
            const long = text.split('\n').length > 15;

            const wrap = document.createElement('div');
            wrap.className = 'code-wrap' + (long ? ' code-collapsed' : '');

            if (lang) {
                const tag = document.createElement('div');
                tag.className = 'code-lang';
                tag.textContent = lang;
                wrap.appendChild(tag);
            }

            const copyBtn = document.createElement('button');
            copyBtn.className = 'code-copy-top';
            copyBtn.textContent = '复制';
            copyBtn.onclick = (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(text).then(() => {
                    copyBtn.textContent = '✓ 已复制';
                    setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
                }).catch(() => toast('复制失败', 'er'));
            };
            wrap.appendChild(copyBtn);

            pre.parentNode.replaceChild(wrap, pre);
            wrap.appendChild(pre);

            if (long) {
                const toggle = document.createElement('div');
                toggle.className = 'code-toggle';
                const btn = document.createElement('button');
                btn.textContent = '展开全部';
                btn.onclick = () => {
                    wrap.classList.toggle('code-collapsed');
                    btn.textContent = wrap.classList.contains('code-collapsed') ? '展开全部' : '收起';
                };
                toggle.appendChild(btn);
                wrap.appendChild(toggle);
            }

            // 底部复制按钮
            const bottom = document.createElement('div');
            bottom.className = 'code-copy-bottom';
            const btnB = document.createElement('button');
            btnB.textContent = '📋 复制代码';
            btnB.onclick = () => {
                navigator.clipboard.writeText(text).then(() => {
                    btnB.textContent = '✓ 已复制';
                    setTimeout(() => { btnB.textContent = '📋 复制代码'; }, 1500);
                }).catch(() => toast('复制失败', 'er'));
            };
            bottom.appendChild(btnB);
            wrap.appendChild(bottom);
        });
    }

    /* ---------- 完整渲染流程（用于消息完成后） ---------- */
    function fullRender(bubElement, text) {
        bubElement.classList.remove('streaming');
        bubElement.innerHTML = renderMarkdown(text);
        try {
            renderMath(bubElement);
            wrapCodeBlocks(bubElement);
            renderMermaid(bubElement);
            // 图片点击放大
            bubElement.querySelectorAll('img').forEach(img => {
                img.onclick = () => {
                    const lb = document.getElementById('lightbox');
                    const lbImg = document.getElementById('lbImg');
                    if (lb && lbImg) { lbImg.src = img.src; lb.classList.add('show'); }
                };
                // 生成图加下载按钮
                if (img.src.startsWith('data:image') && !img.dataset._dlAdded) {
                    img.dataset._dlAdded = '1';
                    const dl = document.createElement('a');
                    dl.textContent = '⬇ 下载此图';
                    dl.href = img.src;
                    dl.download = 'feifan-img-' + Date.now() + '.png';
                    dl.style.cssText = 'display:inline-block;margin:4px 0;font-size:12px;color:var(--pri);text-decoration:underline;cursor:pointer';
                    dl.onclick = (e) => e.stopPropagation();
                    if (img.parentNode) img.parentNode.insertBefore(dl, img.nextSibling);
                }
            });

        } catch (e) {
            console.warn('[fullRender]', e);
        }
    }

    /* ---------- 流式渲染（节流，仅文本） ---------- */
    /* 流式过程中只更新文本（避免反复 markdown 解析卡死） */
    /* 完成后调用 fullRender 一次性渲染 markdown */
    function streamRender(bubElement, text) {
        if (!bubElement.classList.contains('streaming')) {
            bubElement.classList.add('streaming');
        }
        bubElement.textContent = text;
    }

    /* ---------- 创建消息 DOM ---------- */
    function createMessageNode(msg, options) {
        const opts = options || {};
        const wrap = document.createElement('div');
        wrap.className = 'msg ' + msg.role;
        wrap.dataset.msgId = msg.id || '';

        const av = document.createElement('div');
        av.className = 'av';
        av.textContent = msg.role === 'user' ? '👤' : '🤖';
        wrap.appendChild(av);

        const m = document.createElement('div');
        m.className = 'm';

        // 附件徽章（先占位，第三批实现）
        if (msg.attachments && msg.attachments.length) {
            const mf = document.createElement('div');
            mf.className = 'mf';
            msg.attachments.forEach(a => {
                const fb = document.createElement('span');
                fb.className = 'fb';
                fb.textContent = '📎 ' + (a.name || 'file');
                mf.appendChild(fb);
            });
            m.appendChild(mf);
        }

        const bub = document.createElement('div');
        bub.className = 'bub';

        if (msg.role === 'assistant') {
            if (msg._streaming) {
                streamRender(bub, msg.content || '');
            } else {
                fullRender(bub, msg.content || '');
            }
        } else {
            bub.textContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        }
        m.appendChild(bub);

        // 底部操作栏
        const mm = document.createElement('div');
        mm.className = 'mm';

        if (msg._time) {
            const t = document.createElement('span');
            t.className = 'msg-time';
            t.textContent = msg._time;
            mm.appendChild(t);
        }

        if (msg.role === 'assistant' && msg.content) {
            const wc = cntW(msg.content);
            if (wc > 0) {
                const w = document.createElement('span');
                w.textContent = wc + ' 字';
                mm.appendChild(w);
            }
        }

        // 复制按钮
        const cpBtn = document.createElement('button');
        cpBtn.textContent = '📋 复制';
        cpBtn.onclick = () => {
            navigator.clipboard.writeText(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))
                .then(() => toast('已复制'))
                .catch(() => toast('复制失败', 'er'));
        };
        mm.appendChild(cpBtn);

        // 删除按钮
        if (opts.onDelete) {
            const dBtn = document.createElement('button');
            dBtn.textContent = '🗑️ 删除';
            dBtn.onclick = () => {
                if (confirm('删除这条消息？')) opts.onDelete(msg);
            };
            mm.appendChild(dBtn);
        }

        // 重新生成（仅 assistant）
        if (msg.role === 'assistant' && opts.onRegen) {
            const rBtn = document.createElement('button');
            rBtn.textContent = '🔄 重答';
            rBtn.onclick = () => opts.onRegen(msg);
            mm.appendChild(rBtn);
        }

        m.appendChild(mm);
        wrap.appendChild(m);
        return { wrap: wrap, bub: bub };
    }

    /* ---------- 渲染整个消息列表 ---------- */
    function renderMessages(container, messages, options) {
        container.innerHTML = '';
        if (!messages || !messages.length) {
            container.innerHTML = '<div class="empty"><div class="ico">🚀</div><p>开始新的对话吧</p>'
                + '<p style="font-size:12px;opacity:.6;margin-top:4px">支持拖拽 / 粘贴上传文档与图片</p></div>';
            return null;
        }
        let lastBub = null;
        messages.forEach(m => {
            const node = createMessageNode(m, options);
            container.appendChild(node.wrap);
            lastBub = node.bub;
        });
        // 滚动到底部
        container.scrollTop = container.scrollHeight;
        return lastBub;
    }

    /* ---------- 滚动到底部（节流） ---------- */
    const scrollToBottom = rafThrottle(function (container) {
        container.scrollTop = container.scrollHeight;
    });

    /* ---------- 流式更新（节流到 50ms） ---------- */
    function makeStreamUpdater(bub, container) {
        let lastUpdate = 0;
        let pending = '';
        let timer = null;
        const INTERVAL = 50;

        function flush() {
            if (!pending) return;
            streamRender(bub, pending);
            scrollToBottom(container);
            lastUpdate = Date.now();
            timer = null;
        }

        return function update(fullText) {
            pending = fullText;
            const now = Date.now();
            const elapsed = now - lastUpdate;
            if (elapsed >= INTERVAL) {
                flush();
            } else if (!timer) {
                timer = setTimeout(flush, INTERVAL - elapsed);
            }
        };
    }

    /* ---------- 暴露 ---------- */
    return {
        renderMarkdown: renderMarkdown,
        renderMath: renderMath,
        renderMermaid: renderMermaid,
        wrapCodeBlocks: wrapCodeBlocks,
        fullRender: fullRender,
        streamRender: streamRender,
        createMessageNode: createMessageNode,
        renderMessages: renderMessages,
        scrollToBottom: scrollToBottom,
        makeStreamUpdater: makeStreamUpdater,
    };
})();
