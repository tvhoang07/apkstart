'use strict';
/**
 * 极简 ZIP 读取器（仅依赖 Node 内置 zlib）
 * 只解析中央目录，按需Giải nén单cái条目，避免Lớn APK 全量Giải nén撑爆Bộ nhớ。
 *
 * 注意：本文件只做「读」，不做「写」。两处「LớnNhỏ」相关của不变量：
 *  - 单cái Buffer Có上限（Node 约 2GB），所以 GB 级条目一律走 ZipFile + pipeTo；
 *  - ZIP của传统 EOCD Dùng 16/32 位存条目数与偏移，超过就进位成 0xffff/0xffffffff，
 *    真正của值在 Zip64 EOCD（0x06064b50）与 Zip64 扩展字段（id=0x0001）里。
 *    两条Đường dẫn都必须识别，否则Lớn镜像包会被「静默截断条目」或直接越界。
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOC_SIG = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
// read() 单条目上限：超过就要求调Dùng方走 pipeTo（流式），避免整块进Bộ nhớ
const MAX_READ = 256 * 1024 * 1024;

/** 把 BigInt 偏移安全地转成 Number（ZIP 不可能Lớn过 2^53 byte） */
function toNum(v) { return typeof v === 'bigint' ? Number(v) : v; }

/**
 * 解析 Zip64 扩展字段（0x0001），补全中央目录里被置成 0xffffffff của字段。
 * 字段顺序固定：未压缩LớnNhỏ、压缩LớnNhỏ、本地头偏移、起始磁盘号；只出现「被置位」của那些。
 * @param {Buffer} extra 中央目录mụccủa扩展字段
 * @param {{uncompSize:number, compSize:number, localOffset:number}} fields
 */
function applyZip64Extra(extra, fields) {
  if (!extra || extra.length < 4) return fields;
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = extra.readUInt16LE(off);
    const len = extra.readUInt16LE(off + 2);
    const dataStart = off + 4;
    const dataEnd = dataStart + len;
    if (dataEnd > extra.length) break;
    if (id === 0x0001) {
      let p = dataStart;
      const take64 = () => {
        if (p + 8 > dataEnd) return null;
        const v = toNum(extra.readBigUInt64LE(p));
        p += 8;
        return v;
      };
      if (fields.uncompSize === MAX32) { const v = take64(); if (v !== null) fields.uncompSize = v; }
      if (fields.compSize === MAX32) { const v = take64(); if (v !== null) fields.compSize = v; }
      if (fields.localOffset === MAX32) { const v = take64(); if (v !== null) fields.localOffset = v; }
      break;
    }
    off = dataEnd;
  }
  return fields;
}

/**
 * 从 EOCD 位置解出条目数 / 中央目录LớnNhỏ / 中央目录偏移，Tự động跟进 Zip64。
 * @param {Buffer} buf 包含 EOCD của缓冲区
 * @param {number} eocd EOCD 在 buf 内của下标
 * @param {number} base buf[0] 对应của文件绝对偏移（ZipFile của尾部窗口Dùng）
 * @returns {{total:number, cdSize:number, cdOffset:number, eocdAbs:number}}
 */
function readEndOfCentralDirectory(buf, eocd, base) {
  let total = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const eocdAbs = base + eocd;

  const needsZip64 = total === MAX16 || cdSize === MAX32 || cdOffset === MAX32;
  if (!needsZip64) return { total, cdSize, cdOffset, eocdAbs };

  // Zip64 EOCD locator 固定紧挨在 EOCD 前面 20 byte
  const loc = eocd - 20;
  if (loc < 0) return { total, cdSize, cdOffset, eocdAbs };
  if (buf.readUInt32LE(loc) !== ZIP64_LOC_SIG) return { total, cdSize, cdOffset, eocdAbs };
  const z64Abs = toNum(buf.readBigUInt64LE(loc + 8));
  const z64 = z64Abs - base;
  if (z64 < 0 || z64 + 56 > buf.length) return { total, cdSize, cdOffset, eocdAbs };
  if (buf.readUInt32LE(z64) !== ZIP64_EOCD_SIG) return { total, cdSize, cdOffset, eocdAbs };

  total = toNum(buf.readBigUInt64LE(z64 + 32));
  cdSize = toNum(buf.readBigUInt64LE(z64 + 40));
  cdOffset = toNum(buf.readBigUInt64LE(z64 + 48));
  return { total, cdSize, cdOffset, eocdAbs };
}

class ZipArchive {
  constructor(buffer) {
    this.buf = buffer;
    this.entries = new Map();
    this._parse();
  }

  _parse() {
    const buf = this.buf;
    let eocd = -1;
    const maxScan = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= maxScan; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Không phải tệp ZIP/APK hợp lệ (không tìm thấy EOCD)');

    const { total, cdOffset } = readEndOfCentralDirectory(buf, eocd, 0);
    let offset = cdOffset;

    for (let i = 0; i < total; i++) {
      if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) break;
      const flags = buf.readUInt16LE(offset + 8);
      const method = buf.readUInt16LE(offset + 10);
      const nameLen = buf.readUInt16LE(offset + 28);
      const extraLen = buf.readUInt16LE(offset + 30);
      const commentLen = buf.readUInt16LE(offset + 32);
      const nameEnd = offset + 46 + nameLen;
      if (nameEnd > buf.length) break;
      const fields = applyZip64Extra(
        buf.subarray(nameEnd, nameEnd + extraLen),
        {
          uncompSize: buf.readUInt32LE(offset + 24),
          compSize: buf.readUInt32LE(offset + 20),
          localOffset: buf.readUInt32LE(offset + 42),
        },
      );
      const name = buf.toString('utf8', offset + 46, nameEnd);
      this.entries.set(name, {
        name, flags, method,
        compSize: fields.compSize,
        uncompSize: fields.uncompSize,
        localOffset: fields.localOffset,
      });
      offset = nameEnd + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }

  names() { return [...this.entries.keys()]; }

  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    const buf = this.buf;
    if (e.localOffset + 30 > buf.length) throw new Error(`Header tệp cục bộ vượt giới hạn: ${name}`);
    if (buf.readUInt32LE(e.localOffset) !== LOC_SIG) {
      throw new Error(`Header tệp cục bộ bị hỏng: ${name}`);
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    if (start + e.compSize > buf.length) throw new Error(`Dữ liệu mục vượt giới hạn: ${name}`);
    const raw = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`Kiểu nén không được hỗ trợ ${e.method}: ${name}`);
  }

  /** 列出匹配某cái前缀/正则của条目名 */
  find(re) {
    return [...this.entries.keys()].filter((n) => re.test(n));
  }

  /**
   * 流式Giải nén单cái条目到可写流。
   * system.img 这类 GB 级条目无法整块 inflate 进Bộ nhớ（会撞上 Node của 2GB 单 Buffer 上限），
   * 必须边Giải nén边落盘。
   */
  pipeTo(name, dest) {
    const e = this.entries.get(name);
    if (!e) return Promise.reject(new Error(`Mục không tồn tại: ${name}`));
    const buf = this.buf;
    if (buf.readUInt32LE(e.localOffset) !== LOC_SIG) {
      return Promise.reject(new Error(`Header tệp cục bộ bị hỏng: ${name}`));
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compSize);

    return new Promise((resolve, reject) => {
      const done = (err) => { if (err) reject(err); else resolve(e.uncompSize); };
      dest.on('error', done);
      dest.on('finish', () => done(null));

      if (e.method === 0) {
        dest.end(raw);
        return;
      }
      if (e.method !== 8) return done(new Error(`Kiểu nén không được hỗ trợ ${e.method}: ${name}`));

      const inflater = zlib.createInflateRaw();
      // Phân mảnh喂入，避免一次性把 GB 数据塞进 zlib 缓冲区
      const SLICE = 1 << 20;
      let pos = 0;
      const pump = () => {
        while (pos < raw.length) {
          const end = Math.min(pos + SLICE, raw.length);
          const chunk = raw.subarray(pos, end);
          pos = end;
          if (!inflater.write(chunk)) {
            inflater.once('drain', pump);
            return;
          }
        }
        inflater.end();
      };
      inflater.on('error', done);
      inflater.pipe(dest);
      pump();
    });
  }
}

/**
 * 文件版 ZIP 读取器：只把尾部中央目录读进Bộ nhớ，条目按需从 fd 流式读。
 * Dùng于 emulator / Ảnh hệ thống这类 GB 级Gói cài đặt——旧版 fs.readFileSync 整包读会
 * 在低Bộ nhớ机器上直接 OOM，表现là “下载完了却装不上」。
 */
class ZipFile {
  constructor(filePath) {
    this.path = filePath;
    this.fd = fs.openSync(filePath, 'r');
    this.size = fs.statSync(filePath).size;
    this.entries = new Map();
    try { this._parse(); } catch (e) { this.close(); throw e; }
  }

  close() {
    if (this.fd != null) { try { fs.closeSync(this.fd); } catch (_) { /* ignore */ } }
    this.fd = null;
  }

  _readAt(pos, len) {
    const n = Math.max(0, Math.min(len, this.size - pos));
    const b = Buffer.alloc(n);
    if (n > 0) {
      let got = 0;
      while (got < n) {
        // readSync 可能短读（尤其Lớn块），必须循环到读满
        const r = fs.readSync(this.fd, b, got, n - got, pos + got);
        if (r <= 0) break;
        got += r;
      }
    }
    return b;
  }

  _parse() {
    if (this.size < 22) throw new Error('Không phải tệp ZIP/APK hợp lệ (tệp quá nhỏ)');
    const tailLen = Math.min(this.size, 22 + 65557 + 4096);
    const tailBase = this.size - tailLen;
    const tail = this._readAt(tailBase, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Không phải tệp ZIP/APK hợp lệ (không tìm thấy EOCD)');

    const { total, cdSize, cdOffset, eocdAbs } = readEndOfCentralDirectory(tail, eocd, tailBase);
    if (cdOffset + cdSize > this.size) {
      throw new Error('ZIP Lệch vị trí thư mục trung tâm');
    }

    let cd = tail;
    let cdBase = tailBase;
    if (cdOffset < tailBase || cdOffset + cdSize > eocdAbs) {
      // 中央目录不在尾部缓冲里（超Lớn注释 / 多分卷），按声明LớnNhỏ精确读一段
      const len = Math.min(cdSize, 256 * 1024 * 1024);
      if (len <= 0) throw new Error('ZIP Lệch vị trí thư mục trung tâm');
      cd = this._readAt(cdOffset, len);
      cdBase = cdOffset;
    }

    let off = cdOffset - cdBase;
    for (let i = 0; i < total; i += 1) {
      if (off + 46 > cd.length || cd.readUInt32LE(off) !== CEN_SIG) break;
      const flags = cd.readUInt16LE(off + 8);
      const method = cd.readUInt16LE(off + 10);
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      const nameEnd = off + 46 + nameLen;
      if (nameEnd > cd.length) break;
      const fields = applyZip64Extra(
        cd.subarray(nameEnd, nameEnd + extraLen),
        {
          uncompSize: cd.readUInt32LE(off + 24),
          compSize: cd.readUInt32LE(off + 20),
          localOffset: cd.readUInt32LE(off + 42),
        },
      );
      const name = cd.toString('utf8', off + 46, nameEnd);
      this.entries.set(name, {
        name, flags, method,
        compSize: fields.compSize,
        uncompSize: fields.uncompSize,
        localOffset: fields.localOffset,
      });
      off = nameEnd + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }
  names() { return [...this.entries.keys()]; }
  find(re) { return this.names().filter((n) => re.test(n)); }

  _range(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error(`Mục không tồn tại: ${name}`);
    const head = this._readAt(e.localOffset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== LOC_SIG) throw new Error(`Header tệp cục bộ bị hỏng: ${name}`);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    return { e, start, end: start + e.compSize - 1 };
  }

  read(name) {
    const { e, start } = this._range(name);
    // read() 会把整cái条目解到Bộ nhớ：给一cái明确上限，避免未来某cái调Dùng点顺手
    // 拿来读 GB 级镜像（那正是 issue #21 里「Lớn包必炸」của形态）。
    if (e.compSize > MAX_READ) {
      throw new Error(`Mục quá lớn (${(e.compSize / 1048576).toFixed(0)}MB), hãy dùng pipeTo: ${name}`);
    }
    const raw = this._readAt(start, e.compSize);
    if (raw.length < e.compSize) throw new Error(`Dữ liệu mục bị cắt cụt: ${name}`);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`Kiểu nén không được hỗ trợ ${e.method}: ${name}`);
  }

  pipeTo(name, dest) {
    let r;
    try { r = this._range(name); } catch (e) { return Promise.reject(e); }
    const { e, start, end } = r;
    return new Promise((resolve, reject) => {
      const done = (err) => (err ? reject(err) : resolve(e.uncompSize));
      dest.on('error', done);
      dest.on('finish', () => done(null));
      if (e.compSize === 0) { dest.end(); return undefined; }
      if (e.method !== 0 && e.method !== 8) return done(new Error(`Kiểu nén không được hỗ trợ ${e.method}: ${name}`));
      const src = fs.createReadStream(null, {
        fd: this.fd, autoClose: false, start, end: Math.max(start, end),
      });
      src.on('error', done);
      if (e.method === 0) return src.pipe(dest);
      const inflater = zlib.createInflateRaw();
      inflater.on('error', done);
      return src.pipe(inflater).pipe(dest);
    });
  }
}

/**
 * 把 ZIP 条目名安全解析到 destDir 下，挡住 zip-slip（issue #2 P0-4）。
 * 恶意包trong "../evil"、绝对Đường dẫn、盘符、"C:\..."、UNC 都必须在写盘前拒绝。
 * 返回 null 表示该条目不可信，调Dùng方应跳过。
 */
function resolveZipEntry(destDir, name) {
  if (typeof name !== 'string' || !name) return null;
  // 统一正斜杠后判断：反斜杠在 Windows 上同样是Đường dẫn分隔符
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) return null;
  const segments = normalized.split('/');
  if (segments.some((s) => s === '..')) return null;
  const root = path.resolve(destDir);
  const target = path.resolve(root, ...segments.filter((s) => s && s !== '.'));
  // path.resolve 可能因为盘符/挂载点把Mục tiêu甩到根目录外，最后再nhân一次前缀边界
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

module.exports = { ZipArchive, ZipFile, resolveZipEntry };
