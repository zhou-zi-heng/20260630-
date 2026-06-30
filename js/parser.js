/* ===== 飞凡AI - 文件解析分发器 (v2.3.1) ===== */

const Parser = (function () {

    function getExt(name) {
        if (!name) return '';
        const m = name.match(/\.([a-zA-Z0-9]+)$/);
        return m ? m[1].toLowerCase() : '';
    }

    const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
    function isImage(file) {
        if (file.type && file.type.startsWith('image/')) return true;
        return IMAGE_EXTS.has(getExt(file.name));
    }

    function readImageAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = e => resolve(e.target.result);
            r.onerror = () => reject(new Error('图片读取失败'));
            r.readAsDataURL(file);
        });
    }

    /* ---------- 通用文本读取（独立实现，不依赖任何 parser） ---------- */
    function readTextSafe(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = e => resolve(e.target.result || '');
            r.onerror = () => reject(new Error('文件读取失败'));
            r.readAsText(file, 'utf-8');
        });
    }

    async function compressImage(dataUrl, maxSize) {
        const max = maxSize || 1024;
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                if (width <= max && height <= max) {
                    resolve(dataUrl);
                    return;
                }
                if (width > height) {
                    height = Math.round(height * max / width);
                    width = max;
                } else {
                    width = Math.round(width * max / height);
                    height = max;
                }
                const cv = document.createElement('canvas');
                cv.width = width; cv.height = height;
                const ctx = cv.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                const isPng = dataUrl.startsWith('data:image/png');
                resolve(cv.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.85));
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    }

    async function parseFile(file) {
        const ext = getExt(file.name);
        const sizeText = fmtSize(file.size);

        // 图片
        if (isImage(file)) {
            try {
                let dataUrl = await readImageAsDataURL(file);
                dataUrl = await compressImage(dataUrl, 1024);
                return {
                    type: 'image',
                    fileName: file.name,
                    dataUrl: dataUrl,
                    text: '',
                    meta: { ext: ext, size: file.size, sizeText: sizeText },
                };
            } catch (e) {
                throw new Error('图片处理失败：' + e.message);
            }
        }

        // doc 旧格式
        if (ext === 'doc') {
            throw new Error('旧版 .doc 格式无法在浏览器解析，请用 Word 另存为 .docx 后重传');
        }

        // 专用解析器分发（带防御性检查）
        try {
            // DOCX
            if (ext === 'docx' && typeof OfficeParser !== 'undefined') {
                return await OfficeParser.parseDocx(file);
            }
            // XLSX / XLS
            if ((ext === 'xlsx' || ext === 'xls') && typeof OfficeParser !== 'undefined') {
                return await OfficeParser.parseExcel(file, ext);
            }
            // PDF
            if (ext === 'pdf' && typeof PDFParser !== 'undefined') {
                return await PDFParser.parse(file);
            }
            // CSV / TSV
            if ((ext === 'csv' || ext === 'tsv') && typeof CSVParser !== 'undefined') {
                return await CSVParser.parse(file, ext);
            }
            // 已知文本类型（走 TextParser）
            if (typeof TextParser !== 'undefined' && (TextParser.isTextLike(ext) || ext === 'rtf')) {
                return await TextParser.parse(file, ext);
            }
        } catch (e) {
            console.warn('[Parser] 专用解析失败，尝试当文本读:', e.message);
        }

        // 兜底：当文本读
        try {
            const text = await readTextSafe(file);
            // 简单二进制检测：如果前 1KB 包含很多不可打印字符，认为是二进制
            const sample = text.slice(0, 1024);
            let binaryCount = 0;
            for (let i = 0; i < sample.length; i++) {
                const code = sample.charCodeAt(i);
                if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) {
                    binaryCount++;
                }
            }
            if (binaryCount > sample.length * 0.1) {
                throw new Error('此文件似乎是二进制格式，无法当作文本读取');
            }
            return {
                type: 'text',
                fileName: file.name,
                text: text,
                meta: { ext: ext, fallback: true },
            };
        } catch (e) {
            throw new Error('无法解析此文件：' + e.message);
        }
    }

    async function parseFiles(files, onProgress) {
        const results = [];
        const fileArr = Array.from(files);
        for (let i = 0; i < fileArr.length; i++) {
            const f = fileArr[i];
            if (onProgress) onProgress(i, fileArr.length, f.name);
            try {
                const r = await parseFile(f);
                results.push({ ok: true, file: f, result: r });
            } catch (e) {
                console.warn('[Parser] 失败:', f.name, e);
                results.push({ ok: false, file: f, error: e.message });
            }
        }
        return results;
    }

    return {
        parseFile: parseFile,
        parseFiles: parseFiles,
        getExt: getExt,
        isImage: isImage,
        compressImage: compressImage,
    };
})();

window.Parser = Parser;
