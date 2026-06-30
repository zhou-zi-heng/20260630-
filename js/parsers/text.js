/* ===== 飞凡AI - 文本/代码/RTF 解析 (v2.3.1) ===== */

const TextParser = (function () {

    // 超全文本扩展名白名单
    const TEXT_EXTS = new Set([
        // 通用文本
        'txt', 'md', 'markdown', 'mdx', 'rst', 'log', 'text', 'readme',
        // 数据/配置
        'json', 'jsonc', 'json5', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg',
        'env', 'properties', 'plist',
        // Web 前端
        'html', 'htm', 'xhtml', 'shtml', 'css', 'scss', 'sass', 'less', 'styl',
        'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
        'vue', 'svelte', 'astro', 'pug', 'jade', 'ejs', 'hbs', 'handlebars',
        // 后端语言
        'py', 'pyw', 'pyi', 'rb', 'rbw', 'php', 'phtml',
        'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy',
        'swift', 'm', 'mm',
        'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx', 'hh',
        'cs', 'fs', 'fsx', 'vb',
        'r', 'rmd', 'jl', 'lua', 'pl', 'pm', 'dart',
        'erl', 'ex', 'exs', 'elm', 'clj', 'cljs', 'edn',
        'hs', 'lhs', 'ml', 'mli', 'nim', 'cr', 'zig',
        // Shell / DevOps
        'sh', 'bash', 'zsh', 'fish', 'ksh',
        'bat', 'cmd', 'ps1', 'psm1', 'psd1',
        'dockerfile', 'containerfile', 'makefile', 'mk',
        'gradle', 'sbt', 'cmake',
        // 数据库 / 查询
        'sql', 'graphql', 'gql', 'cypher', 'sparql',
        'proto', 'thrift', 'avsc', 'avdl',
        // 移动端
        'pbxproj', 'xcconfig',
        // 其他
        'tex', 'bib', 'sty', 'cls',
        'diff', 'patch',
        'srt', 'vtt', 'sub', 'sbv',
        'asm', 's',
        'gitignore', 'gitattributes', 'editorconfig',
        'eslintrc', 'prettierrc', 'babelrc', 'browserslistrc',
        'npmrc', 'yarnrc',
        'lock', 'sum', 'mod',
    ]);

    function isTextLike(ext) {
        return TEXT_EXTS.has((ext || '').toLowerCase());
    }

    /* ---------- 读纯文本（通用工具，被其他 parser 复用） ---------- */
    function readText(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = e => resolve(e.target.result || '');
            r.onerror = () => reject(new Error('读取失败'));
            r.readAsText(file, 'utf-8');
        });
    }

    /* ---------- RTF 简单解析 ---------- */
    function parseRTF(rtfText) {
        let text = rtfText || '';
        text = text.replace(/\\\*?[a-zA-Z0-9]+(-?\d+)?[ ]?/g, '');
        text = text.replace(/[{}]/g, '');
        text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => {
            try { return String.fromCharCode(parseInt(h, 16)); } catch (e) { return ''; }
        });
        return text.trim();
    }

    async function parse(file, ext) {
        const text = await readText(file);
        if ((ext || '').toLowerCase() === 'rtf') {
            return {
                type: 'text',
                fileName: file.name,
                text: parseRTF(text),
                meta: { ext: 'rtf' },
            };
        }
        return {
            type: 'text',
            fileName: file.name,
            text: text,
            meta: { ext: (ext || '').toLowerCase() },
        };
    }

    return {
        isTextLike: isTextLike,
        parse: parse,
        readText: readText,
        TEXT_EXTS: TEXT_EXTS,
    };
})();

// 同时挂到 window 上，确保任何加载顺序都能访问
window.TextParser = TextParser;
