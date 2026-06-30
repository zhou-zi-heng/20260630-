/* ===== 飞凡AI - CSV/TSV 解析 (v2.3.1，独立无依赖) ===== */

const CSVParser = (function () {

    /* ---------- 自带读文本（不依赖 TextParser） ---------- */
    function readText(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = e => resolve(e.target.result || '');
            r.onerror = () => reject(new Error('读取失败'));
            r.readAsText(file, 'utf-8');
        });
    }

    /* ---------- 解析 CSV/TSV 文本 ---------- */
    function parseCSVText(text, delimiter) {
        const rows = [];
        let cur = [];
        let field = '';
        let inQuotes = false;
        const len = text.length;

        for (let i = 0; i < len; i++) {
            const ch = text[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (text[i + 1] === '"') { field += '"'; i++; }
                    else { inQuotes = false; }
                } else {
                    field += ch;
                }
            } else {
                if (ch === '"') {
                    inQuotes = true;
                } else if (ch === delimiter) {
                    cur.push(field);
                    field = '';
                } else if (ch === '\n') {
                    cur.push(field);
                    rows.push(cur);
                    cur = [];
                    field = '';
                } else if (ch === '\r') {
                    // 跳过
                } else {
                    field += ch;
                }
            }
        }
        if (field || cur.length) {
            cur.push(field);
            rows.push(cur);
        }
        return rows;
    }

    /* ---------- 转 Markdown 表格 ---------- */
    function rowsToMarkdown(rows, maxRows) {
        const limit = maxRows || 200;
        if (!rows || !rows.length) return '';
        const truncated = rows.length > limit;
        const useRows = truncated ? rows.slice(0, limit) : rows;

        const colCount = Math.max(...useRows.map(r => r.length));
        const normalized = useRows.map(r => {
            const arr = r.slice();
            while (arr.length < colCount) arr.push('');
            return arr.map(c => String(c == null ? '' : c).replace(/\|/g, '\\|').replace(/\n/g, ' '));
        });

        const header = normalized[0];
        const body = normalized.slice(1);

        let md = '| ' + header.join(' | ') + ' |\n';
        md += '|' + header.map(() => '---').join('|') + '|\n';
        body.forEach(r => { md += '| ' + r.join(' | ') + ' |\n'; });

        if (truncated) {
            md += '\n_（共 ' + rows.length + ' 行，已显示前 ' + limit + ' 行）_';
        }
        return md;
    }

    async function parse(file, ext) {
        const text = await readText(file);
        const delimiter = (ext || '').toLowerCase() === 'tsv' ? '\t' : ',';
        const rows = parseCSVText(text, delimiter);
        const md = rowsToMarkdown(rows);
        return {
            type: 'table',
            fileName: file.name,
            text: md,
            meta: {
                ext: (ext || '').toLowerCase(),
                rowCount: rows.length,
                colCount: rows[0] ? rows[0].length : 0,
            },
        };
    }

    return {
        parse: parse,
        parseCSVText: parseCSVText,
        rowsToMarkdown: rowsToMarkdown,
        readText: readText,
    };
})();

window.CSVParser = CSVParser;
