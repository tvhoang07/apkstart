'use strict';
/**
 * Cài đặt / 启动 / Gỡ cài đặt 编排层
 * 把「解析 APK → Cài đặt进Bộ chạy → 落本地元数据 → 生成Màn hình nền快捷方式」串成一条流水线。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { parseApk } = require('./apk');
const { ZipFile } = require('./zip');
const { iconToIco, writeShortcut, removeShortcut, safeFileName, shortcutExt } = require('./shortcut');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** APK 只Có ARM 原生库（国产 App 绝Lớn多数如此） */
function isArmOnly(meta) {
  return !!(meta && meta.abis && meta.abis.length && !meta.abis.some((a) => /x86/i.test(a)));
}

/**
 * 拆分Gói cài đặt（.apks / .xapk）：解出里面củaPhân mảnh APK 到纯 ASCII 临时目录。
 * Dùng文件版 ZIP 读取器 + 流式落盘：拆分包动辄 2GB+，整包读Bộ nhớ会Thất bại。
 * 返回 { meta, files, cleanup }；meta 来自带 AndroidManifest của base APK。
 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  const dir = path.join(os.tmpdir(), 'apkstart-bundle', crypto.createHash('sha1')
    .update(filePath).digest('hex').slice(0, 12));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try {
    const apkNames = zip.names().filter((n) => /\.apk$/i.test(n));
    if (!apkNames.length) throw new Error('Không tìm thấy phân mảnh APK trong gói cài đặt này (có thể không phải .apks/.xapk)');
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < apkNames.length; i++) {
      const target = path.join(dir, `split-${i}.apk`);
      // 单cáiPhân mảnh也可能是几百 MB：流式Giải nén，不经过 Buffer
      // eslint-disable-next-line no-await-in-loop
      await zip.pipeTo(apkNames[i], fs.createWriteStream(target));
      files.push(target);
    }
    let meta = null;
    for (const f of files) {
      try { meta = parseApk(f); break; } catch (_) { /* Phân mảnh里没Có清单 */ }
    }
    if (!meta) throw new Error('Phân tích base APK của gói tách thất bại');
    return { meta, files, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    zip.close();
  }
}

function accentOf(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 52%)`;
}

class Installer {
  constructor(runtime, ctx) {
    this.runtime = runtime;
    this.ctx = ctx; // { launcherTarget, launcherArgs, cwd, isDev, desktopDir }
  }

  shortcutTarget() {
    const { launcherTarget, launcherArgs } = this.ctx;
    return { target: launcherTarget, baseArgs: launcherArgs || '' };
  }

  iconFile(pkg) { return store.iconPath(pkg); }

  icoFile(pkg) { return path.join(store.ICON_DIR, `${pkg}.ico`); }

  shortcutPath(app) {
    const s = store.getSettings();
    const dir = s.shortcutDir && s.shortcutDir.trim() ? s.shortcutDir : this.ctx.desktopDir;
    return path.join(dir, `${safeFileName(app.label)}${shortcutExt()}`);
  }

  /**
   * Màn hình nền + 开始菜单两份。
   * Windows 搜索索引của是「开始菜单 \ 程序」trong .lnk，只放Màn hình nền会搜不到；
   * Có些机器củaMàn hình nền被 OneDrive 重定向，开始菜单这份也保证入口不丢。
   *
   * Linux（FydeOS）那边对应của是 freedesktop của .desktop：
   * Màn hình nền一份，Áp dụng菜单 ~/.local/share/applications 一份。
   */
  shortcutPaths(app) {
    const out = [this.shortcutPath(app)];
    if (this.ctx.startMenuDir && store.getSettings().createStartMenuShortcut !== false) {
      // 放在独立子目录：既能被 Windows 搜索索引到，又不会覆盖同名第三方Áp dụngcủa快捷方式
      // （实测「红果免费短剧」在开始菜单里已被另一cáiMàn hình nền助手占Dùng）
      out.push(path.join(this.ctx.startMenuDir, 'ApkStart', `${safeFileName(app.label)}${shortcutExt()}`));
    }
    return [...new Set(out)];
  }

  /** Ảnh hệ thống tương thích按「首次遇到 ARM Áp dụng」按需下载，作为Tổng享只读基础层只下一次 */
  async ensureCompatImage(onProgress) {
    const prov = this.runtime.provisioner;
    if (prov.playImageInfo().ok) return true;
    onProgress({ stage: 'runtime', message: 'Lần đầu cài ứng dụng ARM: đang tải ảnh tương thích (khoảng 1.5GB, chỉ một lần)…' });
    await prov.installPlayImage((p) => onProgress({ stage: 'runtime', message: p.message, percent: p.percent }));
    if (!prov.playImageInfo().ok) throw new Error('Tải ảnh tương thích thất bại, hãy kiểm tra mạng rồi thử lại');
    return true;
  }

  /** 切换镜像必须重启Bộ chạy；重启后把Ứng dụng đã cài从本地 APK 备份重新灌回去 */
  async switchToCompat(onProgress) {
    const apps = store.getApps();
    store.saveSettings({ runtime: { compatImage: true } });
    onProgress({ stage: 'runtime', message: 'Đang chuyển sang ảnh hệ thống tương thích và khởi động lại bộ chạy…' });
    try { await this.runtime.stop(); } catch (_) { /* ignore */ }
    // 等旧设备从 adb 列表里消失，避免被 ensure() 当成可复Dùng实例
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ds = await this.runtime.client().devices().catch(() => []);
      if (!ds.some((d) => /^emulator-\d+$/.test(d.serial))) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
    if (!rt.ok) {
      const err = new Error(rt.error || 'Bộ chạy không dùng được sau khi chuyển ảnh tương thích');
      err.needsSetup = rt.needsSetup || 'provision';
      throw err;
    }
    for (const app of apps) {
      if (!app.apkPath || !fs.existsSync(app.apkPath)) continue;
      try {
        if (app.bundle) {
          // eslint-disable-next-line no-await-in-loop
          const b = await parseBundle(app.apkPath);
          // eslint-disable-next-line no-await-in-loop
          await rt.client.installMultiple(b.files);
          b.cleanup();
        } else {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.install(app.apkPath);
        }
        onProgress({ stage: 'runtime', message: `Đang khôi phục ứng dụng đã cài ${app.label}…` });
      } catch (_) { /* 单 ứng dụng恢复Thất bại不阻塞 */ }
    }
    return rt;
  }

  async install(filePath, onProgress = () => {}) {
    onProgress({ stage: 'parse', message: 'Đang phân tích APK…' });
    let meta;
    let bundle = null;
    if (/\.(apks|xapk)$/i.test(filePath)) {
      bundle = await parseBundle(filePath);
      meta = bundle.meta;
    } else {
      meta = parseApk(filePath);
    }
    onProgress({
      stage: 'parse-done',
      message: `Đã nhận dạng ${meta.label}（${meta.package}）`,
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    // 50GB 级游戏：先nhân对模拟器数据盘剩余Trống间，而不是装到一半才报
    // INSTALL_INSUFFICIENT_STORAGE（Dùng户看到của是「装了很久然后Thất bại」）。
    try {
      const backend = this.runtime && this.runtime.backend;
      if (backend && typeof backend.checkDiskFor === 'function') {
        let bytes = 0;
        if (bundle && bundle.files) {
          for (const f of bundle.files) {
            try { bytes += fs.statSync(f).size; } catch (_) { /* 忽略临时文件 */ }
          }
        } else {
          try { bytes = fs.statSync(filePath).size; } catch (_) { /* Dùng 0 兜底 */ }
        }
        const verdict = backend.checkDiskFor(bytes);
        if (!verdict.ok) {
          onProgress({ stage: 'error', message: verdict.message });
          const err = new Error(verdict.message);
          err.needsSetup = 'disk';
          throw err;
        }
      }
    } catch (e) {
      if (e && e.needsSetup === 'disk') throw e;
      // 容量探测Thất bại不能挡住Cài đặt
    }

    try {
      // 零配置：仅含 ARM 库củaÁp dụngTự động补齐带 ARM 翻译层của镜像，Dùng户不Dùng开任何开关
      if (isArmOnly(meta) && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const switched = await this.switchToCompat(onProgress);
        return this.finishInstall(switched, meta, filePath, bundle, onProgress);
      }

      onProgress({ stage: 'runtime', message: 'Đang chuẩn bị bộ chạy Android…' });
      const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
      if (!rt.ok) {
        const err = new Error(rt.error || 'Bộ chạy không khả dụng');
        err.needsSetup = rt.needsSetup || 'provision';
        throw err;
      }
      return await this.finishInstall(rt, meta, filePath, bundle, onProgress);
    } finally {
      if (bundle) bundle.cleanup();
    }
  }

  /** Cài đặt本体 + 落盘元数据 + 快捷方式；Thất bại时带一次Tự độngSửa重试 */
  async finishInstall(rt, meta, filePath, bundle, onProgress) {
    const client = rt.client;
    const existing = store.getApp(meta.package);
    // 装完之后旧 quickboot 快照trong磁盘状态就过期了，留着会导致「装好củaÁp dụng重启后又不见了」
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    onProgress({ stage: 'install', message: existing ? 'Đang cập nhật ứng dụng…' : 'Đang cài đặt ứng dụng…' });
    try {
      if (bundle) await client.installMultiple(bundle.files);
      else await client.install(filePath);
    } catch (e) {
      // 到了这一步还报 ABI 不匹配：说明当前Bộ chạy是 AOSP 镜像，Tự động切Ảnh hệ thống tương thích再装一次
      if (e.code === 'NO_MATCHING_ABIS' && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const rt2 = await this.switchToCompat(onProgress);
        onProgress({ stage: 'install', message: 'Đã chuyển sang ảnh tương thích, đang cài lại…' });
        if (bundle) await rt2.client.installMultiple(bundle.files);
        else await rt2.client.install(filePath);
      } else {
        throw e;
      }
    }
    this.runtime.touch();

    // 图标落盘。APK 图标Lớn量是 WebP，nativeImage 解不了，交给渲染进程解码 +
    // 品牌占位图兜底，保证 .lnk 一定带图标（之前 icoPath 一直是 null）。
    // iconFallback 记录「真实图标解不出来、Dùng了占位图」——这种要作为软警告告诉Dùng户，
    // 否则Màn hình nền上只Có一片绿色三角，Dùng户会以为是 ApkStart 弄错了图标。
    let iconPath = null;
    let icoPath = null;
    let iconFallback = '';
    if (meta.iconPng) {
      try {
        iconPath = store.iconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconPng);
      } catch (_) { /* ignore */ }
      try {
        const ico = await iconToIco(meta.iconPng, {
          decode: this.ctx.decodeIcon,
          onFallback: (why) => { iconFallback = why; },
        });
        if (ico) {
          icoPath = this.icoFile(meta.package);
          fs.writeFileSync(icoPath, ico);
        }
      } catch (_) { /* 图标Thất bại不影响Cài đặt */ }
    }

    // 备份 APK，便于日后重装/找回
    let apkCopy = null;
    try {
      apkCopy = store.apkPath(meta.package, meta.versionCode.toString(36));
      fs.copyFileSync(filePath, apkCopy);
    } catch (_) { /* ignore */ }

    // 启动入口以系统解析结果为准：APK 里解析到của「主 Activity」经常不是
    // 真正của LAUNCHER 入口，直接Dùng它启动会跳过Áp dụngcủa初始化页导致闪退。
    let launchActivity = meta.launchActivity;
    try {
      client.clearLauncherCache?.(meta.package);
      const resolved = await client.resolveLauncher(meta.package);
      if (resolved) launchActivity = resolved;
    } catch (_) { /* 保留 APK 解析结果 */ }

    const app = {
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity: launchActivity,
      abis: meta.abis,
      minSdk: meta.minSdk,
      sizeBytes: meta.sizeBytes,
      iconPath,
      icoPath,
      apkPath: apkCopy,
      bundle: !!bundle,
      accent: existing ? existing.accent : accentOf(meta.package),
      installedAt: existing ? existing.installedAt : Date.now(),
      updatedAt: Date.now(),
      launchCount: existing ? existing.launchCount || 0 : 0,
      lastLaunchAt: existing ? existing.lastLaunchAt || 0 : 0,
      shortcutPath: existing ? existing.shortcutPath || null : null,
      bounds: existing ? existing.bounds || null : null,
      // Áp dụng天然của横Màn dọc（离线从 APK 清单算出来）：
      // 决定模拟器物理面板Dùng哪cái方向，方向一致画面才能铺满窗口不留黑边。
      // Dùng户手动设过 orientationOverride 时以Dùng户của为准，这里只是「默认值」。
      orientation: meta.orientation || (existing ? existing.orientation || null : null),
      pinned: existing ? !!existing.pinned : false,
    };

    store.upsertApp(app);

    const settings = store.getSettings();
    if (settings.createShortcutOnInstall) {
      onProgress({ stage: 'shortcut', message: 'Đang tạo lối tắt trên màn hình nền…' });
      try {
        app.shortcutPath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: app.shortcutPath });
      } catch (e) {
        onProgress({ stage: 'shortcut-warn', message: `Tạo lối tắt thất bại:${e.message}` });
      }
    }

    // Gợi ý tương thích：只Có ARM 原生库时，x86 Bộ chạyCần转译层
    const warnings = [];
    if (meta.minSdk && meta.minSdk > 34) {
      warnings.push(`Ứng dụng này yêu cầu Android ${meta.minSdk}+, cao hơn bộ chạy hiện tại, có thể không chạy bình thường.`);
    }
    if (iconFallback === 'placeholder') {
      warnings.push('Không giải mã được biểu tượng ứng dụng (có thể là biểu tượng thích ứng định dạng đặc biệt), lối tắt tạm dùng biểu tượng giữ chỗ.');
    } else if (iconFallback === 'webp-decode-failed') {
      warnings.push('Giải mã biểu tượng ứng dụng (WebP) thất bại, lối tắt tạm dùng biểu tượng giữ chỗ.');
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});
    // 装Áp dụng时作废了旧快照，这里补排一lần:Trống闲时把「已装好新Áp dụng」của状态存下来，
    // 否则下次开机要重新Khởi động nguội（20 多giây)。
    try { this.runtime.scheduleSnapshotSave?.(12000); } catch (_) { /* ignore */ }

    onProgress({ stage: 'done', message: `${app.label} Cài đặt hoàn tất`, app });
    return { app, warnings, engine: rt.engine };
  }

  createShortcut(app) {
    const { target, baseArgs } = this.shortcutTarget();
    const args = `${baseArgs ? baseArgs + ' ' : ''}--launch "${app.package}"`.trim();
    const ico = app.icoPath && fs.existsSync(app.icoPath) ? app.icoPath : undefined;
    // Linux của .desktop 只认 PNG/SVG 绝对Đường dẫn，ICO Không hợp lệ —— 所以两条Đường dẫn都传下去，
    // 由 writeShortcut 按平台挑。（Windows Dùng ico，FydeOS Dùng png）
    const png = app.iconPath && fs.existsSync(app.iconPath) ? app.iconPath : undefined;
    const paths = this.shortcutPaths(app);

    const write = (shortcutPath) => writeShortcut({
      shortcutPath,
      target,
      args,
      iconIcoPath: ico,
      iconPngPath: png,
      description: `${app.label} — do ApkStart chạy`,
      cwd: this.ctx.cwd,
      // 每 ứng dụng一cái AUMID：任务栏上按Áp dụng分组，不会全挤到 ApkStart 里
      appUserModelId: `RoutineMiku.ApkStart.${app.package}`.slice(0, 128),
    });

    let first = null;
    let startMenuPath = null;
    const errors = [];
    paths.forEach((p, i) => {
      try {
        write(p);
        if (!first) first = p;
        if (i === 1) startMenuPath = p;
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    });

    // 主Đường dẫn全Thất bại（自定义Thư mục lối tắt不可写 / 被安全软件拦截）：
    // 退回Màn hình nền再试一次——Màn hình nền上Có图标，Dùng户才找得到Áp dụng。
    if (!first) {
      const fallback = path.join(this.ctx.desktopDir, `${safeFileName(app.label)}${shortcutExt()}`);
      try {
        write(fallback);
        first = fallback;
      } catch (e) {
        errors.push(`${fallback}: ${e.message}`);
      }
    }
    if (!first) throw new Error(errors.join('; ') || 'Tạo lối tắt thất bại');
    // 开始菜单那份củaĐường dẫn也存下来，Gỡ cài đặt时一起删
    if (startMenuPath || first) {
      store.upsertApp({ package: app.package, startMenuPath });
    }
    return first;
  }

  /** 补全Thiếu失của快捷方式与图标：老版本只建了Màn hình nền那份，且 WebP 图标当时没转成功 */
  async ensureShortcuts() {
    const made = [];
    // Dùng户明确关掉「Cài đặt后Tự độngTạo」、且这 ứng dụng本来就没Có任何入口时不要擅自补，
    // 否则开关关掉了也挡不住启动时被重建。
    const auto = store.getSettings().createShortcutOnInstall !== false;
    for (const app of store.getApps()) {
      if (!auto && !app.shortcutPath && !app.startMenuPath) continue;
      let dirty = false;
      if ((!app.icoPath || !fs.existsSync(app.icoPath)) && app.iconPath && fs.existsSync(app.iconPath)) {
        try {
          const ico = await iconToIco(fs.readFileSync(app.iconPath), { decode: this.ctx.decodeIcon });
          if (ico) {
            const p = this.icoFile(app.package);
            fs.writeFileSync(p, ico);
            store.upsertApp({ package: app.package, icoPath: p });
            app.icoPath = p;
            dirty = true;
          }
        } catch (_) { /* 图标补建Thất bại不影响入口 */ }
      }
      const missing = this.shortcutPaths(app).filter((p) => !fs.existsSync(p));
      if (!missing.length && !dirty) continue;
      try {
        // 图标刚补出来时，即使 .lnk 存在也要重建，让快捷方式换上真实Áp dụng图标
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath });
        made.push(app.label);
      } catch (_) { /* 单cáiThất bại不阻塞启动 */ }
    }
    return made;
  }

  async uninstall(pkg, { removeShortcut: rm = true } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure();
    if (rt.ok) await rt.client.uninstall(pkg).catch(() => {});
    if (app && rm) {
      removeShortcut(app.shortcutPath);
      removeShortcut(app.startMenuPath);
    }
    if (app) {
      try { if (app.iconPath && fs.existsSync(app.iconPath)) fs.unlinkSync(app.iconPath); } catch (_) {}
      try { if (app.icoPath && fs.existsSync(app.icoPath)) fs.unlinkSync(app.icoPath); } catch (_) {}
      try { if (app.apkPath && fs.existsSync(app.apkPath)) fs.unlinkSync(app.apkPath); } catch (_) {}
    }
    store.removeApp(pkg);
    return true;
  }

  async launch(pkg, { onLog = () => {}, beforeStart = null, onMark = () => {}, onAppUp = null } = {}) {
    const app = store.getApp(pkg);
    // Dùng let：beforeStart 可能因là “面板方向和Áp dụng方向不一致」而重启Bộ chạy并
    // 返回一cái新của rt（旧 client 已随 stop 失效）。以前这里是 const，一旦真của
    // 走了重启分支就抛 "Assignment to constant variable."，把整cái启动打断 ——
    // 表现là “切Màn ngang/Màn dọc后点Áp dụng直接Thất bại」。
    let rt = await this.runtime.ensure({ onLog });
    onMark('ensure done');
    if (!rt.ok) {
      const err = new Error(rt.error || 'Bộ chạy không khả dụng');
      err.needsSetup = rt.needsSetup;
      throw err;
    }
    // 分辨率要在拉起Áp dụng之前改，避免 wm size 触发配置变更把刚启动của Activity 重建
    if (beforeStart) {
      const replaced = await beforeStart(rt).catch((e) => { onLog(`Bỏ qua thích ứng hiển thị:${e.message}`); return null; });
      // beforeStart 可以返回一cái新của rt（重启Bộ chạy后旧 client 已失效），
      // 后续全部Dùng新của。不返回就Tiếp tụcDùng原来của。
      if (replaced && replaced.client) rt = replaced;
    }
    // 清掉旧版本可能残留在 /data trong wm size / density 覆盖与Tự động旋转Cài đặt。
    // 这些覆盖是持久化của，不Dọn dẹpcủa话每次启动画面都会被转 90° 躺倒、留黑边、
    // 鼠标点击也无法对应（Dùng户反馈của「旋转黑边 / 未填满 / 点不动同意」）。
    await rt.client.resetDisplayOverrides(!!(store.getSettings().display || {}).landscape).catch(() => {});
    // Khởi động nguội时顺手做过网络Kiểm tra sức khỏe：没网就直接说清楚。否则Dùng户只会看到「这 ứng dụng一直黑屏」，
    // 完全想不到是虚拟机没网（联网页面拿不到数据就是一块黑底）。
    // 关键Sửa：Wi-Fi 关联往往比 sys.boot_completed 晚几十秒，红果一进去就拉首页数据，
    // 没网时首页渲染成整块黑底 —— 这就是「点同意并Tiếp tục后一直黑屏」của真正原因。
    // 所以拉起Áp dụng前先等网络Sẵn sàng（最多 90 giây)，宁可多等几秒也不要给Dùng户一块黑屏。
    // 拉起来之前先看一眼网络：**只等，不重启**。
    // 之前这里调của是 ensureNetwork()，网络慢时会「停掉虚拟机 → Khởi động nguội」，
    // 结果 adb 设备在Cài đặt途中消失，直接变成「红果打不开」。
    // 启动Đường dẫn上绝不能做这种破坏性动作，等不到就先启动，Lớn不了页面暂时加载慢。
    if (rt.engine === 'emulator' || rt.engine === 'builtin') {
      let net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 20000 }).catch(() => null);
      if (net && net.ok) {
        onLog(`Mạng máy ảo sẵn sàng (${net.ip || ''}）`);
      } else {
        // 等不到网络时，做一次**Không phải破坏性**của补救：把「Đã lưu但不会Tự động连」
        // của AndroidWifi 点一下。它不重启虚拟机、不碰Dùng户数据，只是拉起Cài đặt页
        // 点一条Đã lưucủa热点，所以放在启动Đường dẫn上是安全của。
        // 实机上「虚拟机一直没网」绝Lớn多数就是这cái原因（见 emulator.repairWifi）。
        onLog('Máy ảo không kết nối được Wi-Fi, đang thử kết nối lại…');
        try {
          // 注意：repairWifi 挂在 engine（this.runtime）上，不在 rt 上。
          // rt 是 ensure() của返回对象 { ok, client, engine, ... }，里面只Có client；
          // 写成 rt.repairWifi 会是 undefined，一调就抛 TypeError 被 catch 吞掉，
          // 表现就是「Nhật ký打了正在重连，但 1 毫秒后就说还是没网」。
          const fixed = await this.runtime.repairWifi().catch(() => false);
          if (fixed) {
            net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 15000 }).catch(() => null);
            if (net && net.ok) {
              onLog(`Mạng máy ảo đã khôi phục (${net.ip || ''}）`);
              // 关键：把「网络已连上」这cái状态立刻存进快照。
              // 不存của话下次开机还是从「没网」của旧快照恢复，每次都要再花十几秒重连。
              // Dùng forceSnapshotSave 是因为马上要启动Áp dụng，永远等不到「Trống闲」。
              try { this.runtime.forceSnapshotSave?.(3000); } catch (_) { /* 存不下不影响启动 */ }
            }
          }
        } catch (e) {
          // 不要把异常吞得无声无息：这条Nhật ký就是「重连到底跑没跑」của唯一证据。
          onLog(`Tự kết nối lại Wi-Fi thất bại:${e.message}`);
        }
        if (!net || !net.ok) {
          onLog('Mạng máy ảo chưa sẵn sàng, hãy mở ứng dụng trước (trang cần mạng có thể tải chậm hơn)');
        }
      }
    }
    const settings = store.getSettings();
    const start = () => rt.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
      freeform: settings.freeform,
      bounds: app ? app.bounds : null,
    });
    // Áp dụng可能还没装进当前Bộ chạy（镜像重建 / 清过数据 / 首次），直接拉起会报
    // "Invalid packageName"。先在本地缓存里把它装上再启动，这样「点开Áp dụng」永远能进，
    // 不Dùng先手动装一遍——这正是「点击Đã cài đặtÁp dụng直接进入系统」想要của体验。
    // 关键: dùng isInstalled()（pm path + 逐cáinhân对 APK 文件真实存在）而不是
    // `pm list packages`。快照与数据Phân vùng不一致时 PackageManager 仍报 installed=true，
    // 但 /data/app 下文件已被回滚掉 —— 这时 am start 必然Thất bại。文件校验不通过就重装。
    if (app && app.apkPath && fs.existsSync(app.apkPath)) {
      let installed = false;
      try { installed = await rt.client.isInstalled(pkg); } catch (_) { /* 当作Chưa cài đặt，走重装 */ }
      if (!installed) {
        onLog('Thiếu tệp ứng dụng (snapshot và dữ liệu không khớp), đang tự cài lại từ bản sao lưu cục bộ…');
        // 重装前作废快照：否则旧快照của packages.xml 仍说「已装」，下次又不对
        try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
        await rt.client.install(app.apkPath).catch((e) => onLog(`Tự cài đặt thất bại:${e.message}`));
      }
    }
    // 观察 25 秒并要求「连续存活 5 秒」才算启动成功。
    // 关键：进程"还没起来"和"起来过又没了"必须分开看。以前一看到 pidof 为Trống就判Thất bại，
    // 结果Lớn型Áp dụng（红果这种首启要十几秒của）在加载途中就被 force-stop 重启，
    // 反复三轮才勉强起来，Dùng户感知就是"点了要等一phút"。
    const staysAlive = async () => {
      const t0 = Date.now();
      let aliveSince = 0;
      let seen = false;
      while (Date.now() - t0 < 25000) {
        // 先查再睡：常驻容器里热启动往往 1 秒内就能看到进程，
        // 先 sleep 1 秒等于把最快của那条Đường dẫn硬生生拖慢一秒。
        // eslint-disable-next-line no-await-in-loop
        const pid = await rt.client.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
        if (!String(pid).trim()) {
          if (seen) return false; // 起来过又消失 = 真của崩了
        } else {
          if (!seen && typeof onAppUp === 'function') {
            // 进程刚出现就把画面接上去（不等那 4 秒观察期）。
            // 这 4 秒是在等「Xác nhận不会马上崩」，但Dùng户看到của是「点了没反应」；
            // 先让他看到Áp dụng在加载，观感比藏 4 秒好得多。
            // 回调是 fire-and-forget：它Thất bại了也不影响后面của存活判定。
            try { onAppUp(); } catch (_) { /* ignore */ }
          }
          seen = true;
          if (!aliveSince) aliveSince = Date.now();
          if (Date.now() - aliveSince >= 4000) return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
      return seen; // 一直没见过进程才算Thất bại
    };
    try {
      // 先确保Bộ chạy权限齐备：Cài đặt时của -g 在清过数据后可能失效，
      // Thiếu权限时Áp dụng会被系统授权框挡住，Dùng户看到của就是「点了没反应/打不开」。
      await rt.client.grantRuntimePermissions(pkg).catch(() => {});
      onMark('permissions granted');
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        if (attempt > 1) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.forceStop(pkg).catch(() => {});
          // 授权框挡在最前面时，Áp dụng看起来就是「打不开」；先补授权再收掉弹窗
          // eslint-disable-next-line no-await-in-loop
          await rt.client.grantRuntimePermissions(pkg).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await rt.client.dismissPermissionDialog().catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await sleep(600 * attempt);
        }
        let started = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await start();
        } catch (e) {
          // Có明确崩溃Nhật ký才交给外层（可能要切Ảnh hệ thống tương thích）；没Có证据多半只是启动慢，重试即可
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
          started = false;
        }
        onMark(`am start #${attempt} ${started ? 'ok' : 'fail'}`);
        // Activity 起来后立刻把方向锁死。放在这里是因为Áp dụng启动过程本身会触发
        // 配置变更（Activity 重建），启动前设của user-rotation 可能被系统重置回 0 ——
        // 一旦回 0，Bảng màn ngang上của画面就会躺倒 90°（Dùng户看到của就是「转不正」）。
        if (started) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.setOrientation(!!(store.getSettings().display || {}).landscape).catch(() => {});
        }
        // eslint-disable-next-line no-await-in-loop
        ok = started ? await staysAlive() : false;
        onMark(`alive #${attempt} ${ok}`);
        if (!ok && attempt < 3) onLog(`Ứng dụng thoát sau khi khởi động (lần ${attempt} lần), đang tự thử lại…`);
      }
      if (!ok) {
        // 兜底：异常Thoát会留下「半初始化」của数据，导致之后每次都崩。
        // 清一次Áp dụng数据再拉起来，成功率最高（Dùng户不必自己去Cài đặt里清缓存）。
        onLog('Ứng dụng liên tục thoát, đang đặt lại dữ liệu ứng dụng rồi thử lại…');
        await rt.client.shell(`pm clear ${pkg}`, { timeout: 20000 }).catch(() => '');
        await sleep(800);
        // pm clear 会把Bộ chạy权限一并清掉，必须重新授，否则会卡在系统授权框
        await rt.client.grantRuntimePermissions(pkg).catch(() => {});
        await start().catch((e) => {
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
        });
        ok = await staysAlive();
        if (!ok) await rt.client.dismissPermissionDialog().catch(() => {});
      }
      if (!ok) {
        const err = new Error('Ứng dụng thoát ngay sau khi khởi động, đã tự thử lại và đặt lại dữ liệu ứng dụng nhưng vẫn không được');
        err.code = 'APP_UNSTABLE';
        throw err;
      }
    } catch (e) {
      if (e.code === 'APP_CRASHED' && !this.runtime.provisioner.playImageInfo().ok) {
        // 崩溃来自 ARM 翻译层：Tự động切镜像、重装备份 APK、再启动一次
        onLog('Phát hiện lớp dịch ARM bị sập, đang tự chuyển sang ảnh hệ thống tương thích…');
        await this.ensureCompatImage(onLog ? (m) => onLog(m.message || '') : () => {});
        const rt2 = await this.switchToCompat((m) => onLog(m.message || ''));
        if (app && app.apkPath && fs.existsSync(app.apkPath)) {
          try { await rt2.client.install(app.apkPath); } catch (_) { /* 保留原包 */ }
        }
        await rt2.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
          freeform: settings.freeform,
          bounds: app ? app.bounds : null,
        });
      } else {
        throw e;
      }
    }
    this.runtime.touch();
    if (app) {
      store.upsertApp({
        package: app.package,
        launchCount: (app.launchCount || 0) + 1,
        lastLaunchAt: Date.now(),
      });
    }
    return { ok: true, engine: rt.engine };
  }
}

module.exports = { Installer, accentOf, parseBundle };
