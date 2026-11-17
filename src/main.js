'use strict';
/**
 * ApkStart 主进程
 * 职责：窗口 / 托盘 / 单实例 / 命令行分发（双击 apk、Màn hình nền快捷方式启动）/ IPC
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage, screen, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const store = require('./core/store');
const { Runtime } = require('./core/engine');
const { Installer } = require('./core/installer');
const { Sharer } = require('./core/sharer');
const { parseApk } = require('./core/apk');
const { drawAppIcon } = require('./core/png');

// 品牌 Logo（build/render-logo.js 生成）；Thiếu失时回退到程序化绘制của旧版图标
const LOGO_DIR = path.join(__dirname, 'ui', 'assets');
const LOGO_FILE = path.join(LOGO_DIR, 'logo.png');
const APPICON_FILE = path.join(LOGO_DIR, 'appicon.ico');
function loadBrandIcon(size) {
  try {
    if (fs.existsSync(LOGO_FILE)) {
      const img = nativeImage.createFromPath(LOGO_FILE);
      return size ? img.resize({ width: size, height: size, quality: 'best' }) : img;
    }
  } catch (_) { /* 落到程序化图标 */ }
  return nativeImage.createFromBuffer(drawAppIcon(size || 256));
}

// 托盘Dùng「Nhỏ尺寸简化标」：把 512 主标缩到 16px 会糊成一团，纹理和文字都没了
function loadTrayIcon() {
  try {
    const p = path.join(LOGO_DIR, 'tray-16.png');
    if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  } catch (_) { /* 回退到程序化图标 */ }
  return nativeImage.createFromBuffer(drawAppIcon(16));
}
const assoc = require('./core/assoc');
const windowctl = require('./core/windowctl');
const display = require('./core/display');
const { WinAgent } = require('./core/agent');
const pointer = require('./core/pointer');
const { KeymapEngine } = require('./core/keymap-engine');
const { PRESETS: KEYMAP_PRESETS } = require('./core/keymap');
const { AppWindow, TITLEBAR_H } = require('./core/appwin');
const { NotifyBridge } = require('./core/notify');
const { AndroidSettings } = require('./core/android');
const { Updater, findUninstaller } = require('./core/updater');
const leftovers = require('./core/leftovers');

// Windows 下窗口被遮挡时 capturePage 会拿到旧帧，Tự động化截图Cần禁Dùng遮挡计算
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/**
 * 系统盘快满时，把 Chromium 自己của缓存（Cache / GPUCache / Local Storage …）
 * 挪到「安卓数据目录」所在của盘。
 * 默认这些缓存写在 %APPDATA%\apkstart 里 —— C 盘Chỉ còn几百 MB 时，连启动都可能Thất bại，
 * 而Dùng户往往已经把安卓数据挪到别của盘了，缓存却还在 C 盘上挤。
 * 必须在 app ready 之前Cài đặt，之后改Không hợp lệ。
 */
function relocateUserDataIfCrowded() {
  try {
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(store.DATA_DIR);
    const avd = String(store.getSettings().runtime.avdDir || '').trim();
    if (!avd) return;
    const avdFree = doctor.freeDiskMB(avd);
    if (freeMB >= 2048 || avdFree <= freeMB * 2) return;
    const target = path.join(avd, 'appdata');
    fs.mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
  } catch (_) { /* 放不进去就维持默认，不影响启动 */ }
}
relocateUserDataIfCrowded();

// Cửa sổ ứng dụng把模拟器以 SetParent 方式嵌进来当子窗口。Chromium 默认Dùng
// DirectComposition 上半透明图层（Intermediate D3D Window /
// WS_EX_NOREDIRECTIONBITMAP）绘制网页，这层由 DWM 在窗口级别合成，
// 会直接盖住嵌入của子窗口——表现就是"画面全黑但安卓其实在跑"。
// 外壳界面只Có一条 38px 标题栏和启动遮罩，走软件合成完全不卡，
// 关掉Tăng tốc phần cứng后 Chromium 直接画进 HWND，子窗口层级才真正生效。
// 想对比效果时可以设 APKSTART_HWACCEL=1 启动。
if (process.env.APKSTART_HWACCEL !== '1') app.disableHardwareAcceleration();

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = process.argv.includes('--dev');

/**
 * 轻量文件Nhật ký：打包后没Có控制台，出问题时Dùng户可以把 app.log 发过来。
 * 只记关键节点和异常，正常Đường dẫn几千行也不会撑爆。
 */
function appLog(line) {
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    const limit = store.getSettings().engine.logLimitKB || 2048;
    require('./core/logfile').append(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}`, limit);
  } catch (_) { /* Nhật kýThất bại不能影响主流程 */ }
}
process.on('uncaughtException', (e) => appLog(`UNCAUGHT ${e && (e.stack || e.message)}`));
process.on('unhandledRejection', (e) => appLog(`REJECT ${e && (e.stack || e.message || e)}`));

/**
 * 完整版（内置Bộ chạy）Tự động接管：
 * 发行包里 ApkStart.exe 旁边带Có runtime/（emulator + platform-tools + AEHD + ARM Ảnh hệ thống tương thích）。
 * 首次启动（settings.json 尚Không tồn tại）时直接把 runtime.dir 指向它并开启Tương thích模式，
 * Dùng户无需任何下载与Cài đặt，开箱即Dùng。之后Dùng户仍可在Cài đặt里改回在线版。
 */
/**
 * 随Gói cài đặt带来củaThư mục bộ chạy (完整版 exe 旁边của runtime/、微软商店 MSIX của
 * app\resources\runtime）。Không phảiTrống = 模拟器和镜像都是本地của：开机动画不该提
 * 「下载」，autoDeploy 也不该联网。
 *
 * 必须在 bootstrapBundledRuntime() 之前声明：那cái函数在模块加载时立刻执行，
 * Dùng `let` 声明在它后面会撞上 TDZ（赋值直接抛错，被 catch 吞掉，标志永远为Trống）。
 */
let bundledRuntimeDir = null;

function bootstrapBundledRuntime() {
  try {
    const exeDir = path.dirname(process.execPath);
    // 便携版把Bộ chạy放在 exe 旁边；electron-builder của portable 会把资源解到
    // resources/ 下，进程 exe 和 resources 同级，所以几cái候Chọn位置都看一下。
    const candidates = [
      path.join(exeDir, 'runtime'),
      path.join(path.dirname(exeDir), 'runtime'),
      path.join(process.resourcesPath || '', 'runtime'),
      path.join(process.resourcesPath || '', 'app', 'runtime'),
    ];
    // 内置Bộ chạy只要求「Có emulator + 任意一套完整Ảnh hệ thống」，不写死 API 版本：
    // 单文件发行版带của可能是更Nhỏcủa AOSP 镜像，写死 API34 会让它误判成没CóBộ chạy。
    const hasImage = (dir) => {
      const root = path.join(dir, 'system-images');
      let apis = [];
      try { apis = fs.readdirSync(root); } catch (_) { return false; }
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) {
            const d = path.join(root, api, tag, abi);
            // 单文件发行版trong镜像是压缩存放của（system.img.xz / .gz），Giải nén在首次启动时做。
            // 这里只认 system.img 会让「包里明明带了镜像」被判成没带，转而去联网下载。
            const hasSys = ['system.img', 'system.img.xz', 'system.img.gz']
              .some((f) => fs.existsSync(path.join(d, f)));
            if (hasSys && fs.existsSync(path.join(d, 'kernel-ranchu'))) return true;
          }
        }
      }
      return false;
    };
    const bundled = candidates.find((dir) =>
      fs.existsSync(path.join(dir, 'emulator', 'emulator.exe')) && hasImage(dir));
    if (!bundled) return;

    const s = store.getSettings();
    // 旧版只在 settings.json Không tồn tại时接管: dùng户先装过在线版再Giải nén完整版，
    // 就会一直走「Thiếu组件」của部署向导。Hiện只要当前Bộ chạyTrong thư mục không có emulator 就接管。
    const explicit = String(s.runtime.dir || '').trim();
    const current = explicit || path.join(store.DATA_DIR, 'runtime');
    const currentExe = path.join(current, 'emulator', 'emulator.exe');
    // 便携版被移动/升级（Giải nén到新目录）后，settings 里记của还是旧Đường dẫn：
    // 必须只认「本次 EXE 所在目录下của runtime」，否则会一直Dùng旧包trong组件
    // （实测踩过：旧包của emulator Thiếu emulator-check → Tăng tốc探测Thất bại → 退回 TCG Giả lập phần mềm）。
    const sameTree = path.resolve(current).toLowerCase()
      .startsWith(path.resolve(exeDir).toLowerCase());
    const currentOk = fs.existsSync(currentExe) && sameTree;
    // Dùng户自己挑của目录（不在 EXE 目录树里，Ví dụ D:\ApkStartRuntime 或别của盘）
    // 一律尊重：他可能就是为了省 C 盘Trống间、或让多cái便携版TổngDùng一cáiBộ chạy。
    // 旧版在这里无条件覆盖成 exe 旁边của bundled runtime，表现就是
    // 「Cài đặt里改了Bộ chạy数据目录，结果还是下到旧目录 / AppData」（issue #23）。
    if (explicit && !sameTree && fs.existsSync(currentExe)) {
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // 已CóKhả dụngBộ chạy（含在线版）就尊重它：AVD Dùng户数据就在该目录下，不能悄悄搬走
    if (currentOk) {
      // Bộ chạy就在 EXE 目录树里 = 它是Gói cài đặt自带của（完整版 / 商店版）
      bundledRuntimeDir = current;
      // 但仍把Tự động参数Mở，旧配置trong硬编码 4G/4nhân/弃Dùng GPU 模式不能Tiếp tụcDùng
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // 包里带của是 Google Play 镜像才开Tương thích模式；AOSP 镜像带của是原生 x86_64 库
    let playBundled = false;
    try {
      const root = path.join(bundled, 'system-images');
      for (const api of fs.readdirSync(root)) {
        for (const tag of fs.readdirSync(path.join(root, api))) {
          if (/playstore|google_apis/i.test(tag)) playBundled = true;
        }
      }
    } catch (_) { /* 忽略 */ }
    store.saveSettings({
      runtime: { dir: bundled, compatImage: playBundled },
      engine: { gpuMode: 'auto', autoMemory: true },
    });
    bundledRuntimeDir = bundled;
  } catch (_) { /* 接管Thất bại不阻塞启动，走在线引导 */ }
}
bootstrapBundledRuntime();

// 冒烟截图等Tự động化场景下跳过注册表探测（避免依赖 reg.exe）
const NO_SHELL_PROBE = process.argv.includes('--smoke') || process.env.APKSTART_NO_SHELL_PROBE === '1';
const ICON_PNG = loadBrandIcon().toPNG();

let mainWindow = null;
let tray = null;
let runtime = null;
// 「哪些窗口算我们của」由 whenReady 里赋值（见 agentScope）。放模块级是因为
// runLaunch / 预热定时器都早于那段代码定义，闭包trong const 在它们của作Dùng域外看不到。
let armAgent = async () => ({ ok: false });
let installer = null;
let sharer = null;
let quitting = false;
let winAgent = null;
let appWin = null;
let notifier = null;
let androidSet = null;
let updater = null;
let updateBusy = false;
let updateInfo = null;

/**
 * 开机动画窗口của状态放在模块级。
 *
 * 之前是写在 app.whenReady() của回调里（const splashWin/splashDone），而
 * runLaunch() / autoDeploy() 定义在更外层作Dùng域 —— 它们trong
 * `typeof splashDone === 'function'` 永远是 false，于是：
 *   - 进度文字永远不更新（一直显示「Đang chuẩn bị…」）；
 *   - 启动成功后 splash 永远不Đóng，480x360 của alwaysOnTop 窗口就钉在
 *     屏幕中央、压在安卓画面上面。
 * 这就是Dùng户反馈của「Mở ứng dụng出现多cái窗口」：管理窗口/splash/Cửa sổ ứng dụng同时在场。
 * 提升到模块级之后这些调Dùng才真正生效。
 */
let splashWin = null;
let splashProgress = () => {};
let splashDone = () => {};

// ---------------- 命令行解析 ----------------

function parseArgs(argv) {
  const args = argv.slice(IS_DEV ? 2 : 1).filter((a) => !a.startsWith('--allow-file-access'));
  const out = { apk: null, launch: null, silent: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--launch') {
      // Electron 会往 argv 里塞自己của开关和 app Đường dẫn，只认形如 com.foo.bar của包名
      const v = args.slice(i + 1).find((x) => x && /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(x));
      if (v) { out.launch = v; out.silent = true; }
    } else if (a === '--silent' || a === '--autostart') out.silent = true;
    else if (/\.(apk|xapk|apks)$/i.test(a) && !a.startsWith('--')) out.apk = a;
  }
  return out;
}

/** Chromium 能解 WebP，nativeImage 不能；Dùng隐藏窗口把 APK 图标转成 PNG */
let decodeWindow = null;
async function decodeIcon(raw) {
  if (!decodeWindow || decodeWindow.isDestroyed()) {
    decodeWindow = new BrowserWindow({ show: false, width: 2, height: 2, skipTaskbar: true });
    await decodeWindow.loadURL('about:blank');
  }
  const mime = /^RIFF/.test(raw.toString('ascii', 0, 4)) ? 'image/webp' : 'image/png';
  const js = `(async () => {
    const img = new Image();
    img.src = 'data:${mime};base64,${raw.toString('base64')}';
    await img.decode();
    const s = Math.min(256, Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = s; c.height = s;
    c.getContext('2d').drawImage(img, 0, 0, s, s);
    return c.toDataURL('image/png');
  })()`;
  const url = await decodeWindow.webContents.executeJavaScript(js);
  return Buffer.from(String(url).split(',')[1] || '', 'base64');
}

/** 开机自启：默认开启，不CầnDùng户去Cài đặt里勾 */
function applyAutoStart() {
  if (!app.isPackaged) return; // 开发时不写注册表
  const on = !!store.getSettings().autoStart;
  try {
    // 必须显式给 name，否则注册表trong启动mục会叫 "electron.app.Electron"
    app.setLoginItemSettings({
      openAtLogin: on,
      name: 'ApkStart',
      path: process.execPath,
      args: ['--autostart'],
    });
    // 清掉旧版本（没传 name）留下của那条，避免重复启动
    app.setLoginItemSettings({ openAtLogin: false, name: 'electron.app.Electron' });
  } catch (_) { /* 组策略禁止时忽略 */ }
}

// ---------------- Chế độ hiển thị：全屏自适应 / Màn dọc窗口可调 ----------------

function displaySettings() { return store.getSettings().display || {}; }

/**
 * Windows 任务栏 / 通知của身份。
 *
 * 为什么要按Áp dụng切换：每cáiỨng dụng AndroidcủaMàn hình nền快捷方式都写了自己của AUMID
 * （`RoutineMiku.ApkStart.<包名>`，见 installer.createShortcut），而且快捷方式của
 * 图标是**那 ứng dụng自己của图标**。Windows 只Có在「运行进程của AUMID == 快捷方式của
 * AUMID」时，才会把Đang chạycủa窗口和任务栏固定mục合并成同一cái按钮、并沿Dùng快捷方式
 * của图标。身份对不上就会出现「固定mục是Áp dụng图标、任务栏上却另起一cái ApkStart 图标」。
 *
 * setAppUserModelId 官方建议只调一次；实践中对**之后Tạo**của窗口Có效（VS Code 这类
 * 一cái进程跑多 ứng dụngcủa壳层就是这么做của）。这里只在开窗口之前切，且全程 try/catch ——
 * 万一某cái Windows 版本忽略它，也只是退化成按 exe 图标显示，不影响功能。
 */
const APP_AUMID = 'RoutineMiku.ApkStart';
function setAumid(id) {
  try { app.setAppUserModelId(String(id || APP_AUMID).slice(0, 128)); } catch (_) { /* Không phải Windows 或旧版本忽略 */ }
}

/**
 * 这 ứng dụng应该DùngBảng màn ngang还是Bảng màn dọc？
 *
 * 模拟器của物理面板（hw.lcd）是画面của「真实形状」，Android 不会为了
 * 一cái跟面板方向不一致củaÁp dụng去旋转整块面板 —— 它只会给Áp dụng一cái信箱式của
 * 中间窄条，两侧留黑。所以「铺满窗口」của唯一出路是：面板方向 = Áp dụng方向。
 *
 * 优先级：Cài đặttrong强制模式 > 单 ứng dụngcủa手动覆盖 > APK 清单解析出của天然方向
 * > Hướng bảng hiện tại（Áp dụng声明跟随重力时不折腾重启）。
 */
function wantLandscapeFor(pkg) {
  const ds = displaySettings();
  const mode = ds.orientationMode || 'auto';
  if (mode === 'landscape') return true;
  if (mode === 'portrait') return false;
  const app = pkg ? store.getApp(pkg) : null;
  const override = app && app.orientationOverride;
  if (override === 'landscape') return true;
  if (override === 'portrait') return false;
  const natural = app && app.orientation;
  if (natural === 'landscape') return true;
  if (natural === 'portrait') return false;
  return !!ds.landscape;
}

/**
 * 运行期「学习」Áp dụng真正của方向。
 *
 * 离线解析 AndroidManifest 对红果这类Áp dụng够Dùng（几十cái Activity 写死 portrait），
 * 但CócủaÁp dụng全部声明成 sensor / fullSensor，清单里看不出倾向。这种就等它真của
 * 跑起来后问安卓自己要了一次（ActivityRecord của requestedOrientation 是系统
 * 按Áp dụng实际请求算出来của最终 giá trị)。学到之后写进 apps.json，下次启动就能Chọn对面板。
 */
async function learnAppOrientation(pkg) {
  const app = store.getApp(pkg);
  if (!app || app.orientation || app.orientationOverride) return null;
  let out = '';
  try {
    out = await runtime.client().shell(
      'dumpsys activity activities | grep -m1 requestedOrientation', { timeout: 8000 });
  } catch (_) { return null; }
  const s = String(out || '');
  let value = null;
  if (/requestedOrientation=SCREEN_ORIENTATION_(PORTRAIT|SENSOR_PORTRAIT|REVERSE_PORTRAIT|USER_PORTRAIT)/.test(s)) value = 'portrait';
  else if (/requestedOrientation=SCREEN_ORIENTATION_(LANDSCAPE|SENSOR_LANDSCAPE|REVERSE_LANDSCAPE|USER_LANDSCAPE)/.test(s)) value = 'landscape';
  if (!value) return null;
  store.upsertApp({ package: pkg, orientation: value });
  appLog(`learned orientation ${pkg} = ${value}`);
  return value;
}

function screenRect() {
  const d = screen.getPrimaryDisplay();
  const a = d.workArea || d.bounds;
  return { x: a.x || 0, y: a.y || 0, w: a.width || 1920, h: a.height || 1080 };
}

let currentAppPkg = null;
let wheelRouter = null;
const deviceSize = { value: null };

/** 滚轮注入Cần知道 Android 侧分辨率；缓存一次，转屏/重启Bộ chạy后失效 */
async function getDeviceSize() {
  if (deviceSize.value) return deviceSize.value;
  try { deviceSize.value = await runtime.client().wmSize(); } catch (_) { /* Bộ chạy还没起来 */ }
  if (!deviceSize.value || !deviceSize.value.width || !deviceSize.value.height) {
    const p = portraitSize();
    deviceSize.value = { width: p.w, height: p.h };
  }
  return deviceSize.value;
}

function portraitSize() {
  const d = displaySettings();
  return display.portraitSize(d.portrait || '540x960');
}

/** Cài đặt页改动Phím chuột后，立刻按当前窗口焦点同步一次钩子配置 */
function refreshPointerMapping() {
  if (appWin && appWin.isOpen) appWin.refreshPointer();
  else if (winAgent && winAgent.hooked) winAgent.setHook(false).catch(() => {});
}

/**
 * 旋转 = 换物理面板尺寸并重启模拟器。
 *
 * 这是唯一能得到「正立 + 铺满」Màn ngangcủa方式（三种错路都踩过）：
 *   - wm size：只改逻辑分辨率，物理 LCD 仍是竖của -> 画面躺倒 90°、只占左上角一条；
 *   - wm density：framebuffer 尺寸不变 -> 画面不铺满，Phóng to后右侧一Lớn片Trống白；
 *   - adb emu rotate：只转画面内容，系统里还是Màn dọc。
 * 只Có把 hw.lcd.width/height 换成Màn ngang并重启，Qt 才会按Bảng màn ngang开窗口、画面正立铺满。
 */
async function restartForOrientation(landscape, { reloadApp = true } = {}) {
  if (!appWin || !appWin.isOpen) return false;
  const pkg = appWin.pkg;
  store.saveSettings({ display: { landscape: !!landscape } });
  send('runtime:log', landscape ? 'Chuyển sang ngang: đang khởi động lại bộ chạy Android…' : 'Chuyển về dọc: đang khởi động lại bộ chạy Android…');
  try {
    // 先把嵌入窗口摘下来，避免重启过程中在Màn hình nền留下黑窗
    try { await appWin.agent.detach(); } catch (_) { /* ignore */ }
    await runtime.stop({ graceful: false }).catch(() => {});
    appLog(`rotate -> landscape=${landscape} restarting runtime`);
    const rt = await runtime.ensure({
      onLog: (m) => { send('runtime:log', m); appLog(`  rt ${m}`); },
    });
    if (!rt || !rt.ok) return false;
    await runtime.waitForNetwork({ onLog: () => {}, timeoutMs: 25000 }).catch(() => null);
    // reloadApp=false：调Dùng方（runLaunch）自己会把Áp dụng拉起来，这里别抢着做一遍
    if (reloadApp && pkg) {
      const app = store.getApp(pkg);
      if (app) {
        await rt.client.install(app.apkPath).catch(() => {});
        await rt.client.startApp(app.package, app.activity, {}).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1500));
      await attachAppWindow();
      appWin.scheduleFit(6);
    }
    // 返回新của rt：beforeStart 拿到后会替换掉旧của（旧 client 已随 stop 失效）
    return rt;
  } catch (e) {
    appLog(`rotate restart failed: ${e && e.message}`);
    return false;
  }
}

/**
 * 把安卓画面接到Dùng户眼前。两种模式：
 *   - 嵌入（默认）：SetParent 进我们自己của窗口，观感统一；
 *   - 独立窗口：让模拟器开原生窗口，绕开嵌入固Cócủa一整串问题
 *     （黑边、坐标错位、铺不满、Qt 面板方向打架）。由Cài đặt display.windowEmbed 控制。
 */
async function attachAppWindow() {
  if (!appWin || !appWin.isOpen) return false;
  const embedMode = displaySettings().windowEmbed !== false;
  if (!embedMode) {
    // 独立窗口不Cần标题栏里那块区域了，直接让模拟器窗口自己露出来
    return appWin.openDetached().catch(() => false);
  }
  const ok = await appWin.embed().catch(() => false);
  if (!ok) {
    setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 1500);
    setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 4000);
  }
  return ok;
}

/**
 * Mở（或复Dùng）那cái「一 ứng dụng一cái干净窗口」。
 *
 * 切换Áp dụng时必须先把**上一cái**Áp dụng真正关掉，否则会出现Dùng户反馈của
 * 「点开第二 ứng dụng，第一cái没响应 / ANR」：
 *   - appWin.open() 里对旧窗口Dùngcủa是 close({keepApp:true})，它只收窗口、
 *     **不调 endApp**，于是旧Áp dụng进程既没被 force-stop，也留在
 *     runtime._activeApps 里；
 *   - 新Áp dụng beginApp 时 `first = _activeApps.size === 0` 因此判断错误，
 *     优先级 / 快照逻辑全乱；
 *   - 两 ứng dụng同时抢同一cái模拟器của前台 → 旧của卡死弹 ANR。
 * 所以这里先 await 把旧Áp dụng停干净，再开新窗口。
 */
async function openAppWindow(pkg, tip) {
  // 只Có「切到另一 ứng dụng」才Cần关旧của；重复点同一cái走复DùngĐường dẫn，不打断。
  if (currentAppPkg && currentAppPkg !== pkg && appWin && appWin.isOpen) {
    const prev = currentAppPkg;
    try {
      // 先摘画面再停进程：独立窗口模式下模拟器原生窗口是Dùng户正看着của那扇，
      // park 把它藏好，避免销毁宿主时在Màn hình nền留下黑窗。
      await appWin.close({ keepApp: true });
      await runtime.endApp(prev, { onIdle: onContainerActive }).catch(() => {});
      appLog(`switch: closed ${prev} before launching ${pkg}`);
    } catch (e) {
      appLog(`switch close ${prev} failed: ${e && e.message}`);
    }
  } else if (currentAppPkg && currentAppPkg !== pkg) {
    // 窗口已经不在了，但进程可能还挂在 _activeApps 里，同样要收尾。
    await runtime.endApp(currentAppPkg).catch(() => {});
  }
  const rec = store.getApp(pkg);
  const land = wantLandscapeFor(pkg);
  const p0 = portraitSize();
  const detached = displaySettings().windowEmbed === false;
  // 面板方向和Áp dụng方向不一致 → beforeStart 会重启一次Bộ chạy(khoảng 40 giây)。
  const willRestart = land !== !!displaySettings().landscape;
  // 独立窗口模式下壳窗口平时不显示，但**等待期间**必须给Dùng户一cái可见của交代：
  //   - Có开机动画（首次启动）时由动画负责；
  //   - 没Có动画（切换Áp dụng）时必须把壳窗口显示出来，否则Màn hình nền上 40 秒什么都没Có，
  //     Dùng户会以为程序崩了。
  const splashVisible = !!(splashWin && !splashWin.isDestroyed());
  const label = (rec && rec.label) || pkg;
  // 先把这 ứng dụngcủa身份切过去，再开窗口：任务栏才会沿Dùng快捷方式里那 ứng dụngcủa图标
  setAumid(`${APP_AUMID}.${pkg}`);
  appWin.open({
    pkg,
    label,
    iconPath: rec && rec.icoPath,
    // Màn ngang时窗口按横比例开，否则竖窗口里塞横画面会留出Lớn片黑边
    portrait: land ? { w: p0.h, h: p0.w } : p0,
    // 全屏Có两种来路：显式Chọn了「全屏」模式，或者勾了「启动时Tự động toàn màn hình」。
    // 后者以前是cái死开关（只在默认Cài đặt里声明，没Có任何代码读它），这里补上。
    fullscreen: displaySettings().mode === 'fullscreen'
      || displaySettings().autoFullscreenOnLaunch === true,
    detached,
    showWhileWaiting: detached && !splashVisible,
  });
  appWin.setIcon(rec && rec.icoPath);
  // Mở时按Đã lưucủa方向初始化（物理面板方向在 doctor.lcdFor 里决定）
  appWin.setState({
    // Cần重启换面板时，直接把「为什么慢」写在提示里，别让Dùng户对着 40 秒Trống屏猜
    tip: willRestart
      ? `Đang xử lý cho “${String(label).slice(0, 20)}” chuyển sang${land ? 'Màn ngang' : 'Màn dọc'}(khởi động lại môi trường Android, khoảng 40 giây, chỉ cần một lần)…`
      : (tip || 'Đang khởi động bộ chạy Android…'),
    ready: false,
    landscape: land,
  });
  currentAppPkg = pkg;
}

async function toggleDisplayMode() {
  const next = store.saveSettings({
    display: { mode: displaySettings().mode === 'fullscreen' ? 'window' : 'fullscreen' },
  });
  const full = next.display.mode === 'fullscreen';
  if (appWin && appWin.isOpen) {
    // 独立窗口模式下画面在模拟器原生窗口里，maximize 壳窗口毫无视觉效果，
    // 走 appWin.toggleMaximize 才会把模拟器窗口铺满/还原。
    if (displaySettings().windowEmbed === false) {
      appWin.toggleMaximize().catch(() => {});
    } else if (full) appWin.win.maximize();
    else appWin.win.unmaximize();
    appWin.scheduleFit(6);
    // 注意：这里**不再**顺手把面板方向也切了。
    // 全屏和Màn ngang是两件事：面板方向Hiện由「Áp dụng自己声明của方向」决定
    // （见 wantLandscapeFor）。以前 F11 会连带重启Bộ chạy切Màn ngang，结果Màn dọcÁp dụng
    // 被塞进Bảng màn ngang → 两侧黑边 → Dùng户以là “全屏没生效」。
  }
  return next.display.mode;
}

/** 首次运行把 adb / emulator / Ảnh hệ thống一次装完，不再分 1~5 步 */
let deploying = false;
async function autoDeploy({ force = false } = {}) {
  if (deploying || !store.getSettings().autoDeploy) return { ok: false, error: 'skipped' };
  // Tải thất bại冷却：以前只要 checkEnv() 还Thiếu组件，每次启动 ApkStart 都会重新
  // 拉一遍 1.5GB củaBộ chạy包，Dùng户看到của就是「一直重复下载」。
  // Thất bại后记一cái时间戳，30 phút内不再Tự động重试；Dùng户手动点「一键部署」时
  // force=true 可以立刻重试。成功或人为强制都清掉冷却。
  const COOLDOWN_MS = 30 * 60 * 1000;
  const lastFail = Number(store.getSettings().runtime.deployFailedAt || 0);
  if (!force && lastFail && Date.now() - lastFail < COOLDOWN_MS) {
    appLog(`autoDeploy Đang nghỉ (lần thất bại trước lúc ${new Date(lastFail).toISOString()}), bỏ qua tự thử lại`);
    return { ok: false, error: 'cooldown', cooldown: true, until: lastFail + COOLDOWN_MS };
  }
  deploying = true;
  const progress = (p) => {
    send('provision:progress', { ...p, component: p.component || 'all' });
    // 同步推送到开机动画窗口
    if (typeof splashProgress === 'function') splashProgress(p);
  };
  let succeeded = false;
  try {
    const env = await runtime.provisioner.checkEnv();
    const needEngine = !env.emulator.ok || !env.sysimg.ok;
    // 随包自带Bộ chạy（完整版Gói cài đặt / 微软商店版）：**一律不联网**。
    // 镜像已经在包里（压缩形态），第一次开机由 engine.ensure() 就地展开；
    // 这里再下一套 1.5GB 纯属浪费，也正是Dùng户抱怨của「装完还在下镜像」。
    if (bundledRuntimeDir && env.adb.ok && env.emulator.ok && env.sysimg.ok) {
      appLog(`autoDeploy Bỏ qua: bộ chạy đã tích hợp sẵn trong gói (${bundledRuntimeDir}), không cần mạng`
        + (env.needsExtract ? ', ảnh hệ thống sẽ được giải nén cục bộ ở lần khởi động đầu' : ''));
      return { ok: true, source: 'bundled', needsExtract: !!env.needsExtract };
    }
    if (bundledRuntimeDir && !env.emulator.ok) {
      appLog(`autoDeploy Bỏ qua tải qua mạng: thư mục bộ chạy đã tích hợp sẵn trong gói (${bundledRuntimeDir}), chuyển cho quy trình chẩn đoán`);
      return { ok: false, error: 'bundled', bundled: true };
    }
    // 轻量版优先Dùng「本mục目 GitHub củaToàn bộ gói bộ chạy」：一cái文件搞定 emulator + Ảnh hệ thống，
    // 下载源和更新源统一在 GitHub 上（国内比 dl.google.com 稳得多）。
    // 整包拿不到（没网 / 还没发过该资产 / 被限流）再逐cái从官方源装。
    if (needEngine && store.getSettings().runtime.preferGithubRuntime !== false) {
      try {
        progress({ message: 'Đang tải bộ chạy từ GitHub…' });
        await runtime.provisioner.installRuntimePack(progress);
        const afterPack = await runtime.provisioner.checkEnv();
        if (afterPack.emulator.ok && afterPack.sysimg.ok) {
          succeeded = true;
          return { ok: true, source: 'github' };
        }
        progress({ message: 'Gói bộ chạy không đầy đủ, chuyển sang nguồn chính thức để bổ sung…' });
      } catch (e) {
        progress({ message: `GitHub Bộ chạy không khả dụng (${e.message}), chuyển sang nguồn chính thức…` });
      }
    }
    if (!env.adb.ok) {
      progress({ message: 'Đang chuẩn bị adb…' });
      await runtime.provisioner.installAdb(progress);
    }
    if (!env.emulator.ok) {
      progress({ message: 'Đang chuẩn bị bộ chạy Android…' });
      await runtime.provisioner.installEmulator(progress);
    }
    if (!env.sysimg.ok) {
      progress({ message: 'Đang chuẩn bị ảnh hệ thống Android…' });
      await runtime.provisioner.installSystemImage(progress);
    }
    const after = await runtime.provisioner.checkEnv();
    succeeded = !!(after.adb.ok && after.emulator.ok && after.sysimg.ok);
    return { ok: succeeded };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    // 只Có「真Thất bại」才进冷却；部署成功要把旧Thất bại记录清掉。
    try {
      store.saveSettings({ runtime: { deployFailedAt: succeeded ? 0 : Date.now() } });
    } catch (_) { /* Cài đặt写不进去不影响本次结果 */ }
    deploying = false;
  }
}

function launcherInfo() {
  if (app.isPackaged) {
    return { target: process.execPath, args: '', cwd: path.dirname(process.execPath) };
  }
  return { target: process.execPath, args: `"${APP_ROOT}"`, cwd: APP_ROOT };
}

/** 递归复制目录内容（best-effort，不删源；Dùng于Tổng享目录改Đường dẫn时一次性搬迁旧文件） */
function copyDirContents(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) copyDirContents(s, d);
      else fs.copyFileSync(s, d);
    } catch (_) { /* 单文件Thất bại不影响其余 */ }
  }
}

/** 以管理员权限启Dùng一cái Windows 可Chọn功能（如 VirtualMachinePlatform / HypervisorPlatform） */
/**
 * 提权开启一cái Windows 可Chọn功能。
 *
 * 返回 { ok, cancelled, code, feature }：
 *   cancelled Dùng 1223（ERROR_CANCELLED）区分「Dùng户在 UAC 里点了否」和「真củaThất bại」——
 *   以前两者都是 ok:false，UI 只能笼统说「Không bật được」，Dùng户完全不知道自己点了Hủy。
 */
function enableWindowsFeature(feature) {
  return new Promise((resolve) => {
    const inner = `Enable-WindowsOptionalFeature -Online -FeatureName '${feature}' -NoRestart -All`;
    const ps = `try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru `
      + `-ArgumentList @('-NoProfile','-NonInteractive','-Command',${JSON.stringify(inner)}); exit $p.ExitCode } `
      + 'catch { exit 1223 }';
    const { spawn } = require('child_process');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('exit', (code) => resolve({
      ok: code === 0, cancelled: code === 1223, restart: true, code, feature,
    }));
    proc.on('error', () => resolve({ ok: false, feature, error: 'Không thể khởi động PowerShell' }));
  });
}

/**
 * 开启系统自带của WHPX（Windows Hypervisor Platform）。
 *
 * 注意：真正让 Android 模拟器Dùng上 WHPX của功能叫
 * **「Windows 虚拟机监控程序平台」(HypervisorPlatform)**；
 * 「虚拟机平台」(VirtualMachinePlatform) 是 WSL2 Dùngcủa，单独开它 WHPX 仍然Không khả dụng。
 * 两cái都开一次，覆盖不同机器上của差异（顺序上先开真正Cầncủa那cái）。
 *
 * 也不再拿 WinHvPlatform.dll 是否存在当开关：那cái DLL 在现代 Windows 上本来就在
 * （实测Máy này WinHvPlatform.dll 存在，但跑của是 AEHD）——Dùng它判断「能不能开 WHPX」
 * 只会把真正Cần开của机器挡在门外。
 */
async function enableWhpxFeatures() {
  const steps = [];
  for (const f of ['HypervisorPlatform', 'VirtualMachinePlatform']) {
    // eslint-disable-next-line no-await-in-loop
    steps.push(await enableWindowsFeature(f));
  }
  return { ok: steps.some((s) => s.ok), cancelled: steps.every((s) => s.cancelled), steps };
}

/** 商店版专Dùngcủa手动引导文案：MSIX 包固定 mediumIL，提权通常拿不到 */
const MSIX_ACCEL_HINT = 'Bản Store không tự nâng quyền được. Hãy bật thủ công một lần:'
  + 'Nhấn Win+R → nhập optionalfeatures → tick “Nền tảng Hypervisor của Windows”'
  + '(HypervisorPlatform, thứ WHPX thực sự cần), sau khi xác nhận hãy khởi động lại máy.';

// ---------------- 主窗口 ----------------

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: Number(process.env.APKSTART_WIN_W) || 1140,
    height: Number(process.env.APKSTART_WIN_H) || 740,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#f7f8fa',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f7f8fa', symbolColor: '#2b3138', height: 44 },
    icon: nativeImage.createFromBuffer(ICON_PNG),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (show) mainWindow.once('ready-to-show', () => mainWindow.show());

  // 冒烟测试时把渲染进程của报错打到 stdout：界面Trống白、按钮点了没反应，
  // 十Có八九是 app.js 里某cái id 改动后抛了异常，正常运行看不到。
  if (process.argv.includes('--smoke')) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer] ${message} (${String(source).split('/').pop()}:${line})`);
    });
  }

  // 外链一律交给系统Duyệt器（公众号/GitHub 等），绝不把Cửa sổ ứng dụng导航走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    notify('ApkStart Vẫn đang chạy nền', 'Bấm biểu tượng ở khay hệ thống để mở lại; bấm chuột phải vào khay để thoát.');
  });

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  return mainWindow;
}

function showWindow() {
  // 回到管理窗口 = 回到 ApkStart 自己của身份（不然任务栏会沿Dùng上一 ứng dụngcủa图标）
  setAumid(APP_AUMID);
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notify(title, body) {
  if (store.getSettings().notifyOnInstall === false) return;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body, icon: nativeImage.createFromBuffer(ICON_PNG) }).show();
  } catch (_) { /* ignore */ }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------- 托盘 ----------------

function buildTray() {
  const icon = loadTrayIcon();
  try {
    tray = new Tray(icon);
  } catch (_) {
    return;
  }
  const refresh = () => {
    const apps = store.getApps().slice(0, 8);
    // 独立窗口模式主界面是隐藏của，托盘就成了唯一随时Truy cập đượccủa入口 ——
    // 「Đóng ứng dụng hiện tại」必须放这里，否则Dùng户根本没法关掉正在跑củaÁp dụng。
    // 判断「Có没CóÁp dụng在跑」要同时看 currentAppPkg 和 runtime.activeApps：
    // endApp 会从 activeApps 里删掉包名，所以关掉后这里Tự động变 false。
    // 但 currentAppPkg 可能还指着上一 ứng dụng（endApp 不清它），所以要双重判断。
    const hasRunning = currentAppPkg && runtime && runtime.activeApps
      ? runtime.activeApps.includes(currentAppPkg)
      : false;
    const runningLabel = currentAppPkg
      ? ((store.getApp(currentAppPkg) || {}).label || currentAppPkg)
      : '';
    const menu = Menu.buildFromTemplate([
      { label: 'Mở ApkStart', click: () => showWindow() },
      { type: 'separator' },
      ...(apps.length
        ? apps.map((a) => ({ label: a.label, click: () => runLaunch(a.package) }))
        : [{ label: 'Chưa cài ứng dụng nào', enabled: false }]),
      { type: 'separator' },
      {
        label: hasRunning ? `Đóng ứng dụng hiện tại (${runningLabel}）` : 'Đóng ứng dụng hiện tại',
        enabled: !!hasRunning,
        click: () => {
          const pkg = currentAppPkg;
          if (!pkg) return;
          // 复Dùng app:stop của同一条Đường dẫn，不在两处写同样của逻辑
          stopApp(pkg).then(() => refresh());
        },
      },
      {
        label: displaySettings().landscape ? 'Quay về dọc (cần khởi động lại bộ chạy)' : 'Chuyển sang ngang (cần khởi động lại bộ chạy)',
        enabled: !!currentAppPkg,
        click: () => { restartForOrientation(!displaySettings().landscape).catch(() => {}); },
      },
      {
        label: displaySettings().mode === 'fullscreen' ? 'Quay về cửa sổ dọc' : 'Toàn màn hình (tự thích ứng màn hình)',
        click: () => { toggleDisplayMode(); },
      },
      { label: 'Tạo lại lối tắt màn hình nền/Start Menu', click: () => { installer.ensureShortcuts().catch(() => {}); } },
      { label: 'Đồng bộ thư mục chia sẻ', click: () => sharer.sync() },
      { label: 'Cài đặt', click: () => { showWindow(); send('ui:navigate', 'settings'); } },
      {
        label: updateInfo && updateInfo.hasUpdate ? `Có phiên bản mới ${updateInfo.tag}` : 'Kiểm tra cập nhật',
        click: async () => {
          showWindow();
          send('ui:navigate', 'settings');
          const info = await updater.check().catch(() => null);
          if (info) { updateInfo = info; send('update:state', info); }
          if (info && info.hasUpdate && info.asset) {
            const r = await dialog.showMessageBox(mainWindow || undefined, {
              type: 'question',
              title: 'Có phiên bản mới',
              message: `ApkStart ${info.tag} Đã phát hành, phiên bản hiện tại v${app.getVersion()}. Cập nhật ngay bây giờ?`,
              detail: (info.notes || '').slice(0, 600),
              buttons: ['Cập nhật ngay', 'Lúc khác'],
              defaultId: 0,
              cancelId: 1,
            });
            if (r.response === 0) runUpdate();
          } else if (info && !info.hasUpdate) {
            notify('Đã là phiên bản mới nhất', `ApkStart v${app.getVersion()}`);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Thoát',
        click: async () => {
          try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };
  tray.setToolTip('ApkStart — Trình chạy ứng dụng Android');
  // Windows 托盘của惯例是单击就Mở主窗口（双击当然也可以）。
  // 之前只绑了 double-click，Dùng户单击没反应，会以为托盘图标坏了。
  // 右键才出菜单，所以这里单击直接 showWindow 不会和菜单冲突。
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  refresh();
  setInterval(refresh, 5000).unref?.();
}

// ---------------- nhân心动作 ----------------

let installBusy = null;   // Đang cài đặtcủa文件Đường dẫn：双击 APK 连点会走 second-instance，不能并发装
let lastInstallErr = { msg: '', at: 0 };

async function runInstall(filePath) {
  showWindow();
  // 同一cái包正在装（Dùng户连点了几次图标 / 拖了好几次）→ 只提示一次，别重复跑一遍Cài đặt
  if (installBusy) {
    if (installBusy === filePath) {
      send('toast', { type: 'info', message: 'APK này đang được cài, vui lòng đợi…' });
      return { ok: false, error: 'Đang cài đặt' };
    }
    send('toast', { type: 'info', message: 'Đã có tác vụ cài đặt đang chạy, vui lòng đợi cài xong.' });
    return { ok: false, error: 'Đã có tác vụ cài đặt đang chạy' };
  }
  installBusy = filePath;
  send('install:start', { file: filePath });
  try {
    const result = await installer.install(filePath, (p) => send('install:progress', p));
    send('install:done', result);
    // 新建củaMàn hình nền图标要让资源管理器立刻Làm mới，否则Dùng户会以là “没Tạo快捷方式」
    windowctl.refreshShell().catch(() => {});
    notify('Cài đặt hoàn tất', `${result.app.label} Đã cài đặt${result.app.shortcutPath ? ', đã tạo lối tắt trên màn hình nền' : ''}`);
    return result;
  } catch (e) {
    send('install:error', { message: e.message, file: filePath });
    if (e.needsSetup) send('ui:navigate', 'setup');
    // 同一条错误 8 秒内只弹一次系统通知：连续重试时不会在右下角刷屏
    const now = Date.now();
    if (e.message !== lastInstallErr.msg || now - lastInstallErr.at > 8000) {
      lastInstallErr = { msg: e.message, at: now };
      // 窗口在前台时Dùng户已经看到界面trong提示，不必再弹系统通知
      if (!mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()) {
        notify('Cài đặt thất bại', e.message.slice(0, 120));
      }
    }
    throw e;
  } finally {
    installBusy = null;
  }
}

/**
 * 下载并Cài đặt新版本，然后由 update-apply 脚本接管「替换 + 重启」。
 * 界面与托盘菜单TổngDùng这一条Đường dẫn。
 */
async function runUpdate() {
  if (updateBusy) return { ok: false, error: 'Đang cập nhật' };
  // 商店（MSIX）版不能自更新：Cài đặt目录 C:\Program Files\WindowsApps 是只读của，
  // 覆盖 exe 不仅会Thất bại，还可能让包完整性校验失效、Áp dụng直接起不来。
  // 更新走 Microsoft Store（ms-windows-store: 协议）。
  if (store.STORE_BUILD) {
    shell.openExternal('ms-windows-store://downloadsandupdates').catch(() => {});
    return { ok: false, error: 'Bản Store do Microsoft Store cập nhật, đã mở mục “Tải xuống và cập nhật” của Store', manual: true };
  }
  updateBusy = true;
  const sendProgress = (p) => send('update:progress', p);
  try {
    const info = updateInfo && updateInfo.hasUpdate ? updateInfo : await updater.check();
    updateInfo = info;
    if (!info.hasUpdate) return { ok: false, error: 'Đã là phiên bản mới nhất' };
    if (!info.asset) {
      shell.openExternal(info.htmlUrl || Updater.repoUrl()).catch(() => {});
      return { ok: false, error: 'Phiên bản này không có gói cài đặt trực tiếp, đã mở trang phát hành GitHub', manual: true };
    }
    sendProgress({ stage: 'download', percent: 0, message: 'Đang chuẩn bị tải…' });
    const job = await updater.prepare(info);
    sendProgress({ stage: 'apply', percent: 100, message: 'Đang thay chương trình và khởi động lại…' });
    updater.apply(job);
    // 给界面一点时间显示「即将重启」，然后走Thoát bình thường流程（before-quit 会把模拟器窗口藏好）
    setTimeout(() => { quitting = true; app.quit(); }, 900);
    return { ok: true, version: info.version, mode: job.mode };
  } catch (e) {
    sendProgress({ stage: 'error', percent: 0, message: e.message });
    return { ok: false, error: e.message };
  } finally {
    updateBusy = false;
  }
}

/**
 * 启动串行化。
 *
 * 一次启动最长要 80 秒（换面板重启 + Khởi động nguội）。这期间Dùng户完全可能再点一 ứng dụng、
 * 或者双击同一cái图标两次、或者托盘菜单里点一下 —— 以前这些都会真của并发跑第二遍：
 * openAppWindow 会把正在启动của那 ứng dụng关掉（close + endApp），而虚拟机正在重启，
 * 结果两边一起Thất bại，Nhật ký里是 `cmd: Can't find service: activity` / `device not found`，
 * Dùng户看到của是「点了没反应，然后弹回主界面」。
 *
 * Hiện：同一 ứng dụng → 直接复Dùng进行中của那次（连点等于一次）；换Áp dụng → 等前一次
 * 收尾再开始，而不是把它củaBộ chạy抽走。
 */
let launchInFlight = null;
// 「Giả lập phần mềm」提醒每cái进程只弹一次，避免每次切Áp dụng都来一条系统通知
let accelWarned = false;

async function runLaunch(pkg) {
  if (launchInFlight) {
    if (launchInFlight.pkg === pkg) {
      appLog(`launch reused in-flight ${pkg}`);
      return launchInFlight.promise;
    }
    appLog(`launch queued ${pkg}(đang chờ ${launchInFlight.pkg} khởi động xong)`);
    await launchInFlight.promise.catch(() => {});
  }
  const entry = { pkg };
  entry.promise = launchOne(pkg).finally(() => {
    if (launchInFlight === entry) launchInFlight = null;
  });
  launchInFlight = entry;
  return entry.promise;
}

async function launchOne(pkg) {
  const t0 = Date.now();
  const mark = (s) => appLog(`launch ${pkg} ${s} +${Date.now() - t0}ms`);
  // 「Nhận hình sớm」của状态：进程一出现就接，但最终成败要等回调回来才知道。
  // 放在函数作Dùng域，供后面của最终判定使Dùng。
  let attachDoneEarly = false;
  let earlyAttachOk = false;
  appLog(`launch start ${pkg}`);
  try {
    // 0) 先把管理窗口收起来，再去开Cửa sổ ứng dụng。
    // 顺序很重要：以前是 openAppWindow() 之后、armAgent() 之后才 hide()，
    // 而 armAgent 要等窗口代理Khởi động nguội（300~600ms），这段里「管理窗口 +
    // Cửa sổ ứng dụng(+ 开机动画)」是同时在屏幕上của —— Dùng户看到của就是多cái窗口乱飞。
    if (mainWindow && mainWindow.isVisible() && !IS_DEV) mainWindow.hide();
    // 1) 再把「Cửa sổ ứng dụng」Mở显示启动动画：整cái过程看不到安卓Màn hình nền，也看不到模拟器窗口
    await openAppWindow(pkg, 'Đang khởi động bộ chạy Android…');
    // 开机阶段把模拟器主窗 + qemu / netsimd của控制台黑窗藏起来，避免任何闪现。
    // 压制是常驻của（embed 后它会Tự động跳过被嵌入của那一cái窗口，见 appwin.embed）。
    // 这里必须 await：不等压制生效就往下走，黑窗会在启动瞬间露出来。
    if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }

    const r = await installer.launch(pkg, {
      onLog: (m) => {
        send('runtime:log', m); appLog(`  rt ${m}`);
        // 同步到开机动画
        if (typeof splashProgress === 'function') splashProgress({ message: m });
      },
      onMark: mark,
      // Áp dụng进程一出现就把画面接上去，不等后面那 4 秒của「Xác nhận不会崩」观察期。
      // 那 4 秒对稳定性Có意义，但Dùng户看到của是「点了没反应」；先让他看到Áp dụng在加载，
      // 观感差别很Lớn（实测点开到出画面 7.2s → 约 3s）。
      // 这里故意不 await：接画面和存活判定并行，谁先Hoàn tất都不影响另一边。
      onAppUp: () => {
        attachDoneEarly = true;
        mark('app up (Nhận hình sớm)');
        attachAppWindow()
          .then((ok) => {
            earlyAttachOk = ok;
            mark(`early attach=${ok}`);
            // 画面已接到Dùng户眼前 → 开机动画可以淡出了。
            // 放在这里而不是 launch ok 之后，是因为 early attach 时模拟器窗口
            // 已经 show 出来了；如果等 launch ok（还要再等 4 秒存活Xác nhận），
            // splash 和模拟器窗口会同时可见好几秒，Dùng户看到 splash 被「顶上去」。
            if (ok && typeof splashDone === 'function') splashDone();
          })
          .catch(() => { earlyAttachOk = false; });
        // Áp dụng刚起来时 Activity 还在重建，会按自己声明của方向（portrait）再转一次，
        // 把刚锁好của方向覆盖掉 —— 这就是「平板/Màn ngang模式下画面总是 90 度躺着」。
        // 等它稳定后补一次方向自愈（读 init/cur，只Có真躺倒才写）。
        setTimeout(() => {
          runtime._healOrientation?.().catch(() => {});
          // 顺带记下这 ứng dụng真正của方向（清单里全是 sensor củaÁp dụng只能这样学）
          learnAppOrientation(pkg).catch(() => {});
        }, 1800);
      },
      // 启动前先把面板方向校正到Cài đặt要求của那 mục.
      // Màn ngang只能靠物理面板（hw.lcd.width/height 互换）+ 重启实现，而这一mục是在
      // 开机时写进 config.ini của。如果Dùng户改了「Màn ngang」Cài đặt、但虚拟机还以Bảng màn dọc
      // 跑着（预热của场景很常见），光靠 wm size / wm user-rotation 只会让画面躺倒。
      // 所以这里Phát hiện不一致就先重启一次，reloadApp=false 让下面照常启动Áp dụng。
      beforeStart: async (rt) => {
        mark('engine ready');
        // 面板方向必须和Áp dụng自己của声明方向一致，否则 Android 只会给一cái信箱式
        // 窄条（两侧全黑）。wantLandscapeFor 会把「Cài đặttrong强制模式 / 单Áp dụng覆盖 /
        // APK 清单解析出của方向」合起来算，见函数注释。
        const wantLand = wantLandscapeFor(pkg);
        const cur = runtime.emulator && typeof runtime.emulator.panelLandscape === 'function'
          ? runtime.emulator.panelLandscape()
          : null;
        if (cur !== null && cur !== wantLand) {
          mark(`orientation mismatch (panel=${cur ? 'landscape' : 'portrait'}, want=${wantLand}) Khởi động lại để chỉnh`);
          appWin.setState({ tip: wantLand ? 'Đang chuyển sang màn ngang…' : 'Đang chuyển sang màn dọc…' });
          // restartForOrientation 重启Bộ chạy后返回新của rt（旧 client 已失效）。
          // 把它返回给 installer.launch，后续của resetDisplayOverrides / startApp
          // 都Dùng新 client，否则全部静默Thất bại（catch 吞掉，Áp dụng起不来画面）。
          const newRt = await restartForOrientation(wantLand, { reloadApp: false }).catch(() => null);
          mark('orientation fixed');
          if (newRt && newRt.ok) return newRt;
        }
        appWin.setState({ tip: 'Đang mở ứng dụng…' });
        // 沉浸式 + 关动画 + 收起锁屏：只做一次，之后每次启动都秒进
        await rt.client.prepareForeground().catch(() => {});
        mark('foreground ready');
        // 没Có重启就返回 null（installer Dùng原来của rt）
        return null;
      },
    });
    mark('app started');

    // 2) Áp dụng真của活下来了，才把画面接到Dùng户眼前（否则Dùng户会看到闪一下củaMàn hình nền/崩溃页）
    // 但如果 onAppUp 已经把画面接上了（提前接管），这里只做一次「Xác nhận」，不重复接 ——
    // 重复接在独立窗口模式下会把刚摆好của窗口再隐藏/显示一遍，画面会闪。
    let embedded;
    if (attachDoneEarly) {
      embedded = !!earlyAttachOk;
      mark(`early attached already (${embedded})`);
    } else {
      embedded = await attachAppWindow();
    }
    // Nhật ký措辞要分清两种模式：独立窗口模式下 embedded=true của意思是
    // 「画面已经接到Dùng户眼前（在模拟器原生窗口里）」，而不是「嵌进我们của窗口」。
    // 否则看Nhật kýcủa人会以为Cài đặt没生效。
    const attachMode = displaySettings().windowEmbed === false ? 'detached' : 'embed';
    if (!embedded) appLog(`attach failed (${attachMode}): ${appWin.lastEmbedError || 'unknown'}`);
    mark(`${attachMode}=${embedded}`);
    // 嵌入Hoàn tất后把窗口从别của窗口底下抬出来。否则上层窗口（Duyệt器等）会盖住安卓画面，
    // Dùng户看到của是「黑屏 / 画面没填满」，鼠标也点不到Áp dụng（全被上层窗口吃掉）。
    // 短暂 topmost 再立刻撤销，只借Dùng一次置顶把 Z 序抬到最前，不会长期霸占顶层。
    // 独立窗口模式跳过：那时画面在模拟器自己của窗口里，把Trống壳窗口显示出来只会挡住它。
    const detachedMode = displaySettings().windowEmbed === false;
    if (appWin.isOpen && !detachedMode) {
      try {
        appWin.win.show();
        appWin.win.setAlwaysOnTop(true);
        appWin.win.moveTop();
        appWin.win.focus();
        setTimeout(() => {
          if (appWin.isOpen) {
            try { appWin.win.setAlwaysOnTop(false); } catch (_) { /* 窗口Đã tắt */ }
          }
        }, 700);
      } catch (_) { /* 窗口可能刚Đóng */ }
    }
    appWin.setState({ ready: true, tip: '' });
    // 容器会话：环境已经Sẵn sàng，这里只做「按Áp dụng裁剪 + Mở后台轮询」，
    // 不再为这cái App 重新引导一遍 Android。Phím chuột钩子由窗口 focus 事件
    // 按Cài đặt决定，失焦即Gỡ cài đặt。
    deviceSize.value = null;
    appWin.refreshPointer();
    await runtime.beginApp(pkg, { onActive: onContainerActive }).catch(() => {});
    // 游戏/低延迟模式：让窗口代理降频扫描，减少全Màn hình nền EnumWindows 造成của整机卡顿
    if (winAgent) {
      const game = store.getSettings().engine?.priorityMode === 'game';
      winAgent.setPerformanceMode(game).catch(() => {});
    }
    send('app:launched', { package: pkg, engine: r.engine });
    appLog(`launch ok ${pkg} ${attachMode}=${embedded}`);
    // Giả lập phần mềm下第一次启动Áp dụng时提醒一lần:这时候Dùng户已经开始等了，横幅/自检mục
    // 都在Cài đặt里，很可能压根没看到。系统通知能盖在Cửa sổ ứng dụng上面，是最Có效của告知点。
    if (!accelWarned) {
      runtime.provisioner.emulatorAccel().then((a) => {
        if (!a || a.ok) return;
        accelWarned = true;
        notify('Đang chạy bằng giả lập phần mềm (rất chậm)', store.STORE_BUILD
          ? 'Sau khi bật “Nền tảng Hypervisor của Windows” và khởi động lại một lần, tốc độ có thể tăng 5~10  lần.'
            + 'Cài đặt → Tự kiểm tra môi trường → Sửa sẽ mở thẳng cửa sổ này.'
          : 'Cài đặt → Tự kiểm tra môi trường → Sửa để bật bằng một cú nhấp (cần quyền quản trị), sau đó khởi động lại một lần.');
      }).catch(() => {});
    }
    // 兜底：如果 early attach 没触发 splashDone（比如嵌入模式），这里补一次
    if (typeof splashDone === 'function') splashDone();
    return { ok: true, embedded };
  } catch (e) {
    appLog(`launch failed ${pkg}: ${e && (e.stack || e.message)}`);
    try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
    // Khởi động thất bại也把模拟器窗口Tiếp tục压住（不要让它以「独立của模拟器窗口」形式露出来），
    // 下次点Áp dụng还是走同一条隐藏 → embed củaĐường dẫn。
    if (winAgent) armAgent(winAgent).catch(() => {});
    showWindow();
    send('toast', { type: 'error', message: `Khởi động thất bại:${e.message}` });
    return { ok: false, error: e.message };
  }
}

/**
 * 容器Có/无Cửa sổ ứng dụng时của后台任务开关。
 * 文件同步每 8 秒要遍历Tổng享目录并走一次 adb find/stat，通知桥也在轮询；
 * 以前从 ApkStart 一启动就无条件开跑，哪怕一cái Android Áp dụng都没Mở。
 * Hiện只在容器里真củaCóÁp dụng时才开，关掉最后一cái窗口立刻停。
 */
function onContainerActive(on) {
  if (on) {
    sharer?.start(8000);
    startNotifier();
  } else {
    sharer?.stop();
    notifier?.stop();
  }
}

/**
 * 关掉一cáiĐang chạycủaỨng dụng Android —— 托盘菜单和右键菜单TổngDùng这一条Đường dẫn。
 *
 * 做了三件事：
 *  1. forceStop Áp dụng进程（endApp của停放逻辑也在这步之后）
 *  2. 收掉画面：嵌入模式关壳窗口；独立模式先把模拟器窗口藏了再关壳
 *     （顺序很重要：先销毁壳窗口会让模拟器窗口在Màn hình nền闪一下再被 park）
 *  3. 清 currentAppPkg，让托盘菜单của「Đóng ứng dụng hiện tại」立刻变灰
 *
 * @param {string} pkg 要ĐóngcủaGói ứng dụng名
 * @param {object} [opts] { keepWindow } keepWindow=true 时不收窗口
 * @returns {Promise<{ok:boolean, pkg?:string, error?:string}>}
 */
async function stopApp(pkg, opts = {}) {
  const target = pkg || currentAppPkg;
  if (!target) return { ok: false, error: 'Không có ứng dụng nào đang chạy' };
  const detached = displaySettings().windowEmbed === false;
  try {
    await runtime.endApp(target, { onIdle: (idle) => onContainerActive(idle) }).catch(() => {});
    appLog(`stop ${target}`);

    if (!opts.keepWindow) {
      // 独立窗口模式：先把模拟器窗口藏掉，再关壳窗口。
      // 反过来会在Màn hình nền留下一cái闪了闪又消失của模拟器窗口。
      if (detached && appWin && appWin.isOpen) {
        try { await appWin.agent.hide(); } catch (_) { /* ignore */ }
      }
      if (appWin && appWin.isOpen) {
        appWin.close({ keepApp: true });
      }
    }

    // 清掉当前Áp dụng标记：托盘菜单、右键菜单của「Đóng ứng dụng」都据此变灰
    if (currentAppPkg === target) currentAppPkg = null;

    try { send('apps:changed'); } catch (_) { /* ignore */ }
    return { ok: true, pkg: target };
  } catch (e) {
    appLog(`stop failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** 通知桥：只在CóCửa sổ ứng dụng时轮询，关掉窗口就停，避免Trống转 */
function startNotifier() {
  if (!notifier) {
    notifier = new NotifyBridge({
      getClient: () => runtime.client(),
      getAppLabel: (pkg) => (store.getApp(pkg) || {}).label || pkg,
      getAppIcon: (pkg) => (store.getApp(pkg) || {}).icoPath || '',
      onOpen: (pkg) => {
        if (appWin && appWin.isOpen && appWin.pkg === pkg) {
          appWin.win.show();
          appWin.win.focus();
        } else {
          runLaunch(pkg).catch(() => {});
        }
      },
    });
  }
  notifier.start();
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('app:info', () => ({    version: app.getVersion(),
    isDev: IS_DEV,
    dataDir: store.DATA_DIR,
    runtimeDir: runtime.provisioner.paths().root,
    diskFreeMB: (() => {
      try { return require('./core/doctor').freeDiskMB(runtime.provisioner.paths().root); } catch (_) { return 0; }
    })(),
    exe: process.execPath,
    packaged: app.isPackaged,
  }));

  // 启动方式（开机自启 / 双击Mở）：欢迎卡据此决定是否Tự động弹出
  ipcMain.handle('app:startupInfo', () => {
    const a = parseArgs(process.argv);
    return {
      autostart: process.argv.includes('--autostart') || !!a.silent,
      launch: a.launch || null,
      smoke: process.argv.includes('--smoke'),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
    };
  });

  // Chọn文件夹（Dùng于把Bộ chạy/镜像/Ứng dụng đã cài挪到Không phải系统盘）
  ipcMain.handle('dialog:openDir', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn thư mục lưu dữ liệu',
      defaultPath: defaultPath || store.DATA_DIR,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('apps:list', async () => {
    const apps = store.getApps();
    const settings = store.getSettings();
    let running = [];
    try {
      const c = runtime.client();
      if (await c.isOnline()) running = await c.runningPackages();
    } catch (_) { /* Bộ chạy chưa khởi động时忽略 */ }
    return apps
      .map((a) => ({
        ...a,
        running: running.includes(a.package),
        iconUrl: a.iconPath && fs.existsSync(a.iconPath)
          ? `file:///${a.iconPath.replace(/\\/g, '/').replace(/ /g, '%20')}`
          : null,
        shortcutExists: a.shortcutPath ? fs.existsSync(a.shortcutPath) : false,
      }))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastLaunchAt || 0) - (a.lastLaunchAt || 0) || a.label.localeCompare(b.label, 'zh'));
  });

  ipcMain.handle('apk:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn mục cần cài APK',
      filters: [{ name: 'Android Áp dụng', extensions: ['apk', 'apks', 'xapk'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  ipcMain.handle('apk:parse', async (_e, filePath) => parseApk(filePath));

  ipcMain.handle('apk:install', async (_e, filePath) => {
    const r = await runInstall(filePath);
    return { ok: true, app: r.app, warnings: r.warnings };
  });

  ipcMain.handle('app:launch', async (_e, pkg) => runLaunch(pkg));

  /**
   * 关掉一cáiĐang chạycủaỨng dụng Android。
   *
   * 以前根本没Có这cái入口：endApp 只在「Cửa sổ ứng dụng被Đóng」时触发，而独立窗口模式下
   * 那cái窗口是隐藏của、永远不会被关，所以Áp dụng一旦起来就关不掉，
   * Dùng户只能退到托盘Thoát整cái ApkStart（连虚拟机一起没了）。
   */
  ipcMain.handle('app:stop', async (_e, pkg, opts = {}) => stopApp(pkg, opts));

  ipcMain.handle('app:uninstall', async (_e, pkg) => {
    await installer.uninstall(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:shortcut', async (_e, pkg) => {
    const appRecord = store.getApp(pkg);
    if (!appRecord) throw new Error('Ứng dụng không tồn tại');
    const p = installer.createShortcut(appRecord);
    store.upsertApp({ package: pkg, shortcutPath: p });
    return { ok: true, path: p };
  });

  ipcMain.handle('app:clearData', async (_e, pkg) => {
    const rt = await runtime.ensure();
    if (!rt.ok) throw new Error(rt.error);
    await rt.client.clearData(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:pin', async (_e, { pkg, pinned }) => {
    store.upsertApp({ package: pkg, pinned: !!pinned });
    return { ok: true };
  });

  ipcMain.handle('app:revealApk', async (_e, pkg) => {
    const a = store.getApp(pkg);
    if (a?.apkPath && fs.existsSync(a.apkPath)) shell.showItemInFolder(a.apkPath);
  });

  ipcMain.handle('apk:reveal', async () => {
    fs.mkdirSync(store.APK_DIR, { recursive: true });
    shell.openPath(store.APK_DIR);
  });

  /**
   * Bộ nhớ / CPU / 数据Phân vùng这几mục会直接决定虚拟机怎么开、能装多Lớncủa游戏，
   * 保存前统一收敛一lần:手改 settings.json、旧版本残留của离谱值都在这里被拉回来，
   * 免得开机时 qemu 因为 -memory 32 直接Thoát，或者Phân vùng填到比磁盘还Lớn。
   */
  const sanitizeResourcePatch = (patch) => {
    if (!patch || !patch.engine) return patch;
    const res = require('./core/resources');
    const host = res.hostProfile();
    const eng = { ...patch.engine };
    if ('memoryMB' in eng) {
      const c = res.clampMemoryMB(eng.memoryMB, host.totalMB);
      eng.memoryMB = c.mb;
      if (c.mb > 0) eng.autoMemory = false;
    }
    if ('cores' in eng) eng.cores = res.clampCores(eng.cores, host.cores).cores;
    if ('dataPartitionGB' in eng) {
      eng.dataPartitionGB = Math.max(0, Math.min(256, Number(eng.dataPartitionGB) || 0));
    }
    return { ...patch, engine: eng };
  };

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, rawPatch) => {
    const patch = sanitizeResourcePatch(rawPatch);
    const next = store.saveSettings(patch);
    if (patch && patch.autoStart !== undefined) applyAutoStart();
    if (patch && patch.display && appWin && appWin.isOpen) {
      // Màn dọc基准尺寸变了：只影响后续Mởcủa窗口LớnNhỏ，不打断正在跑củaÁp dụng
      appWin.portrait = portraitSize();
    }
    // Mở「开始菜单快捷方式」时立刻补齐，不Dùng等下次Cài đặt
    if (patch && (patch.createStartMenuShortcut === true || patch.createShortcutOnInstall === true)) {
      installer.ensureShortcuts().catch(() => {});
    }
    // Phím chuột变了：立刻按当前焦点重装/Gỡ cài đặt钩子，不Dùng等下次切窗口
    if (patch && patch.engine && (
      'mouseRightBack' in patch.engine || 'mouseWheelMode' in patch.engine || 'mouseSideButtons' in patch.engine
    )) {
      refreshPointerMapping();
    }
    // 换了更新源 / 镜像前缀 / 整包地址：之前那套「谁最快」của结论不再成立，清掉测速缓存；
    // Toàn bộ gói bộ chạy / Engine / 镜像của地址还缓存在 provisioner._cache 里，不清掉就要重启进程才生效。
    if (patch && patch.runtime && (
      'sourcePreference' in patch.runtime || 'mirrorPrefix' in patch.runtime
      || 'autoMirror' in patch.runtime || 'runtimePackUrl' in patch.runtime
      || 'emulatorUrl' in patch.runtime || 'sysimgUrl' in patch.runtime
    )) {
      try {
        updater?.sources?.reset();
        runtime?.provisioner?.sources?.reset();
        runtime?.provisioner?.invalidateEnvCache?.();
      } catch (_) { /* ignore */ }
    }
    return next;
  });

  /**
   * 修改Thư mục chia sẻ của máy：把旧目录里已Cócủa文件一次性迁到新目录（best-effort，不删旧文件），
   * 再保存Cài đặt。Sharer 每次同步都动态读 store.getSettings().sharedDir，无需重启即可生效。
   */
  ipcMain.handle('settings:setSharedDir', async (_e, dir) => {
    if (!dir || !dir.trim()) return { ok: false, error: 'Thư mục không được để trống' };
    const newDir = dir.trim();
    const oldDir = store.getSettings().sharedDir;
    try {
      if (oldDir && oldDir !== newDir) copyDirContents(oldDir, newDir);
      fs.mkdirSync(newDir, { recursive: true });
      store.saveSettings({ sharedDir: newDir });
      return { ok: true, oldDir, newDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Chế độ hiển thị / 快捷方式 / 一键部署 ----------------

  ipcMain.handle('display:state', () => ({
    ...displaySettings(),
    screen: screenRect(),
    current: currentAppPkg,
  }));

  ipcMain.handle('display:set', async (_e, patch) => {
    const next = store.saveSettings({ display: patch || {} });
    if (appWin && appWin.isOpen) {
      appWin.portrait = portraitSize();
      const full = next.display.mode === 'fullscreen';
      if (full && !appWin.win.isMaximized()) appWin.win.maximize();
      if (!full && appWin.win.isMaximized()) appWin.win.unmaximize();
      // 全屏 = 平板Màn ngang排版（见 toggleDisplayMode của说明）
      appWin.setLandscape(full).catch(() => {});
      appWin.scheduleFit();
    }
    return next.display;
  });

  ipcMain.handle('display:toggle', () => toggleDisplayMode());

  ipcMain.handle('shortcut:rebuild', async () => ({ ok: true, fixed: await installer.ensureShortcuts() }));
  // Dùng户手动点「一键部署」时强制重试，绕过Thất bại冷却
  ipcMain.handle('runtime:autoDeploy', (_e, opts = {}) => autoDeploy({ force: !!opts.force }));
  // Đóng「深度裁剪」时把被 pm disable-user của系统包恢复回来
  ipcMain.handle('settings:restoreSystem', async () => runtime.restoreSystemApps());
  // Phím chuột改变：只同步配置，不再无条件Gỡ cài đặt（右键返回/滚轮可能仍Cần钩子）
  ipcMain.handle('settings:refreshPointer', async () => { refreshPointerMapping(); return true; });
  // Tương thích旧界面：语义已改là “按Cài đặt重新同步」
  ipcMain.handle('settings:unhook', async () => { refreshPointerMapping(); return true; });

  // ---------------- Máy nàyKiểm tra sức khỏe / Tự cấu hình ----------------
  // 探测能Tự động做của（Bộ nhớ、nhân心、画质、渲染后端）就Tự động做；
  // 必须管理员权限của（开 Windows 功能、装 AEHD）给按钮；只能进 BIOS của说清楚怎么改。

  ipcMain.handle('preflight:run', async () => {
    const preflight = require('./core/preflight');
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* Bộ chạy还没部署 */ }
    const hw = await preflight.collect({ accel });
    const edition = store.STORE_BUILD ? 'store' : 'installer';
    const report = preflight.evaluate({ hw, settings: store.getSettings(), edition });
    return { ok: true, hw, report, edition };
  });

  /**
   * Áp dụngKiểm tra sức khỏe推荐：写Cài đặt + 把这台机器của补丁落成一份Trình điều khiển。
   * 只写 preflight 明确列出của几cái安全mục（Bộ nhớ / nhân心 / 画质 / 渲染后端 / 是否锁Giả lập phần mềm）。
   */
  ipcMain.handle('preflight:apply', async () => {
    const preflight = require('./core/preflight');
    const drv = require('./core/drivers');
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* ignore */ }
    const hw = await preflight.collect({ accel });
    const edition = store.STORE_BUILD ? 'store' : 'installer';
    const report = preflight.evaluate({ hw, settings: store.getSettings(), edition });
    const patch = sanitizeResourcePatch(report.patch);
    const next = store.saveSettings(patch);

    // 把这台机器của参数固化成Trình điều khiển：以后每次开机都按它来，不Dùng重复Kiểm tra sức khỏe。
    // 校验一遍再落盘 —— Kiểm tra sức khỏe生成của内容同样不能绕过白名单。
    let driverFile = '';
    let driverError = '';
    try {
      const v = drv.validateDriver(report.driver);
      if (!v.ok) throw new Error(v.errors.join('；'));
      const dir = drv.userDir(store);
      fs.mkdirSync(dir, { recursive: true });
      driverFile = path.join(dir, `${v.driver.id}.json`);
      fs.writeFileSync(driverFile, `${JSON.stringify(report.driver, null, 2)}\n`, 'utf8');
      const prev = (next.drivers && next.drivers.state) || {};
      store.saveSettings({ drivers: { state: { ...prev, [v.driver.id]: true } } });
    } catch (e) {
      driverError = e.message;
    }

    appLog(`Cấu hình tự động theo kiểm tra:${JSON.stringify(patch.engine)} driver=${driverFile || '(Chưa ghi)'}`);
    return {
      ok: true,
      settings: store.getSettings(),
      driverFile,
      driverError,
      summary: report.summary,
      recommended: report.recommended,
    };
  });

  // ---------------- Trình điều khiển（Bản vá tương thích） ----------------
  // 一cáiTrình điều khiển就是一份 JSON：声明「匹配哪些机器」+「命中后改哪些启动参数」。
  // 这里只做「读目录 / 校验 / 匹配 / 导入 / 导出模板 / 开关」，Không chạy bất kỳ mã nào。

  /** 组装当前机器画像 + 全部Trình điều khiển + 匹配结果（给Cài đặt页Dùng） */
  async function driverOverview() {
    const drv = require('./core/drivers');
    const doctor = require('./core/doctor');
    const os = require('os');
    const s = store.getSettings();
    const disabled = (s.drivers && s.drivers.disabled) || [];
    const state = (s.drivers && s.drivers.state) || {};
    let accel = { ok: false, kind: 'none' };
    try { accel = await runtime.provisioner.emulatorAccel(); } catch (_) { /* 没装Bộ chạy */ }
    let emulatorVersion = '';
    try { emulatorVersion = (await runtime.provisioner.emulatorVersion()).version || ''; } catch (_) { /* ignore */ }
    let osBuild = 0;
    try {
      const m = /(\d+)\s*$/.exec(os.release() || '');
      osBuild = m ? Number(m[1]) : 0;
    } catch (_) { /* ignore */ }
    const host = drv.hostContext({
      info: { ...doctor.hostInfo(), cpuVendor: (os.cpus() || [])[0]?.model || '' },
      gpuVendor: doctor.detectGpuVendor(),
      osBuild,
      accel: accel && accel.ok ? (accel.kind || 'whpx') : 'none',
      emulatorVersion,
    });
    const dirs = { user: drv.userDir(store), bundled: drv.bundledDir(APP_ROOT) };
    const loaded = drv.loadAll([dirs.bundled, dirs.user]);
    const resolved = drv.resolve({ drivers: loaded.drivers, host, state, disabled });
    const hit = new Map(resolved.applied.map((d) => [d.id, d]));
    return {
      host,
      dirs,
      errors: loaded.errors,
      effect: resolved.effect,
      drivers: loaded.drivers.map((d) => {
        const forced = typeof state[d.id] === 'boolean' ? state[d.id] : null;
        return {
          id: d.id,
          name: d.name,
          version: d.version,
          author: d.author,
          description: d.description,
          priority: d.priority,
          builtin: d.dir === dirs.bundled,
          file: d.file,
          enabled: forced !== null ? forced : d.enabled !== false,
          matched: hit.has(d.id),
          hits: (hit.get(d.id) || {}).hits || [],
        };
      }),
    };
  }

  ipcMain.handle('drivers:list', () => driverOverview());

  ipcMain.handle('drivers:openFolder', async () => {
    const dir = require('./core/drivers').userDir(store);
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return { ok: true, dir };
  });

  ipcMain.handle('drivers:import', async () => {
    const drv = require('./core/drivers');
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn tệp trình điều khiển (.json)',
      filters: [{ name: 'Trình điều khiển JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const out = drv.importDriver(r.filePaths[0], drv.userDir(store));
    if (out.ok) {
      // 导入即启Dùng: dùng户特意导入của补丁，默认应该立刻生效
      const s = store.getSettings();
      store.saveSettings({ drivers: { state: { ...(s.drivers.state || {}), [out.driver.id]: true } } });
      send('runtime:log', `Đã nhập trình điều khiển:${out.driver.name} v${out.driver.version}`);
    }
    return { ...out, overview: await driverOverview() };
  });

  ipcMain.handle('drivers:exportTemplate', async () => {
    const drv = require('./core/drivers');
    const overview = await driverOverview();
    const tpl = drv.templateFromHost(overview.host);
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Xuất mẫu trình điều khiển của máy này',
      defaultPath: path.join(drv.userDir(store), `${tpl.id}.json`),
      filters: [{ name: 'Trình điều khiển JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.mkdirSync(path.dirname(r.filePath), { recursive: true });
    fs.writeFileSync(r.filePath, `${JSON.stringify(tpl, null, 2)}\n`, 'utf8');
    return { ok: true, file: r.filePath, template: tpl };
  });

  ipcMain.handle('drivers:setEnabled', async (_e, { id, enabled } = {}) => {
    const did = String(id || '');
    if (!did) return { ok: false, error: 'Thiếu trình điều khiển id' };
    const s = store.getSettings();
    const prev = (s.drivers && s.drivers.state) || {};
    store.saveSettings({ drivers: { state: { ...prev, [did]: !!enabled } } });
    return { ok: true, overview: await driverOverview() };
  });

  ipcMain.handle('runtime:status', async () => runtime.status());
  ipcMain.handle('runtime:probe', async () => runtime.probe());
  ipcMain.handle('runtime:start', async () => {
    const r = await runtime.ensure({ onLog: (m) => send('runtime:log', m) });
    return r.ok ? { ok: true, engine: r.engine } : { ok: false, error: r.error, needsSetup: r.needsSetup };
  });
  ipcMain.handle('runtime:stop', async () => {
    await runtime.stop();
    return { ok: true };
  });
  ipcMain.handle('runtime:log', () => runtime.bootLog);

  // ---------------- Chẩn đoán / 瘦身 ----------------

  ipcMain.handle('doctor:profile', async () => {
    const doctor = require('./core/doctor');
    // 已经开机就Dùng实跑参数；没开机也要按「真实Engine版本 + 真实Tăng tốc状态」推导，
    // 否则Cài đặt页会显示已弃Dùngcủa swiftshader_indirect / Giả lập phần mềm，和实跑不一致。
    let p = runtime.emulator.profile;
    if (!p) {
      const env = await runtime.provisioner.checkEnv();
      p = doctor.autoProfile({
        settings: store.getSettings(),
        accel: env.accel,
        emulatorVersion: env.emulator.version || '',
        diskMB: doctor.freeDiskMB(store.DATA_DIR),
      });
    }
    return { profile: p, text: doctor.describeProfile(p) };
  });

  ipcMain.handle('doctor:report', async () => {
    const r = await runtime.diagnostics();
    shell.showItemInFolder(r.file);
    return r;
  });

  /**
   * 系统问题Tự động校验：启动前/Đang chạyTự động检查常见导致「装不上、起不来」của根因，
   * 并给出可操作củaSửa建议（在首页横幅 + Cài đặt面板里展示，按问题一键Sửa）。
   */
  ipcMain.handle('doctor:selfCheck', async () => {
    const doctor = require('./core/doctor');
    const issues = [];
    // 这两cái值在 try 内赋值、在 try 外返回，必须在作Dùng域外声明
    let accel = { ok: false };
    let free = 0;
    try {
      if (!doctor.vcRedistOk()) {
        issues.push({
          code: 'vcRedist', severity: 'error', title: 'Thiếu thư viện VC++ (x64)',
          hint: 'Bộ chạy Android cần Microsoft VC++ 2015-2022; thiếu sẽ khiến trình giả lập không khởi động được (0xc0000135).', fix: 'vcRedist',
        });
      }
      accel = await runtime.provisioner.emulatorAccel().catch(() => ({ ok: false }));
      if (!accel.ok) {
        // 商店版和Cài đặt版của补救Đường dẫn完全不同，提示必须分开写：
        //   - 商店（MSIX）版不能装内nhânTrình điều khiển、也通常拿不到管理员授权 → 只能引导Dùng户
        //     自己去「启Dùng或Đóng Windows 功能」里勾「Windows 虚拟机监控程序平台」；
        //   - Cài đặt版/便携版可以一键提权开启（Thất bại还能退 AEHD Trình điều khiển）。
        // 以前两种版本TổngDùng一句话，商店Dùng户看到của是「建议Cài đặt AEHD Trình điều khiển」——
        // 而商店版根本装不了Trình điều khiển，等于指了一条死路。
        issues.push(store.STORE_BUILD
          ? {
            code: 'accel',
            severity: 'error',
            title: 'Cần bật “Windows Hypervisor Platform”',
            hint: 'Không có nó thì chỉ chạy được giả lập phần mềm thuần, khởi động chậm đến vài phút.'
              + MSIX_ACCEL_HINT
              + '(bản Store không thể nâng quyền thay bạn, cần bạn thao tác thủ công một lần, sau đó khởi động lại.)',
            fix: 'virtualization',
          }
          : {
            code: 'accel',
            severity: 'warn',
            title: 'Chưa bật tăng tốc phần cứng',
            hint: `${accel.note || 'Sẽ quay về trình giả lập phần mềm (chạy được nhưng rất chậm).'}`
              + 'Bấm “Sửa” bên phải sẽ tự bật (cần quyền quản trị, có thể phải khởi động lại một lần);'
              + 'Nếu thất bại sẽ tự động cài lại trình điều khiển AEHD.',
            fix: 'virtualization',
          });
      }
      free = doctor.freeDiskMB(runtime.provisioner.paths().root);
      if (free && free < 8192) {
        issues.push({
          code: 'disk', severity: free < 2048 ? 'error' : 'warn', title: 'Dung lượng ổ đĩa của bộ chạy sắp hết',
          hint: `「${runtime.provisioner.paths().root}” nằm trên ổ chỉ còn ${free} MB, vì nó sẽ hiện ra trên ứng dụng đang chạy`, fix: 'disk',
        });
      }
      const rtDir = runtime.provisioner.paths().root;
      if (!doctor.isAsciiPath(rtDir)) {
        issues.push({
          code: 'pathRuntime', severity: 'warn', title: 'Thư mục bộ chạy chứa tiếng Trung/ký tự đặc biệt',
          hint: 'Một số thành phần bộ chạy nhạy với đường dẫn tiếng Trung, có thể làm khởi động lỗi. Nên chuyển sang thư mục chỉ có chữ Latin.', fix: 'path',
        });
      }
      const env = await runtime.provisioner.checkEnv().catch(() => ({}));
      if (!env.adb || !env.adb.ok) {
        issues.push({ code: 'adb', severity: 'error', title: 'adb Thiếu bộ công cụ', hint: 'Không thể kết nối bộ chạy Android.', fix: 'deploy' });
      }
      if (!env.emulator || !env.emulator.ok) {
        issues.push({ code: 'emulator', severity: 'error', title: 'Chưa cài lõi bộ chạy', hint: 'Cần triển khai lõi bộ chạy trước (khoảng 440MB).', fix: 'deploy' });
      }
      if (!env.sysimg || !env.sysimg.ok) {
        issues.push({ code: 'sysimg', severity: 'warn', title: 'Ảnh hệ thống chưa sẵn sàng', hint: 'Cần tải ảnh hệ thống Android trước (khoảng 1.5GB).', fix: 'deploy' });
      }
      // 残留锁文件：会让下一次启动被判定là “AVD 已被占Dùng」而 FATAL
      const avdHome = runtime.provisioner.paths().avdHome;
      let locked = false;
      try { for (const f of fs.readdirSync(avdHome)) { if (/\.lock$/i.test(f)) { locked = true; break; } } } catch (_) { /* ignore */ }
      if (locked) {
        issues.push({ code: 'lock', severity: 'warn', title: 'Phát hiện tệp khóa còn sót từ lần trước', hint: 'Có thể khiến lần khởi động sau bị coi là “AVD đang bị chiếm dụng”.', fix: 'lock' });
      }
    } catch (_) { /* 自检Thất bại不阻断使Dùng */ }
    return { issues, accel, free };
  });

  // 微软 VC++ 2015-2022 x64 运行库：安卓模拟器（Qt6）与 qemu 都依赖它。
  // Thiếu了在「其他电脑」上会直接起不来（0xc0000135 / MSVCP140 Thiếu失）。
  function vcRedistInstaller() {
    const p = runtime.provisioner.paths();
    const cands = [
      path.join(p.root, 'vc_redist.x64.exe'),
      path.join(process.resourcesPath || '', 'runtime', 'vc_redist.x64.exe'),
    ];
    return cands.find((c) => c && fs.existsSync(c)) || null;
  }
  ipcMain.handle('runtime:vcRedist', () => {
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk(), path: vcRedistInstaller() };
  });
  ipcMain.handle('runtime:installVcRedist', async () => {
    const file = vcRedistInstaller();
    if (!file) return { ok: false, reason: 'no-installer' };
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
      // Dùng RunAs 提权Cài đặt（VC++ 是系统级组件，Cần管理员）；/quiet 静默 /norestart 不重启
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
        `Start-Process -FilePath "${file}" -ArgumentList '/quiet','/norestart' -Verb RunAs -Wait`],
      { windowsHide: true, stdio: 'ignore' });
      ps.on('exit', () => resolve());
      ps.on('error', () => resolve());
    });
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk() };
  });

  ipcMain.handle('runtime:usage', () => runtime.usage());

  // 通DùngXác nhận框（渲染层统一走这里，避免各处自己拼 dialog 文案）
  ipcMain.handle('app:confirm', async (_e, opts = {}) => {
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: opts.type || 'question',
      title: opts.title || 'Xác nhận',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: ['Hủy', opts.okLabel || 'OK'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return { response };
  });

  /**
   * 资源分配总览：宿主上限、当前分配、数据盘余量。
   * 由Bộ chạy自己của resources() 回答，界面只认这cái结构。
   */
  ipcMain.handle('engine:resources', async () => {
    try {
      const backend = runtime.backend;
      if (backend && typeof backend.resources === 'function') return await backend.resources();
      return { backend: backend ? backend.id : '', ok: false, note: 'Bộ chạy chưa sẵn sàng, tạm thời chưa đọc được phân bổ tài nguyên' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * 就地扩容做不到时（quickboot 差量盘）走这条：按Mục tiêu容量重建 /data。
   * 会清TrốngỨng dụng đã cài与存档 —— 调Dùng方必须已经让Dùng户明确Xác nhận过。
   */
  ipcMain.handle('runtime:resetAndResize', async (_e, gb) => {
    const res = require('./core/resources');
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(runtime.provisioner.paths().root);
    const want = res.clampDataGB(gb, freeMB).gb;
    if (!want) return { ok: false, error: 'Dung lượng mục tiêu không hợp lệ' };
    store.saveSettings({ engine: { dataPartitionGB: want } });
    await runtime.stop().catch(() => {});
    const r = await runtime.resetAndroidData().catch((e) => ({ ok: false, error: e.message }));
    appLog(`reset+resize -> ${want}GB: ${JSON.stringify(r)}`);
    return { ok: !!(r && r.ok), wantGB: want, ...r };
  });

  // 数据Phân vùng（/data）容量：Áp dụng、游戏与它们của更新包都装在这里。
  // 「游戏更新提示Không đủ dung lượng」几乎都是这一mục太Nhỏ，扩容是就地做của，不丢数据。
  ipcMain.handle('runtime:dataInfo', () => {
    const doctor = require('./core/doctor');
    const b = runtime.backend;
    const info = (b && typeof b.dataInfo === 'function') ? (b.dataInfo() || {}) : {};
    const freeDiskMB = Number(info.freeMB) || Number(info.freeDiskMB)
      || doctor.freeDiskMB(runtime.provisioner.paths().root);
    return { ...info, freeDiskMB };
  });

  ipcMain.handle('runtime:setDataSize', async (_e, gb) => {
    const res = require('./core/resources');
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(runtime.provisioner.paths().root);
    const clamped = res.clampDataGB(gb, freeMB);
    const want = clamped.gb;
    store.saveSettings({ engine: { dataPartitionGB: want } });
    if (!want) {
      const info = runtime.emulator.dataInfo();
      return { ok: true, auto: true, ...info };
    }
    const mb = Math.round(want * 1024);
    // 镜像正被 qemu 占着时不能改，先停容器（Áp dụng会跟着Thoát，属于预期）
    let stopped = false;
    try {
      const online = await runtime.client().isOnline().catch(() => false);
      if (runtime.emulator.running() || online) {
        await runtime.stop().catch(() => {});
        stopped = true;
      }
    } catch (_) { /* ignore */ }
    try {
      const r = runtime.emulator.resizeDataPartition(mb);
      appLog(`data partition -> ${want}GB: ${JSON.stringify(r)}`);
      if (r && r.ok) notify('Đã điều chỉnh phân vùng dữ liệu', `Dung lượng trống của Android khoảng ${want} GB${stopped ? '(bộ chạy đã khởi động lại)' : ''}`);
      return { ok: !!(r && r.ok), stopped, ...r, ...runtime.emulator.dataInfo() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:cleanup', async (_e, opts = {}) => {
    // 明确两次Xác nhận：先给清单，Dùng户Xác nhận后才真正删；且只Dọn dẹp ApkStart 自己củaBộ chạy目录
    const pass = { apply: false, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots };
    if (!opts.apply) return runtime.cleanup(pass);
    const preview = await runtime.cleanup(pass);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Hủy', `Dọn dẹp ${preview.candidates.length} mục`],
      defaultId: 0,
      cancelId: 0,
      title: 'Xác nhận dọn bộ nhớ đệm của bộ chạy',
      message: `Sẽ giải phóng khoảng ${(preview.candidates.reduce((n, c) => n + c.size, 0) / 1048576).toFixed(0)} MB`,
      detail: (opts.includeSnapshots
        ? 'Sẽ dừng bộ chạy trước, rồi xóa ảnh hệ thống cũ, snapshot khởi động nhanh của AVD hiện tại, tệp khóa và bộ nhớ đệm của các AVD không hoạt động. Bản thân các ứng dụng đã cài được giữ lại (chỉ xóa snapshot),'
        : 'Chỉ xóa ảnh hệ thống cũ, snapshot cũ, tệp khóa và bộ nhớ đệm của AVD không hoạt động; ứng dụng đã cài được giữ lại.')
        + 'Thao tác này không thể hoàn tác, nên xuất báo cáo chẩn đoán trước.',
    });
    if (response !== 1) return { ...preview, cancelled: true };
    return runtime.cleanup({ apply: true, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots });
  });

  // 彻底Đặt lại dữ liệu Android：清Trống /data Dùng户Phân vùng + Ứng dụng đã cài + 快速启动快照，
  // AVD 还原成「刚装好系统」của干净状态。会真实Xóa数 GB 数据，UI 必须二次Xác nhận。
  ipcMain.handle('runtime:resetData', async () => {
    try {
      const r = await runtime.resetAndroidData();
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, reclaimed: r.reclaimed, reclaimedMB: Math.round(r.reclaimed / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Sửa虚拟机网络：重置 /data（保留Áp dụng清单，点开Áp dụng会Tự động重装）。
  // 典型场景：安卓里所Có联网页面一直黑屏，其实是 wlan0 没起来、没Có默认路由。
  ipcMain.handle('runtime:repairNetwork', async () => {
    try {
      const r = await runtime.repairNetwork({
        onLog: (m) => send('toast', { message: m, kind: 'info', timeout: 6000 }),
      });
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 只做网络Kiểm tra sức khỏe，不动任何数据（Cài đặt页Dùng来显示当前状态）
  ipcMain.handle('runtime:checkNetwork', async () => {
    try {
      const network = await runtime.emulator.checkNetwork(runtime.adbPath());
      return { ok: !!network.ok, network };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- 旧版本残留 ----------------

  /** 只扫描、不Xóa：先把「能Tìm thấy什么」原样给界面，由Dùng户决定 */
  ipcMain.handle('leftovers:scan', () => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const dataDir = store.DATA_DIR;
      let avdHome = '';
      try { avdHome = runtime.provisioner.paths().avdHome; } catch (_) { avdHome = ''; }
      return { ok: true, ...leftovers.scan({ installDir, dataDir, avdHome }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('leftovers:clean', (_e, items) => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const r = leftovers.clean(Array.isArray(items) ? items : [], { installDir });
      appLog(`leftovers cleaned: ${r.removed.length} removed, ${r.failed.length} failed`);
      return { ok: true, ...r, freedMB: Math.round(r.freedBytes / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Bộ chạy自举 ----------------

  ipcMain.handle('provision:installEmulator', async () => {
    try {
      const r = await runtime.provisioner.installEmulator(
        (p) => send('provision:progress', { ...p, component: 'emulator' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installSysimg', async () => {
    try {
      const r = await runtime.provisioner.installSystemImage(
        (p) => send('provision:progress', { ...p, component: 'sysimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installPlayImage', async () => {
    try {
      const r = await runtime.provisioner.installPlayImage(
        (p) => send('provision:progress', { ...p, component: 'playimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAehd', async () => {
    try {
      const r = await runtime.provisioner.installAehd(
        (p) => send('provision:progress', { ...p, component: 'aehd' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** 提权Cài đặt AEHD Trình điều khiển：弹出 UAC，Dùng户Xác nhận后静默Cài đặt */
  ipcMain.handle('provision:enableAccel', async () => {
    try {
      const p = runtime.provisioner.paths();
      const bat = path.join(p.aehdDir, 'silent_install.bat');
      if (!fs.existsSync(bat)) {
        const r = await runtime.provisioner.installAehd(
          (x) => send('provision:progress', { ...x, component: 'aehd' }),
        );
        if (!fs.existsSync(bat)) throw new Error(r.error || 'AEHD Gói trình điều khiển chưa sẵn sàng');
      }

      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          windowsHide: true,
        });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Đã hủy cấp quyền quản trị (cần bấm “Có” mới cài được trình điều khiển)' : `Cài trình điều khiển thất bại (mã thoát ${code}）`,
        ))));
        proc.on('error', (e) => reject(e));
      });

      const accel = await runtime.provisioner.emulatorAccel();
      return { ok: accel.ok, accel, error: accel.ok ? '' : accel.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Tự động开启虚拟化: dùng户无需手动去「Windows 功能」面板。
   * 优先启Dùng系统自带của「虚拟机平台」（WHPX）功能；若该 DLL 都Không tồn tại（老系统），
   * 退而Cài đặt并启Dùng Google của AEHD Trình điều khiển。两种方式都Cần管理员提权。
   */
  ipcMain.handle('provision:enableVirtualization', async () => {
    try {
      const accel = await runtime.provisioner.emulatorAccel();
      if (accel.ok) return { ok: true, already: true, accel, note: 'Tăng tốc phần cứng đã dùng được, không cần thao tác thêm' };

      // ---------------- 商店（MSIX）版：只能走系统自带của WHPX ----------------
      // MSIX 包由 AppX 部署模型拉起，固定 mediumIL，既不能装内nhânTrình điều khiển（AEHD），
      // 通常也拿不到管理员授权。所以这里只尝试 WHPX，拿不到就退回「手动开启」
      // của引导 —— 以前của实现直接Dùng Start-Process -Verb RunAs，商店Dùng户点了
      // 注定Thất bại，横幅上của「Chưa bật tăng tốc phần cứng」永远消不掉。
      if (store.STORE_BUILD) {
        const whpx = await enableWhpxFeatures();
        runtime.provisioner.invalidateEnvCache?.();
        if (whpx.ok) {
          return {
            ok: true, restartNeeded: true, steps: whpx.steps,
            accel: await runtime.provisioner.emulatorAccel().catch(() => accel),
            note: 'Đã yêu cầu bật “Nền tảng Hypervisor của Windows”, tăng tốc phần cứng chỉ có hiệu lực sau khi khởi động lại máy',
          };
        }
        return {
          ok: false,
          manual: true,
          settingsUri: 'ms-settings:optionalfeatures',
          steps: whpx.steps,
          accel,
          note: MSIX_ACCEL_HINT,
        };
      }

      // ---------------- Cài đặt版 / 便携版 ----------------
      // Thử trước WHPX（系统自带，无需下载）；Thất bại（Dùng户点了否 / 系统Không hỗ trợ）再退 AEHD Trình điều khiển。
      // AEHD Cần联网拿Trình điều khiển包，所以放在后面。
      const whpx = await enableWhpxFeatures();
      runtime.provisioner.invalidateEnvCache?.();
      if (whpx.ok) {
        return {
          ok: true, restartNeeded: true, steps: whpx.steps,
          accel: await runtime.provisioner.emulatorAccel().catch(() => accel),
          note: whpx.steps.some((s) => s.cancelled)
            ? 'Đã bật “Nền tảng Hypervisor của Windows”, có hiệu lực sau khi khởi động lại máy'
            : 'Đã bật “Nền tảng Hypervisor của Windows”, có hiệu lực sau khi khởi động lại máy',
        };
      }
      if (whpx.cancelled) {
        return {
          ok: false,
          cancelled: true,
          error: 'Bạn đã hủy cấp quyền quản trị, tăng tốc phần cứng không thay đổi. Có thể bấm “Sửa” lại, hoặc tự bật “Windows Hypervisor Platform”.',
        };
      }

      // WHPX 开不起来：改Dùng Google của AEHD Trình điều khiển（装完即Dùng，不Dùng重启）
      const ae = await runtime.provisioner.installAehd(
        (x) => send('provision:progress', { ...x, component: 'aehd' }),
      ).catch((e) => ({ ok: false, error: e.message }));
      if (!ae.ok) return { ok: false, error: ae.error || 'AEHD Chuẩn bị gói trình điều khiển thất bại' };
      const bat = path.join(runtime.provisioner.paths().aehdDir, 'silent_install.bat');
      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Đã hủy cấp quyền quản trị (cần bấm “Có” mới cài được trình điều khiển)' : `Cài trình điều khiển thất bại (mã thoát ${code}）`,
        ))));
        proc.on('error', (e) => reject(e));
      });
      runtime.provisioner.invalidateEnvCache?.();
      const after = await runtime.provisioner.emulatorAccel();
      return { ok: after.ok, accel: after, note: after.ok ? 'AEHD Đã bật tăng tốc phần cứng' : after.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAdb', async () => {
    try {
      const r = await runtime.provisioner.installAdb((p) => send('provision:progress', { ...p, component: 'adb' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installQemu', async () => {
    try {
      const r = await runtime.provisioner.installQemu((p) => send('provision:progress', { ...p, component: 'qemu' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:downloadIso', async () => {
    try {
      const r = await runtime.provisioner.downloadIso((p) => send('provision:progress', { ...p, component: 'iso' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:createDisk', async (_e, sizeGB) => {
    try {
      const r = await runtime.provisioner.createDisk(sizeGB || store.getSettings().runtime.diskSizeGB || 24,
        (p) => send('provision:progress', { ...p, component: 'disk' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importIso', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn ảnh hệ thống Android-x86 / Bliss OS',
      filters: [{ name: 'Ảnh hệ thống', extensions: ['iso', 'img'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      return { ok: true, ...runtime.provisioner.importIso(r.filePaths[0]) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importDisk', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn ổ đĩa ảo đã cài Android',
      filters: [{ name: 'Ổ đĩa ảo', extensions: ['qcow2', 'img', 'vmdk', 'raw'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      const info = runtime.provisioner.importDisk(r.filePaths[0]);
      store.saveSettings({ runtime: { installed: true } });
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:check', async () => runtime.provisioner.checkEnv());
  ipcMain.handle('provision:probeSources', async () => runtime.provisioner.probeSources());

  ipcMain.handle('runtime:startInstaller', async () => {
    try {
      await runtime.startInstaller({ onLog: (m) => send('runtime:log', m) });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:markInstalled', async () => {
    await runtime.markInstalled();
    return { ok: true };
  });

  ipcMain.handle('runtime:resetInstall', async () => {
    store.saveSettings({ runtime: { installed: false } });
    return { ok: true };
  });

  ipcMain.handle('assoc:status', () => {
    // 冒烟/无 shell 环境：不探测注册表（reg.exe 可能被策略拦截）
    if (NO_SHELL_PROBE) return { registered: false, skipped: true };
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\.apk', '/ve'], { windowsHide: true, encoding: 'utf8' });
      return { registered: out.includes(assoc.PROGID) };
    } catch (_) {
      return { registered: false };
    }
  });

  ipcMain.handle('assoc:register', () => {
    const l = launcherInfo();
    const icoPath = path.join(store.ICON_DIR, 'apkstart.ico');
    if (!fs.existsSync(icoPath)) {
      // 优先Dùng随包分发của多尺寸品牌 ICO，Thiếu失时从 Logo PNG 现算
      if (fs.existsSync(APPICON_FILE)) fs.copyFileSync(APPICON_FILE, icoPath);
      else {
        const { pngToIco } = require('./core/shortcut');
        const ico = pngToIco(ICON_PNG);
        if (ico) fs.writeFileSync(icoPath, ico);
      }
    }
    return assoc.registerAssociation(l.target, icoPath, l.args);
  });

  ipcMain.handle('assoc:unregister', () => assoc.unregisterAssociation());

  ipcMain.handle('share:sync', async () => sharer.sync({ onLog: (m) => send('runtime:log', m) }));
  ipcMain.handle('share:open', async () => {
    const dir = store.getSettings().sharedDir;
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });

  /** Dọn dẹpLần trước残留của AVD 锁文件：会让下次启动被误判là “AVD 已被占Dùng」而 FATAL */
  ipcMain.handle('app:clearLocks', async () => {
    try {
      const avdHome = runtime.provisioner.paths().avdHome;
      let removed = 0;
      for (const f of fs.readdirSync(avdHome)) {
        if (/\.lock$/i.test(f)) {
          try { fs.rmSync(path.join(avdHome, f), { force: true }); removed++; } catch (_) { /* ignore */ }
        }
      }
      return { ok: true, removed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Gỡ cài đặt một chạm ApkStart 本体：
   * 1) 先Hủy .apk 文件关联（避免Gỡ cài đặt后双击 APK 指向已Xóacủa程序）
   * 2) Cài đặt版：启动 NSIS Gỡ cài đặt程序（它会自行请求管理员/Xác nhận），随后Thoát本程序
   * 3) 便携版（旁加载 / 免Cài đặt）：没Có uninstaller.exe，返回提示让Dùng户手动Xóa程序与数据目录
   */
  ipcMain.handle('app:removeSelf', async () => {
    try {
      try { await assoc.unregisterAssociation(); } catch (_) { /* Hủy关联Thất bại不影响Gỡ cài đặt */ }
      const exeDir = path.dirname(process.execPath);
      // 和 updater.flavor Dùng同一套识别规则：electron-builder 生成của是
      // "Uninstall ApkStart.exe"，旧代码只找 "uninstaller.exe"，
      // 导致Cài đặt版点「Gỡ cài đặt một chạm」被误判成便携版、只弹提示不真Gỡ cài đặt（issue #51）。
      const unName = findUninstaller(exeDir);
      if (!unName) {
        return { ok: true, portable: true, dataDir: store.DATA_DIR, exeDir };
      }
      const uninstaller = path.join(exeDir, unName);
      const { spawn } = require('child_process');
      // Gỡ cài đặt前先收掉常驻của模拟器：qemu 会锁住 resources\runtime trong exe/dll，
      // NSIS 删不掉就会留下半cáiCài đặt目录。这里只针对「真của在Gỡ cài đặt」，不影响日常Thoát。
      try { await runtime?.emulator?.killOrphanProcesses(); } catch (_) { /* ignore */ }
      // 先让本程序Thoát，再由一cái独立进程延迟 2 秒拉起Gỡ cài đặt器：
      // Đang chạycủa exe 会锁住Cài đặt目录trong文件，直接拉起Gỡ cài đặt器容易删不干净。
      const cmd = `ping 127.0.0.1 -n 3 >nul & start "" "${uninstaller}"`;
      spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setTimeout(() => app.quit(), 300);
      return { ok: true, portable: false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));

  /**
   * Mở「启Dùng或Đóng Windows 功能」对话框。
   *
   * 为什么不Dùng ms-settings:optionalfeatures：Win11 那cái页面是「可Chọn功能」列表，
   * 里面**没Có**「Windows 虚拟机监控程序平台」，Dùng户会白找一圈。经典对话框
   * optionalfeatures.exe 才Có那一mục（WHPX 真正Cầncủa功能）。
   * Mở它本身不Cần管理员权限，点「OK」时才 UAC。
   */
  ipcMain.handle('provision:openWindowsFeatures', () => {
    try {
      const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'optionalfeatures.exe');
      const { spawn } = require('child_process');
      spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    } catch (e) {
      // 极少见：被组策略挡住 / 文件Thiếu失。退到Cài đặt页，至少给Dùng户一cái入口
      shell.openExternal('ms-settings:optionalfeatures').catch(() => {});
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:hide', () => mainWindow?.hide());

  // ---------------- Cửa sổ ứng dụng（只Có 旋转 / Thu nhỏ / Phóng to / Đóng） ----------------

  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle('shell:state', () => ({ ...appWin.state, iconUrl: appWin.iconUrl || '' }));
  // 独立窗口模式下画面在模拟器原生窗口里，壳窗口是隐藏của —— 按钮必须作Dùng到真正
  // 可见của那一扇。统一交给 appWin 判断模式处理，避免对隐藏窗口 maximize/minimize。
  ipcMain.handle('shell:minimize', () => appWin.minimize());
  ipcMain.handle('shell:maximize', () => appWin.toggleMaximize());
  // Đóng必须走 appWin.close()：它会先把模拟器窗口从宿主上摘下来、再停掉Ứng dụng Android。
  // 老实现直接 win.close()，绕过了这段收尾 —— 窗口是没了，但安卓侧của进程还在跑，
  // 就是Dùng户说của「点Đóng关不掉Áp dụng」。
  ipcMain.handle('shell:close', () => {
    if (appWin && appWin.isOpen) { appWin.close(); return { ok: true }; }
    return { ok: false };
  });
  // 标题栏của旋转按钮 = 「这 ứng dụng我要横着/竖着Dùng」。
  // 以前它只是把全局 landscape 翻一下，于是点红果của旋转按钮会把**所Có**Áp dụng
  // 都带到Bảng màn ngang上去，红果自己反而被信箱化。Hiện写成该Áp dụng自己của覆盖值，
  // 别củaÁp dụng不受影响（Cài đặttrong「强制」模式仍然优先）。
  ipcMain.handle('shell:rotate', () => {
    const pkg = appWin && appWin.pkg;
    // 以「面板实际方向」为基准取反，而不是 appWin.state.landscape
    //（后者是「期望方向」，在启动切换面板của过程中可能还没落地）。
    const next = !displaySettings().landscape;
    if (pkg) {
      store.upsertApp({ package: pkg, orientationOverride: next ? 'landscape' : 'portrait' });
      appLog(`orientation override ${pkg} = ${next ? 'landscape' : 'portrait'}`);
    }
    return appWin.rotate(restartForOrientation);
  });

  ipcMain.handle('shell:back', async () => { await runtime.client().keyBack(); });
  ipcMain.handle('shell:forward', async () => { await runtime.client().keyForward(); });

  // ---------------- Cài đặt hệ thống Android (không cần vào màn hình chính Android) ----------------

  ipcMain.handle('android:status', async () => {
    try { return { ok: true, ...(await androidSet.status()) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:set', async (_e, { key, value }) => {
    try {
      switch (key) {
        case 'wifi': return { ok: true, ...(await androidSet.setWifi(!!value)) };
        case 'airplane': return { ok: true, ...(await androidSet.setAirplane(!!value)) };
        case 'volume': return { ok: true, ...(await androidSet.setVolume(value)) };
        case 'animations': return { ok: true, ...(await androidSet.setAnimations(!!value)) };
        case 'fontScale': return { ok: true, ...(await androidSet.setFontScale(value)) };
        case 'density': return { ok: true, ...(await androidSet.setDensity(value)) };
        default: return { ok: false, error: `Mục cài đặt không xác định ${key}` };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:open', async (_e, action) => {
    try { return { ok: true, ...(await androidSet.open(action)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:tune', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.tune({ pkg })) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:permissions', async (_e, pkg) => {
    try { return { ok: true, rows: await androidSet.permissions(pkg) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:grantAll', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.grantAll(pkg)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('app:foreground', () => {
    if (appWin && appWin.isOpen) { appWin.win.show(); appWin.win.focus(); return true; }
    return false;
  });

  // ---- 按键映射 ----
  ipcMain.handle('shell:keyEvent', async (_e, key) => {
    if (!keymapEngine || !keymapEngine.enabled) return false;
    const pkg = currentAppPkg;
    if (!pkg) return false;
    return keymapEngine.handleKey(key, pkg);
  });
  ipcMain.handle('keymap:getPresets', () => {
    return Object.entries(KEYMAP_PRESETS).map(([id, p]) => ({ id, label: p.label, desc: p.desc }));
  });
  ipcMain.handle('keymap:getMap', (_e, pkg) => keymapEngine ? keymapEngine.getMap(pkg) : []);
  ipcMain.handle('keymap:setMap', (_e, pkg, mappings) => {
    if (!keymapEngine) return { ok: false };
    keymapEngine.setMap(pkg, mappings);
    // 持久化到Cài đặt
    const maps = { ...(store.getSettings().engine.keymaps || {}) };
    if (mappings && mappings.length) maps[pkg] = mappings;
    else delete maps[pkg];
    store.saveSettings({ engine: { keymaps: maps } });
    return { ok: true };
  });
  ipcMain.handle('keymap:setEnabled', (_e, on) => {
    if (keymapEngine) keymapEngine.enable(!!on);
    store.saveSettings({ engine: { keymapEnabled: !!on } });
    return { ok: true };
  });
  ipcMain.handle('keymap:isEnabled', () => keymapEngine ? keymapEngine.enabled : false);
  ipcMain.handle('keymap:applyPreset', (_e, pkg, presetId) => {
    if (!keymapEngine || !KEYMAP_PRESETS[presetId]) return { ok: false };
    const mappings = KEYMAP_PRESETS[presetId].mappings;
    keymapEngine.setMap(pkg, mappings);
    const maps = { ...(store.getSettings().engine.keymaps || {}) };
    maps[pkg] = mappings;
    store.saveSettings({ engine: { keymaps: maps } });
    return { ok: true, mappings };
  });

  // ---------------- 在线更新 ----------------

  ipcMain.handle('app:updateCheck', async (_e, opts = {}) => {
    try {
      // Dùng户主动点「Kiểm tra cập nhật」→ 跳过缓存，必定重新问一次两cái源
      const info = await updater.check({ force: opts.force !== false });
      updateInfo = info;
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message, current: app.getVersion() };
    }
  });

  ipcMain.handle('app:updateOpen', (_e, url) => {
    // GitHub 和 Gitee của发布页都允许直接Mở：Kiểm tra cập nhậtThất bại时界面就是靠这cái
    // 让Dùng户手动去下载，只放行 github.com 会把国内Dùng户挡在门外。
    const raw = String(url || '');
    const ok = /^https:\/\/(github\.com|gitee\.com)\//i.test(raw);
    const target = ok ? raw : Updater.repoUrl();
    shell.openExternal(target).catch(() => {});
    return { ok: true, target };
  });

  ipcMain.handle('app:updateApply', () => runUpdate());

  ipcMain.handle('app:updateCancel', () => { updateBusy = false; return { ok: true }; });

  ipcMain.handle('app:restart', () => {
    setTimeout(() => { quitting = true; app.quit(); }, 200);
    return { ok: true };
  });
}

// ---------------- 生命周期 ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    const args = parseArgs(argv);
    if (args.launch) { runLaunch(args.launch); return; }
    if (args.apk) { runInstall(args.apk).catch(() => {}); return; }
    showWindow();
  });

  app.whenReady().then(async () => {
    store.ensureDirs();
    // Windows 任务栏身份（AppUserModelID）
    // 不设của话 Windows 只能按 exe Đường dẫn猜身份：任务栏固定mục、跳转列表、通知来源
    // 都会落到 "Electron" 上 —— Dùng户看到của就是「图标/名字是默认của那cái」。
    // 注意这里是「当前进程」của身份，切到某cáiỨng dụng Android时会换成那 ứng dụng自己của
    // AUMID（见 openAppWindow），否则任务栏固定mục和Đang chạycủa窗口对不上，
    // 固定mục显示của还是 ApkStart của图标。
    setAumid(APP_AUMID);
    runtime = new Runtime(APP_ROOT);
    // 启动即留一行痕迹：出问题时Dùng户把 app.log 发过来就能看到版本与数据目录
    appLog(`start v${app.getVersion()} data=${store.DATA_DIR} pid=${process.pid}`);

    // ---- 开机动画窗口 ----
    // 仿抖音 DSH 风格：Logo 渐显 + 进度条 + 状态文字。
    // 首次Cài đặt时额外显示配置步骤介绍；Không phải首次只显示精简动画。
    // 安卓环境Sẵn sàng后淡出Đóng，Áp dụng秒进。
    const isFirstRun = !store.getSettings().runtime.installed;
    try {
      // 屏幕居中
      const { screen: electronScreen } = require('electron');
      const disp = electronScreen.getPrimaryDisplay();
      const sw = disp.workAreaSize.width;
      const sh = disp.workAreaSize.height;
      const splashW = 480, splashH = 360;
      splashWin = new BrowserWindow({
        width: splashW, height: splashH,
        x: Math.round((sw - splashW) / 2),
        y: Math.round((sh - splashH) / 2),
        frame: false, transparent: false, resizable: false,
        alwaysOnTop: true, skipTaskbar: true,
        backgroundColor: '#0b0c0e',
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'splash-preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: false,
        },
      });
      // Dùng screen-saver 级别确保不被模拟器窗口盖住（之前 alwaysOnTop 默认 level
      // 和 agent của SetForegroundWindow 抢 z-order，导致 splash 被顶到后面）
      splashWin.setAlwaysOnTop(true, 'screen-saver');
      splashWin.loadFile(path.join(__dirname, 'ui', 'splash.html'));
      splashWin.once('ready-to-show', () => splashWin.show());
      // IPC：版本号、首次运行标记、Đóng
      ipcMain.handle('splash:version', () => app.getVersion());
      ipcMain.handle('splash:isFirstRun', () => isFirstRun);
      // 组件是否随包自带：开机动画据此换文案，别对已经内置镜像củaDùng户说「Đang tải xuống」
      ipcMain.handle('splash:bundled', () => !!bundledRuntimeDir);
      ipcMain.on('splash:close', () => {
        if (splashWin && !splashWin.isDestroyed()) splashWin.close();
        splashWin = null;
      });
    } catch (e) {
      appLog(`splash window failed: ${e.message}`);
      splashWin = null;
    }
    // 向 splash 推送进度 / Hoàn tất信号（模块级变量，见文件顶部说明）
    splashProgress = (p) => {
      if (splashWin && !splashWin.isDestroyed()) splashWin.webContents.send('splash:progress', p);
    };
    // 淡出信号只发一次；同时挂一cái「保险丝」：splash 自己 2.5 秒内没关掉
    // （渲染进程卡住 / IPC 丢失）就由主进程强关，绝不把启动画面留在Màn hình nền上。
    let splashDoneSent = false;
    splashDone = () => {
      if (splashDoneSent) return;
      splashDoneSent = true;
      if (!splashWin || splashWin.isDestroyed()) return;
      try { splashWin.webContents.send('splash:done'); } catch (_) { /* ignore */ }
      setTimeout(() => {
        try {
          if (splashWin && !splashWin.isDestroyed()) splashWin.close();
        } catch (_) { /* ignore */ }
        splashWin = null;
      }, 2500).unref?.();
    };
    // 兜底Hết thời gian：任何Đường dẫn都没触发 splashDone（Ví dụKhởi động thất bại卡住）也要收掉，
    // 否则 splash 会一直悬在屏幕中央 —— 这就是「多cái窗口」最刺眼của一幕。
    setTimeout(() => { if (!splashDoneSent) splashDone(); }, 180000).unref?.();

    const l = launcherInfo();
    installer = new Installer(runtime, {
      launcherTarget: l.target,
      launcherArgs: l.args,
      cwd: l.cwd,
      isDev: IS_DEV,
      desktopDir: app.getPath('desktop'),
      // Windows 搜索索引của是开始菜单trong .lnk，只放Màn hình nền会「搜不到Áp dụng」；
      // Linux 那边对应của是 freedesktop củaÁp dụng菜单目录。
      startMenuDir: process.platform === 'win32'
        ? path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
        : path.join(process.env.HOME || app.getPath('home'), '.local', 'share', 'applications'),
      decodeIcon,
    });
    sharer = new Sharer(runtime);
    androidSet = new AndroidSettings(runtime);

    // ---- 按键映射Engine ----
    const keymapEngine = new KeymapEngine({
      execInput: (cmd) => runtime.client().shell(cmd, { timeout: 4000 }),
      getSize: () => {
        // Dùng当前面板尺寸（Màn ngang 1280x720 / Màn dọc 720x1280）
        const land = !!(store.getSettings().display || {}).landscape;
        return land ? { width: 1280, height: 720 } : { width: 720, height: 1280 };
      },
    });
    // 从Cài đặt里加载每Áp dụngcủa映射表
    const savedMaps = (store.getSettings().engine || {}).keymaps || {};
    for (const [pkg, mappings] of Object.entries(savedMaps)) {
      if (Array.isArray(mappings) && mappings.length) keymapEngine.setMap(pkg, mappings);
    }
    // 默认启Dùng（Dùng户可在Cài đặt里关）
    keymapEngine.enable(store.getSettings().engine.keymapEnabled !== false);

    updater = new Updater({
      currentVersion: app.getVersion(),
      exePath: process.execPath,
      isPackaged: app.isPackaged,
      dataDir: store.DATA_DIR,
      // 让更新器能读到「只走 GitHub / 只走 Gitee / Tự độngChọn快」和镜像前缀Cài đặt
      settings: () => store.getSettings(),
      onProgress: (p) => send('update:progress', p),
    });

    // 滚轮合并器：一cái时间窗内của滚动只注入一条 input swipe，走常驻 adb shell。
    wheelRouter = new pointer.WheelRouter({
      getSize: getDeviceSize,
      inject: (cmd) => runtime.client().input(cmd),
    });

    // 窗口代理：只负责内嵌模拟器窗口。全局鼠标钩子只在Cửa sổ ứng dụng前台时按配置Cài đặt。
    winAgent = new WinAgent();
    appWin = new AppWindow({
      agent: winAgent,
      // 旋转要改 Android của逻辑分辨率，交给 adb 客户端做
      setOrientation: async (landscape) => {
        deviceSize.value = null;
        return runtime.client().setOrientation(landscape);
      },
      // 传 getter：Cài đặt页改了键位，下一次窗口 focus / Làm mới就生效，不Dùng重启
      pointerConfig: () => pointer.pointerOptions(store.getSettings()),
      // 画面窗口由窗口代理按进程作Dùng域自己找（自带 emulator của窗口就是我们拉起来của）
      windowTargets: () => null,
    });
    appWin.onCloseApp((pkg) => {
      // 关窗口 = 停这 ứng dụng；最后一cái窗口关掉时容器停放（降优先级、停轮询），
      // 但 Android 环境留着，下次点开是秒进而Không phải重新Khởi động nguội。
      runtime?.endApp(pkg, { onIdle: onContainerActive }).catch(() => {});
      // 外部Đóng（Alt+F4 / 任务栏Đóng）也要清当前Áp dụng标记，否则托盘菜单
      // 还显示「Đóng ứng dụng hiện tại (xxx）」但点了没反应（Áp dụng已经停了）。
      if (currentAppPkg === pkg) currentAppPkg = null;
      try { send('apps:changed'); } catch (_) { /* ignore */ }
    });

    // 「哪些窗口才算我们của」= Bộ chạy目录 + 随包của engine 目录。
    // 窗口代理只允许碰这些进程Tạocủa窗口 —— 别của Qt Áp dụng（微信 4.x 就是 Qt6，
    // 窗口类名和模拟器一模一样）一cái都不许动，见 agent.ps1 của SetScope。
    const agentScope = () => {
      const dirs = [];
      try { dirs.push(runtime.provisioner.root); } catch (_) { /* ignore */ }
      try { dirs.push(path.join(APP_ROOT, 'engine')); } catch (_) { /* ignore */ }
      return dirs.filter(Boolean);
    };
    // 范围存在代理进程củaBộ nhớ里，代理一重建就没了 —— 所以每次开机压制前都重发一次。
    armAgent = async (agent) => {
      if (!agent) return { ok: false };
      const dirs = agentScope();
      // 第二cái参数是本进程 pid：代理据此拒绝把窗口嵌进「不是我们của」窗口
      await agent.scope(dirs, process.pid).catch(() => null);
      if (!dirs.length) appLog('agent scope Để trống: không chặn cửa sổ nào (tránh ảnh hưởng phần mềm khác)');
      return agent.bootHide().catch(() => ({ ok: false }));
    };

    // 代理进程意外Thoát后会重建，事件监听必须一起重新挂上（旧版会在这里丢掉
    // 右键返回与滚轮，表现是「Dùng一会儿就没反应了」）。
    const attachAgentEvents = (agent) => {
      agent.on('back', () => { runtime.client().keyBack().catch(() => {}); });
      agent.on('forward', () => { runtime.client().keyForward().catch(() => {}); });
      agent.on('wheel', (m) => {
        if (pointer.pointerOptions(store.getSettings()).wheel === 'smooth') wheelRouter.push(m);
      });
      agent.on('exit', () => {
        const next = new WinAgent();
        winAgent = next;
        appWin.agent = next;
        attachAgentEvents(next);
        // 新代理没Có范围信息，不补这一下它就什么窗口都不敢碰
        armAgent(next).catch(() => {});
      });
    };
    attachAgentEvents(winAgent);

    // 命令窗压制của「闸门」必须在模拟器进程Tạo之前Mở。
    // 旧实现是「等 ApkStart 起来 4 秒后再藏」，而模拟器在这之前就已经把
    // qemu 控制台窗口Tạo出来了 —— Dùng户看到của就是一次一闪而过của黑框。
    runtime.emulator.onBeforeSpawn = async () => {
      if (!winAgent) return;
      await armAgent(winAgent);
    };
    // 窗口代理是cái PowerShell 常驻进程，Khởi động nguội约 300~600ms。
    // 提前拉起，别等到真正要藏窗口của那一刻才开始等。
    winAgent.ensure().then(() => armAgent(winAgent)).catch(() => {});

    registerIpc();
    createWindow({ show: !parseArgs(process.argv).silent });
    buildTray();
    applyAutoStart();

    // 老版本Cài đặtcủaÁp dụng没Có orientation 字段（那时还没这cái功能）。
    // 不补của话「跟随Áp dụng」对它们只能退回「Hướng bảng hiện tại」，红果这类Màn dọcÁp dụng
    // 在Bảng màn ngang下依旧是两侧黑边。这里Dùng随包của离线 APK 清单解析补一次，
    // 只读中央目录 + AndroidManifest，几百毫秒且只跑一次。
    try {
      const { parseApk } = require('./core/apk');
      const filled = [];
      for (const app of store.getApps()) {
        if (app.orientation || !app.apkPath) continue;
        if (!fs.existsSync(app.apkPath)) continue;
        try {
          const meta = parseApk(app.apkPath);
          if (meta.orientation) {
            store.upsertApp({ package: app.package, orientation: meta.orientation });
            filled.push(`${app.label}=${meta.orientation}`);
          }
        } catch (_) { /* 解析Thất bạicủaÁp dụng跳过，不影响启动 */ }
      }
      if (filled.length) appLog(`orientation backfill: ${filled.join(', ')}`);
    } catch (_) { /* ignore */ }

    // 磁盘余量：Nhỏ于 3GB 时安卓根本起不来（写镜像/快照都会Thất bại）。
    // 与其让Dùng户看着「打不开」不明所以，不如开门见山告诉他往哪儿改。
    {
      const doctor = require('./core/doctor');
      const freeMB = doctor.freeDiskMB(store.DATA_DIR);
      if (freeMB && freeMB < 3072) {
        appLog(`LOW_DISK free=${freeMB}MB dir=${store.DATA_DIR}`);
        setTimeout(() => {
          notify('Không đủ dung lượng ổ đĩa', `Chỉ còn ${(freeMB / 1024).toFixed(1)} GB. Vào “Cài đặt → Tích hợp hệ thống” để chuyển thư mục dữ liệu Android/thư mục bộ chạy sang ổ khác, hoặc dọn đĩa trước.`);
          send('toast', { type: 'error', message: `Ổ đĩa chỉ còn ${(freeMB / 1024).toFixed(1)} GB, Android có thể không khởi động được (Cài đặt → Tích hợp hệ thống để đổi ổ)` });
        }, 3000).unref?.();
      }
    }

    // 老版本只建过Màn hình nền快捷方式 / 图标是 null：启动即Tự động补齐，不DùngDùng户操作
    installer.ensureShortcuts().then((fixed) => {
      if (fixed && fixed.length) {
        windowctl.refreshShell().catch(() => {});
        notify('Đã bổ sung lối tắt', fixed.join('、'));
      }
    }).catch(() => {});

    // F11 全屏 / 窗口切换；全局快捷键只在 ApkStart 活着时Có效
    try {
      globalShortcut.register('F11', () => { toggleDisplayMode(); });
    } catch (_) { /* ignore */ }

    const args = parseArgs(process.argv);
    if (args.apk) runInstall(args.apk).catch(() => {});
    else if (args.launch) await runLaunch(args.launch);
    else {
      // 没Có直接启动Áp dụng：splash 在主窗口 ready 后淡出
      if (typeof splashDone === 'function') {
        setTimeout(() => splashDone(), 800);
      }
    }

    // Làm nóng:像 WSA / Áp dụng宝电脑版那样把安卓环境常驻。
    // Mở ApkStart 时就在后台把它引导好（窗口全程隐藏），之后点Áp dụngChỉ còn一次 am start。
    // 只Có「已经装过Áp dụng + CóKhả dụngBộ chạy」才预热，避免第一次使Dùng/纯管理场景白占Bộ nhớ。
    const prewarmEnabled = store.getSettings().engine.prewarm !== false;
    if (prewarmEnabled && !args.launch && store.getApps().length > 0) {
      // 1.2 秒就够窗口画完第一帧了。以前等 4 秒，Dùng户这时已经点了Áp dụng，
      // 结果「点开」和「预热」抢同一cái AVD 锁，反而更慢。
      setTimeout(async () => {
        try {
          const env = await runtime.provisioner.checkEnv();
          if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) {
            appLog(`prewarm skipped: not ready (adb=${env.adb.ok} emu=${env.emulator.ok} img=${env.sysimg.ok})`);
            return;
          }
          // 开机阶段把模拟器窗口与 qemu 控制台藏起来，Dùng户不该看到任何窗
          // 注意要 await：不等它生效就去 spawn，黑窗一定会露出来。
          if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }
          const t0 = Date.now();
          appLog('prewarm start');
          const r = await runtime.prewarm({ onLog: (m) => appLog(`prewarm ${m}`) });
          if (r && r.ok) appLog(`prewarm ready in ${Date.now() - t0}ms`);
          else {
            appLog(`prewarm failed: ${r && (r.error || r.skipped)}`);
            // 预热Thất bại也Tiếp tục压住模拟器窗口：它可能只是慢，过一会儿就起来了，
            // Dùng户不该因là “预热Thất bại」在Màn hình nền上看到一台模拟器。
            if (winAgent) armAgent(winAgent).catch(() => {});
          }
        } catch (e) { appLog(`prewarm error: ${e && e.message}`); /* 预热Thất bại不影响后续正常Mở */ }
      }, 1200).unref?.();
    } else {
      appLog(`prewarm off (enabled=${prewarmEnabled} launch=${!!args.launch} apps=${store.getApps().length})`);
    }

    // 首次运行của组件部署延后 20 秒：Khởi động nguội那段时间磁盘/CPU 已经打满，
    // 再并发下载Giải nén只会让Màn hình nền更卡。真CóÁp dụng要Mở时 ensure() 自会准备。
    setTimeout(() => {
      autoDeploy().then((r) => {
        if (r && r.ok) send('toast', { type: 'ok', message: 'Bộ chạy đã tự chuẩn bị xong' });
      }).catch(() => {});
    }, 20000).unref?.();

    // 启动 8 秒后静默查一次新版本（打包后才Có意义）。Có phiên bản mới只提示，
    // 绝不Tự động下载 —— 更新是Dùng户点「Cập nhật ngay」才做của事。
    // 商店（MSIX）版跳过：Cài đặt目录是只读của WindowsApps，自更新既写不进去也不
    // 合规，更新统一由 Microsoft Store 负责。
    if (app.isPackaged && !store.STORE_BUILD) {
      // issue #98：先检查「Lần trướcĐã tải xuốngGiải nén、但替换/重启没落地của更新」。
      // 命中就直接Dùng本地载荷重放替换+重启，绝不再下一遍包——这是更新死循环của根治。
      // 放在查新版本之前，避免 resumable 与新一轮 check 抢进度条。
      let resuming = false;
      try {
        const job = updater.findResumableJob();
        if (job) {
          resuming = true;
          appLog(`resuming pending update ${job.version} from cached payload`);
          send('update:progress', { stage: 'apply', percent: 100, message: 'Đang hoàn tất bản cập nhật dang dở lần trước…' });
          updater.apply(job);
          setTimeout(() => { quitting = true; app.quit(); }, 900);
        }
      } catch (e) { appLog(`resume check failed: ${e.message}`); }
      // 命中续做就不再并行发起新一轮查新版本；但不能Dùng return 跳出整cái启动回调。
      if (!resuming) setTimeout(() => {
        updater.check().then((info) => {
          updateInfo = info;
          send('update:state', info);
          if (info.hasUpdate) {
            appLog(`update available ${info.tag} (current v${app.getVersion()}, asset=${info.asset ? info.asset.name : 'none'})`);
            // 不再单独弹系统通知：启动时của提醒统一收到Áp dụng内của「欢迎卡」里，
            // 避免开机自启时又冒一cái右下角气泡（Dùng户反馈của「Nhỏ弹窗」之一）。
          }
        }).catch((e) => appLog(`update check failed: ${e.message}`));
      }, 8000).unref?.();
    }

    // 文件同步 / 通知轮询不再无条件常驻：只在容器里真củaCóCửa sổ ứng dụng时才跑
    // （见 onContainerActive）。

    // 冒烟测试：截图后Thoát，Dùng于Tự động化验证界面是否正常渲染
    if (process.argv.includes('--smoke') && mainWindow) {
      const out = process.argv[process.argv.indexOf('--smoke') + 1] || 'smoke.png';
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            if (process.argv.includes('--setup')) {
              // Bộ chạy面板已并入Cài đặt：--setup 与 --settings 等价，直接Mở cài đặt截图
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('btnSettings').click(); true;",
              );
              await new Promise((r) => setTimeout(r, 2500));
            }
            if (process.argv.includes('--settings')) {
              const opened = await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('btnSettings').click();
                  for (let i = 0; i < 50; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    if (document.getElementById('settingsMask').classList.contains('on')) return true;
                  }
                  return false;
                })()
              `);
              console.log('[smoke] settings opened =', opened);
              await new Promise((r) => setTimeout(r, 600));
              const dbg = await mainWindow.webContents.executeJavaScript(
                "JSON.stringify({ on: document.getElementById('settingsMask').classList.contains('on'), qr: !!document.querySelector('#aboutGroup img'), qrH: (document.querySelector('#aboutGroup img')||{}).naturalHeight, ver: (document.getElementById('aboutVer')||{}).textContent, note: (document.getElementById('setupNote')||{}).textContent })",
              );
              console.log('[smoke] dom =', dbg);
            }
            // 窗口可能被遮挡导致拿到旧帧：强制重绘 + 连拍两帧取后一帧
            const snap = async (file) => {
              mainWindow.webContents.invalidate();
              await mainWindow.webContents.capturePage().catch(() => null);
              await new Promise((r) => setTimeout(r, 400));
              const im = await mainWindow.webContents.capturePage();
              fs.writeFileSync(file, im.toPNG());
              console.log('[smoke] saved', file);
            };
            await snap(out);
            if (process.argv.includes('--perf')) {
              // 拍一张「Hiệu năng và tài nguyên」区（Cài đặt页里控件最多của一块）
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('perfGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-perf.png'));
            }
            if (process.argv.includes('--download')) {
              // 拍一张「Nguồn tải và cập nhật」区
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('downloadGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-download.png'));
            }
            if (process.argv.includes('--settings')) {
              // 再拍一张「Giới thiệu」区（二维码 / GitHub / Powered by）
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('aboutGroup').scrollIntoView({ block: 'center' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-about.png'));
            }
          } catch (e) {
            console.error('[smoke] Chụp ảnh màn hình thất bại', e);
          }
          quitting = true;
          app.quit();
        }, 6500);
      });
    }

    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // 正常Đóng窗口时只隐藏到托盘（close 事件已拦截），
    // 走到这里说明是真正要Thoát，必须放行，否则进程会残留并占住单实例锁。
    if (quitting) app.exit(0);
  });

  let quitReady = false;
  app.on('before-quit', (e) => {
    quitting = true;
    // Thoát前必须先让窗口代理把模拟器窗口「摘下 + 藏好」。这一步是异步của
    // （要等代理回包），所以第一次 before-quit 先拦下来，收尾Hoàn tất再真正Thoát。
    // 少了这一步，宿主窗口一销毁，Windows 会把模拟器子窗口重挂到Màn hình nền并显示出来——
    // 表现就是「关掉 ApkStart 之后，Màn hình nền上还留着一cái Android Emulator 黑窗」。
    if (!quitReady) {
      e.preventDefault();
      quitReady = true;
      sharer?.stop();
      notifier?.stop();
      try { appWin?.close({ keepApp: true }); } catch (_) { /* ignore */ }
      const finish = () => {
        try { winAgent?.dispose(); } catch (_) { /* ignore */ }
        try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
        runtime?.dispose();
        // 隐藏của图标解码窗口也算一cái窗口，不关掉会让 window-all-closed 永远不触发
        try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
        app.quit();
      };
      setTimeout(finish, 400);
      return;
    }
    try { winAgent?.dispose(); } catch (_) { /* ignore */ }
    try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
    runtime?.dispose();
    try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
  });
}
