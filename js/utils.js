/* ===== ZenMux 工具函数库 (v2.7.0) ===== */

const APP_VERSION = '2.7.0';

function gId() {
    return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function esc(t) {
    if (t === null || t === undefined) return '';
    const d = document.createElement('div');
    d.textContent = String(t);
    return d.innerHTML;
}

/* ===== 字数统计（对齐 WPS/Word，含中文标点） ===== */
function _cleanForCount(text) {
    let s = String(text || '');
    s = s.replace(/```[\s\S]*?```/g, ' ');
    s = s.replace(/`[^`\n]*`/g, ' ');
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/^\s*\|?[\s:\-]*\|[\s:\-|]*\|?\s*$/gm, ' ');
    s = s.replace(/\|/g, ' ');
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    s = s.replace(/^\s{0,3}>+\s?/gm, '');
    s = s.replace(/^\s{0,3}([-*+])\s+/gm, '');
    s = s.replace(/^\s{0,3}\d+\.\s+/gm, '');
    s = s.replace(/^\s{0,3}([-*_])\1{2,}\s*$/gm, ' ');
    s = s.replace(/(\*\*\*|\*\*|\*|___|__|_|~~)/g, '');
    return s;
}
function _countHan(s) {
    try { return (s.match(/[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}]/gu) || []).length; }
    catch (e) { return (s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length; }
}
function _countCnPunct(s) {
    const re = /[\u3000-\u303f\uff00-\uffef“”‘’]/g;
    return (s.match(re) || []).length;
}
function cntW(t) {
    if (!t) return 0;
    const s = String(t);
    // 中文字符（含中文标点）—— 对齐 WPS「中文字符」
    let han;
    try { han = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}\u3000-\u303f\uff00-\uffef]/gu) || []).length; }
    catch (e) { han = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g) || []).length; }
    // 非中文单词（连续字母/数字算一个词）—— 对齐 WPS「非中文单词」
    const words = (s.match(/[a-zA-Z0-9]+(?:['’\-][a-zA-Z0-9]+)*/g) || []).length;
    // WPS「字数」= 中文字符 + 非中文单词
    return han + words;
}
function cntDetail(t) {
    const s = _cleanForCount(t || '');
    const han = _countHan(s), cnPunct = _countCnPunct(s);
    const eng = (s.match(/[a-zA-Z]+/g) || []).length, num = (s.match(/\d+/g) || []).length;
    return { total: han + cnPunct + eng + num, chinese: han + cnPunct, han: han, cnPunct: cnPunct, words: eng, digits: num, nonChinese: eng + num };
}

function nowTime() {
    const d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function fmtSize(bytes) {
    if (!bytes) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(i ? 1 : 0) + ' ' + u[i];
}

function toast(msg, type) {
    if (!type) type = 'ok';
    const c = document.getElementById('tc');
    if (!c) { console.log('[toast]', msg); return; }
    const t = document.createElement('div');
    t.className = 'tt ' + type;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}

function dl(content, filename, mime) {
    const b = new Blob([content], { type: mime + ';charset=utf-8' });
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(u);
}

function debounce(fn, delay) {
    let timer;
    return function (...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), delay); };
}

function throttle(fn, interval) {
    let last = 0, timer;
    return function (...args) {
        const now = Date.now();
        const remain = interval - (now - last);
        if (remain <= 0) { clearTimeout(timer); last = now; fn.apply(this, args); }
        else if (!timer) { timer = setTimeout(() => { last = Date.now(); timer = null; fn.apply(this, args); }, remain); }
    };
}

function rafThrottle(fn) {
    let scheduled = false, lastArgs;
    return function (...args) {
        lastArgs = args;
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; fn.apply(this, lastArgs); });
    };
}

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const IS_MOBILE = window.innerWidth <= 768 || /Mobi|Android/i.test(navigator.userAgent);
const SUPPORTS_INDEXEDDB = 'indexedDB' in window;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeJSON(str, fallback) {
    if (fallback === undefined) fallback = null;
    try { return JSON.parse(str); } catch (e) { return fallback; }
}
