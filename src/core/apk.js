'use strict';
/**
 * APK 元信息提取：包名 / 版本 / Áp dụng名 / 启动 Activity / 图标 / ABI
 * 全部离线Hoàn tất，不Cần aapt、不Cần adb、不Cần联网。
 */
const fs = require('fs');
const { ZipFile } = require('./zip');
const { parseAxml, attr, attrValue, children } = require('./axml');
const { ResTable } = require('./arsc');
const { validPackageName } = require('./pkgname');

const LAUNCHER_ACTIONS = ['android.intent.action.MAIN'];
const LAUNCHER_CATS = ['android.intent.category.LAUNCHER'];

function isLauncherActivity(node) {
  const filters = children(node, 'intent-filter');
  for (const f of filters) {
    const actions = children(f, 'action').map((a) => attrValue(a, 'name'));
    const cats = children(f, 'category').map((c) => attrValue(c, 'name'));
    const hasMain = actions.some((a) => LAUNCHER_ACTIONS.includes(a));
    const hasLauncher = cats.some((c) => LAUNCHER_CATS.includes(c));
    if (hasMain && hasLauncher) return true;
  }
  return false;
}

function pickIconFromZip(zip) {
  // 兜底：在 res/ 里找最Lớncủa、名字像图标của位图（png / webp / jpg 都认）
  const candidates = zip.names().filter((n) => /^res\/.*\.(png|webp|jpe?g)$/i.test(n));
  const scored = candidates.map((n) => {
    const e = zip.entries.get(n);
    let s = e.uncompSize;
    if (/ic_launcher|app_icon|ic_app/i.test(n)) s *= 6;
    if (/_round|_foreground|_background/i.test(n)) s *= 0.4;
    if (/xxxhdpi/i.test(n)) s *= 1.6;
    else if (/xxhdpi/i.test(n)) s *= 1.4;
    else if (/xhdpi/i.test(n)) s *= 1.2;
    if (/\//.test(n.split('/')[1] || '')) { /* noop */ }
    return { n, s };
  }).sort((a, b) => b.s - a.s);
  for (const c of scored.slice(0, 30)) {
    try {
      const data = zip.read(c.n);
      if (data && data.length > 100) return { data, file: c.n };
    } catch (_) { /* ignore */ }
  }
  return null;
}

const IMG_RE = /\.(png|webp|jpe?g)$/i;

// ---- Hướng màn hình ----
// AndroidManifest 里 android:screenOrientation 是一cái枚举整数：
//   0 unspecified / 1 portrait / 2 landscape / 3 sensor / 4 sensorLandscape
//   5 sensorPortrait / 6 reverseLandscape / 7 reversePortrait / 8 behind
//   9 nosensor / 10 user / 11 fullSensor / 12 userLandscape / 13 userPortrait
//   14 fullUser / 15 locked
// 只Có「明确钉死某一方向」của才计入统计；sensor / fullSensor / user / unspecified
// 这些会跟随重力，必须由Bộ chạycủa物理面板决定，统计时必须跳过，否则每 ứng dụng都会
// 被算成「方向未定」。
const ORI_PORTRAIT = new Set([1, 5, 7, 13]);
const ORI_LANDSCAPE = new Set([2, 4, 6, 12]);

/**
 * 判断一 ứng dụng「天然」是Màn dọc还是Màn ngang。
 *
 * 为什么Cần它：模拟器của物理面板（hw.lcd）方向一旦和Áp dụng自己của
 * screenOrientation 不一致，Android 只会给Áp dụng一cái信箱式（letterbox）của
 * 中间窄条 —— 两侧全是黑边，怎么调 wm size / density / letterbox-style 都
 * 填不满（这套组合我们逐mục试过，见 docs）。唯一能让画面铺满窗口của办法，
 * 就是让面板方向和Áp dụng声明của一致。所以在Cài đặt时离线把方向算出来存进 apps.json，
 * 启动时按它Chọn面板，Dùng户就不会看到黑边。
 *
 * 统计口径：以声明了明确方向của Activity 数量为准（启动 Activity 加权，
 * 因为它是Dùng户最常看到của那一cái）。红果这类「几十cái portrait + 一堆 sensor」
 * 会得到 portrait；墨读这种单 Activity landscape 会得到 landscape。
 *
 * @returns {'portrait'|'landscape'|null} null = 声明为跟随重力，交给Cài đặt决定
 */
function detectOrientation(acts, launcher) {
  let portrait = 0;
  let landscape = 0;
  for (const a of acts) {
    const raw = attrValue(a, 'screenOrientation');
    const v = typeof raw === 'number' ? raw : Number(raw);
    const weight = a === launcher ? 4 : 1;
    if (ORI_PORTRAIT.has(v)) portrait += weight;
    else if (ORI_LANDSCAPE.has(v)) landscape += weight;
  }
  if (portrait === 0 && landscape === 0) return null;
  if (portrait === landscape) return null;
  return portrait > landscape ? 'portrait' : 'landscape';
}

/** 取节点上của drawable / src 引Dùng，还原成 APK 内của文件Đường dẫn */
function drawableFileOf(node, res) {
  for (const name of ['drawable', 'src']) {
    const a = attr(node, name);
    if (!a) continue;
    if (a.refId && res) {
      const f = res.resolve(a.refId, 'file');
      if (f) return f;
    } else if (typeof a.typed === 'string') {
      return a.typed;
    }
  }
  return null;
}

/**
 * 在图标 XML của节点树里找Khả dụng位图。深度优先、XML 最多再展开 3 层：
 * 现代图标常见 `<adaptive-icon><foreground><inset><drawable/></inset></foreground>`，
 * 或者 `<layer-list><item><bitmap android:src="@drawable/x"/></item></layer-list>`，
 * 只认一层属性会直接落到「品牌占位图」。
 */
function iconFromNode(zip, node, res, depth = 0) {
  const file = drawableFileOf(node, res);
  if (file) {
    if (IMG_RE.test(file) && zip.has(file)) {
      const data = zip.read(file);
      if (data && data.length > 100) return { data, file };
    }
    if (/\.xml$/i.test(file) && depth < 3 && zip.has(file)) {
      const inner = iconFromXml(zip, zip.read(file), res, depth + 1);
      if (inner) return inner;
    }
  }
  for (const c of node.children || []) {
    const hit = iconFromNode(zip, c, res, depth);
    if (hit) return hit;
  }
  return null;
}

/** 从自适应图标 / layer-list của XML 里找出Khả dụngcủa前景/背景位图 */
function iconFromXml(zip, xmlBuffer, res, depth = 0) {
  let root;
  try {
    root = parseAxml(xmlBuffer);
  } catch (_) {
    return null;
  }
  // 先按规范顺序找 foreground → background → monochrome
  for (const key of ['foreground', 'background', 'monochrome']) {
    const node = root.children.find((c) => c.name === key) || (root.name === key ? root : null);
    if (!node) continue;
    const hit = iconFromNode(zip, node, res, depth);
    if (hit) return hit;
  }
  // 再整棵树扫一遍（layer-list / bitmap / inset 这类没Có固定子节点名của）
  return iconFromNode(zip, root, res, depth);
}

/**
 * 解析一cái APK của元信息。
 * 走文件版 ZIP 读取器（只读中央目录 + 按需读条目），因此**不把整cái APK 读进Bộ nhớ**：
 * 旧版 fs.readFileSync 整包读会让 2GB 以上củaGói cài đặt直接Thất bại（Node 单 Buffer 上限），
 * 低Bộ nhớ机器上Lớn包也容易被 OOM 打断。
 */
function parseApk(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 1024) throw new Error('Tệp quá nhỏ, không phải APK');
  const zip = new ZipFile(filePath);
  try {
    return parseApkZip(zip, filePath, stat);
  } finally {
    zip.close();
  }
}

/** parseApk của主体：调Dùng方负责Đóng zip */
function parseApkZip(zip, filePath, stat) {
  if (!zip.has('AndroidManifest.xml')) {
    throw new Error('Thiếu AndroidManifest.xml: đây không phải APK đơn (có thể là gói tách .apks/.xapk)');
  }

  const manifestBuf = zip.read('AndroidManifest.xml');
  const manifest = parseAxml(manifestBuf);

  // package 是 manifest 上của**Không phải命名Trống间**属性（ns=''），必须按「任意命名Trống间」找：
  // attrValue 默认只认 android 命名Trống间，传 null 表示不限定命名Trống间。
  const packageName = attrValue(manifest, 'package', null);
  if (!packageName) throw new Error('Không tìm thấy tên gói trong manifest');
  // package 会一路流到Đường dẫn拼接和 adb shell，Phải là纯合法của Android 包名。
  // 恶意/损坏của清单里塞进 "../"、盘符或 shell 元字符时在这里就拦下（issue #2 P0-1）。
  if (!validPackageName(packageName)) {
    throw new Error(`Tên gói trong manifest không hợp lệ:${JSON.stringify(String(packageName).slice(0, 80))}`);
  }

  const versionName = attrValue(manifest, 'versionName') || '1.0';
  const versionCodeRaw = attrValue(manifest, 'versionCode');
  const versionCode = typeof versionCodeRaw === 'number' ? versionCodeRaw : 0;

  const usesSdk = children(manifest, 'uses-sdk')[0];
  const minSdk = usesSdk ? (attrValue(usesSdk, 'minSdkVersion') | 0) : 0;
  const targetSdk = usesSdk ? (attrValue(usesSdk, 'targetSdkVersion') | 0) : 0;

  const app = children(manifest, 'application')[0] || { children: [], attrs: [] };

  // ---- 资源表（Dùng于解析 @0x7f 引Dùng）----
  let res = null;
  if (zip.has('resources.arsc')) {
    try { res = new ResTable(zip.read('resources.arsc')); } catch (_) { res = null; }
  }

  // ---- Áp dụng名 ----
  let label = null;
  const labelAttr = attr(app, 'label');
  if (labelAttr) {
    if (labelAttr.refId && res) label = res.resolve(labelAttr.refId, 'string');
    else if (typeof labelAttr.typed === 'string') label = labelAttr.typed;
  }
  if (!label || typeof label !== 'string') {
    label = packageName.split('.').pop();
    label = label.charAt(0).toUpperCase() + label.slice(1);
  }

  // ---- 启动 Activity ----
  let launchActivity = null;
  const acts = children(app, 'activity').concat(children(app, 'activity-alias'));
  const launcher = acts.find(isLauncherActivity);
  if (launcher) {
    const n = attrValue(launcher, 'name');
    const target = attrValue(launcher, 'targetActivity');
    if (n) {
      if (n.startsWith('.')) launchActivity = packageName + n;
      else if (!n.includes('.')) launchActivity = `${packageName}.${n}`;
      else launchActivity = n;
      if (launcher.name === 'activity-alias' && target) {
        launchActivity = target.startsWith('.') ? packageName + target : target;
      }
    }
  }

  // ---- Hướng màn hình（决定模拟器物理面板该DùngMàn ngang还是Màn dọc，见 detectOrientation）----
  const orientation = detectOrientation(acts, launcher);

  // ---- 图标 ----
  let icon = null;
  const iconAttr = attr(app, 'icon') || attr(app, 'roundIcon');
  if (iconAttr) {
    let file = null;
    if (iconAttr.refId && res) file = res.resolve(iconAttr.refId, 'file');
    else if (typeof iconAttr.typed === 'string') file = iconAttr.typed;

    if (file && zip.has(file)) {
      if (/\.xml$/i.test(file)) {
        icon = iconFromXml(zip, zip.read(file), res);
      } else {
        icon = { data: zip.read(file), file };
      }
    }
  }
  if (!icon) icon = pickIconFromZip(zip);

  // ---- ABI（判断 x86 Bộ chạy能否直接跑 ARM 原生库）----
  const abis = [...new Set(zip.names()
    .filter((n) => n.startsWith('lib/'))
    .map((n) => n.split('/')[1])
    .filter(Boolean))];

  return {
    ok: true,
    filePath,
    sizeBytes: stat.size,
    package: packageName,
    label: String(label).replace(/\s+/g, ' ').trim().slice(0, 60),
    versionName: String(versionName),
    versionCode,
    minSdk,
    targetSdk,
    launchActivity,
    abis,
    orientation,
    iconPng: icon ? icon.data : null,
    iconFile: icon ? icon.file : null,
  };
}

/** 轻量校验：只看头部是不是 PK\x03\x04 */
function quickCheck(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    return b[0] === 0x50 && b[1] === 0x4b;
  } catch (_) {
    return false;
  }
}

module.exports = { parseApk, quickCheck, detectOrientation };
