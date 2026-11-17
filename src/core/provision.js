'use strict';
/**
 * Bộ chạy自举（Provisioning）
 *
 * ApkStart 不依赖任何第三方模拟器：adb、QEMU、Ảnh hệ thống全部由自己下载/校验/管理。
 * 所CóBộ chạy文件都放在 %APPDATA%\apkstart\runtime 下，保证在任何Cài đặt位置都可写。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const store = require('./store');
const doctor = require('./doctor');
const { download, downloadAny, downloadAnyParallel, downloadMulti, head, discardPartial } = require('./download');
const { ZipArchive, ZipFile, resolveZipEntry } = require('./zip');
const { Sources } = require('./sources');
const { cmpVer } = require('./version');

const IS_WIN = process.platform === 'win32';

const SOURCES = {
  adb: [
    'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  ],
  qemuIndex: 'https://qemu.weilnetz.de/w64/',
  qemuFallback: [
    'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe',
  ],
  // Google 官方 SDK 索引：emulator 与Ảnh hệ thốngcủa真实地址从这里动态解析，不写死版本号
  sdkIndex: 'https://dl.google.com/android/repository/repository2-3.xml',
  sysImgIndexes: [
    'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
    'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
  ],
  aehdFallback: 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip',
  // 兜底：索引Không khả dụng时直接Dùngcủa已知版本
  emulatorFallback: 'https://dl.google.com/android/repository/emulator-windows_x64-16847572.zip',
  sysimgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // ARM Ảnh hệ thống tương thích（Google Play 版，内置 native bridge）
  playImgIndex: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml',
  playImgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // Android-x86 9.0-r2（x86_64）：仅在Dùng户已自备 ISO 时使Dùng
  iso: [
    'https://master.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso?viasf=1',
    'https://nchc.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://phoenixnap.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://downloads.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
  ],
  isoSizeHint: 900 * 1024 * 1024,
  // 轻量版（不带Bộ chạy）从这里拿「Toàn bộ gói bộ chạy」：本mục目自己của GitHub Release。
  // 以前轻量版要从 dl.google.com 分别下 emulator / Ảnh hệ thống，国内网络经常
  // 卡在几十 KB/s 甚至直接 404；改成整包 + 本mục目 GitHub 之后，下载源和更新源
  // 是同一cái地方，出了问题也只Cần在一cái地方修。
  ghReleaseApi: 'https://api.github.com/repos/RoutineMiku/apkstart/releases',
  ghReleasePage: 'https://github.com/RoutineMiku/apkstart/releases',
  // 同内容của Gitee 镜像：国内直连 api.github.com 常常几十秒才响应，Gitee 一般几百毫秒。
  // 两边都问一次，谁先给出「带Toàn bộ gói bộ chạycủa最高版本」就Dùng谁。
  giteeReleaseApi: 'https://gitee.com/api/v5/repos/daily-miku/apkstart/releases',
  giteeReleasePage: 'https://gitee.com/daily-miku/apkstart/releases',
};

/**
 * SDK 索引trong <url> 是相对Đường dẫn，基准目录各不相同：
 *   repository2-3.xml      → https://dl.google.com/android/repository/
 *   sys-img/android/*.xml  → https://dl.google.com/android/repository/sys-img/android/
 * 所以基准目录一律取「索引文件自身所在目录」。此前直接拿文件名当 URL 会抛 Invalid URL。
 */
const REPO_BASE = 'https://dl.google.com/android/repository/';

function baseOf(indexUrl) {
  const s = String(indexUrl || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i + 1) : REPO_BASE;
}

function absUrl(u, base = REPO_BASE) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return base + s.replace(/^\/+/, '');
}

/**
 * 只保留一份「通Dùng基础镜像」。
 * 旧版默认 AOSP API30 + 可Chọn API34 Play Ảnh hệ thống tương thích，导致：
 *   - Dùng户装国产 ARM Áp dụng时必然Thất bại，还要手动切镜像（实Dùng门槛）；
 *   - 两份镜像各 0.6~3GB，Bộ chạy目录动辄十几 GB；
 *   - 切换镜像要 wipe-data，Ứng dụng đã cài全丢。
 * Hiện统一为 Android 14 Google Play x86_64：x86 Áp dụng、ARM Áp dụng、GMS 都能跑，
 * 全机只存一份只读基础层（容器式Tổng享），按需下载一次即可。
 */
const PLAY_SYSIMG = { api: '34', tag: 'google_apis_playstore', abi: 'x86_64' };
const DEFAULT_SYSIMG = PLAY_SYSIMG;

const MIN_SIZE = {
  adb: 5 * 1024 * 1024,
  qemu: 60 * 1024 * 1024,
  iso: 400 * 1024 * 1024,
  disk: 1024 * 1024,
  emulator: 200 * 1024 * 1024,
  sysimg: 300 * 1024 * 1024,
  aeHD: 64 * 1024,
};

function run(cmd, args, { timeout = 60000, cwd, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, windowsHide, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

/**
 * 目录可写性探测（结果按目录缓存）。
 *
 * 为什么不Dùng fs.accessSync(dir, W_OK)：Windows 上它只看「只读」文件属性、
 * 不看 ACL，对 C:\Program Files\WindowsApps\...（MSIX Cài đặt目录）会给出错误của
 * 「可写」结论，然后 .img.xz 展开到一半才Thất bại。这里真của写一cái探测文件再删掉。
 */
const _dirWritableCache = new Map();
function provisionDirWritable(dir) {
  if (_dirWritableCache.has(dir)) return _dirWritableCache.get(dir);
  let ok = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.apkstart-wtest-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
    ok = true;
  } catch (_) {
    ok = false;
  }
  _dirWritableCache.set(dir, ok);
  return ok;
}

/**
 * 下载完của完整性检查。不通过就**删掉这cái不完整文件**。
 *
 * 以前这里只抛错、不删文件，于是 tmp 里永远留着一cái半截 zip。下次进来
 * download() 看到已Có文件就带 Range 续传 —— 若服务器/源变了，续传来củabyte
 * 和前半截拼不上，又Thất bại、又留半截…… Dùng户看到của就是「一直重复下载」。
 */
function assertComplete(file, minBytes, label) {
  const size = fileSize(file);
  if (size >= minBytes) return size;
  discardPartial(file);
  throw new Error(`${label}Tải chưa đầy đủ (${(size / 1048576).toFixed(1)} MB), đã dọn dẹp, hãy thử lại`);
}

/**
 * 环境探测结果của落盘缓存。
 *
 * `emulator -version` 与 `emulator -accel-check` 每次都要新起一cái emulator 进程，
 * 在 Windows 上实测 1~3 秒；而这两mục在「Engine/Trình điều khiển没变」时结果恒定。
 * 以前只在Bộ nhớ里缓存 30 秒，等于每次Khởi động nguội都要重付一遍，而且这几秒正好卡在
 * Dùng户点开Áp dụngcủa那一刻。这里按「exe LớnNhỏ+修改时间 + AEHD Trình điều khiển时间 + WHPX 组件」
 * 做指纹落到 %APPDATA%，软硬件一换Tự động失效。
 */
const ENV_CACHE_TTL = 6 * 60 * 60 * 1000;
const ENV_CACHE_NEG_TTL = 10 * 60 * 1000; // Tăng tốc「Không khả dụng」只信 10 phút: dùng户可能刚去开了虚拟化

function envCacheFile() {
  return path.join(store.DATA_DIR, 'cache', 'env.json');
}

function statKey(p) {
  try {
    const s = fs.statSync(p);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch (_) { return ''; }
}

class Provisioner {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this._hypervisor = null;
    this._cache = { adbVersion: '', qemuVersion: '' };
    this._sources = new Sources(() => store.getSettings());
  }

  /** 双源/镜像của统一入口（测速缓存也在这里，多cái组件TổngDùng一份） */
  get sources() {
    return this._sources;
  }

  /** 缓存指纹：Engine文件与Tăng tốcTrình điều khiển任一变化就换 key */
  _envKey(exe) {
    const aehd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    return [
      String(exe || '').replace(/\\/g, '/').toLowerCase(),
      statKey(exe),
      statKey(aehd),
      fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll') ? '1' : '0',
    ].join('|');
  }

  envCacheGet(exe) {
    try {
      const j = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8'));
      if (!j || j.key !== this._envKey(exe)) return null;
      return j;
    } catch (_) { return null; }
  }

  envCacheSet(exe, patch) {
    try {
      const key = this._envKey(exe);
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8')) || {}; } catch (_) { /* 首次 */ }
      const base = cur.key === key ? cur : { key, version: null, accel: null, accelAt: 0 };
      const next = { ...base, ...patch, key, at: Date.now() };
      fs.mkdirSync(path.dirname(envCacheFile()), { recursive: true });
      fs.writeFileSync(envCacheFile(), JSON.stringify(next));
    } catch (_) { /* 缓存写不进去不影响主流程 */ }
  }

  /** 开机Thất bại（Tăng tốc/镜像类问题）时调Dùng：下次启动重新探测，避免一直Dùng错của结论 */
  invalidateEnvCache() {
    this._cache = { adbVersion: '', qemuVersion: '' };
    try { fs.rmSync(envCacheFile(), { force: true }); } catch (_) { /* ignore */ }
  }

  // ---------------- Đường dẫn ----------------

  get root() {
    const r = store.getSettings().runtime.dir;
    return r && r.trim() ? r : path.join(store.DATA_DIR, 'runtime');
  }

  paths() {
    const root = this.root;
    const sysTag = DEFAULT_SYSIMG.tag;
    const sysApi = DEFAULT_SYSIMG.api;
    const sysAbi = DEFAULT_SYSIMG.abi;
    // Bộ chạy目录可写吗？
    // 商店（MSIX）版把 emulator / platform-tools / system-images 直接放在Gói cài đặt
    // 里（C:\Program Files\WindowsApps\...），该目录是只读của：
    //   - 就地展开 .img.xz、建 _tmp、建 qemu/ 都会Thất bại；
    //   - 但可执行文件从包里跑是允许của（而且这样才Có包身份，%APPDATA% 虚拟化
    //     视图才能和父进程一致）。
    // 所以「能执行」和「可写」要分开：可执行Đường dẫnTiếp tục指向包内，可写của数据
    // （镜像展开目录 / AVD / 临时目录）全部改到Dùng户数据目录。
    const rootWritable = provisionDirWritable(root);
    // AVD（含Dùng户数据、Ứng dụng đã cài、quickboot 快照）必须落在可写且不会被Dọn dẹpcủa地方。
    // 单文件发行版củaBộ chạy是随包Giải nén到临时目录của，把 AVD 放进去等于每次Thoát都丢Áp dụng。
    // 只要Bộ chạy目录不在 %APPDATA% 里，就把 AVD 固定指到Dùng户数据目录。
    // 另外：允许在Cài đặt里单独指定「安卓数据目录」——它才是真正吃盘của地方
    // （6~24GB 数据Phân vùng + 2~3GB 快照），只挪Bộ chạy、不挪它，C 盘一样会满。
    const explicitAvd = String(store.getSettings().runtime.avdDir || '').trim();
    const writable = explicitAvd || path.join(store.DATA_DIR, 'avd');
    const insideData = root.toLowerCase().startsWith(store.DATA_DIR.toLowerCase());
    // Ảnh hệ thống放哪儿：**Bộ chạy目录优先**。
    // 之前của顺序是「Dùng户数据目录优先」，后果是——Dùng户把Bộ chạy目录改到 D 盘省 C 盘Trống间，
    // 1.4GB của整包解到 D 盘以后，materializeImages 又把 3.3GB của system.img 展开回
    // C://Users//...//AppData//Roaming//apkstart//system-images，C 盘照样被吃掉，而且
    // 同一套镜像在两处各存一份（实测 1.2GB + 3.3GB 并存）。
    // Hiện：Bộ chạy目录里已经Có system-images（整包Giải néncủa产物）就Dùng它；
    // 没Có才回退到Dùng户数据目录（老版本、单文件发行版都是这种布局）。
    const rootImg = path.join(root, 'system-images');
    const dataImg = path.join(store.DATA_DIR, 'system-images');
    // 三种情况：
    //  1) Bộ chạy目录里已经Có镜像（整包Giải néncủa产物）→ Dùng它của；
    //  2) 老Dùng户/单文件发行版把镜像放在Dùng户数据目录 → Dùng那trong；
    //  3) 全新Cài đặt（两处都没Có）→ 落在Bộ chạy目录，因为Dùng户数据目录可能是被
    //     重定向过của临时目录（CI 组装Bộ chạy就是这种情况，写歪会直接校验Thất bại）。
    //  4) Bộ chạy目录只读（MSIX 包内）→ 必须落到Dùng户数据目录，否则 .img.xz 展不开。
    let sysRoot;
    if (!rootWritable) sysRoot = dataImg;
    else if (fs.existsSync(rootImg)) sysRoot = rootImg;
    else if (fs.existsSync(dataImg)) sysRoot = dataImg;
    else sysRoot = rootImg;
    return {
      root,
      // 只Có可写时才把临时目录/辅助目录放在 root 下，否则一律改Dùng数据目录
      writeRoot: rootWritable ? root : path.join(store.DATA_DIR, 'runtime'),
      qemuDir: path.join(root, 'qemu'),
      qemuExe: path.join(root, 'qemu', 'qemu-system-x86_64.exe'),
      qemuImg: path.join(root, 'qemu', 'qemu-img.exe'),
      adbDir: path.join(root, 'platform-tools'),
      adbExe: path.join(root, 'platform-tools', 'adb.exe'),
      // emulator Bộ chạy（Google 官方）：root 同时充当 ANDROID_SDK_ROOT
      emulatorDir: path.join(root, 'emulator'),
      emulatorExe: path.join(root, 'emulator', 'emulator.exe'),
      sysImgRoot: sysRoot,
      sysImgDir: path.join(sysRoot, `android-${sysApi}`, sysTag, sysAbi),
      avdHome: insideData ? path.join(root, 'avd') : writable,
      aehdDir: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), 'aehd'),
      imagesDir: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), 'images'),
      iso: path.join(root, 'images', 'android-x86.iso'),
      disk: path.join(root, 'images', 'android.qcow2'),
      tmp: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), '_tmp'),
      rootWritable,
      sysTag, sysApi, sysAbi,
    };
  }

  ensureDirs() {
    const p = this.paths();
    for (const d of [p.root, p.qemuDir, p.adbDir, p.imagesDir, p.tmp, p.avdHome]) {
      // 逐cái容错：商店（MSIX）版của p.root 在只读củaGói cài đặt里，建不出来也正常，
      // 可写目录已经全部改道到Dùng户数据目录（见 paths()）。一cái建不出来不该
      // 让整条启动Đường dẫn抛错。
      try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* 只读/被占Dùng都跳过 */ }
    }
    return p;
  }

  /**
   * 磁盘守卫：在下载 / Giải nén一份Lớn体积组件之前，先Xác nhậnMục tiêu盘Có足够Khả dụngTrống间。
   * 否则会下到一半把系统盘撑爆，或Giải nén阶段直接Thất bại（且残留半截文件）。
   * 预留 1GB 缓冲：模拟器/镜像Giải nén后还Có快照、Dùng户数据Phân vùng会持续膨胀。
   * @param {string} component 组件名（决定所需Trống间估算）
   * @param {string} targetDir 写入目录（据此定位所在盘）
   */
  async guardDisk(component, targetDir) {
    const need = {
      adb: 64, emulator: 600, sysimg: 1800, playimg: 1800, qemu: 320, iso: 1100, aehd: 64,
      // Toàn bộ gói bộ chạy：1.5GB 压缩包 + 展开后 ~3.3GB 镜像，峰值同时存在
      runtime: 5000,
    }[component] || 512; // MB
    const buf = 1024; // 额外预留 1GB（快照 / 数据Phân vùng / Giải nén中间文件）
    const dir = targetDir || this.root;
    const free = doctor.freeDiskMB(dir);
    if (free && free < need + buf) {
      throw new Error(
        `Ổ đĩa đích không đủ dung lượng: thành phần này cần khoảng ${need + buf} MB, nhưng “${dir}” nằm trên ổ chỉ còn ${free} MB。\n`
        + 'Gợi ý: đổi “Thư mục dữ liệu bộ chạy” sang ổ có nhiều dung lượng hơn (Cài đặt → Tích hợp hệ thống → Thư mục dữ liệu bộ chạy → Duyệt),'
        + 'Hoặc hãy dọn đĩa / gỡ ứng dụng không dùng rồi thử lại.',
      );
    }
    return free;
  }

  // ---------------- 环境检查 ----------------

  async hypervisor() {
    if (this._hypervisor !== null) return this._hypervisor;
    if (!IS_WIN) { this._hypervisor = { whpx: false, note: 'Không phải nền tảng Windows' }; return this._hypervisor; }
    // 只做毫秒级của文件检查。真正"WHPX 是否Khả dụng"由 emulator -accel-check 给出权威答案，
    // 避免在这里拉起 PowerShell（Khởi động nguội 1-2 giây)拖慢每次状态轮询。
    const dll = fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll');
    this._hypervisor = {
      whpx: false,          // 由 emulatorAccel() 覆盖为真实值
      dll,
      hypervisorPresent: false,
      note: dll
        ? 'Có thành phần nền tảng máy ảo (khả dụng do engine bộ chạy kiểm tra)'
        : 'Không phát hiện thành phần Windows Hypervisor Platform: vào “Bật hoặc tắt các tính năng của Windows”, tích “Virtual Machine Platform” rồi khởi động lại',
    };
    return this._hypervisor;
  }

  async adbVersion() {
    // 30s 缓存，避免状态轮询频繁拉起外部进程
    if (this._adbCache && Date.now() - this._adbCache.at < 30000) return this._adbCache.value;
    const { adbExe, adbDir } = this.paths();
    const candidates = [adbExe, path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['version'], { timeout: 10000 });
      if (r.ok) {
        const m = /version\s+([\d.]+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : r.stdout.split('\n')[0].trim() };
        this._adbCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._adbCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._adbCache.value;
  }

  async qemuVersion() {
    if (this._qemuCache && Date.now() - this._qemuCache.at < 30000) return this._qemuCache.value;
    const p = this.paths();
    const candidates = [
      p.qemuExe,
      store.getSettings().runtime.qemuPath,
      'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',   // winget 默认Cài đặt位置
      path.join(this.appRoot, 'engine', 'qemu', 'qemu-system-x86_64.exe'),
    ].filter(Boolean);
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['--version'], { timeout: 15000 });
      if (r.ok || r.stdout) {
        const m = /QEMU emulator version\s+(\S+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : (r.stdout || '').split('\n')[0].trim() };
        this._qemuCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._qemuCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._qemuCache.value;
  }

  /** 校验 ISO9660 主卷描述符（偏移 0x8001 处của "CD001"），防止把错误页/半截文件当镜像 */
  inspectIso(file) {
    const size = fileSize(file);
    if (!size) return { ok: false, iso9660: false, size: 0, reason: 'Chưa tải' };
    let magic = '';
    try {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(5);
      fs.readSync(fd, b, 0, 5, 0x8001);
      fs.closeSync(fd);
      magic = b.toString('latin1');
    } catch (_) { /* ignore */ }

    const iso9660 = magic === 'CD001';
    // Dùng户导入của raw/已装磁盘镜像不含 ISO 引导区，按尺寸放行
    const rawImage = !iso9660 && /\.(img|raw|qcow2)$/i.test(file) && size > MIN_SIZE.iso;
    const ok = size > MIN_SIZE.iso && (iso9660 || rawImage);

    let reason = '';
    if (!ok) {
      reason = size <= MIN_SIZE.iso
        ? `Tệp chỉ có ${(size / 1048576).toFixed(1)}MB, tải chưa xong`
        : 'Không phải ảnh ISO9660 hợp lệ (có thể đã tải nhầm trang lỗi hoặc tệp hỏng)';
    }
    return { ok, iso9660, rawImage, size, reason, magic };
  }

  async checkEnv() {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const [adb, qemu, hv, emulator, accel] = await Promise.all([
      this.adbVersion(), this.qemuVersion(), this.hypervisor(),
      this.emulatorVersion(), this.emulatorAccel(),
    ]);

    const isoPath = s.runtime.isoPath || p.iso;
    const diskPath = s.runtime.diskPath || p.disk;
    const iso = this.inspectIso(isoPath);
    const diskSize = fileSize(diskPath);
    const sysimg = this.systemImageInfo();

    // 完整版（内置Bộ chạy）只带一份 API 34 Google Play 镜像，它同时是主镜像与Ảnh hệ thống tương thích；
    // 不再依赖 compatImage 开关，避免「镜像明明在，却因为没勾开关而判定未部署」
    const playImage = this.playImageInfo();
    const compatReady = playImage.ok;
    const emulatorReady = emulator.ok && (sysimg.ok || compatReady);
    const qemuReady = qemu.ok && diskSize > MIN_SIZE.disk;
    // 包内带来của是 .xz/.gz：镜像「在」，只是还没展开。上层据此判断
    // 「要不要联网下载」—— Có镜像就绝不下载，只展开。
    const needsExtract = !!(sysimg.compressed || (compatReady && playImage.compressed));

    return {
      adb: { ...adb, required: true },
      emulator: { ...emulator, required: true, note: emulator.ok ? emulator.version : 'Chưa cài đặt' },
      sysimg: {
        ok: sysimg.ok || compatReady,
        dir: sysimg.dir,
        size: sysimg.ok ? sysimg.size : (compatReady ? playImage.size : 0),
        api: sysimg.ok ? sysimg.api : (compatReady ? PLAY_SYSIMG.api : sysimg.api),
        compressed: needsExtract,
        required: false,
        note: sysimg.ok
          ? `Android ${sysimg.api}（${(sysimg.size / 1073741824).toFixed(2)} GB${sysimg.compressed ? ', bản nén trong gói, tự bung ra khi khởi động lần đầu' : ''}）`
          : (compatReady
            ? `Android ${PLAY_SYSIMG.api}（${playImage.compressed ? 'Bản nén trong gói, tự giải nén khi khởi động lần đầu' : 'ARM Ảnh hệ thống tương thích'}）`
            : (sysimg.note || 'Chưa tải')),
      },
      // true = 镜像就在本地（包内），只需展开一次；上层据此**禁止**任何联网下载
      needsExtract,
      playImage,
      accel,
      qemu: { ...qemu, required: false },
      iso: {
        ok: iso.ok,
        path: isoPath,
        size: iso.size,
        iso9660: iso.iso9660,
        required: false,
        note: iso.size ? `${(iso.size / 1073741824).toFixed(2)} GB` : 'Chưa tải',
        reason: iso.reason,
      },
      disk: {
        ok: diskSize > MIN_SIZE.disk,
        path: diskPath,
        size: diskSize,
        required: false,
        note: diskSize ? `${(diskSize / 1073741824).toFixed(2)} GB` : 'Chưa tạo',
      },
      hypervisor: hv,
      ready: !!(adb.ok && (emulatorReady || qemuReady)),
      engine: emulatorReady ? 'emulator' : (qemuReady ? 'qemu' : 'none'),
      paths: p,
    };
  }

  // ---------------- adb ----------------

  async installAdb(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('adb', p.root);
    const zipPath = path.join(p.tmp, 'platform-tools.zip');
    onProgress({ stage: 'download', message: 'Đang tải Android platform-tools (khoảng 8MB)…', percent: 2 });

    await downloadAny(SOURCES.adb, zipPath, {
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Đang tải adb… ${(pr.got / 1048576).toFixed(1)}MB / ${(pr.total / 1048576).toFixed(1)}MB`,
        percent: pr.percent,
        speed: pr.speed,
      }),
    });

    assertComplete(zipPath, MIN_SIZE.adb, 'adb Gói cài đặt');

    onProgress({ stage: 'extract', message: 'Đang giải nén adb…', percent: 92 });
    await this.extractZip(zipPath, p.root);

    const v = await this.adbVersion();
    if (!v.ok) throw new Error('adb Không chạy được sau khi giải nén, hãy kiểm tra có bị phần mềm diệt virus chặn không');

    fs.rmSync(zipPath, { force: true });
    store.saveSettings({ adbPath: v.path });
    this._cache.adbVersion = v.version;
    onProgress({ stage: 'done', message: `adb ${v.version} Sẵn sàng`, percent: 100 });
    return v;
  }

  /**
   * Dùng自带của ZIP 解析器Giải nén（避免依赖系统Giải nén工具）
   * Lớn条目（GB 级 system.img）走流式，Nhỏ条目整块读，避免撞 Node của单 Buffer 上限。
   */
  // ---------------- 本mục目 GitHub củaToàn bộ gói bộ chạy（轻量版） ----------------

  async _fetchJson(url) {
    const text = await this._fetchText(url).catch(() => '');
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  /**
   * 解析「Toàn bộ gói bộ chạy」của下载地址。
   * 资产名约定：ApkStart-runtime-<tag>.zip（由 .github/workflows/release.yml 产出，
   * 内容就是 build/runtime của那一套：emulator/ + platform-tools/ + aehd/ + system-images/）。
   * GitHub 与 Gitee 两边都扫一遍，取版本号最高của那cái；Không tìm thấy就抛错，让上层退回
   * Google 官方分组件下载。
   */
  async resolveRuntimePack() {
    const custom = String(store.getSettings().runtime.runtimePackUrl || '').trim();
    if (custom) return { url: absUrl(custom), name: path.basename(custom.split('?')[0]), size: 0, tag: 'custom' };
    if (this._cache.pack) return this._cache.pack;

    const pref = String(store.getSettings().runtime.sourcePreference || 'auto');
    const apis = [];
    if (pref !== 'gitee') apis.push({ api: SOURCES.ghReleaseApi, page: SOURCES.ghReleasePage, name: 'GitHub' });
    if (pref !== 'github') apis.push({ api: SOURCES.giteeReleaseApi, page: SOURCES.giteeReleasePage, name: 'Gitee' });

    // 并发问两边；任何一cáiThất bại都不影响另一cái
    const lists = await Promise.all(apis.map(async (a) => {
      const j = await this._fetchJson(`${a.api}?per_page=15`).catch(() => null);
      return { ...a, list: Array.isArray(j) ? j : null };
    }));

    const cands = [];
    for (const item of lists) {
      if (!item.list) continue;
      for (const rel of item.list) {
        if (!rel || rel.draft) continue;
        const hit = (rel.assets || []).find((x) => /^ApkStart-runtime-.*\.zip$/i.test(x.name || ''));
        if (!hit) continue;
        cands.push({
          url: hit.browser_download_url || hit.url,
          name: hit.name,
          size: hit.size || 0,
          tag: String(rel.tag_name || rel.name || '').replace(/^v/i, ''),
          page: rel.html_url || item.page,
          from: item.name,
        });
      }
    }
    if (!cands.length) {
      const errs = lists.filter((x) => !x.list).map((x) => `${x.name} Không truy cập được`).join('、');
      throw new Error(`Cả hai nguồn đều không có gói bộ chạy đầy đủ${errs ? `（${errs}）` : ''}`);
    }
    cands.sort((a, b) => cmpVer(b.tag, a.tag));
    this._cache.pack = cands[0];
    return this._cache.pack;
  }

  /**
   * 轻量版一键部署：从本mục目 GitHub Tải bộ chạy整包并Giải nén。
   * Ảnh hệ thống在包里是 .xz，首次开机时由 materializeImages() 展开（只做一次）。
   */
  async installRuntimePack(onProgress = () => {}) {
    const p = this.ensureDirs();
    // 先给一条进度：找版本 + 测速这一段没Cóbyte数，不给提示Dùng户会以là “卡死了」。
    onProgress({ stage: 'download', message: 'Đang lấy thông tin phiên bản bộ chạy…', percent: 1 });
    const pack = await this.resolveRuntimePack();
    await this.guardDisk('runtime', p.root);
    const zip = path.join(p.tmp, 'runtime-pack.zip');
    const total = pack.size || 0;
    const s = store.getSettings().runtime || {};
    const conn = Math.max(1, Math.min(16, Number(s.downloadConnections) || 8));

    onProgress({ stage: 'download', message: `Đang chọn nguồn tải nhanh nhất (${pack.from || 'GitHub'} · ${pack.tag}）…`, percent: 1 });
    // 候Chọn = 源站 + 镜像前缀。先各下一cái 128KB 实测速度再决定Dùng哪cái：
    // 「按域名猜」在实测里经常错 —— 同一cái地址上午 30KB/s、晚上 5MB/s。
    const urls = await this.sources
      .rank(this._downloadUrls(pack.url), { onProgress: (pp) => onProgress({ stage: 'download', message: pp.message, percent: 1 }) })
      .catch(() => this._downloadUrls(pack.url));

    onProgress({ stage: 'download', message: `Đang tải bộ chạy (khoảng 1.5 GB, chỉ cần một lần,${conn} luồng)…`, percent: 2 });
    // 分块并行（8 luồng）比单流快得多：GitHub 对单连接限速很常见，单流实测只Có
    // 一两百 KB/s，8 luồng能跑满本地带宽。中途断掉会退回单流续传。
    await downloadMulti(urls, zip, {
      connections: conn,
      onProgress: (pr) => {
        const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
        const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
        const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
        const eta = Number(pr.eta) > 0 ? ` · còn khoảng ${Math.ceil(pr.eta / 60)} phút` : '';
        onProgress({
          stage: 'download',
          message: `Tải bộ chạy ${mb}${sp}${eta}`,
          percent: Math.max(1, Math.min(90, Math.round(pct * 0.9))),
          speed: pr.speed,
        });
      },
    });
    assertComplete(zip, 200 * 1024 * 1024, 'Toàn bộ gói bộ chạy');

    onProgress({ stage: 'extract', message: 'Đang giải nén bộ chạy (khoảng 1 phút)…', percent: 91 });
    await this.extractZip(zip, p.root, {
      onEntry: (name, done, all) => {
        if (done % 50 === 0) {
          onProgress({ stage: 'extract', percent: Math.min(99, 91 + Math.round((done / all) * 8)), message: `Giải nén ${done}/${all}` });
        }
      },
    });
    try {
      fs.writeFileSync(path.join(p.root, '.runtime-pack.json'), JSON.stringify({
        name: pack.name, tag: pack.tag, at: new Date().toISOString(), from: pack.url,
      }));
      fs.rmSync(zip, { force: true });
    } catch (_) { /* 标记写不进去不影响使Dùng */ }

    // 整包trong system.img 是 .xz 压缩của（和完整版Gói cài đặt一致）。这里立刻展开，
    // 否则紧接着 checkEnv() 会认là “没装Ảnh hệ thống」，又去 Google 下一套 1.4 GB。
    // 展开Thất bại必须让部署Thất bại并带上原因：旧版这里 catch 成 0，Dùng户看到进度
    // 停在 99% 之后又跳回「改Dùng官方源补齐」，白下一套 1.4GB。
    onProgress({ stage: 'extract', message: 'Đang giải nén ảnh hệ thống (khoảng 1 phút, chỉ cần một lần)…', percent: 99 });
    await this.materializeImages((m) => onProgress({ stage: 'extract', message: m, percent: 99 }));

    onProgress({ stage: 'done', message: 'Bộ chạy đã sẵn sàng', percent: 100 });
    return { ok: true, name: pack.name, tag: pack.tag };
  }

  /**
   * 下载地址候Chọn：直连优先，其次镜像前缀。
   * 走 Sources 统一处理，好处是「Tự động镜像（ghfast / gh-proxy）」与Dùng户自定义前缀
   * 只在一cái地方维护，且能和多luồng下载TổngDùng同一份测速缓存。
   */
  _downloadUrls(url) {
    return this.sources.candidates(url);
  }

  async extractZip(zipPath, destDir, opts = {}) {
    // Lớn包（emulator / Ảnh hệ thống）走文件版：不把 1.5GB zip 整包读进Bộ nhớ，
    // 低Bộ nhớ机器也能稳定Giải nén；Nhỏ包沿DùngBộ nhớ版，速度更快。
    const big = fileSize(zipPath) > 64 * 1024 * 1024;
    const zip = big ? new ZipFile(zipPath) : new ZipArchive(fs.readFileSync(zipPath));
    const STREAM_THRESHOLD = 64 * 1024 * 1024;
    const total = zip.names().length;
    let done = 0;

    try {
      for (const name of zip.names()) {
        // zip-slip 守卫（issue #2 P0-4）：Bộ chạy包来自网络，条目名不可信。
        // 目录条目和文件条目都Phải là destDir 内của合法相对Đường dẫn。
        const target = resolveZipEntry(destDir, name);
        if (!target) {
          if (opts.onUnsafeEntry) opts.onUnsafeEntry(name);
          continue;
        }
        if (name.endsWith('/')) {
          fs.mkdirSync(target, { recursive: true });
          continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const e = zip.entries.get(name);
        if (e.uncompSize > STREAM_THRESHOLD) {
          // eslint-disable-next-line no-await-in-loop
          await zip.pipeTo(name, fs.createWriteStream(target));
        } else {
          fs.writeFileSync(target, zip.read(name));
        }
        done += 1;
        if (opts.onEntry) opts.onEntry(name, done, total);
      }
    } finally {
      if (zip.close) zip.close();
    }
    return destDir;
  }

  // ---------------- Emulator（Google 官方Bộ chạy） ----------------

  /** 抓取一段 XML 文本（带LớnNhỏ上限，索引文件约 400KB） */
  async _fetchText(url, limit = 2 * 1024 * 1024) {
    const { openStream } = require('./download');
    const res = await openStream(url);
    // issue #2 P1-1：超限时 destroy() 既不发 'end'、错误又没被兜住时，
    // 这cái Promise 永远不 settle，部署向导就永久卡在「正在解析索引」。
    // Dùng一次性 settle 门闩 + 硬Hết thời gian，任何Đường dẫn都只结算一次。
    return new Promise((resolve) => {
      let d = '';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(d);
      };
      const timer = setTimeout(() => { try { res.destroy(); } catch (_) {} finish(); }, 30000);
      res.on('data', (c) => {
        if (done) return;
        d += c;
        if (d.length > limit) {
          d = '';                       // 超出上限của内容Không khả dụng，别把半截索引当完整
          try { res.destroy(); } catch (_) {}
          finish();
        }
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
  }

  /** 从 SDK 索引里动态解析最新của Windows emulator 包地址 */
  async resolveEmulatorUrl() {
    const cached = store.getSettings().runtime.emulatorUrl;
    if (cached && cached.trim()) return absUrl(cached);
    if (this._cache.emulatorUrl) return this._cache.emulatorUrl;
    try {
      const xml = await this._fetchText(SOURCES.sdkIndex);
      const block = /<remotePackage path="emulator"[\s\S]*?<\/remotePackage>/.exec(xml);
      if (block) {
        const base = baseOf(SOURCES.sdkIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base));
        const win = urls.find((u) => /windows_x64.*\.zip$/i.test(u));
        if (win) {
          this._cache.emulatorUrl = win;
          return win;
        }
      }
    } catch (_) { /* 落兜底 */ }
    this._cache.emulatorUrl = SOURCES.emulatorFallback;
    return SOURCES.emulatorFallback;
  }

  /** 从 sys-img 索引里解析默认 AOSP Ảnh hệ thống地址 */
  async resolveSysimgUrl() {
    const cached = store.getSettings().runtime.sysimgUrl;
    if (cached && cached.trim()) return absUrl(cached, baseOf(SOURCES.sysImgIndexes[0]));
    if (this._cache.sysimgUrl) return this._cache.sysimgUrl;
    const want = `system-images;android-${DEFAULT_SYSIMG.api};${DEFAULT_SYSIMG.tag};${DEFAULT_SYSIMG.abi}`;
    for (const idx of [SOURCES.playImgIndex, ...SOURCES.sysImgIndexes]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const xml = await this._fetchText(idx);
        const re = new RegExp(`<remotePackage path="${want.replace(/[;]/g, ';')}"[\\s\\S]*?</remotePackage>`);
        const block = re.exec(xml);
        if (block) {
          const base = baseOf(idx);
          const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
            .filter((u) => /x86_64.*\.zip$/i.test(u));
          if (urls.length) {
            this._cache.sysimgUrl = urls[urls.length - 1];
            return this._cache.sysimgUrl;
          }
        }
      } catch (_) { /* 换下一cái索引 */ }
    }
    this._cache.sysimgUrl = SOURCES.sysimgFallback;
    return SOURCES.sysimgFallback;
  }

  async emulatorVersion() {
    if (this._cache.emulatorVersion && this._cache.emulatorVerAt && Date.now() - this._cache.emulatorVerAt < 30000) {
      return this._cache.emulatorVersion;
    }
    const p = this.paths();
    const candidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      // 上一次会话探测过、且Engine文件没变：直接Dùng落盘结果（省掉一次 1s+ của进程拉起）
      const cached = this.envCacheGet(c);
      if (cached && cached.version && cached.version.ok && Date.now() - (cached.at || 0) < ENV_CACHE_TTL) {
        this._cache.emulatorVersion = cached.version;
        this._cache.emulatorVerAt = Date.now();
        return cached.version;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await run(c, ['-version'], { timeout: 20000 });
      const text = `${r.stdout}${r.stderr}`;
      const m = /Android emulator version\s+([\d.]+)/i.exec(text);
      if (m) {
        this._cache.emulatorVersion = { ok: true, path: c, version: m[1] };
        this._cache.emulatorVerAt = Date.now();
        this.envCacheSet(c, { version: this._cache.emulatorVersion });
        return this._cache.emulatorVersion;
      }
    }
    return { ok: false, path: '', version: '' };
  }

  /**
   * 首次启动把随包带来của压缩镜像展开到Dùng户目录（只做一次）。
   * 单文件发行版里 system.img 是 .gz（3.1GB→580MB 左右），不展开模拟器没法Dùng。
   * 展开到 %APPDATA% 而不是包里：便携版củaBộ chạy目录每次启动都是新của临时目录，
   * 放进去等于每次开机都重Giải nén一遍。
   */
  async materializeImages(onLog = () => {}) {
    const srcRoot = path.join(this.root, 'system-images');
    // 展开Mục tiêu必须和 paths().sysImgRoot Dùng同一套规则，否则会出现
    // 「整包解到 D 盘、镜像又展开回 C 盘 APPDATA」của重复占Dùng（实测 1.2GB + 3.3GB）。
    const destRoot = this.paths().sysImgRoot;
    const jobs = [];
    const copies = []; // 压缩镜像之外của文件（kernel-ranchu / ramdisk / 未压缩 .img 等）必须一并落到展开目录
    const found = new Map(); // dest -> job（同镜像 .xz/.gz 并存时优先 .xz）
    const walk = (dir, rel = '') => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, path.join(rel, e.name)); continue; }
        // 支持 .img.xz（LZMA2，体积比 .gz Nhỏ ~25%）和旧của .img.gz
        if (/\.img\.(xz|gz)$/i.test(e.name)) {
          const dest = path.join(destRoot, rel, e.name.replace(/\.img\.(xz|gz)$/i, '.img'));
          const job = { src: p, dest, xz: /\.xz$/i.test(e.name) };
          const prev = found.get(dest);
          if (!prev || (job.xz && !prev.xz)) found.set(dest, job);
        } else {
          copies.push({ src: p, dest: path.join(destRoot, rel, e.name) });
        }
      }
    };
    walk(srcRoot);
    jobs.push(...found.values());
    if (!jobs.length && !copies.length) return 0;

    // 先补齐Không phải镜像文件（模拟器靠 kernel-ranchu 等定位/引导，Thiếu了会报"Còn thiếuẢnh hệ thống"）
    for (const c of copies) {
      try {
        if (path.resolve(c.src) === path.resolve(c.dest)) continue;   // 原地展开，无需复制
        const have = fileSize(c.dest);
        if (have > 0 && have === fileSize(c.src)) continue;
        fs.mkdirSync(path.dirname(c.dest), { recursive: true });
        fs.copyFileSync(c.src, c.dest);
      } catch (e) { onLog(`Sao chép thành phần ảnh thất bại:${e.message}`); }
    }

    let done = 0;
    const failures = [];
    for (const j of jobs) {
      const have = fileSize(j.dest);
      // 判断「已经展开过」不能只看 32MB：旧版没Có .part，被中断后可能留下
      // 几百 MB của半截镜像，阈值一过就被当成Hoàn tất，开机时炸在Ảnh hệ thống损坏上。
      // 真实镜像Giải nén后一定比压缩包Lớn，所以「Nhỏ于压缩包LớnNhỏ」= 必然没展开完。
      const srcSize = fileSize(j.src);
      if (have > 32 * 1024 * 1024 && (srcSize <= 0 || have >= srcSize)) continue;
      // 先解到 .part，成功后再改名：Giải nén中途被打断（关程序 / 断电 / 磁盘满）
      // 不会留下一cái「看着像已Hoàn tất」của半截 system.img，否则下次会跳过展开、
      // 开机时死在镜像损坏上，Dùng户只能删数据重来。
      const part = `${j.dest}.part`;
      try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
      fs.mkdirSync(path.dirname(j.dest), { recursive: true });
      onLog(`Khởi động lần đầu: đang bung ảnh hệ thống ${path.basename(j.dest)}(khoảng 1 phút, chỉ một lần)`);
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          const { pipeline, Readable } = require('stream');
          if (j.xz) {
            // LZMA2 Giải nén：必须直接引原生绑定 index.js。
            // 包默认入口 main.js / xz.js 内部会 require('stream-polyfill.mjs')，
            // Electron của Node 20 Không hỗ trợ require(ESM) 会抛错；而 exports 又Không được phép
            // 直接写 '@napi-rs/lzma/index.js'，所以Dùng require.resolve 定位目录后按文件Đường dẫn引。
            const path0 = require('path');
            const lzmaDir = path0.dirname(require.resolve('@napi-rs/lzma'));
            const { xz } = require(path0.join(lzmaDir, 'index.js'));
            const webIn = Readable.toWeb(fs.createReadStream(j.src));
            const webOut = xz.decompressStream(webIn);
            pipeline(Readable.fromWeb(webOut), fs.createWriteStream(part), (err) => (err ? reject(err) : resolve()));
          } else {
            pipeline(
              fs.createReadStream(j.src),
              zlib.createGunzip(),
              fs.createWriteStream(part),
              (err) => (err ? reject(err) : resolve()),
            );
          }
        });
        fs.renameSync(part, j.dest);
        done += 1;
      } catch (e) {
        try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
        // 不能再静默吞掉：调Dùng方（一键部署 / 开机）必须知道镜像没展开成功，
        // 否则会「Dùng官方源再下一套 1.4GB」或者直接开机Thất bại。
        failures.push(`${path.basename(j.dest)}: ${e.message}`);
        onLog(`Giải nén ảnh thất bại:${e.message}`);
      }
    }
    if (failures.length) {
      const err = new Error(`Giải nén ảnh hệ thống thất bại (${failures.join('；')}）`);
      err.code = 'MATERIALIZE_FAILED';
      err.failed = failures;
      throw err;
    }
    return done;
  }

  /**
   * Ảnh hệ thống是否完整。
   *
   * 「完整」Có两种形态：
   *   1. 已展开của `system.img`（本地缓存 / Dùng户在Cài đặt里指定củaBộ chạy目录）；
   *   2. **包内带来của `system.img.xz` / `.gz`** —— 商店（MSIX）版和完整版Gói cài đặt
   *      都是这种形态，首次开机时由 materializeImages() 就地展开。
   *
   * 第 2 种必须算 ok，否则 checkEnv().ready 会是 false，autoDeploy 就会以为
   * 「Dùng户还没下镜像」，去网上拉一套 1.5GB của —— 这正是「明明装完带了镜像，
   * 结果还在下载」của根因。返回值trong compressed 标记表示「还Cần展开一次」。
   */
  systemImageInfo() {
    const p = this.paths();
    const roots = [p.sysImgRoot, path.join(this.root, 'system-images'), path.join(this.appRoot, 'engine', 'system-images')];
    // 先在默认位置（API34 Play）找，再退到「随便哪套镜像」。
    // 单文件发行版可能只带一套更Nhỏcủa AOSP 镜像，写死 API34 会导致
    // 镜像明明在包里却报"Chưa tải"，Dùng户被迫联网下载一套新của。
    const preferred = [p.sysImgDir,
      path.join(this.appRoot, 'engine', 'system-images',
        `android-${DEFAULT_SYSIMG.api}`, DEFAULT_SYSIMG.tag, DEFAULT_SYSIMG.abi)];
    const candidates = [...preferred];
    for (const root of roots) {
      let apis = [];
      try { apis = fs.readdirSync(root).filter((d) => /^android-\d+$/.test(d)); } catch (_) { continue; }
      apis.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) candidates.push(path.join(root, api, tag, abi));
        }
      }
    }
    let missing = null;
    let packed = null;   // 只Tìm thấy压缩包：还算「Có」，但要展开
    for (const dir of candidates) {
      const kernel = path.join(dir, 'kernel-ranchu');
      const m = /system-images[\\/]android-(\d+)[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(dir);
      const api = m ? Number(m[1]) : DEFAULT_SYSIMG.api;
      const tag = m ? m[2] : DEFAULT_SYSIMG.tag;
      const abi = m ? m[3] : DEFAULT_SYSIMG.abi;
      // 已展开của优先
      const size = fileSize(path.join(dir, 'system.img'));
      if (size > MIN_SIZE.sysimg && fs.existsSync(kernel)) {
        return { ok: true, dir, size, api, tag, abi, compressed: false };
      }
      // 再认压缩包（包内镜像của常态）
      if (fs.existsSync(kernel)) {
        for (const name of ['system.img.xz', 'system.img.gz']) {
          const cs = fileSize(path.join(dir, name));
          if (cs > MIN_SIZE.sysimg) {
            if (!packed) packed = { ok: true, dir, size: cs, api, tag, abi, compressed: true, file: name };
            break;
          }
        }
      }
      if (!missing && fs.existsSync(dir)) {
        missing = { ok: false, dir, size, api, tag, abi, note: size ? 'Ảnh không đầy đủ' : 'Thiếu system.img' };
      }
    }
    // Có压缩包就Dùng它：Cần展开，但**不Thiếu镜像**，绝对不该触发联网下载
    if (packed) return packed;
    if (missing) return missing;
    return { ok: false, dir: p.sysImgDir, size: 0, api: DEFAULT_SYSIMG.api, tag: DEFAULT_SYSIMG.tag, note: 'Chưa tải' };
  }

  /**
   * Tăng tốc phần cứng状态。
   * emulator 在 Windows 上支持两种Tăng tốc：WHPX（系统功能，需重启）与 AEHD（Google 自家Trình điều khiển，装完即Dùng）。
   */
  async emulatorAccel() {
    // 状态轮询每几秒一次，而 -accel-check 要拉起一cái emulator 进程，必须缓存
    if (this._cache.accel && this._cache.accelAt && Date.now() - this._cache.accelAt < 30000) {
      return this._cache.accel;
    }
    const p = this.paths();
    const exe = fs.existsSync(p.emulatorExe) ? p.emulatorExe
      : path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe');
    if (!fs.existsSync(exe)) return { ok: false, kind: 'none', note: 'Chưa cài đặt emulator' };

    // 落盘缓存：Khởi động nguội时不再为这一mục拉起 emulator 进程。
    // 「Không khả dụng」结论只信 10 phút —— Dùng户可能刚去开了虚拟化/装了 AEHD，要能立刻反映。
    const cached = this.envCacheGet(exe);
    if (cached && cached.accel) {
      const ttl = cached.accel.ok ? ENV_CACHE_TTL : ENV_CACHE_NEG_TTL;
      if (Date.now() - (cached.accelAt || 0) < ttl) {
        this._cache.accel = cached.accel;
        this._cache.accelAt = Date.now();
        return cached.accel;
      }
    }

    const aehdSys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    const hasAehdFile = fs.existsSync(aehdSys) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    const hv = await this.hypervisor();

    const r = await run(exe, ['-accel-check'], { timeout: 30000 });
    const text = `${r.stdout}${r.stderr}`;
    const usable = /accel:\s*\n?0\b/.test(text) && !/ERROR_ACCESS_DENIED|not installed/i.test(text);

    let result;
    if (usable) {
      const kind = hasAehdFile && /aehd/i.test(text) ? 'aehd' : 'whpx';
      result = { ok: true, kind, note: kind === 'whpx' ? 'WHPX Đã bật tăng tốc phần cứng' : 'AEHD Đã bật tăng tốc phần cứng' };
    } else if (/can't find the emulator-check|corrupted tools installation/i.test(text) && hasAehdFile) {
      // 部分精简Bộ chạy包会漏掉 emulator-check.exe，导致 -accel-check 无法给出结论。
      // 此时只要 AEHD Trình điều khiểnĐã cài đặt，就按「Khả dụng」处理：启动时 emulator 自己会挂载Trình điều khiển，
      // 避免被误判成无Tăng tốc而强行 -accel off（Giả lập phần mềm在部分机器上会直接崩溃）。
      result = { ok: true, kind: 'aehd', note: 'AEHD Đã bật tăng tốc phần cứng (thiếu emulator-check, xác định theo trình điều khiển)' };
    } else if (hasAehdFile && /aehd/i.test(text) && !/ERROR_ACCESS_DENIED/i.test(text)) {
      result = { ok: true, kind: 'aehd', note: 'AEHD Đã bật tăng tốc phần cứng' };
    } else if (hv.dll && /whpx/i.test(text) && !/error|denied/i.test(text)) {
      result = { ok: true, kind: 'whpx', note: 'WHPX Đã bật tăng tốc phần cứng' };
    } else {
      result = {
        ok: false,
        kind: 'none',
        whpx: hv.whpx,
        aehdInstalled: hasAehdFile,
        viaTcg: true,
        note: 'Chưa bật tăng tốc phần cứng: sẽ chuyển sang giả lập phần mềm (chạy được nhưng rất chậm). Nên cài trình điều khiển AEHD hoặc bật “Virtual Machine Platform”',
      };
    }
    this._cache.accel = result;
    this._cache.accelAt = Date.now();
    this.envCacheSet(exe, { accel: result, accelAt: Date.now() });
    return result;
  }

  /** 下载并Cài đặt emulator（zip 顶层就是 emulator/，直接解到 SDK root） */
  async installEmulator(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('emulator', p.root);
    const url = await this.resolveEmulatorUrl();
    const zip = path.join(p.tmp, 'emulator.zip');
    onProgress({ stage: 'download', message: 'Đang tải lõi bộ chạy (khoảng 440MB, từ nguồn chính thức của Google)…', percent: 1 });

    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Tải lõi bộ chạy ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1048576).toFixed(1)} MB/s）` : ''),
        percent: Math.round(pr.percent * 0.85),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.emulator, 'Engine bộ chạy');

    onProgress({ stage: 'extract', message: 'Đang giải nén engine bộ chạy…', percent: 88 });
    await this.extractZip(zip, p.root);
    fs.rmSync(zip, { force: true });

    // SDK root 必须同时具备 platform-tools，否则 emulator 拒绝启动
    this.ensurePlatformTools();

    const v = await this.emulatorVersion();
    if (!v.ok) throw new Error('emulator Không chạy được sau khi giải nén, hãy kiểm tra có bị phần mềm diệt virus chặn không');
    this._cache.emulatorVersion = v.version;
    onProgress({ stage: 'done', message: `Engine bộ chạy ${v.version} Sẵn sàng`, percent: 100 });
    return v;
  }

  /** emulator 要求 SDK root 下Có platform-tools 目录，否则直接 FATAL */
  ensurePlatformTools() {
    const p = this.paths();
    fs.mkdirSync(p.adbDir, { recursive: true });
    if (fs.existsSync(p.adbExe)) return true;
    const src = [
      path.join(this.appRoot, 'engine', 'platform-tools'),
      path.join(this.appRoot, 'tools', 'platform-tools'),
      path.dirname(this.adbVersionPath() || ''),
    ].find((d) => d && fs.existsSync(path.join(d, 'adb.exe')));
    if (!src) return false;
    for (const f of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
      const from = path.join(src, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(p.adbDir, f));
    }
    return fs.existsSync(p.adbExe);
  }

  adbVersionPath() {
    try {
      const s = store.getSettings();
      if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    } catch (_) { /* ignore */ }
    return '';
  }

  /** 只下载一份通Dùng基础镜像（Android 14 Play x86_64），不再Có「普通/Tương thích」两套 */
  async installSystemImage(onProgress = () => {}) {
    if (this.playImageInfo().ok) return this.playImageInfo();
    return this.installPlayImage(onProgress);
  }

  /** ARM Ảnh hệ thống tương thích（Google Play 版）是否已就位 */
  playImageInfo() {
    const p = this.paths();
    const rel = `android-${PLAY_SYSIMG.api}/${PLAY_SYSIMG.tag}/${PLAY_SYSIMG.abi}`;
    // 两cái位置都看：展开Mục tiêu（可写của数据目录）与包内原始位置。
    // 商店/完整版Gói cài đặt里带của是 system.img.xz，第一次开机才展开 —— 这里必须
    // 认它，否则 installSystemImage / autoDeploy 会去网上重下一套。
    const dirs = [path.join(p.sysImgRoot, rel), path.join(this.root, 'system-images', rel)];
    let packed = null;
    for (const dir of dirs) {
      if (!fs.existsSync(path.join(dir, 'kernel-ranchu'))) continue;
      const size = fileSize(path.join(dir, 'system.img'));
      if (size > MIN_SIZE.sysimg) {
        return { ok: true, dir, size, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag, compressed: false };
      }
      if (!packed) {
        for (const name of ['system.img.xz', 'system.img.gz']) {
          const cs = fileSize(path.join(dir, name));
          if (cs > MIN_SIZE.sysimg) {
            packed = { ok: true, dir, size: cs, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag, compressed: true, file: name };
            break;
          }
        }
      }
    }
    if (packed) return packed;
    const size = fileSize(path.join(dirs[0], 'system.img'));
    return { ok: false, dir: dirs[0], size, note: size ? 'Ảnh không đầy đủ' : 'Chưa tải' };
  }

  /** 解析 Google Play 版镜像地址（<url> 相对索引文件所在目录） */
  async resolvePlayUrl() {
    if (this._cache.playUrl) return this._cache.playUrl;
    try {
      const xml = await this._fetchText(SOURCES.playImgIndex);
      const want = `system-images;android-${PLAY_SYSIMG.api};${PLAY_SYSIMG.tag};${PLAY_SYSIMG.abi}`;
      const block = new RegExp(`<remotePackage path="${want}"[\\s\\S]*?</remotePackage>`).exec(xml);
      if (block) {
        const base = baseOf(SOURCES.playImgIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
          .filter((u) => /x86_64.*\.zip$/i.test(u));
        if (urls.length) {
          this._cache.playUrl = urls[urls.length - 1];
          return this._cache.playUrl;
        }
      }
    } catch (_) { /* 落兜底 */ }
    this._cache.playUrl = SOURCES.playImgFallback;
    return this._cache.playUrl;
  }

  /** 下载并Cài đặt ARM Ảnh hệ thống tương thích（Google Play 版，约 1.5GB） */
  async installPlayImage(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('playimg', p.sysImgRoot);
    const url = await this.resolvePlayUrl();
    const zip = path.join(p.tmp, 'play-sysimg.zip');
    onProgress({ stage: 'download', message: 'Đang tải ảnh hệ thống tương thích ARM (Android 14, khoảng 1.5GB)…', percent: 1 });
    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Tải ảnh hệ thống tương thích ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1048576).toFixed(1)} MB/s）` : ''),
        percent: Math.round(pr.percent * 0.8),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.sysimg, 'Ảnh hệ thống tương thích');

    const dest = path.join(p.sysImgRoot, `android-${PLAY_SYSIMG.api}`, PLAY_SYSIMG.tag);
    fs.mkdirSync(dest, { recursive: true });
    onProgress({ stage: 'extract', message: 'Đang giải nén ảnh tương thích (3GB, mất hơn chục giây)…', percent: 82 });
    await this.extractZip(zip, dest, {
      onEntry: (_n, i, total) => onProgress({
        stage: 'extract',
        message: `Giải nén ảnh tương thích ${i}/${total}`,
        percent: 82 + Math.round((i / Math.max(1, total)) * 15),
      }),
    });
    fs.rmSync(zip, { force: true });

    const info = this.playImageInfo();
    if (!info.ok) throw new Error('Kiểm tra ảnh tương thích thất bại sau khi giải nén');
    // 旧版（API 30）Ảnh hệ thống tương thích不再使Dùng，成功装好后Dọn dẹp腾Trống间
    for (const old of ['android-30']) {
      const legacy = path.join(p.sysImgRoot, old, 'google_apis_playstore');
      if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
    }
    onProgress({ stage: 'done', message: 'ARM Ảnh tương thích đã sẵn sàng, khởi động lại bộ chạy để có hiệu lực', percent: 100 });
    return info;
  }

  /** 下载 AEHD Trình điều khiển（Nhỏ文件）；Cài đặtCần管理员权限，交给引导流程 */
  async installAehd(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('aehd', p.aehdDir);
    const zip = path.join(p.tmp, 'aehd.zip');
    onProgress({ stage: 'download', message: 'Đang tải trình điều khiển AEHD…', percent: 10 });
    await downloadAnyParallel(this._downloadUrls(SOURCES.aehdFallback), zip, { connections: 2 });
    fs.mkdirSync(p.aehdDir, { recursive: true });
    await this.extractZip(zip, p.aehdDir);
    fs.rmSync(zip, { force: true });
    const has = fs.existsSync(path.join(p.aehdDir, 'aehd.Sys')) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    if (!has) throw new Error('AEHD Gói trình điều khiển giải nén bất thường');
    this._cache.accel = null;
    this._cache.accelAt = 0;
    onProgress({ stage: 'done', message: 'AEHD Trình điều khiển đã sẵn sàng, cần quyền quản trị để cài', percent: 100 });
    return { ok: true, dir: p.aehdDir, installer: path.join(p.aehdDir, 'silent_install.bat') };
  }

  // ---------------- QEMU ----------------

  /** 抓取官方目录里最新củaGói cài đặt文件名（不写死版本号） */
  async resolveQemuUrl() {
    const configured = store.getSettings().runtime.qemuUrl;
    if (configured && configured.trim()) return configured.trim();
    try {
      const { openStream } = require('./download');
      const res = await openStream(SOURCES.qemuIndex);
      const html = await new Promise((resolve, reject) => {
        let d = '';
        res.on('data', (c) => { d += c; if (d.length > 512 * 1024) res.destroy(); });
        res.on('end', () => resolve(d));
        res.on('error', reject);
      });
      const files = [...html.matchAll(/href="([^"]*qemu-w64-setup-(\d+)\.exe)"/g)]
        .map((m) => ({ file: m[1], ver: Number(m[2]) }))
        .sort((a, b) => b.ver - a.ver);
      if (files.length) {
        const f = files[0].file.replace(/^.*\//, '');
        return new URL(f, SOURCES.qemuIndex).href;
      }
    } catch (_) { /* 落到备Dùng源 */ }
    return SOURCES.qemuFallback[0];
  }

  async installQemu(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('qemu', p.root);
    const setup = path.join(p.tmp, 'qemu-setup.exe');

    onProgress({ stage: 'resolve', message: 'Đang tìm phiên bản QEMU mới nhất…', percent: 1 });
    const url = await this.resolveQemuUrl();
    onProgress({ stage: 'download', message: `Đang tải QEMU (khoảng 200MB)…`, percent: 2, url });

    await download(url, setup, {
      resume: true,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Đang tải QEMU… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1024).toFixed(0)} KB/s）` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });
    assertComplete(setup, MIN_SIZE.qemu, 'QEMU Gói cài đặt');

    onProgress({ stage: 'install', message: 'Đang cài QEMU (chế độ im lặng)…', percent: 96 });
    // qemu-w64-setup 是 NSIS Cài đặt器：/S 静默，/D 指定目录（必须最后且不加引号）
    const target = p.qemuDir;
    fs.mkdirSync(target, { recursive: true });
    await new Promise((resolve) => {
      const proc = spawn(setup, ['/S', `/D=${target}`], { windowsHide: true, stdio: 'ignore' });
      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
      setTimeout(() => { try { proc.kill(); } catch (_) {} resolve(); }, 600000);
    });

    const v = await this.qemuVersion();
    if (!v.ok) {
      throw new Error('QEMU Sau khi cài không tìm thấy qemu-system-x86_64.exe: có thể tự tải QEMU và giải nén vào engine/qemu/');
    }
    fs.rmSync(setup, { force: true });
    this._cache.qemuVersion = v.version;
    onProgress({ stage: 'done', message: `QEMU ${v.version} Sẵn sàng`, percent: 100 });
    return v;
  }

  // ---------------- Ảnh hệ thống ----------------

  async downloadIso(onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.isoPath || p.iso;
    await this.guardDisk('iso', path.dirname(dest));
    const custom = s.runtime.isoUrl && s.runtime.isoUrl.trim();
    const urls = custom ? [custom, ...SOURCES.iso] : SOURCES.iso;

    onProgress({ stage: 'download', message: 'Đang tải Android-x86 9.0-r2 (khoảng 900MB, 8 luồng chia khối)…', percent: 1 });
    const r = await downloadAnyParallel(urls, dest, {
      connections: 8,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Đang tải ảnh hệ thống… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1024).toFixed(0)} KB/s）` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });

    const info = this.inspectIso(dest);
    if (!info.ok) {
      throw new Error(`Ảnh hệ thống không khả dụng:${info.reason}${info.size && info.size < MIN_SIZE.iso ? ', có thể bấm lại để tiếp tục tải từ chỗ dừng' : ''}`);
    }

    store.saveSettings({ runtime: { isoPath: dest } });
    onProgress({ stage: 'done', message: `Ảnh hệ thống sẵn sàng (${(info.size / 1073741824).toFixed(2)} GB）`, percent: 100, path: dest });
    return { ...r, ...info };
  }

  /** 校验Dùng户导入của镜像/ISO */
  inspectImage(file) {
    const size = fileSize(file);
    if (!size) throw new Error('Tệp không tồn tại hoặc rỗng');
    const fd = fs.openSync(file, 'r');
    const head4 = Buffer.alloc(4);
    fs.readSync(fd, head4, 0, 4, 0);
    fs.closeSync(fd);
    const magic = head4.toString('hex');
    let kind = 'unknown';
    if (magic === '514649fb') kind = 'qcow2';
    else if (head4.toString('ascii', 0, 4) === 'KDMV') kind = 'vmdk';
    else if (size > 400 * 1024 * 1024 && magic !== '00000000') kind = 'raw-or-iso';
    return { kind, size, path: file };
  }

  importIso(file) {
    const info = this.inspectIso(file);
    if (!info.ok) {
      const e = new Error(info.reason || 'Tệp ảnh không khả dụng');
      e.invalidIso = true;
      throw e;
    }
    store.saveSettings({ runtime: { isoPath: file } });
    return { ok: true, ...info };
  }

  importDisk(file) {
    const info = this.inspectImage(file);
    store.saveSettings({ runtime: { diskPath: file } });
    return { ok: true, ...info };
  }

  // ---------------- Ổ đĩa ảo ----------------

  async createDisk(sizeGB = 24, onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.diskPath || p.disk;
    if (fileSize(dest) > MIN_SIZE.disk) return { ok: true, path: dest, existed: true };

    onProgress({ stage: 'disk', message: `Tạo ${sizeGB}GB Đĩa ảo…`, percent: 40 });
    const qemuImg = fs.existsSync(p.qemuImg)
      ? p.qemuImg
      : path.join(path.dirname(store.getSettings().runtime.qemuPath || ''), 'qemu-img.exe');

    const tool = fs.existsSync(qemuImg) ? qemuImg : null;
    if (tool) {
      const r = await run(tool, ['create', '-f', 'qcow2', dest, `${sizeGB}G`], { timeout: 120000 });
      if (!r.ok) throw new Error(`qemu-img Tạo ổ đĩa ảo thất bại:${r.stderr || r.stdout}`);
    } else {
      throw new Error('Không tìm thấy qemu-img.exe, hãy cài đặt trước QEMU');
    }
    store.saveSettings({ runtime: { diskPath: dest } });
    onProgress({ stage: 'done', message: 'Đã tạo đĩa ảo', percent: 100, path: dest });
    return { ok: true, path: dest, size: fileSize(dest) };
  }

  // ---------------- Ảnh hệ thốngTruy cập được性预检 ----------------

  async probeSources() {
    const [adb, qemu, iso] = await Promise.all([
      head(SOURCES.adb[0]),
      head(SOURCES.qemuFallback[0]),
      head(SOURCES.iso[0]),
    ]);
    return { adb, qemu, iso };
  }
}

module.exports = { Provisioner, SOURCES, MIN_SIZE, absUrl, baseOf };
