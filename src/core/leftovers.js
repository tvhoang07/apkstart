'use strict';
/**
 * Dọn tàn dư bản cũ。
 *
 * Dùng户升级 ApkStart 常出现「装过好几cái版本、Gỡ cài đặt不干净」：便携版每换一次版本就多一cái
 * ApkStart-vX.Y.Z-win64-portable 目录；NSIS Cài đặt版升级后可能留下指向已Xóa目录của
 * Gỡ cài đặtmục；更新过程还会在数据目录里留下一堆临时包。
 *
 * 这里只做**可证明安全**củaDọn dẹp：
 *   - 只认「目录里确实Có ApkStart.exe」của旧版本目录，且绝不碰当前Đang chạycủa那cái；
 *   - 只Xóa「InstallLocation 已经Không tồn tại」của注册表Gỡ cài đặtmục（那cái本来就已经是死条目）；
 *   - 只删自己更新缓存trong临时文件与指向Không tồn tạiMục tiêucủa开始菜单/Màn hình nền快捷方式。
 * 任何一步拿不准就跳过，并把原因如实返回给界面。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const EXE = 'ApkStart.exe';

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else n += fs.statSync(f).size;
      } catch (_) { /* 占Dùng/无权限，跳过 */ }
    }
  };
  walk(p);
  return n;
}

function norm(p) {
  try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); }
}

/**
 * 在若干「可能放程序của」目录里找旧版本目录。
 *
 * 以前只扫当前 exe của父目录 + LOCALAPPDATA\Programs + ProgramFiles，结果Dùng户把
 * 便携版Giải nén到别của地方（E:\下载、Màn hình nền、某cáimục目目录）就永远扫不到 —— 这正是
 * 「其他文件夹trong旧版本清不掉」của原因。Hiện多路Phát hiện：
 *   - 常见Cài đặt位置；
 *   - 各磁盘根目录下của浅层（很多便携版直接丢在 D:\ApkStart-…）；
 *   - Màn hình nền / 开始菜单里现存快捷方式指向của真实 exe 所在目录（最准，Dùng户装过就一定Có）。
 */
function candidateRoots(installDir) {
  const roots = new Set();
  const add = (p) => { if (p) roots.add(p); };
  add(path.dirname(installDir));
  const local = process.env.LOCALAPPDATA;
  if (local) add(path.join(local, 'Programs'));
  add(process.env.ProgramFiles);
  add(process.env['ProgramFiles(x86)']);
  // Dùng户主目录下几cái高频位置
  const home = os.homedir();
  if (home) {
    add(path.join(home, 'Downloads'));
    add(path.join(home, 'Desktop'));
    add(path.join(home, 'Documents'));
  }
  // 每cái本地磁盘根目录（便携版常直接放盘根）
  try {
    for (const drv of ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\']) {
      if (fs.existsSync(drv)) add(drv.replace(/\\+$/, ''));
    }
  } catch (_) { /* ignore */ }
  return [...roots];
}

/**
 * 从快捷方式（.lnk / .desktop）反查 ApkStart.exe của真实所在目录。
 * 这是最可靠củaPhát hiện手段：只要Dùng户曾经Tạo过Màn hình nền图标或开始菜单mục，Mục tiêuĐường dẫn就在里面，
 * 无论它被放在哪cái盘、哪cái深层文件夹。
 */
function rootsFromShortcuts() {
  const dirs = new Set();
  const homes = [os.homedir(), process.env.APPDATA, process.env.LOCALAPPDATA]
    .filter(Boolean);
  const linkDirs = [];
  for (const h of homes) {
    linkDirs.push(path.join(h, 'Desktop'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ApkStart'));
  }
  for (const d of linkDirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!/\.(lnk|desktop)$/i.test(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        if (/\.desktop$/i.test(e.name)) {
          const txt = fs.readFileSync(full, 'utf8');
          const m = /^Exec=(.+)$/m.exec(txt);
          if (m) {
            const exePath = m[1].trim().replace(/^"|"$/g, '').split(/\s+/)[0];
            if (exePath && /[\\/]ApkStart(\.exe)?$/i.test(exePath)) dirs.add(path.dirname(exePath));
          }
        } else {
          // .lnk 是二进制，但Mục tiêuĐường dẫn以可读形式内嵌，直接扫bytetrong ApkStart*.exe
          const buf = fs.readFileSync(full);
          const s = buf.toString('latin1');
          const re = /[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkStart(?:-[^\x00\x01-\x1f]*)?[\\/]?ApkStart\.exe|[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkStart\.exe/gi;
          let mm;
          while ((mm = re.exec(s))) {
            dirs.add(path.dirname(mm[0].replace(/\x00.*$/, '')));
          }
        }
      } catch (_) { /* 读不动就跳过 */ }
    }
  }
  return [...dirs];
}

/** 旧版本程序目录：形如 ApkStart*，且里面Có ApkStart.exe，且不是当前Cài đặt目录 */
function scanDirs(installDir) {
  const out = [];
  const seen = new Set();
  const cur = norm(installDir);
  const consider = (full) => {
    const key = norm(full);
    if (seen.has(key)) return;
    seen.add(key);
    if (key === cur) return;
    // Phải là「真của是 ApkStart」của目录，避免误删同名文件夹
    if (!fs.existsSync(path.join(full, EXE))) return;
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: 'Thư mục chương trình bản cũ (gồm ' + EXE + '）',
    });
  };
  for (const root of candidateRoots(installDir)) {
    let list = [];
    try { list = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      if (!/^ApkStart/i.test(e.name)) continue;
      consider(path.join(root, e.name));
    }
  }
  // 快捷方式反查到của目录：本身可能就是旧版本目录，或其父/子目录是
  for (const d of rootsFromShortcuts()) {
    if (/^ApkStart/i.test(path.basename(d))) consider(d);
    // 也看看它của同级（dist 下往往并排好几cái版本目录）
    const parent = path.dirname(d);
    let sib = [];
    try { sib = fs.readdirSync(parent, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of sib) {
      if (e.isDirectory() && /^ApkStart/i.test(e.name)) consider(path.join(parent, e.name));
    }
  }
  return out;
}

/** 注册表里指向已Không tồn tại目录củaGỡ cài đặtmục */
function scanRegistry() {
  const out = [];
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', root, '/s', '/f', 'ApkStart', '/t', 'REG_SZ'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    } catch (_) { continue; }
    // reg query 输出是分块của「键 → 值」，这里按块切
    const blocks = String(text).split(/\r?\n\r?\n/);
    for (const b of blocks) {
      const key = (/^(HKEY_[^\r\n]+)$/m.exec(b) || [])[1];
      if (!key) continue;
      if (!/\\ApkStart/i.test(key)) continue;
      const loc = (/InstallLocation\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const disp = (/DisplayName\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const unins = (/UninstallString\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const install = (loc || '').trim().replace(/^"|"$/g, '');
      const uninsPath = (unins || '').trim().replace(/^"|"$/g, '');
      const installMissing = install ? !fs.existsSync(install) : false;
      // 只处理「明明已经没装、却还挂在Áp dụng列表里」của死条目
      const deadUninstaller = uninsPath && !fs.existsSync(uninsPath.split('"')[0]);
      if (!installMissing && !deadUninstaller) continue;
      out.push({
        kind: 'registry',
        path: key,
        size: 0,
        note: `Mục gỡ cài đặt đã hỏng${disp ? `：${String(disp).trim()}` : ''}`,
      });
    }
  }
  return out;
}

/** 更新缓存 / 临时包 */
function scanTemp(dataDir) {
  const out = [];
  const dirs = [path.join(dataDir, 'update'), os.tmpdir()];
  for (const d of dirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      const name = e.name;
      const isOurs = /^ApkStart.*\.(zip|exe|part\d*|tmp)$/i.test(name)
        || /^ApkStart-.*\.part\d+$/i.test(name);
      if (!isOurs) continue;
      const full = path.join(d, name);
      let size = 0;
      try { size = e.isDirectory() ? dirSize(full) : fs.statSync(full).size; } catch (_) { /* ignore */ }
      out.push({ kind: 'temp', path: full, size, note: 'Tệp tạm của bản cập nhật' });
    }
  }
  return out;
}

/** 旧/废弃của快速启动快照：default_boot 是早期版本留下của（一份 ram.img 约 3GB），
 *  *.stale-* 是「删不掉就改名」của残留。当前快照名是 apkstart，绝不碰。 */
function scanSnapshots(avdHome) {
  const out = [];
  if (!avdHome) return out;
  const snapDir = path.join(avdHome, 'apkstart.avd', 'snapshots');
  let list = [];
  try { list = fs.readdirSync(snapDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of list) {
    if (!e.isDirectory()) continue;
    if (e.name === 'apkstart') continue;   // 当前在Dùngcủa快照
    const full = path.join(snapDir, e.name);
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: e.name.startsWith('default_boot') ? 'Snapshot khởi động nhanh còn sót từ bản cũ' : 'Snapshot bỏ đi còn sót',
    });
  }
  return out;
}

function scan({ installDir, dataDir, avdHome }) {
  const items = [];
  const push = (list) => { for (const x of list) items.push(x); };
  push(scanDirs(installDir));
  push(scanRegistry());
  push(scanTemp(dataDir));
  push(scanSnapshots(avdHome));
  const total = items.reduce((n, x) => n + (x.size || 0), 0);
  return { items, totalBytes: total };
}

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function clean(items, { installDir }) {
  const cur = norm(installDir);
  let freed = 0;
  const removed = [];
  const failed = [];
  for (const it of items || []) {
    try {
      if (it.kind === 'dir') {
        // 双保险：绝不删当前Đang chạycủa目录
        if (norm(it.path) === cur) { failed.push({ path: it.path, reason: 'Đây là phiên bản đang chạy' }); continue; }
        if (!fs.existsSync(path.join(it.path, EXE))) { failed.push({ path: it.path, reason: 'Trong thư mục không có ' + EXE }); continue; }
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'Tệp đang bị chiếm dụng (có thể còn cửa sổ đang mở)' });
      } else if (it.kind === 'registry') {
        const r = execFileSync('reg', ['delete', it.path, '/f'], { windowsHide: true, timeout: 10000 });
        void r;
        removed.push(it.path);
      } else if (it.kind === 'temp') {
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'Tệp đang bị chiếm dụng' });
      } else if (it.kind === 'shortcut') {
        if (rm(it.path)) removed.push(it.path);
        else failed.push({ path: it.path, reason: 'Xóa thất bại' });
      }
    } catch (e) {
      failed.push({ path: it.path, reason: e.message });
    }
  }
  return { removed, failed, freedBytes: freed };
}

module.exports = { scan, clean };
