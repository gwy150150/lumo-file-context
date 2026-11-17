'use strict';

/**
 * 文件上下文解析：把本地文件转成可发给模型的纯文本。
 * 支持：纯文本/代码/CSV/JSON、docx、xlsx、pptx、pdf（尽力解析）。
 * 不依赖任何第三方库，只用 Node 内置的 zlib。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_TEXT_CHARS = 200000; // 单个文件最多取这么多字符
const MAX_FILE_BYTES = 80 * 1024 * 1024;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff', 'heic']);
const PDF_EXT = new Set(['pdf']);
const OLD_OFFICE = new Set(['doc', 'xls', 'ppt', 'wps', 'et', 'dps']);
const ZIP_OFFICE = new Set(['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm']);

const EXT_LABEL = {
  docx: 'Word', docm: 'Word', xlsx: 'Excel', xlsm: 'Excel', pptx: 'PPT', pptm: 'PPT',
  pdf: 'PDF', md: 'Markdown', txt: '文本', csv: 'CSV', json: 'JSON', log: '日志',
};

/* ---------------- 通用工具 ---------------- */

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch (_) {
    return '';
  }
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  let zero = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 0) zero++;
  return zero > n * 0.05;
}

/** 文本解码：处理 BOM，UTF-8 失败时回退 GBK/BIG5 */
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    try { return new TextDecoder('utf-16le').decode(buf.slice(2)); } catch (_) {}
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    try { return new TextDecoder('utf-16be').decode(buf.slice(2)); } catch (_) {}
  }
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad > utf8.length * 0.002) {
    for (const enc of ['gbk', 'gb18030', 'big5']) {
      try {
        const s = new TextDecoder(enc).decode(buf);
        const b2 = (s.match(/\uFFFD/g) || []).length;
        if (b2 < s.length * 0.002) return s;
      } catch (_) {}
    }
  }
  return utf8;
}

/* ---------------- 极简 ZIP 读取（docx / xlsx / pptx） ---------------- */

function zipEntries(buf) {
  let eocd = -1;
  const stop = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 Office 文档（zip 结构未找到）');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const map = new Map();

  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    map.set(name, { method, csize, lho });
    off += 46 + nlen + elen + clen;
  }

  return {
    names: () => Array.from(map.keys()),
    read(name) {
      const e = map.get(name);
      if (!e) return null;
      const lho = e.lho;
      if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) return null;
      const nlen = buf.readUInt16LE(lho + 26);
      const elen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + nlen + elen;
      const data = buf.slice(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) {
        try { return zlib.inflateRawSync(data); } catch (_) { return null; }
      }
      return null;
    },
  };
}

function stripXml(xml) {
  return decodeEntities(
    String(xml)
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<[^>]+>/g, '')
  );
}

/* ---------------- 各格式解析 ---------------- */

function docxText(buf) {
  const z = zipEntries(buf);
  const xml = z.read('word/document.xml');
  if (!xml) throw new Error('docx 里没有正文（document.xml）');
  return stripXml(xml.toString('utf8'))
    .replace(/\t+\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pptxText(buf) {
  const z = zipEntries(buf);
  const slides = z
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10));
  if (!slides.length) throw new Error('ppt 里没有幻灯片内容');
  const out = [];
  slides.forEach((name, i) => {
    const xml = z.read(name);
    if (!xml) return;
    const texts = [];
    const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
    let m;
    while ((m = re.exec(xml.toString('utf8')))) texts.push(decodeEntities(m[1]));
    if (texts.join('').trim()) out.push(`--- 第 ${i + 1} 页 ---\n${texts.join('\n')}`);
  });
  return out.join('\n\n').trim();
}

function xlsxText(buf) {
  const z = zipEntries(buf);
  const shared = [];
  const ssXml = z.read('xl/sharedStrings.xml');
  if (ssXml) {
    const s = ssXml.toString('utf8');
    const siRe = /<si\b[\s\S]*?<\/si>/g;
    let m;
    while ((m = siRe.exec(s))) {
      const texts = [];
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let t;
      while ((t = tRe.exec(m[0]))) texts.push(t[1]);
      shared.push(decodeEntities(texts.join('')));
    }
  }

  const sheets = z
    .names()
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10));
  if (!sheets.length) throw new Error('xlsx 里没有工作表');

  const out = [];
  sheets.forEach((name, i) => {
    const xml = z.read(name);
    if (!xml) return;
    const s = xml.toString('utf8');
    const lines = [`--- 工作表 ${i + 1} ---`];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    let rows = 0;
    while ((rm = rowRe.exec(s)) && rows < 3000) {
      rows++;
      const cells = [];
      const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cRe.exec(rm[1]))) {
        const attrs = cm[1];
        const body = cm[2];
        const tMatch = /\bt="([^"]+)"/.exec(attrs);
        const type = tMatch ? tMatch[1] : 'n';
        let val = '';
        if (type === 'inlineStr') {
          const t2 = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body);
          val = t2 ? t2[1] : '';
        } else {
          const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
          val = v ? v[1] : '';
          if (type === 's') val = shared[parseInt(val, 10)] || '';
        }
        cells.push(decodeEntities(val).replace(/[\t\r\n]+/g, ' '));
      }
      if (cells.some((c) => c.trim())) lines.push(cells.join('\t'));
    }
    if (rows >= 3000) lines.push('…（表格超过 3000 行，已截断）');
    if (lines.length > 1) out.push(lines.join('\n'));
  });
  return out.join('\n\n').trim();
}

/** PDF 尽力解析：解压内容流后抓取文本绘制指令 */
function pdfText(buf) {
  const raw = buf.toString('latin1');
  const pieces = [];
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const chunk = buf.slice(start, end);
    let content = null;
    try {
      content = zlib.inflateSync(chunk).toString('latin1');
    } catch (_) {
      try {
        content = zlib.inflateRawSync(chunk).toString('latin1');
      } catch (_) {
        /* 未压缩的内容流，直接按 latin1 读 */
        content = chunk.toString('latin1');
      }
    }
    if (!content) continue;
    if (!/(\)\s*Tj|\]\s*TJ|Td|TD|T\*)/.test(content)) continue;

    // (text) Tj / [(a) -20 (b)] TJ
    const lit = /\((?:\\.|[^\\()])*\)/g;
    let lm;
    const line = [];
    while ((lm = lit.exec(content))) {
      let s = lm[0].slice(1, -1);
      s = s
        .replace(/\\([nrtbf])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '', f: '' }[c]))
        .replace(/\\([0-7]{1,3})/g, (_, o) => safeFromCodePoint(parseInt(o, 8)))
        .replace(/\\(.)/g, '$1');
      line.push(s);
    }
    if (line.join('').trim()) pieces.push(line.join(''));
    re.lastIndex = end;
  }
  return pieces.join('\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function textQuality(text) {
  if (!text) return 0;
  const sample = text.slice(0, 4000);
  const good = (sample.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef0-9A-Za-z\s\p{P}]/gu) || []).length;
  return good / sample.length;
}

/* ---------------- 对外入口 ---------------- */

function extractBuffer(name, buf) {
  const ext = (path.extname(name) || '').toLowerCase().replace('.', '');
  let text = '';
  let warning = '';

  try {
    if (IMAGE_EXT.has(ext)) {
      warning = '图片暂不做内容识别（无 OCR），本次只发送文件名';
    } else if (PDF_EXT.has(ext)) {
      text = pdfText(buf);
      const q = textQuality(text);
      if (!text || text.length < 20 || q < 0.55) {
        warning = '这份 PDF 没能提取到可靠文字（可能是扫描件或嵌入字体），建议先转成 Word/纯文本';
        if (q < 0.35) text = '';
      }
    } else if (ext === 'docx' || ext === 'docm') {
      text = docxText(buf);
    } else if (ext === 'xlsx' || ext === 'xlsm') {
      text = xlsxText(buf);
    } else if (ext === 'pptx' || ext === 'pptm') {
      text = pptxText(buf);
    } else if (OLD_OFFICE.has(ext)) {
      warning = '旧版 .doc/.xls/.ppt 无法直接读取，请另存为 .docx/.xlsx/.pptx 后再添加';
    } else if (ZIP_OFFICE.has(ext)) {
      warning = '暂不支持该 Office 变体格式';
    } else if (looksBinary(buf)) {
      warning = '这看起来是二进制文件（如压缩包、可执行文件），无法作为文本读取';
    } else {
      text = decodeText(buf);
    }
  } catch (err) {
    warning = '解析失败：' + String((err && err.message) || err);
    text = text || '';
  }

  text = String(text || '').replace(/\u0000/g, '').trim();
  let truncated = false;
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    truncated = true;
    warning = (warning ? warning + '；' : '') + `内容较长，只取前 ${MAX_TEXT_CHARS.toLocaleString()} 个字符`;
  }
  if (!text && !warning) warning = '没有读到文字内容';

  return {
    name,
    ext,
    label: EXT_LABEL[ext] || (ext ? ext.toUpperCase() : '文件'),
    size: buf.length,
    sizeText: fmtSize(buf.length),
    chars: text.length,
    text,
    warning,
    truncated,
  };
}

async function extractFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('不是文件');
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`文件超过 ${fmtSize(MAX_FILE_BYTES)}，请先拆分`);
  }
  const buf = await fs.promises.readFile(filePath);
  const info = extractBuffer(path.basename(filePath), buf);
  info.size = stat.size;
  info.sizeText = fmtSize(stat.size);
  return info;
}

module.exports = { extractFile, extractBuffer, fmtSize, MAX_TEXT_CHARS };
