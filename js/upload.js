/* ===== 飞凡AI - 上传交互（按钮 + 拖拽 + 粘贴） ===== */

const Upload = (function () {

    let _onFiles = null; // 回调：(files) => void

    /* ---------- 注册回调 ---------- */
    function onFiles(cb) { _onFiles = cb; }

    /* ---------- 拖拽支持 ---------- */
    let dragCounter = 0;

    function setupDrag(targetEl, maskEl) {
        if (!targetEl) return;

        // 阻止整个 window 的默认拖拽（避免拖到非目标区域时打开文件）
        ['dragover', 'drop'].forEach(ev => {
            window.addEventListener(ev, e => {
                if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
                    e.preventDefault();
                }
            });
        });

        targetEl.addEventListener('dragenter', (e) => {
            if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
            e.preventDefault();
            dragCounter++;
            if (maskEl) maskEl.classList.add('show');
        });

        targetEl.addEventListener('dragover', (e) => {
            if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        targetEl.addEventListener('dragleave', (e) => {
            if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                if (maskEl) maskEl.classList.remove('show');
            }
        });

        targetEl.addEventListener('drop', (e) => {
            if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
            e.preventDefault();
            dragCounter = 0;
            if (maskEl) maskEl.classList.remove('show');
            if (_onFiles) _onFiles(e.dataTransfer.files);
        });
    }

    /* ---------- 粘贴支持（Ctrl+V） ---------- */
    function setupPaste() {
        document.addEventListener('paste', (e) => {
            if (!e.clipboardData || !e.clipboardData.items) return;
            const files = [];
            for (const item of e.clipboardData.items) {
                if (item.kind === 'file') {
                    const f = item.getAsFile();
                    if (f) files.push(f);
                }
            }
            if (files.length && _onFiles) {
                e.preventDefault();
                _onFiles(files);
                toast('已从剪贴板捕获 ' + files.length + ' 个文件');
            }
        });
    }

    /* ---------- 按钮上传（input change 由调用方绑） ---------- */
    function fromInput(inputEl) {
        if (!inputEl.files || !inputEl.files.length) return;
        if (_onFiles) _onFiles(inputEl.files);
        inputEl.value = ''; // 允许重复选同一文件
    }

    /* ---------- 初始化 ---------- */
    function init(opts) {
        const o = opts || {};
        if (o.dropTarget) setupDrag(o.dropTarget, o.dropMask);
        if (o.paste !== false) setupPaste();
    }

    return {
        init: init,
        onFiles: onFiles,
        fromInput: fromInput,
    };
})();
