/* ===== 飞凡AI - PDF 解析 ===== */

const PDFParser = (function () {

    let _initialized = false;
    function init() {
        if (_initialized) return;
        if (window.pdfjsLib) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
            _initialized = true;
        }
    }

    async function parse(file) {
        init();
        if (!window.pdfjsLib) throw new Error('pdf.js 未加载');

        const buf = await file.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
        const pages = [];

        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const tc = await page.getTextContent();
            const text = tc.items.map(it => it.str).join(' ');
            pages.push(text);
        }

        return {
            type: 'document',
            fileName: file.name,
            text: pages.join('\n\n'),
            meta: { ext: 'pdf', pageCount: pdf.numPages },
        };
    }

    return { parse: parse };
})();
