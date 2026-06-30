/* ===== 飞凡ai对话 IndexedDB 存储层 (v2.7.0) ===== */
/* v2.3.4: 存档目录句柄持久化  v2.6.1: 导入回滚备份  v2.7.0: 功能大合集 */

const DB = (function () {
    const DB_NAME = 'ZenMuxDB';
    const DB_VERSION = 1;
    const OLD_LS_KEY = 'zenmux_v3';
    const SETTINGS_KEY_STATE = 'app_state';
    const SETTINGS_KEY_DIRHANDLE = 'archive_dir_handle';
    const SETTINGS_KEY_ROLLBACK = 'rollback_backup';

    let _db = null;

    function init() {
        return new Promise((resolve, reject) => {
            if (!SUPPORTS_INDEXEDDB) { reject(new Error('当前浏览器不支持 IndexedDB')); return; }
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function (e) {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('conversations')) {
                    const s = db.createObjectStore('conversations', { keyPath: 'id' });
                    s.createIndex('updatedAt', 'updatedAt');
                    s.createIndex('isPinned', 'isPinned');
                    s.createIndex('isArchived', 'isArchived');
                }
                if (!db.objectStoreNames.contains('messages')) {
                    const s = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
                    s.createIndex('convId', 'convId');
                    s.createIndex('convId_seq', ['convId', 'seq']);
                }
                if (!db.objectStoreNames.contains('attachments')) {
                    const s = db.createObjectStore('attachments', { keyPath: 'id', autoIncrement: true });
                    s.createIndex('convId', 'convId');
                }
                if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
                if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'key' });
            };
            req.onsuccess = function (e) { _db = e.target.result; _db.onerror = (ev) => console.error('[DB error]', ev.target.error); resolve(_db); };
            req.onerror = function (e) { reject(e.target.error || new Error('IndexedDB 打开失败')); };
            req.onblocked = function () { reject(new Error('IndexedDB 被其他标签页占用，请关闭其他标签页后刷新')); };
        });
    }

    function _store(name, mode) { if (!_db) throw new Error('数据库未初始化'); return _db.transaction(name, mode || 'readonly').objectStore(name); }
    function _req(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }

    async function setSetting(key, value) { return _req(_store('settings', 'readwrite').put({ key: key, value: value, updatedAt: Date.now() })); }
    async function getSetting(key, defaultValue) { const r = await _req(_store('settings', 'readonly').get(key)); return r ? r.value : (defaultValue !== undefined ? defaultValue : null); }
    async function delSetting(key) { return _req(_store('settings', 'readwrite').delete(key)); }

    async function saveState(state) {
        try { await setSetting(SETTINGS_KEY_STATE, state); return true; }
        catch (e) {
            console.error('[saveState]', e);
            if (e.name === 'QuotaExceededError') toast('⚠️ 存储空间不足，请清理或导出快照', 'er');
            else toast('保存失败: ' + e.message, 'er');
            return false;
        }
    }
    async function loadState() { try { return await getSetting(SETTINGS_KEY_STATE, null); } catch (e) { console.error('[loadState]', e); return null; } }

    async function saveAutoSnapshot(state) { return _req(_store('snapshots', 'readwrite').put({ key: 'auto', data: state, time: Date.now(), version: APP_VERSION })); }
    async function loadAutoSnapshot() { return _req(_store('snapshots', 'readonly').get('auto')); }
    async function clearAutoSnapshot() { return _req(_store('snapshots', 'readwrite').delete('auto')); }

    async function saveDirHandle(handle) { try { await setSetting(SETTINGS_KEY_DIRHANDLE, handle); return true; } catch (e) { console.error('[saveDirHandle]', e); return false; } }
    async function loadDirHandle() { try { return await getSetting(SETTINGS_KEY_DIRHANDLE, null); } catch (e) { console.error('[loadDirHandle]', e); return null; } }
    async function clearDirHandle() { try { await delSetting(SETTINGS_KEY_DIRHANDLE); return true; } catch (e) { console.error('[clearDirHandle]', e); return false; } }

    async function saveRollbackBackup(state) {
        try { const snapshot = JSON.parse(JSON.stringify(state)); await setSetting(SETTINGS_KEY_ROLLBACK, { ts: Date.now(), state: snapshot }); return true; }
        catch (e) { console.warn('[saveRollbackBackup]', e); return false; }
    }
    async function loadRollbackBackup() { try { return await getSetting(SETTINGS_KEY_ROLLBACK, null); } catch (e) { console.error('[loadRollbackBackup]', e); return null; } }
    async function clearRollbackBackup() { try { await delSetting(SETTINGS_KEY_ROLLBACK); return true; } catch (e) { console.error('[clearRollbackBackup]', e); return false; } }

    async function clearAll() {
        const stores = ['conversations', 'messages', 'attachments', 'settings', 'snapshots'];
        for (const name of stores) await _req(_store(name, 'readwrite').clear());
    }

    async function migrateFromLocalStorage() {
        try {
            const raw = localStorage.getItem(OLD_LS_KEY);
            if (!raw) return false;
            const migrated = await getSetting('_migrated_from_ls', false);
            if (migrated) return false;
            const data = safeJSON(raw, null);
            if (!data) return false;
            await saveState(data);
            await setSetting('_migrated_from_ls', { time: Date.now(), version: APP_VERSION });
            console.log('[Migration] 从 localStorage 迁移成功');
            toast('✅ 旧数据已自动迁移到 IndexedDB');
            return true;
        } catch (e) { console.error('[Migration] 失败', e); toast('数据迁移异常，请手动检查', 'er'); return false; }
    }

    async function requestPersistent() {
        try {
            if (navigator.storage && navigator.storage.persist) {
                if (await navigator.storage.persisted()) return true;
                return await navigator.storage.persist();
            }
        } catch (e) { console.warn('[Persist] 不支持或失败', e); }
        return false;
    }

    async function getStorageInfo() {
        const info = { used: 0, quota: 0, usedText: '未知', quotaText: '未知', percent: 0, persisted: false };
        try {
            if (navigator.storage && navigator.storage.estimate) {
                const est = await navigator.storage.estimate();
                info.used = est.usage || 0; info.quota = est.quota || 0;
                info.usedText = fmtSize(info.used); info.quotaText = fmtSize(info.quota);
                info.percent = info.quota ? (info.used / info.quota * 100).toFixed(1) : 0;
            }
            if (navigator.storage && navigator.storage.persisted) info.persisted = await navigator.storage.persisted();
        } catch (e) { console.warn('[getStorageInfo]', e); }
        return info;
    }

    return {
        init: init,
        saveState: saveState, loadState: loadState,
        saveAutoSnapshot: saveAutoSnapshot, loadAutoSnapshot: loadAutoSnapshot, clearAutoSnapshot: clearAutoSnapshot,
        setSetting: setSetting, getSetting: getSetting, delSetting: delSetting,
        saveDirHandle: saveDirHandle, loadDirHandle: loadDirHandle, clearDirHandle: clearDirHandle,
        saveRollbackBackup: saveRollbackBackup, loadRollbackBackup: loadRollbackBackup, clearRollbackBackup: clearRollbackBackup,
        clearAll: clearAll, migrateFromLocalStorage: migrateFromLocalStorage,
        requestPersistent: requestPersistent, getStorageInfo: getStorageInfo,
        _store: _store, _req: _req, get raw() { return _db; },
    };
})();