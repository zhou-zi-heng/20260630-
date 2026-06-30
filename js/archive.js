/* ===== 飞凡AI - 局域网自动存档引擎 (v2.3.7) ===== */
/* File System Access API：用户选定共享目录后，按设定间隔 + AI回复后防抖，
   把"有变动的对话"以 [标题__用户名__ID短码].html + .feifan-share.json 双份写入。
   同名覆盖=排重=永远最新版。仅 Chrome/Edge + https 可用，不支持则静默禁用。
   v2.3.7: 新增打开页面主动授权提示（needsAuth / requestAuthNow）。 */

const Archive = (function () {

    const SUPPORTS_FSA = ('showDirectoryPicker' in window);

    let _dirHandle = null;
    let _intervalTimer = null;
    let _getStateFn = null;
    let _buildHtmlFn = null;
    let _archiveSigs = {};
    let _permissionOK = false;
    let _debounceTimer = null;
    let _intervalMin = 10;
    let _debounceMin = 1;

    function isEnabled() { return SUPPORTS_FSA && !!_dirHandle; }
    function isSupported() { return SUPPORTS_FSA; }
    function isAuthorized() { return _permissionOK; }

    /* 是否需要主动提示授权：已设目录 + 尚未授权 */
    function needsAuth() {
        return isEnabled() && !_permissionOK;
    }

    function _safe(str) {
        return String(str || '')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/__+/g, '_')
            .trim()
            .slice(0, 60);
    }

    function _baseName(chat, userName) {
        const title = _safe(chat.title || '新对话') || '新对话';
        const user = _safe(userName || '未署名') || '未署名';
        const idShort = (chat.id || '').replace(/[^\w]/g, '').slice(-4) || '0000';
        return title + '__' + user + '__' + idShort;
    }

    function _fingerprint(chat) {
        const msgs = chat.messages || [];
        let lastContent = '';
        if (msgs.length) {
            const last = msgs[msgs.length - 1];
            lastContent = typeof last.content === 'string' ? last.content : JSON.stringify(last.content || '');
        }
        let totalLen = 0;
        for (let i = 0; i < msgs.length; i++) {
            const ct = typeof msgs[i].content === 'string' ? msgs[i].content : '';
            totalLen += ct.length;
        }
        return [
            msgs.length,
            (chat.title || ''),
            totalLen,
            lastContent.length,
            lastContent.slice(-60),
            (chat.systemPrompt || '').length,
            (chat.knowledgeBase || []).length,
        ].join('|');
    }

    /* ==========================================================
       ===== 权限 ===============================================
       ========================================================== */
    async function _verifyPermission(handle, readWrite) {
        if (!handle) return false;
        const opts = {};
        if (readWrite) opts.mode = 'readwrite';
        try {
            if ((await handle.queryPermission(opts)) === 'granted') return true;
            if ((await handle.requestPermission(opts)) === 'granted') return true;
        } catch (e) {
            console.warn('[Archive] 权限检查失败', e);
        }
        return false;
    }

    /* 仅查询权限（不弹窗），用于判断 needsAuth */
    async function _queryPermissionOnly() {
        if (!_dirHandle) return false;
        try {
            const r = await _dirHandle.queryPermission({ mode: 'readwrite' });
            return r === 'granted';
        } catch (e) {
            return false;
        }
    }

    /* ★ 主动请求授权（用户点大按钮触发，必须在用户手势中调用才会弹窗） */
    async function requestAuthNow() {
        if (!isEnabled()) return false;
        const ok = await _verifyPermission(_dirHandle, true);
        _permissionOK = ok;
        if (ok) {
            startTimer();
            console.log('[Archive] 已授权写入');
        }
        return ok;
    }

    /* ==========================================================
       ===== 选择 / 恢复 目录 ====================================
       ========================================================== */
    async function chooseDir() {
        if (!SUPPORTS_FSA) {
            toast('当前浏览器不支持自动存档（需 Chrome/Edge）', 'er');
            return false;
        }
        try {
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            const ok = await _verifyPermission(handle, true);
            if (!ok) { toast('未授予写入权限', 'er'); return false; }
            _dirHandle = handle;
            _permissionOK = true;
            await DB.saveDirHandle(handle);

            // ★ 换目录后清空指纹基线，让新目录重新全量存档
            _archiveSigs = {};
            try { await DB.setSetting('archive_sigs', _archiveSigs); } catch (e) {}

            toast('✅ 存档目录已设置：' + (handle.name || '已选定'));
            return true;
        } catch (e) {
            if (e.name === 'AbortError') return false;
            console.error('[Archive] chooseDir', e);
            toast('选择目录失败：' + e.message, 'er');
            return false;
        }
    }


    async function restoreDir() {
        if (!SUPPORTS_FSA) return false;
        try {
            const handle = await DB.loadDirHandle();
            if (handle) {
                _dirHandle = handle;
                // 重开页面后，先查询是否已有权限（不弹窗）
                _permissionOK = await _queryPermissionOnly();
                console.log('[Archive] 已恢复存档目录:', handle.name, '已授权:', _permissionOK);
                return true;
            }
        } catch (e) {
            console.warn('[Archive] restoreDir 失败', e);
        }
        return false;
    }

    async function clearDir() {
        _dirHandle = null;
        _permissionOK = false;
        stopTimer();
        if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
        await DB.clearDirHandle();
        toast('已关闭自动存档');
    }

    function getDirName() { return _dirHandle ? (_dirHandle.name || '已设置') : ''; }

    /* ==========================================================
       ===== 写文件 =============================================
       ========================================================== */
    async function _writeFile(fileName, content) {
        const fh = await _dirHandle.getFileHandle(fileName, { create: true });
        const writable = await fh.createWritable();
        await writable.write(content);
        await writable.close();
    }

    async function _archiveOne(chat, userName) {
        const base = _baseName(chat, userName);
        let html = '';
        try { html = _buildHtmlFn ? _buildHtmlFn(chat) : ''; }
        catch (e) { console.warn('[Archive] 生成 HTML 失败', e); }
        if (html) await _writeFile(base + '.html', html);
        try {
            const payload = Snapshot._buildSharePayload(chat, { includeKB: true, sharedBy: userName || '' });
            await _writeFile(base + '.feifan-share.json', JSON.stringify(payload, null, 2));
        } catch (e) {
            console.warn('[Archive] 生成 JSON 失败', e);
        }
    }

    /* ==========================================================
       ===== 存档核心 ===========================================
       ========================================================== */
    async function archiveAll(opts) {
        opts = opts || {};
        if (!isEnabled()) return { done: 0, skipped: 0, reason: 'disabled' };

        const S = _getStateFn ? _getStateFn() : null;
        if (!S || !S.chats) return { done: 0, skipped: 0, reason: 'no-state' };

        if (!_permissionOK) {
            const ok = await _verifyPermission(_dirHandle, true);
            if (!ok) {
                if (!opts.silent) toast('存档需要写入权限，请点击"允许"', 'er');
                return { done: 0, skipped: 0, reason: 'no-permission' };
            }
            _permissionOK = true;
        }

        const userName = S.userName || '';
        let done = 0, skipped = 0, failed = 0;

        for (const cid in S.chats) {
            const chat = S.chats[cid];
            if (!chat || !chat.messages || !chat.messages.length) { skipped++; continue; }

            const sig = _fingerprint(chat);
            if (_archiveSigs[cid] === sig) { skipped++; continue; }

            try {
                await _archiveOne(chat, userName);
                _archiveSigs[cid] = sig;
                done++;
            } catch (e) {
                console.error('[Archive] 存档失败 ' + cid, e);
                failed++;
                if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
                    _permissionOK = false;
                }
            }
        }

        try { await DB.setSetting('archive_sigs', _archiveSigs); } catch (e) {}

        if (!opts.silent && (done > 0 || failed > 0)) {
            toast('📁 已存档 ' + done + ' 个对话' + (failed ? '（' + failed + ' 失败）' : ''));
        }
        if (done > 0) console.log('[Archive] 存档 ' + done + '，跳过 ' + skipped + '，失败 ' + failed);

        return { done: done, skipped: skipped, failed: failed };
    }

    async function archiveNow() {
        if (!isEnabled()) { toast('请先设置存档目录', 'er'); return; }
        toast('正在存档...');
        await archiveAll({ silent: false });
    }

    /* ==========================================================
       ===== 回复后防抖落盘 ======================================
       ========================================================== */
    function notifyActivity() {
        if (!isEnabled()) return;
        if (_debounceTimer) clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => {
            _debounceTimer = null;
            archiveAll({ silent: true });
        }, _debounceMin * 60 * 1000);
    }

    /* ==========================================================
       ===== 定时器 =============================================
       ========================================================== */
    function startTimer() {
        stopTimer();
        if (!isEnabled()) return;
        const min = parseInt(_intervalMin, 10) || 0;
        if (min <= 0) { console.log('[Archive] 定时存档关闭'); return; }
        _intervalTimer = setInterval(() => {
            archiveAll({ silent: true });
        }, min * 60 * 1000);
        console.log('[Archive] 定时存档启动，间隔 ' + min + ' 分钟');
    }
    function stopTimer() {
        if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; }
    }

    function setInterval_(min) {
        _intervalMin = parseInt(min, 10) || 0;
        startTimer();
    }
    function getInterval() { return _intervalMin; }

    function _bindLifecycle() {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && isEnabled() && _permissionOK) {
                archiveAll({ silent: true });
            }
        });
    }

    async function init(config) {
        config = config || {};
        _getStateFn = config.getState;
        _buildHtmlFn = config.buildHtml;
        if (config.intervalMin !== undefined) _intervalMin = parseInt(config.intervalMin, 10) || 10;
        if (config.debounceMin !== undefined) _debounceMin = parseFloat(config.debounceMin) || 1;

        if (!SUPPORTS_FSA) {
            console.log('[Archive] 浏览器不支持 File System Access，自动存档禁用');
            return;
        }

        try {
            const s = await DB.getSetting('archive_sigs', null);
            if (s && typeof s === 'object') _archiveSigs = s;
        } catch (e) {}

        await restoreDir();

        if (isEnabled() && _permissionOK) {
            startTimer();
            console.log('[Archive] 已就绪并已授权（目录：' + getDirName() + '）');
        } else if (isEnabled()) {
            console.log('[Archive] 已设目录但需授权');
        } else {
            console.log('[Archive] 未设置存档目录');
        }

        _bindLifecycle();
    }

    return {
        init: init,
        isSupported: isSupported,
        isEnabled: isEnabled,
        isAuthorized: isAuthorized,
        needsAuth: needsAuth,
        requestAuthNow: requestAuthNow,
        chooseDir: chooseDir,
        clearDir: clearDir,
        getDirName: getDirName,
        archiveNow: archiveNow,
        archiveAll: archiveAll,
        notifyActivity: notifyActivity,
        setInterval: setInterval_,
        getInterval: getInterval,
        startTimer: startTimer,
        stopTimer: stopTimer,
    };
})();

window.Archive = Archive;
