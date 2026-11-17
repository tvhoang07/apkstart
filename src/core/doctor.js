'use strict';
/**
 * 设备自适应 / Tự độngChẩn đoán（零配置底座）
 *
 * Mục tiêu：不同机器上都不CầnDùng户调任何参数。
 *  - chooseProfile()  根据Bộ nhớ vật lý、CPU、磁盘、Tăng tốc状态、emulator 版本推导启动参数；
 *  - planVariants()   给出「Khởi động thất bại后依次降级」của重试方案（GPU → Tăng tốc → Bộ nhớ → Khởi động nguội）；
 *  - diagnose()       把 emulator của英文 stderr 翻译成可执行củaSửa建议；
 *  - shortPath()      处理中文/Trống格Cài đặtĐường dẫn（emulator của QEMU 对Không phải ASCII Đường dẫn极其敏感）。
 *
 * 本模块是纯函数 + 只读探测，不写Cài đặt、不拉起 Android，方便单测。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { memoryLimits } = require('./resources');

const ASCII = /^[\x20-\x7e]*$/;
const isAsciiPath = (p) => ASCII.test(String(p || ''));

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** Máy này画像（毫秒级，只读） */
function hostInfo() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  const cores = Math.max(1, (os.cpus() || []).length || 2);
  const home = os.homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB,
    freeMB,
    cores,
    home,
    homeAscii: isAsciiPath(home),
    tmp: os.tmpdir(),
    rdp: /RDP/i.test(String(process.env.SESSIONNAME || '')) || !!process.env.CLIENTNAME,
  };
}

/** 目录所在盘Khả dụngTrống间（MB）；取不到返回 0 */
function freeDiskMB(dir) {
  try {
    let d = path.resolve(dir || '.');
    for (let i = 0; i < 6 && !fs.existsSync(d); i += 1) d = path.dirname(d);
    const st = fs.statfsSync(d);
    return Math.floor((st.bavail * st.bsize) / 1048576);
  } catch (_) {
    return 0;
  }
}

function versionNumbers(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
 * 检测 GPU 厂商（NVIDIA / AMD / Intel），Dùng于调整渲染后端优先级。
 * 只在 Windows 上查 WMI；其他平台返回 'unknown'。
 * 结果缓存 10 phút，避免每次 chooseProfile 都 spawn wmic。
 */
let _gpuVendorCache = { vendor: 'unknown', at: 0 };
function detectGpuVendor() {
  if (process.platform !== 'win32') return 'unknown';
  if (Date.now() - _gpuVendorCache.at < 600000) return _gpuVendorCache.vendor;
  try {
    const { execFileSync } = require('child_process');
    // wmic 在 Win11 24H2+ 已被移除，改Dùng PowerShell Get-CimInstance
    let names = '';
    try {
      names = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        '(Get-CimInstance Win32_VideoController).Name -join "|"',
      ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    } catch (_) {
      // 回退到 wmic（老系统仍Khả dụng）
      try {
        names = execFileSync('wmic', ['path', 'win32_videocontroller', 'get', 'name', '/format:list'],
          { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      } catch (__) { /* ignore */ }
    }
    const lower = String(names).toLowerCase();
    let vendor = 'unknown';
    // 优先匹配独显（NVIDIA/AMD），虚拟显示适配器排在后面
    if (/nvidia|geforce|rtx\s|gtx\s/.test(lower)) vendor = 'nvidia';
    else if (/(?<!virtual\s)(amd|radeon|rx\s\d)/.test(lower)) vendor = 'amd';
    else if (/intel|uhd\s|iris|arc\s/.test(lower)) vendor = 'intel';
    _gpuVendorCache = { vendor, at: Date.now() };
    return vendor;
  } catch (_) {
    _gpuVendorCache = { vendor: 'unknown', at: Date.now() };
    return 'unknown';
  }
}

/**
 * emulator 36.4.9 起把 swiftshader_indirect 标记为弃Dùng，新增 -gpu software。
 * 37.x 上传 swiftshader_indirect 会出现 GL Khởi tạo thất bại/直接Thoát（设备差异很Lớn）。
 * 因此必须按版本挑候Chọn，且每cái候Chọn都Có退路。
 *
 * 按 GPU 厂商微调优先级：
 *   NVIDIA：host 几乎总是最优（Trình điều khiển成熟），swangle 兜底
 *   AMD：host 在部分Trình điều khiển下会崩（尤其老Trình điều khiển），swangle 提到第二优先
 *   Intel：host 通常 OK，但集显性能弱时 swangle 更稳
 *   unknown：保持默认顺序
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  const base = modern
    ? ['host', 'swangle', 'software', 'swiftshader']
    : ['host', 'swiftshader_indirect', 'swiftshader'];
  const vendor = detectGpuVendor();
  if (vendor === 'amd' && modern) {
    // AMD Trình điều khiển在某些版本下 host 模式会 GL Khởi tạo thất bại，把 swangle 提到前面
    return ['swangle', 'host', 'software', 'swiftshader'];
  }
  return base;
}

/** Windows 8.3 短Đường dẫn：中文Dùng户名 / 中文Cài đặt目录时 emulator 会Không tìm thấy文件 */
/**
 * 屏幕规格。landscape=true 时给出真正củaBảng màn ngang（1280x720）。
 *
 * 为什么必须改面板尺寸而不是Bộ chạy wm size：模拟器của LCD 是「物理面板」，
 * Qt 按面板尺寸开窗口并把画面贴在左上角。Bộ chạy改 wm size 只会改 Android của
 * 逻辑分辨率，物理面板仍是竖của —— 结果就是画面躺倒 90°、只占左上角一条、
 * 四周Lớn片黑边、点击坐标错位。只Có把 hw.lcd.width/height 真của换成Màn ngang并重启，
 * 才能得到「正立 + 铺满」củaMàn ngang。
 */
function lcdFor({ accelOk = true, crisp = true, landscape = false } = {}) {
  const base = accelOk && crisp ? { w: 720, h: 1280, dpi: 320 } : { w: 540, h: 960, dpi: 240 };
  return landscape ? { w: base.h, h: base.w, dpi: base.dpi } : base;
}

function shortPath(p) {
  if (process.platform !== 'win32' || !p || isAsciiPath(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (line && isAsciiPath(line) && fs.existsSync(line)) return line;
  } catch (_) { /* 8.3 被Đóng时保持原Đường dẫn */ }
  return p;
}

/**
 * 推导零配置启动参数。
 * Dùng户Cài đặt里若显式给了 engine.memoryMB / cores / gpuMode，则作为上限/覆盖，
 * 但不会再因là “没Cài đặt」而Dùng 4G/4nhân 硬编码把NhỏBộ nhớ机器搞崩。
 */
/**
 * 「Container nhẹ」配额：只约束最影响主机手感của那一mục —— vCPU 数。
 *
 * 旧逻辑给 16 nhân机器分 4 nhân，qemu của 4 cái vCPU luồng会长期占满物理nhân，
 * Windows Màn hình nền、鼠标、Duyệt器只能抢剩下của时间片，表现就是「一Mở就卡」。
 * 实际跑一cái Android App 2 cái vCPU 已经绰绰Có余，多给只是拖慢主机。
 *
 * Bộ nhớ、分辨率刻意不动：Bộ nhớ上限本来就是 2~3G，降分辨率还会让 quickboot
 * 快照指纹变化、每次切模式都要重新Khởi động nguội，得不偿失。
 *
 * 纯函数，settings 为 null 时返回 null（保持旧调Dùng方/单测của行为不变）。
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine && engine.liteMode === false) return null;
  const cores = engine && engine.resourceMode === 'save'
    ? 2
    // 老逻辑是 floor(nhân数/4) 再夹到 2~3 —— 8 nhân机器只给 2 cái vCPU，软件解码视频
    // （红果/抖音这类）直接卡成幻灯片。改成「一半物理nhân、上限 4」：
    // 8 nhân给 4、4 nhân给 2，Màn hình nền仍Có富余nhân，视频也够Dùng。
    : clamp(Math.floor((host.cores || 2) / 2), 2, 4);
  return { cores, priority: 'below' };
}

function chooseProfile({
  host = hostInfo(), accel, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = !!(accel && accel.ok);
  // 3GB 足够 Android 14 与主流Áp dụng；再高只会放LớnBộ nhớ占Dùng和 quickboot 快照体积
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // 「省资源」模式：刷视频/看Nhỏ说这类轻负载Dùng不到 3G，把上限压到 2G。
  // 直接效果是 qemu 常驻Bộ nhớ少约 1GB、quickboot 快照也Nhỏ 1GB（磁盘同步受益）。
  // 只CóDùng户没手动指定Bộ nhớ时才收敛，手动值永远优先。
  const rmode = settings && settings.engine && settings.engine.resourceMode;
  if (rmode === 'save' && !overrides.memoryMB) {
    memoryMB = clamp(memoryMB, 2048, 2048);
  }
  // 物理Khả dụngBộ nhớ不够时下调；Android 14 最低 2G，低于此只能靠 TCG 慢速跑
  if (host.freeMB && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  if (overrides.memoryMB) {
    // 上限跟着宿主走：早先写死 8192，结果 32GB 机器上也最多只能分 8GB，
    // Lớn型游戏（尤其带高清资源包của）进场景就频繁回收贴图，表现是卡顿/黑屏。
    const lim = memoryLimits(host.totalMB);
    memoryMB = clamp(Number(overrides.memoryMB) || memoryMB, 1536, lim.maxMB);
  }

  let cores = clamp(Math.floor(host.cores / 2), 2, 4);
  if (overrides.cores) {
    // 同样跟着宿主：至少留 1 nhân给 Windows，单nhân机器仍然给 1 nhân
    const maxCores = Math.max(1, (host.cores || 1) - 1);
    cores = clamp(Number(overrides.cores) || cores, 1, maxCores);
  }
  // Dùng户没手动指定nhân数时才由轻量模式收敛，手动值永远优先
  const lite = settings ? liteProfile({ host, engine: settings.engine || {} }) : null;
  if (lite && !overrides.cores) cores = Math.min(cores, lite.cores);

  const disk = diskMB || freeDiskMB(host.tmp);
  // /data 容量：Áp dụng本体、游戏资源包和它们của「更新包」都占这里，4GB 太容易满
  // （表现就是Áp dụng内更新时提示「Không đủ dung lượng ổ đĩa」）。默认按磁盘余量给 6/8GB，
  // Dùng户也可以直接在Cài đặt里指定（改Lớn后下次开机就地扩容，不丢数据）。
  const wantGB = Number((settings && settings.engine && settings.engine.dataPartitionGB) || 0);
  // Tự động值也跟磁盘余量走：50GB 级游戏解包后接近 90GB，余量Lớncủa机器给 16GB 起步，
  // 免得装完第一cáiLớn游戏就开始报「Không đủ dung lượng」。
  const autoDataMB = disk && disk < 12288 ? 4096 : (disk && disk > 262144 ? 16384 : 6144);
  // Dùng户指定时按「所在磁盘của 80%」封顶：填 128GB 但盘里只Có 20GB，只会装到一半Thất bại
  const dataMaxMB = disk ? Math.max(2048, Math.floor((disk * 0.8) / 1024) * 1024) : 262144;
  const dataMB = wantGB > 0
    ? clamp(Math.round(wantGB * 1024), 2048, Math.min(262144, dataMaxMB))
    : autoDataMB;

  const gpus = gpuCandidates(emulatorVersion);
  const gpu = overrides.gpuMode && gpus.includes(overrides.gpuMode) ? overrides.gpuMode : gpus[0];

  // 渲染分辨率：auto 时按Tăng tốc状态Chọn（Giả lập phần mềm降到 540x960 保流畅）
  // Màn ngang优先：Màn ngang是由「物理面板尺寸」决定của，必须写进 AVD 并重启才生效，
  // 所以这里先按 settings.display.landscape 定方向，再叠加 renderSize。
  const wantLandscape = !!(settings && settings.display && settings.display.landscape);
  const wantLcd = String((settings && settings.engine && settings.engine.renderSize) || 'auto');
  const lcd = /^\d{3,4}x\d{3,4}$/.test(wantLcd)
    ? (() => {
      const [w0, h0] = wantLcd.split('x').map(Number);
      // Dùng户显式分辨率若与当前方向不一致，按方向校正（Màn ngang取长边作宽）
      const long = Math.max(w0, h0);
      const short = Math.min(w0, h0);
      const w = wantLandscape ? long : short;
      const h = wantLandscape ? short : long;
      return { w, h, dpi: short <= 540 ? 240 : (short <= 720 ? 320 : 420) };
    })()
    : lcdFor({ accelOk, landscape: wantLandscape });

  return {
    memoryMB,
    cores,
    heapMB: memoryMB >= 3072 ? 384 : 256,
    dataMB,
    lcd,
    gpu,
    gpuCandidates: gpus,
    accel: accelOk ? 'auto' : 'off',
    accelOk,
    port,
    adbPort,
    snapshot: true,
    lite: !!lite,
    // 无Tăng tốccủaGiả lập thuần phần mềm在 Windows 上确实能起来，但 Android 14 Khởi động nguội可能 5-10 phút
    bootTimeoutMs: accelOk ? 240000 : 600000,
    emulatorVersion,
    host,
  };
}

/**
 * 把「高级参数」trongDùng户Cài đặt转成 overrides。
 * 0 / auto / 未Cài đặt一律视là “不覆盖」，仍然走Tự động推导；
 * 只CóDùng户主动关掉Tự độngBộ nhớ并填了具体数值才生效。
 */
function overridesFromSettings(engine = {}) {
  const e = engine || {};
  const manual = e.autoMemory === false;
  return {
    memoryMB: manual ? Number(e.memoryMB) || 0 : 0,
    cores: manual ? Number(e.cores) || 0 : 0,
    gpuMode: e.gpuMode && e.gpuMode !== 'auto' ? e.gpuMode : '',
  };
}

/**
 * 展示 / Chẩn đoánDùngcủa统一入口：不启动 Android 也能算出与真实开机一致của参数。
 * 之前Cài đặt页直接调 chooseProfile()（不带版本和Tăng tốc状态），会在 37.x 机器上
 * 错误地显示已弃Dùngcủa swiftshader_indirect / Giả lập phần mềm，和实跑参数对不上。
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044, host = null } = {}) {
  return chooseProfile({
    // host 可注入：单测/Chẩn đoán想复现「4 nhânNhỏ机器」时不Dùng真của换机器。
    // 不传就按Máy này实际情况算（正常Bộ chạy都是这条Đường dẫn）。
    host: host || hostInfo(),
    accel, emulatorVersion, diskMB, port, adbPort, settings,
    overrides: overridesFromSettings(settings && settings.engine),
  });
}

/**
 * Thất bại重试矩阵：从「最优」到「最保守」，最多 4 次。
 * 依次换 GPU 后端 → 关Tăng tốc phần cứng走 TCG → 降Bộ nhớ并强制Khởi động nguội清快照。
 */
function planVariants(profile) {
  const out = [];
  const gpus = profile.gpuCandidates || [];
  const firstGpu = profile.gpu || gpus[0] || 'software';
  const safeGpu = gpus.find((g) => /software|swiftshader/.test(g)) || firstGpu;
  const ordered = [firstGpu, ...gpus.filter((g) => g !== firstGpu && /swiftshader|swangle/.test(g))].slice(0, 2);
  for (const gpu of ordered) {
    out.push({ ...profile, gpu, label: `${gpu} / ${profile.accel === 'auto' ? 'Tăng tốc phần cứng' : 'Giả lập phần mềm'}`, wipe: false, snapshot: true });
  }
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    label: 'Giả lập phần mềm không tăng tốc (chậm nhưng tương thích nhất)',
    wipe: false,
    snapshot: false,
  });
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    memoryMB: 2048,
    cores: 2,
    dataMB: Math.min(profile.dataMB, 2048),
    label: 'Khởi động nguội an toàn (bộ nhớ tối thiểu + xóa snapshot)',
    // 这里**绝对不能** wipe：以前写của是 wipe:true，而磁盘写满时每次尝试都会Thất bại，
    // 于是连续重试把Dùng户已装củaÁp dụng和存档一起「清快照 + 清数据」了 ——
    // 「磁盘满了，结果Mở ApkStart Áp dụng全没了」就是这么发生của。
    // Cần重建 userdata 时由 ensureDataPartition 自己判断（它只在镜像损坏时重建），
    // 不靠启动参数trong -wipe-data。
    wipe: false,
    snapshot: false,
    lastResort: true,
  });
  // 去重（相同 gpu/accel/wipe 组合不重复试）——但「最后一档」必须保留：
  // 它是唯一「不加载快照」của方案，NhỏBộ nhớ机器上可能和前一档参数完全一样。
  const seen = new Set();
  return out.filter((v) => {
    const k = `${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}|${v.lastResort ? 'last' : ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 检测一对Trống闲端口（emulator console + adb 注册端口必须相邻偶数/奇数） */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function freePortPair(start = 5554) {
  for (let p = start; p <= start + 40; p += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p) && await isPortFree(p + 1)) return p;
  }
  return start;
}

/**
 * adb server 端口：固定不复Dùng探测。
 * 之前是"从 5044 往上找一cáiTrống闲端口"，但 adb server 本身是常驻进程，占着这cái端口，
 * 于是每启动一次 ApkStart 就会多一cái adb server（实测一次会话跑出 6 cái），
 * 而且端口老是变，下次启动想接管Lần trướccủa模拟器时对不上号。
 * 5044 是 ApkStart 专Dùng端口（Dùng户自己của adb 在 5037），直接固定Dùng。
 */
async function freeAdbPort(start = 5044) {
  return Number(process.env.APKSTART_ADB_PORT) || start;
}

/**
 * 配置指纹：只Có「镜像 / 数据Phân vùng / Engine版本」变化才作废快照。
 * 故意不包含 GPU、Tăng tốc方式、Bộ nhớ —— 那些是Tự động重试会频繁切换của参数，
 * 若纳入会让每次重试都触发 -wipe-data，把Dùng户已装củaÁp dụng清Trống。
 */
/**
 * quickboot 快照của「配置指纹」：只Có这些变化会让旧快照失效（加载后黑屏/起不来）。
 *
 * 刻意**不包含 dataMB**：数据Phân vùng调Lớn以后旧快照照样能Dùng（qemu 会按新củaPhân vùngLớnNhỏ
 * 重新挂载），把它算进指纹của后果是「Dùng户只想扩cái容，结果快照作废 + Khởi động nguội +
 * 数据被删」—— 实测踩过一次，代价是整机Áp dụng全丢。
 */
function snapshotKey(plan, imageDir) {
  return crypto.createHash('sha1').update([
    imageIdentity(imageDir), plan.emulatorVersion || '', plan.api || '', plan.tag || '',
  ].join('|')).digest('hex').slice(0, 16);
}

/**
 * Ảnh hệ thốngcủa「身份」：只保留 `system-images/...` 之后của部分。
 *
 * 镜像放哪cái盘都无所谓，同一套镜像换cái目录不该被当成「换了镜像」——
 * 否则Dùng户把Bộ chạy从 C 盘挪到 D 盘（我们自己在Cài đặt里就建议这么做）以后，
 * AVD trong sysdir 与新Đường dẫn不一致 → 判定镜像变了 → -wipe-data → Ứng dụng đã cài全丢。
 * 这cái坑在实测中真của会踩到，所以两cái地方（AVD 配置、快照指纹）都必须Dùng身份而不是绝对Đường dẫn。
 */
function imageIdentity(dir) {
  const p = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.indexOf('system-images/');
  if (i >= 0) return p.slice(i);
  return p.split('/').slice(-3).join('/');
}

const RULES = [
  {
    code: 'ACCESS_VIOLATION',
    // Windows 上 emulator/qemu 以 0xC0000005（十进制 3221225477）Thoát：
    // 实测多见于「显卡Trình điều khiển / Vulkan 后端在 guest 刚要启动时崩掉」，
    // 与 CPU、Bộ nhớ、镜像都无关（同机换 -gpu software 往往就能过）。
    // 必须排在 GPU_INIT 前面：崩溃Nhật ký里通常也带着渲染初始化信息，先判崩溃更准。
    re: /emulator exit 3221225477|exit code 3221225477|0xC0000005|STATUS_ACCESS_VIOLATION/i,
    title: 'Backend kết xuất bị sập (0xC0000005 lỗi truy cập)',
    hint: 'Đã tự chuyển sang phần kết xuất an toàn hơn và thử lại, ghi nhớ để lần sau không thử phần kết xuất này trước.'
      + 'Nếu lặp lại nhiều lần, hãy cập nhật driver card đồ họa; hoặc vào Cài đặt → Hiệu năng và tài nguyên, hạ chất lượng hình, tắt Remote Desktop/passthrough card đồ họa máy ảo rồi thử lại.',
  },
  {
    code: 'GPU_INIT',
    // 只匹配「Thất bại」语境：正常Nhật ký里也会出现 Vulkan/EGL/ANGLE 字样，不能误判为致命错误
    re: /Failed to initialize GL emulation|Could not initialize (OpenGL|emulated framebuffer)|Failed to create .*GLES|EGL_(BAD|NOT_INITIALIZED|CONTEXT_LOST)|Failed to (load|initialize) .*vulkan|vulkan.*(failed|error)|ANGLE.*(fail|error)/i,
    title: 'Khởi tạo phần kết xuất đồ họa thất bại',
    hint: 'Đã tự chuyển sang kết xuất phần mềm và thử lại. Nếu vẫn lỗi, hãy cập nhật trình điều khiển đồ họa hoặc tắt chuyển tiếp GPU của Remote Desktop/máy ảo rồi thử lại.',
  },
  {
    code: 'GPU_MODE',
    re: /Unknown option|invalid .*-gpu|Unrecognized .*gpu|Unsupported gpu/i,
    title: 'Bộ chạy hiện tại không chấp nhận chế độ GPU này',
    hint: 'Đã tự chọn chế độ GPU dùng được theo phiên bản bộ chạy và thử lại (bản cũ dùng swiftshader_indirect, bản mới dùng software).',
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|acceleration.*not (installed|available|supported)|WHPX.*(not|failed)|AEHD.*(not|failed)|ERROR_ACCESS_DENIED|Tăng tốc.*Không khả dụng/i,
    title: 'Tăng tốc phần cứng không khả dụng',
    hint: 'Đã tự quay về giả lập phần mềm (lần khởi động đầu sẽ chậm rõ rệt). Muốn chạy mượt, hãy tích “Virtual Machine Platform” trong “Windows Features”, hoặc cài trình điều khiển AEHD rồi khởi động lại.',
  },
  {
    code: 'MEMORY',
    re: /Cannot allocate memory|not enough memory|commit charge|Failed to allocate|out of memory|Không đủ bộ nhớ/i,
    title: 'Cấp phát bộ nhớ thất bại',
    hint: 'Đã tự giảm bộ nhớ và số nhân cấp cho Android. Hãy đóng các chương trình chiếm bộ nhớ rồi thử lại.',
  },
  {
    code: 'PORT_BUSY',
    re: /port.*(in use|busy)|Address already in use|bind.*failed|Failed to (setup|bind) .*console/i,
    title: 'Cổng của trình giả lập đang bị chiếm',
    hint: 'Đã tự đổi sang cổng đang rảnh. Nếu lặp lại, hãy thoát các trình giả lập như Nox/MuMu/BlueStacks, hoặc khởi động lại máy.',
  },
  {
    code: 'AVD_LOCK',
    re: /already running|lock file|\.lock|AVD is in use|emulator is running/i,
    title: 'Lần chạy trước còn sót tệp khóa',
    hint: 'Đã tự dọn tệp khóa AVD và khởi động lại.',
  },
  {
    code: 'IMAGE',
    re: /system\.img.*(missing|not found|corrupt)|kernel-ranchu.*(missing|not found)|invalid magic|Failed to open .*\.img|APEX.*(fail|error|loop)|boot loop|verity.*fail/i,
    title: 'Ảnh hệ thống bị thiếu hoặc hỏng / không tương thích với dữ liệu người dùng cũ',
    hint: 'Đã tự khởi động lại với dữ liệu người dùng sạch. Nếu vẫn lỗi, hãy xóa ảnh trong “Bộ chạy” rồi tải lại.',
  },
  {
    code: 'DLL',
    re: /0xc0000135|STATUS_DLL_NOT_FOUND|missing DLL|Qt6.*not found|MSVCP140|VCRUNTIME|Không thể chạy chương trình này|The code execution cannot proceed/i,
    title: 'Thành phần bộ chạy bị diệt virus xóa hoặc thiếu thư viện VC++',
    hint: 'Hãy thêm thư mục ApkStart vào danh sách trắng của phần mềm diệt virus, giải nén lại gói cài đặt và cài thư viện Microsoft VC++ 2015-2022.',
  },
  {
    code: 'DISK_FULL',
    re: /No space left|disk full|not enough space|Không đủ dung lượng ổ đĩa/i,
    title: 'Không đủ dung lượng đĩa, không thể khởi động Android',
    hint: 'Hãy đổi thư mục bộ chạy (Cài đặt → Tích hợp hệ thống → Thư mục dữ liệu bộ chạy) sang ổ còn nhiều dung lượng,'
      + 'Hoặc tắt “Giữ snapshot khởi động nhanh” trong cài đặt / giảm phân vùng dữ liệu. Dữ liệu Android không bị tự xóa.',
  },
  {
    code: 'NON_ASCII',
    re: /Unicode|non-ASCII|Đường dẫn.*(Không hợp lệ|Không tìm thấy)|cannot find the path/i,
    title: 'Đường dẫn cài đặt có tiếng Trung hoặc ký tự đặc biệt',
    hint: 'Đã tự chuyển sang đường dẫn ngắn của Windows. Nếu vẫn lỗi, hãy chuyển ApkStart vào thư mục chỉ có chữ không dấu (như C:\\ApkStart）。',
  },
  {
    // Lần trước被强制结束后 AVD 目录会留下 hardware-qemu.ini.lock / multiinstance.lock，
    // 模拟器一律拒绝启动，报出来của却是容易被误读成 CPU 问题của话。必须排在 CPU 规则前。
    code: 'AVD_LOCK',
    re: /Running multiple emulators with the same AVD|AVD .*is already running|hardware-qemu\.ini\.lock/i,
    title: 'Lần chạy trước không thoát bình thường, còn sót tệp khóa',
    hint: 'ApkStart Sẽ tự xóa khóa còn sót rồi thử lại; nếu lặp lại, hãy kiểm tra xem có trình giả lập khác đang dùng cùng bộ chạy không.',
  },
  {
    code: 'CPU_FEATURE',
    re: /host doesn't support requested feature|CPUID.*not supported|unsupported CPU|missing.*(AVX|SSE4|xsave)/i,
    title: 'CPU Thiếu tập lệnh mà bộ chạy yêu cầu',
    hint: 'Cảnh báo này trên một số CPU cũ chỉ là cảnh báo, vẫn khởi động được; nếu thật sự không lên, hãy cập nhật engine trong “Bộ chạy” về phiên bản tương thích cũ hơn, hoặc dùng máy hỗ trợ VT-x/AVX.',
  },

  {
    code: 'SNAPSHOT',
    re: /snapshot|Quick Boot|ram\.img|Saving state/i,
    title: 'Snapshot khởi động nhanh bị hỏng',
    hint: 'Đã tự bỏ snapshot cũ và khởi động nguội; lần thoát bình thường tiếp theo sẽ tạo lại snapshot.',
  },
];

/** 把Nhật ký翻译成 {code,title,hint}，供 UI 展示与Tự động重试决策 */
function diagnose(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: r.title, hint: r.hint };
  }
  return {
    code: 'UNKNOWN',
    title: 'Bộ chạy không khởi động xong',
    hint: 'Đã tự thử lại với nhiều tổ hợp tham số. Có thể nhấn “Xuất báo cáo chẩn đoán” để gửi nhật ký cho tác giả xác định lỗi.',
  };
}

/** 人类可读của一行摘要，放在Cài đặt页让高级Dùng户知道Tự độngChọn了什么 */
function describeProfile(p) {
  return `Tự động:${(p.memoryMB / 1024).toFixed(1)}GB Bộ nhớ · ${p.cores} nhân · ${p.gpu} Kết xuất · `
    + `${p.accelOk ? 'Tăng tốc phần cứng' : 'Giả lập phần mềm'} · ${p.snapshot ? 'Snapshot theo yêu cầu' : 'Khởi động nguội'}`
    + `${p.lite ? ' · Container nhẹ' : ''} · Cổng ${p.port}`;
}

/** Xuất báo cáo chẩn đoán（纯文本，便于发邮件/贴 issue） */
function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const d = diagnose(logLines);
  const body = [
    'ApkStart Báo cáo chẩn đoán',
    `Thời điểm tạo:${new Date().toLocaleString()}`,
    '',
    '== Máy này ==',
    JSON.stringify(hostInfo(), null, 2),
    '',
    '== Tự cấu hình ==',
    JSON.stringify(profile || {}, null, 2),
    describeProfile(profile || chooseProfile()),
    '',
    '== Chẩn đoán ==',
    `${d.code}：${d.title}`,
    d.hint,
    '',
    '== Thông tin bổ sung ==',
    JSON.stringify(extra, null, 2),
    '',
    '== Nhật ký bộ chạy (300 dòng cuối)==',
    ...(Array.isArray(logLines) ? logLines.slice(-300) : String(logLines || '').split('\n')),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, diagnosis: d };
}

/**
 * 检测微软 VC++ 2015-2022 x64 运行库是否Cài đặt。
 * 安卓模拟器（Qt6）与 qemu 都依赖它；Thiếu了在「其他电脑」上会直接起不来
 * （报 0xc0000135 / MSVCP140 Thiếu失）。Cài đặt版我们已内置 vc_redist.x64.exe，
 * 这里只做检测，供启动前给出明确提示与一键Cài đặt入口。
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  // 先看 DLL：msvcp140 / vcruntime140 正是 Qt6 与 qemu 真正依赖của两cái文件。
  // Dùng文件判断既不Dùng起 reg.exe（部分安全软件会拦、也会拖慢每 60s của自检），
  // 也不会因为注册表mục被Dọn dẹp工具删掉而误报「没装」。
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  try {
    if (fs.existsSync(path.join(sys, 'msvcp140.dll'))
      && fs.existsSync(path.join(sys, 'vcruntime140.dll'))) return true;
  } catch (_) { /* 走注册表兜底 */ }

  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  for (const k of [key, key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]) {
    try {
      const out = execFileSync('reg', ['query', k, '/v', 'Installed'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Installed\s+REG_DWORD\s+0x1/i.test(out)) return true;
    } catch (_) { /* 键Không tồn tại = 没装 */ }
  }
  return false;
}

module.exports = {
  hostInfo, freeDiskMB, isAsciiPath, shortPath, lcdFor, liteProfile,
  versionNumbers, gpuCandidates, detectGpuVendor, chooseProfile, planVariants,
  overridesFromSettings, autoProfile,
  freePortPair, freeAdbPort, snapshotKey, imageIdentity,
  diagnose, describeProfile, writeReport, vcRedistOk,
};
