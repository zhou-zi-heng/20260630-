/* ===== 飞凡AI - Office 解析（docx / xlsx / xls） ===== */

const OfficeParser = (function () {

    /* ---------- 按需加载 SheetJS ---------- */
    let _xlsxLoading = null;
    function loadXLSX() {
        if (window.XLSX) return Promise.resolve();
        if (_xlsxLoading) return _xlsxLoading;
        _xlsxLoading = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
            s.onload = () => {
                if (window.XLSX) resolve();
                else reject(new Error('SheetJS 加载后未注入'));
            };
            s.onerror = () => {
                // 备用 CDN
                const s2 = document.createElement('script');
                s2.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
                s2.onload = () => window.XLSX ? resolve() : reject(new Error('SheetJS 加载失败'));
                s2.onerror = () => reject(new Error('SheetJS CDN 全部失败'));
                document.head.appendChild(s2);
            };
            document.head.appendChild(s);
        });
        return _xlsxLoading;
    }

    /* ---------- DOCX 解析 ---------- */
    async function parseDocx(file) {
        if (!window.mammoth) {
            throw new Error('mammoth.js 未加载，请检查网络');
        }
        const buf = await file.arrayBuffer();
        const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
        return {
            type: 'document',
            fileName: file.name,
            text: result.value || '',
            meta: { ext: 'docx', warnings: (result.messages || []).length },
        };
    }

    /* ---------- XLSX / XLS 解析 → Markdown 表格 ---------- */
    async function parseExcel(file, ext) {
        await loadXLSX();
        const buf = await file.arrayBuffer();
        const wb = window.XLSX.read(buf, { type: 'array' });

        let combined = '';
        const sheetInfos = [];

        wb.SheetNames.forEach(name => {
            const sheet = wb.Sheets[name];
            const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            // 过滤掉全空行
            const clean = rows.filter(r => r.some(c => c !== '' && c !== null && c !== undefined));
            sheetInfos.push({ name: name, rows: clean.length });

            if (clean.length === 0) return;

            const md = CSVParser.rowsToMarkdown(clean.map(r => r.map(c => String(c))));
            combined += '### 📋 工作表：' + name + '\n\n' + md + '\n\n';
        });

        return {
            type: 'table',
            fileName: file.name,
            text: combined.trim() || '（空文件）',
            meta: {
                ext: ext,
                sheets: sheetInfos,
            },
        };
    }

    return {
        parseDocx: parseDocx,
        parseExcel: parseExcel,
        loadXLSX: loadXLSX,
    };
})();
