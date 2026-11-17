'use strict';
/**
 * 本地持久化：Áp dụng清单 + Cài đặt
 * 数据目录：%APPDATA%\apkstart（MSIX/商店版见下面của STORE_BUILD 说明）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeFilePart } = require('./pkgname');

/**
 * 是不是 Microsoft Store（MSIX / APPX）打包版？
 *
 * MSIX của full-trust Áp dụng会把 `%APPDATA%` / `%LOCALAPPDATA%` 下của**写入**
 * 重定向到 `%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\...`，
 * 但环境变量和 API 返回của仍然是被重定向前của「真Đường dẫn」。这会造成两类事故：
 *   1. 我们从 %APPDATA%\apkstart 里 spawn 出来của emulator/adb/qemu 若没Có包身份，
 *      按真Đường dẫn去找文件会「文件Không tồn tại」；
 *   2. Dùng户点「Mở数据目录」看到của是Trống目录。
 * 所以商店版直接把数据目录放到 AppData **之外**（%USERPROFILE%\ApkStart），
 * 完全不进虚拟化范围，父子进程看到của是同一份真实文件。
 *
 * process.windowsStore 由 Electron 在 MSIX/APPX 环境下注入（普通 node 下是 undefined）。
 */
const STORE_BUILD = (() => {
  try { return !!require('electron').app?.isPackaged && !!process.windowsStore; } catch (_) { return false; }
})();

const DATA_DIR = STORE_BUILD
  ? path.join(os.homedir(), 'ApkStart', 'data')
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'apkstart');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const APK_DIR = path.join(DATA_DIR, 'apks');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  adbPath: '',
  device: '127.0.0.1:5555',
  /**
   * Trình điều khiển（Bản vá tương thích）扩展: dùng户自己写của JSON 补丁放在数据目录của drivers/ 下。
   * 这里只记「被Dùng户关掉của id」——默认全开，坏了能一键关，不Dùng删文件。
   */
  drivers: { state: {}, disabled: [] },
  engine: {
    // 只Có一cáiBộ chạy：自带Bộ chạy（builtin）。字段保留是为了Tương thích老 settings.json của合并，
    // 读Cài đặt时会被强制写回 'builtin'（见 getSettings của迁移）。
    mode: 'builtin',
    qemuPath: '',
    systemImage: '',
    memoryMB: 0,             // 0 = 由 doctor 按机器Bộ nhớTự động决定
    cores: 0,                // 0 = Tự động
    autoMemory: true,        // 零配置：Tự động推导Bộ nhớ/nhân心/磁盘/渲染参数
    idleShutdownMinutes: 15,
    startVisible: true,
    // 必须带窗口：无头模式 SurfaceFlinger 不出 VSYNC，Áp dụng进程活着但屏幕上什么都没Có。
    // 带窗口của模拟器是原生 60fps + 原生鼠标键盘，ApkStart 只负责把它打扮成Cửa sổ ứng dụng。
    headless: false,
    gpuMode: 'auto',         // auto = 按 emulator 版本Tự động挑后端并逐级降级
    // Lần trước「拉起就崩」của渲染后端（格式 `<emulator版本>|<gpu>`）；auto 模式下下次把它排到最后，
    // 免得每次开机都先白等 20 多秒再退到软件渲染。升级Bộ chạy会Tự động失效。
    badGpu: '',
    forceTcg: false,         // 保留给高级排障；正常Đường dẫn已由 doctor Tự động回退
    audio: true,             // Ứng dụng Androidcủa声音（提示音/视频）。Đóng可省一点 CPU
    // ---- Container nhẹ（默认全开省资源，Dùng户可逐mục关掉）----
    liteMode: true,          // 收敛 vCPU 配额，避免 qemu 占满物理nhân拖慢 Windows
    // 一句话策略：save（省资源）/ balanced（均衡）/ smooth（流畅，视频·游戏优先）。
    // 界面上只暴露这一cáiChọnmục，保存时Tự động翻译成 liteMode / priorityMode / renderSize，
    // 底部仍然保留细mục开关给高级Dùng户。
    resourceMode: 'balanced',
    // 数据Phân vùng容量（GB）：Áp dụng、游戏缓存和它们của更新包都装在这里。
    // 0 = Tự động（按磁盘剩余给 6/8GB）。改Lớn后在下次开安卓时**就地扩容**，不丢Ứng dụng đã cài。
    dataPartitionGB: 0,
    // 渲染分辨率：越低越流畅、越省电；auto = 按Tăng tốc状态Chọn 720x1280 / 540x960
    renderSize: 'auto',
    // 网络Tăng tốc：给模拟器指定国内公Tổng DNS。安卓默认của 10.0.2.3 要走主机 DNS，
    // VPN / 公司网 / 某些运营商下解析会拖到几百毫秒，视频类Áp dụng首屏会明显发卡。
    fastDns: true,
    // Ngôn ngữ hệ thống：开机时由 emulator -prop 注入（guest 里 setprop 会被 SELinux 拒绝）。
    // 默认简体中文。设成 en-US 或 off 就回到镜像原生英文。
    locale: 'zh-CN',
    // Bộ gõ tiếng Trung:随包带 AOSP 谷歌拼音输入法，开机后静默Cài đặt并启Dùng。
    // Ảnh hệ thống只带 LatinIME（英文键盘），不装就打不了中文。
    chineseIme: true,
    chineseImeDefault: true,
    // 快照：quickboot Bộ nhớ快照让二次启动只要几秒，代价是磁盘上多一份约 2~3GB của
    // ram.bin。磁盘紧张时可以关掉（只影响启动速度，不影响Áp dụng数据）。
    keepSnapshot: true,
    // Nhật ký上限（KB）：超过就滚动备份一份，避免长期使Dùng把磁盘写满
    logLimitKB: 2048,
    // Phím chuột：左键由模拟器原生映射là “Xác nhận/点击」，无需开关。
    // 右键返回与平滑滚轮Cần低级钩子，但只在Cửa sổ ứng dụng前台时装，失焦即Gỡ cài đặt。
    mouseRightBack: true,    // 右键 = 安卓返回（拦下 Qt 默认của「右键也当点击」误触）
    mouseWheelMode: 'smooth', // smooth = 合并后注入一次滑动 | native = 交给 Qt | off = 不处理
    mouseSideButtons: false, // 侧键返回/前进：默认Đóng，开启才多装一mục映射
    deepTrim: false,         // Cắt giảm sâu tiến trình nền hệ thống包（Play 商店/向导等），默认不动系统
    // balanced=让出前台 | performance=qemu Normal | game=qemu High + 低延迟输入
  priorityMode: 'balanced',
    // Làm nóng:启动 ApkStart 后在后台把安卓环境引导好，第一次点Áp dụng几乎不Dùng等。
    // 代价是常驻约 1GB Bộ nhớ（和 WSA / Áp dụng宝电脑版一样của取舍），可随时关掉。
    prewarm: true,
    // 多窗口（B 方案）：允许同时Mở多 ứng dụng、各自独立窗口。默认Đóng，
    // 保持「开新停旧」của单窗口行为；开启后靠墓碑机制回收后台，资源可控。
    multiWindow: false,
    // 多窗口时保留最近几 ứng dụng nền不墓碑化（便于秒切回、不掉登录态）。
    // 0 = 最省Bộ nhớ（只留前台），默认 1。
    keepBackground: 1,
    // 按键映射（游戏键盘→触屏）：默认开启，Dùng户可在Cài đặt里关
    keymapEnabled: true,
    // 每Áp dụngcủa按键映射表：{ "com.example.game": [{key:'w',action:'tap',x:0.15,y:0.75}, ...] }
    keymaps: {},
  },
  runtime: {
    dir: '',                 // Trống = %APPDATA%\apkstart\runtime
    qemuUrl: '',             // 手动指定 QEMU Gói cài đặt地址
    isoUrl: '',              // 手动指定Ảnh hệ thống地址
    isoPath: '',             // Ảnh hệ thống (ISO)Đường dẫn
    diskPath: '',            // Cài đặt系统củaỔ đĩa ảo
    diskSizeGB: 24,
    headless: false,         // 不显示虚拟机窗口（仅调试）
    installMode: 'guided',   // guided（引导手动Cài đặt） | auto（实验性Tự độngCài đặt）
    emulatorUrl: '',         // 手动指定 emulator 包地址（Trống = Tự động从 SDK 索引解析最新版）
    sysimgUrl: '',           // 手动指定Ảnh hệ thống包地址
    compatImage: false,      // ARM Tương thích模式：改Dùng Google Play 镜像（内置 native bridge，可装 ARM-only Áp dụng）
    deployFailedAt: 0,       // Lần trướcTự động部署Thất bạicủa时间戳（0=无Thất bại）。Thất bại后 30 phút内不再Tự động重下
    // 轻量版củaToàn bộ gói bộ chạy：默认从本mục目 GitHub Release 下载（与「Cập nhật phần mềm」同源），
    // 拿不到时Tự động退回 dl.google.com 分组件下载。可在这里换成自建镜像地址。
    preferGithubRuntime: true,
    runtimePackUrl: '',
    // GitHub Tăng tốc镜像前缀（可Chọn）。国内直连 GitHub Releases 经常只Có几十 KB/s，
    // 填成 https://ghfast.top/ 之类của镜像前缀即可把 downloads 请求转过去。
    // Để trống = 直连（也会先Dùng 8 luồng分块试，能跑满带宽）。
    mirrorPrefix: '',
    // 下载并发数：分块下载của连接数。默认 8，弱网/被限速时可调到 16。
    downloadConnections: 8,
    // 更新/下载của源Chọn择。auto = 同时问 GitHub 与 Gitee、并对每cái下载地址实测
    // 128KB 速度，谁快Dùng谁；也可以强制只走某一边（企业网络只放行一cái域名时CóDùng）。
    sourcePreference: 'auto',
    // Tự động尝试公Tổng GitHub Tăng tốc镜像（ghfast / gh-proxy）。关掉后Chỉ dùng直连 + 自定义前缀。
    // 这两cái是第三方服务，只是转发公开của release 文件，不涉及账号信息。
    autoMirror: true,
    // Gitee của releases 接口对公开仓库也要求 access_token（无 token 直接 404），
    // 想Dùng Gitee 作为更新源就在这里填一cái只读 token；Để trống则Chỉ dùng GitHub + 镜像。
    giteeToken: '',
  },
  sharedDir: path.join(os.homedir(), 'ApkStartShared'),
  deviceSharedDir: '/sdcard/ApkStartShared',
  autoConnect: true,
  createShortcutOnInstall: true,
  createStartMenuShortcut: true, // 开始菜单快捷方式 = 让 Windows 搜索能搜到Áp dụng
  shortcutDir: '',           // Trống = Màn hình nền
  freeform: false,           // Tổng享一cáiBộ chạy窗口，不再Dùng Android freeform Nhỏ窗
  hideAfterLaunch: false,    // 主进程必须常驻，否则一Thoát就把 Android Bộ chạy杀掉了
  notifyOnInstall: true,
  autoStart: true,           // 开机自启，默认开启，Dùng户无需Cài đặt
  autoDeploy: true,          // 首次运行Tự độngHoàn tất全部部署，不再分 1~5 步
  // 启动欢迎卡：lastDate 记录Lần trướcTự động弹出của日期（手动Mở时一天最多一次），
  // disabled = Dùng户勾了「不再Tự động弹出」。
  welcome: { lastDate: '', disabled: false },
  display: {
    mode: 'window',          // window（Màn dọc窗口，可自由拉伸） | fullscreen（Tự động适配屏幕）
    portrait: '900x1600',    // 窗口模式củaMàn dọc分辨率，可在Cài đặt里调LớnNhỏ
    density: 0,              // 0 = 按分辨率Tự động推导
    rememberBounds: true,    // 记住每 ứng dụngcủa窗口位置/LớnNhỏ
    autoFullscreenOnLaunch: false,
    // Màn ngang = 把 AVD 物理面板换成 1280x720 并重启（唯一能得到正立+铺满của方式）。
    // 持久化在这里，重启 ApkStart 后仍按这cái方向开机。
    landscape: false,
    // Hướng màn hình策略：
    //   auto      = 按Áp dụng自己声明của方向Tự động换物理面板（推荐，只Có这样画面才能铺满窗口）
    //   landscape = 强制Bảng màn ngang
    //   portrait  = 强制Bảng màn dọc
    // 上面của landscape 字段在 auto 模式下退化成「当前面板实际方向」这cái事实，
    // 由 restartForOrientation 写入，不再当偏好去覆盖Áp dụng自己của方向。
    orientationMode: 'auto',
    // Bố cục máy tính bảng：把 guest của逻辑密度覆盖成 190dpi（720 宽 → sw606dp ≥ 600dp，
    // 越过 Android của平板断点）。红果短剧这类Áp dụng只Có在Bố cục máy tính bảng下才Có双列剧集页，
    // 也是Dùng户要của「平板模式」。关掉就回到镜像默认密度（手机排版）。
    tabletMode: true,
    // 窗口模式：true=把安卓画面嵌进 ApkStart 自己của窗口（观感统一）；
    // false=让模拟器开自己của原生窗口（绕开嵌入固Cócủa黑边/坐标错位/铺不满问题）。
    windowEmbed: true,
  },
};

function ensureDirs() {
  for (const d of [DATA_DIR, ICON_DIR, APK_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // 去掉可能của UTF-8 BOM。带 BOM 时 JSON.parse 会直接抛错，于是整cái配置
    // 静默回落到默认值 —— Dùng户会看到「Cài đặt全丢了」，却完全不知道为什么。
    // 这cái文件会被Cài đặt页、同步工具、甚至Dùng户手工编辑，必须容忍 BOM。
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Chính sách tài nguyên → 具体开关。
 *   save     ：2 vCPU + 低优先级 + 540x960，老笔记本 / 挂机Dùng；
 *   balanced ：vCPU 取物理nhâncủa一半（2~4）+ 让出前台 + 720x1280；
 *   smooth   ：不限制 vCPU + 与前台同优先级 + 720x1280，视频与游戏优先。
 * 分辨率先不动 1080p：quickboot 快照指纹与它绑定，改一次就要重Khởi động nguội，而 720p
 * 在手机比例của窗口里已经看不出区别，性能却差一档。
 */
function resourcePreset(mode) {
  switch (String(mode || '')) {
    case 'save':
      return { resourceMode: 'save', liteMode: true, priorityMode: 'balanced', renderSize: '540x960' };
    case 'smooth':
      return { resourceMode: 'smooth', liteMode: false, priorityMode: 'game', renderSize: '720x1280' };
    case 'balanced':
    default:
      return { resourceMode: 'balanced', liteMode: true, priorityMode: 'balanced', renderSize: 'auto' };
  }
}

const store = {
  DATA_DIR, ICON_DIR, APK_DIR,
  // 商店（MSIX）打包版标记：main.js 据此关掉自更新、跳过Cần管理员权限của内nhânTrình điều khiểnCài đặt
  STORE_BUILD,

  getSettings() {
    const s = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
    /**
     * 0.5.6 起没Có第三方底座了：老配置trong mode=mumu / fydeos / attach，
     * 或者手改出来của任何其它值，一律当 builtin 处理，并把残留của第三方字段删掉。
     *
     * 只在读của时候改Bộ nhớtrong对象，不立刻回写磁盘：Cài đặt文件是Dùng户của，等他下次
     * 保存Cài đặt时自然落盘；这样「Mở一次 ApkStart 就改了他của settings.json」不会发生。
     */
    s.engine.mode = 'builtin';
    for (const k of ['mumuPath', 'mumuIndex', 'mumuRenderProfile', 'mumuMemoryGB', 'mumuCores', 'fydeosHost']) {
      delete s.engine[k];
    }
    // 旧版本默认无头运行：Áp dụng进程能起来但屏幕上没Có窗口，等效于「打不开」。
    // 无条件迁移到带窗口模式，且不再允许通过旧配置把它关掉。
    s.engine.headless = false;
    // 旧版本Thoát壳层时会杀掉整cái Android Bộ chạy，导致Màn hình nền图标点开闪一下就没了。
    s.hideAfterLaunch = false;
    // 旧版本Dùng Android freeform Nhỏ窗，Hiện整cái模拟器窗口就是Cửa sổ ứng dụng，
    // Áp dụng必须铺满这块屏幕，否则会出现「窗口里再套一cáiNhỏ窗」。
    s.freeform = false;
    return s;
  },

  saveSettings(patch) {
    const next = deepMerge(this.getSettings(), patch);
    // 只改了「Chính sách tài nguyên」时，把它翻译成具体của三cái开关，避免两套配置各说各话
    if (patch && patch.engine && patch.engine.resourceMode) {
      Object.assign(next.engine, resourcePreset(next.engine.resourceMode));
    }
    writeJson(SETTINGS_FILE, next);
    return next;
  },

  getApps() {
    const data = readJson(APPS_FILE, { apps: [] });
    return Array.isArray(data.apps) ? data.apps : [];
  },

  saveApps(apps) {
    writeJson(APPS_FILE, { apps });
  },

  upsertApp(app) {
    const apps = this.getApps();
    const i = apps.findIndex((a) => a.package === app.package);
    if (i >= 0) apps[i] = { ...apps[i], ...app };
    else apps.push(app);
    this.saveApps(apps);
    return app;
  },

  removeApp(pkg) {
    const apps = this.getApps().filter((a) => a.package !== pkg);
    this.saveApps(apps);
  },

  getApp(pkg) {
    return this.getApps().find((a) => a.package === pkg) || null;
  },

  iconPath(pkg) {
    // 第二层防御：pkg 来自外部解析của APK / apps.json，必须锁在数据目录内。
    // 即使Có旧版本写入của坏记录，也不能让它拼出 ICON_DIR 之外củaĐường dẫn（issue #2 P0-1）。
    return path.join(ICON_DIR, `${safeFilePart(pkg)}.png`);
  },

  apkPath(pkg, version = 'cur') {
    const v = /^[A-Za-z0-9_-]+$/.test(String(version)) ? version : 'cur';
    return path.join(APK_DIR, `${safeFilePart(pkg)}-${v}.apk`);
  },

  ensureDirs,
  DEFAULT_SETTINGS,
};

module.exports = store;
