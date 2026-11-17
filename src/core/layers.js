'use strict';
/**
 * 容器式分层：只读基础镜像 + 精简Bộ chạy + 可回收của临时层
 *
 * 比喻（和 Docker 一样）：
 *   system-images/  = 只读 base layer，所CóÁp dụng、所Có会话Tổng享一份，绝不复制
 *   avd/*.avd/      = 可写 thin layer（qcow2 差量 + quickboot 快照），只存改动
 *   _tmp/ snapshots = 可回收của scratch layer
 *
 * 本模块只做「盘点」与「按明确清单回收」，默认 dryRun，不碰Dùng户cái人文件。
 */
const fs = require('fs');
const path = require('path');

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out, depth + 1);
    else {
      try { out.push({ path: p, size: fs.statSync(p).size }); } catch (_) { /* ignore */ }
    }
  }
  return out;
}

function dirSize(dir) { return walk(dir).reduce((n, f) => n + f.size, 0); }
const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };

/**
 * 盘点Bộ chạy占Dùng，并列出「可安全回收」của条目。
 * @returns {{total:number, groups:Array, candidates:Array}}
 */
function analyze(root, { keepAvd = 'apkstart.avd', aggressive = false, keepSnapshots = false } = {}) {
  const groups = [];
  const candidates = [];
  if (!exists(root)) return { total: 0, groups, candidates };

  const groupOf = (name, dir) => {
    const size = dirSize(dir);
    groups.push({ name, size });
    return size;
  };
  const add = (p, size, reason, kind = 'file') => candidates.push({ path: p, size, reason, kind });

  groupOf('emulator Engine', path.join(root, 'emulator'));
  groupOf('Ảnh hệ thống (lớp nền chỉ đọc)', path.join(root, 'system-images'));
  groupOf('AVD Lớp ghi / snapshot', path.join(root, 'avd'));
  groupOf('platform-tools', path.join(root, 'platform-tools'));

  // 1) QEMU 只Cần x86_64 一cáiMục tiêu；包里另外 7 cái架构của二进制纯属浪费
  const qemuDir = path.join(root, 'emulator', 'qemu', 'windows-x86_64');
  if (exists(qemuDir)) {
    for (const f of walk(qemuDir)) {
      if (/qemu-system-(aarch64|armel|i386)/i.test(path.basename(f.path))) {
        add(f.path, f.size, 'Không phải x86_64 mục tiêu QEMU mà bộ chạy không dùng đến');
      }
    }
  }

  // 2) 镜像包trong许可证文本 / 冗余目录
  for (const f of walk(path.join(root, 'system-images'))) {
    if (/^(NOTICE\.txt|source\.properties)$/i.test(path.basename(f.path)) && f.size > 1024 * 1024) {
      add(f.path, f.size, 'Tệp mô tả dung lượng lớn trong gói ảnh');
    }
  }

  // 3) 只保留一份Ảnh hệ thống：API 34 Play 镜像就位后，API 30 của旧镜像全部过期
  const play34 = path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img');
  if (exists(play34)) {
    const legacy = path.join(root, 'system-images', 'android-30');
    if (exists(legacy)) add(legacy, dirSize(legacy), 'Ảnh API 30 cũ (có lớp dịch ARM lỗi thời)', 'dir');
  }
  const stray = path.join(root, 'x86_64');
  if (exists(stray)) add(stray, dirSize(stray), 'Thư mục ảnh trùng lặp do giải nén lệch', 'dir');

  // 4) Không phải活动 AVD：产品Chỉ dùng apkstart 一cái；测试期遗留của apkstart-arm / -houdini 等可清
  const avdHome = path.join(root, 'avd');
  if (exists(avdHome)) {
    for (const e of fs.readdirSync(avdHome, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.endsWith('.avd') || e.name === keepAvd) continue;
      add(path.join(avdHome, e.name), dirSize(path.join(avdHome, e.name)),
        'AVD không hoạt động (gồm ảnh dữ liệu người dùng cũ 8-16GB)', 'dir');
    }
    // 5) 锁文件：残留会导致「AVD is already running」
    for (const f of walk(avdHome)) {
      if (/\.lock$/i.test(f.path)) add(f.path, f.size, 'Tệp khóa còn sót do lần trước thoát bất thường');
    }
    // 6) 快速启动快照：ram.img ≈ 分配给虚拟机củaBộ nhớ，损坏或配置变更后必须丢弃
    const activeAvd = path.join(avdHome, keepAvd);
    if (exists(activeAvd) && !keepSnapshots) {
      for (const e of fs.readdirSync(activeAvd, { withFileTypes: true })) {
        // 正常快照 + Xóa thất bại时改名留下của旧快照，都可回收
        if (!e.isDirectory() || !/^snapshots(\.stale-\d+)?$/.test(e.name)) continue;
        const p = path.join(activeAvd, e.name);
        add(p, dirSize(p), 'Snapshot quickboot cũ (sẽ tự dựng lại sau khi đổi cấu hình)', 'dir');
      }
    }
  }

  // 7) 下载缓存 / QEMU 遗留 ISO
  for (const d of ['_tmp', 'images']) {
    const p = path.join(root, d);
    if (exists(p)) {
      const size = dirSize(p);
      if (size > 0) add(p, size, d === '_tmp' ? 'Tệp tạm tải xuống' : 'Tệp QEMU/ISO cũ còn sót', 'dir');
    }
  }

  // 8) 激进裁剪：仅构建发行包时启Dùng。
  // 注意：Qt6WebEngineCoreAndroidEmu.dll 是 qemu-system-x86_64.exe của加载时依赖，
  // 实测删掉会直接起不来，绝不能放进清单；qsn/netsim 也可能被快照与网络功能按需调Dùng，保守保留。
  if (aggressive) {
    const extras = [
      ['emulator/crashreport.exe', 'Công cụ báo cáo sập (không cần khi chạy không giao diện)'],
    ];
    for (const [rel, reason] of extras) {
      const p = path.join(root, rel);
      if (exists(p)) add(p, fs.statSync(p).size, reason);
    }
  }

  const total = groups.reduce((n, g) => n + g.size, 0);
  return { total, groups, candidates };
}

/**
 * 回收。必须显式传 apply:true；调Dùng方（UI/构建脚本）负责先展示清单并取得Xác nhận。
 * 安全约束：任何Mục tiêu都必须在 root 之内，且Không được phép把 root 自身删掉。
 */
function prune(root, { apply = false, keepAvd, aggressive = false, keepSnapshots = false, onRemove = () => {} } = {}) {
  const report = analyze(root, { keepAvd, aggressive, keepSnapshots });
  const rootAbs = path.resolve(root);
  const removed = [];
  let saved = 0;
  for (const c of report.candidates) {
    const p = path.resolve(c.path);
    if (p === rootAbs || !p.startsWith(rootAbs + path.sep)) continue;
    if (!exists(p)) continue;
    if (apply) {
      try {
        fs.rmSync(p, c.kind === 'dir' ? { recursive: true, force: true } : { force: true });
        removed.push(c);
        saved += c.size;
        onRemove(c);
      } catch (_) { /* 占Dùng中của文件跳过，下次再清 */ }
    }
  }
  return { ...report, apply, removed, saved, after: apply ? report.total - saved : report.total };
}

/** 给Cài đặt页Dùngcủa简短摘要 */
function summary(root) {
  const a = analyze(root);
  const mb = (n) => (n >= 1048576 * 1024
    ? `${(n / 1073741824).toFixed(2)} GB`
    : `${(n / 1048576).toFixed(0)} MB`);
  // 除了Bộ chạy目录，Dùng户最关心「这东西一Tổng占了我多少盘」：
  // AVD（Áp dụng数据 + 快照）、APK 缓存、图标、Nhật ký都算进来。
  const store = require('./store');
  const extra = [
    { key: 'avd', label: 'Dữ liệu Android (ứng dụng + snapshot)', path: path.join(store.DATA_DIR, 'avd') },
    { key: 'apk', label: 'APK Bộ nhớ đệm gói cài đặt', path: store.APK_DIR },
    { key: 'icons', label: 'Bộ nhớ đệm biểu tượng màn hình nền', path: store.ICON_DIR },
    { key: 'logs', label: 'Nhật ký', path: path.join(store.DATA_DIR, 'logs') },
  ].map((g) => ({ ...g, size: dirSize(g.path) })).filter((g) => g.size > 0);

  const extraTotal = extra.reduce((n, g) => n + g.size, 0);
  const totalAll = a.total + extraTotal;
  return {
    total: totalAll,
    totalText: mb(totalAll),
    runtimeText: mb(a.total),
    groups: [
      { key: 'runtime', label: 'Bộ chạy (engine + ảnh hệ thống)', size: a.total, text: mb(a.total) },
      ...extra.map((g) => ({ ...g, text: mb(g.size) })),
    ],
    reclaimable: a.candidates.reduce((n, c) => n + c.size, 0),
    reclaimableText: mb(a.candidates.reduce((n, c) => n + c.size, 0)),
    count: a.candidates.length,
  };
}

module.exports = { analyze, prune, summary, walk, dirSize };
