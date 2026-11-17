'use strict';
/**
 * 资源分配（Bộ nhớ / CPU / 存储）của纯逻辑。
 *
 * 为什么要单独一层：「给安卓分多少Bộ nhớ」最终要落进 qemu 命令行（-memory / -cores），
 * 改完下次开机生效；但「Dùng户能填多Lớn」「填过头会发生什么」这套判断是纯函数，
 * 抽出来不依赖 electron，CI 里可以直接 require 做单测。
 *
 * 三条硬约束（都是实测踩出来của）：
 *   1. Bộ nhớ不能把宿主吃满：Windows + 前台程序至少要留 25%，否则整机开始换页，
 *      安卓侧表现为长时间黑屏、动画卡死，看起来像「模拟器坏了」。
 *   2. 存储要按「Gói cài đặt × 1.8 + 2GB」估：50GB của在线游戏解包后往往 80~90GB，
 *      只按Gói cài đặtLớnNhỏ放行，一定会装到一半Thất bại。
 *   3. 任何Tự động值都必须能算得出来：拿不到宿主信息就退回保守默认，不能返回 NaN。
 */

const DEFAULT_STEP_MB = 512;
const MIN_MEM_MB = 1024;
/** 给宿主（Windows + 前台程序）留của比例 */
const HOST_RESERVE_RATIO = 0.25;
/** 低于这cái比例就提示「偏紧」 */
const TIGHT_RATIO = 0.8;
/** 完全不够Dùng（连系统都跑不动）của绝对下限 */
const ABSOLUTE_MIN_MB = 768;

function toInt(v, fallback = 0) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 宿主能力。参数可注入，方便测试；不传就读Máy này。
 * @returns {{ totalMB:number, cores:number }}
 */
function hostProfile(sys) {
  let totalMB = 0;
  let cores = 0;
  const src = sys || {};
  if (Number(src.totalMB) > 0) {
    totalMB = toInt(src.totalMB);
  } else if (Number(src.totalmem) > 0) {
    totalMB = Math.round(Number(src.totalmem) / 1048576);
  } else {
    try {
      // require('os') 放在函数里：避免模块加载期就去碰宿主环境
      const os = require('os');
      totalMB = Math.round(os.totalmem() / 1048576);
      cores = os.cpus() ? os.cpus().length : 0;
    } catch (_) { totalMB = 0; }
  }
  if (Number(src.cores) > 0) cores = toInt(src.cores);
  return { totalMB, cores: Math.max(1, cores || 1) };
}

/**
 * Bộ nhớ可填范围。没读到Bộ nhớ máy chủ时给一cái保守上限，避免界面出现 0。
 * @returns {{ minMB:number, maxMB:number, stepMB:number, totalMB:number }}
 */
function memoryLimits(totalMB) {
  const total = toInt(totalMB);
  if (total <= 0) return { minMB: MIN_MEM_MB, maxMB: 8192, stepMB: DEFAULT_STEP_MB, totalMB: 0 };
  const usable = Math.floor((total * (1 - HOST_RESERVE_RATIO)) / DEFAULT_STEP_MB) * DEFAULT_STEP_MB;
  const maxMB = Math.max(MIN_MEM_MB, Math.min(usable, 65536));
  return { minMB: MIN_MEM_MB, maxMB, stepMB: DEFAULT_STEP_MB, totalMB: total };
}

/**
 * 把Dùng户填củaBộ nhớ收敛到合法值。0 = Tự động，原样返回 0（由各底座自己推导）。
 * @returns {{ mb:number, capped:boolean, reason:string }}
 */
function clampMemoryMB(mb, totalMB) {
  const want = toInt(mb);
  if (want <= 0) return { mb: 0, capped: false, reason: 'auto' };
  const lim = memoryLimits(totalMB);
  const rounded = Math.round(want / lim.stepMB) * lim.stepMB;
  if (rounded > lim.maxMB) {
    return {
      mb: lim.maxMB,
      capped: true,
      reason: `Bộ nhớ máy chủ ${Math.round(lim.totalMB / 1024)} GB, tối đa chỉ chia được ${Math.round(lim.maxMB / 1024)} GB(phải chừa 25% cho Windows)`,
    };
  }
  if (rounded < lim.minMB) return { mb: lim.minMB, capped: true, reason: `Android cần ít nhất ${lim.minMB} MB mới khởi động được` };
  return { mb: rounded, capped: rounded !== want, reason: rounded !== want ? 'Đã căn theo 512 MB' : '' };
}

/**
 * CPU nhân心数收敛。0 = Tự động。
 * 上限定在「物理nhân - 1」，至少留 1 nhân给宿主；单nhân机器只给 1 nhân。
 */
function clampCores(n, hostCores) {
  const want = toInt(n);
  const total = Math.max(1, toInt(hostCores) || 1);
  const max = total > 1 ? total - 1 : 1;
  if (want <= 0) return { cores: 0, capped: false, reason: 'auto' };
  if (want > max) {
    return { cores: max, capped: true, reason: `Máy này ${total} nhân, tối đa chia ${max} nhân (chừa 1 nhân cho Windows)` };
  }
  return { cores: Math.max(1, want), capped: false, reason: '' };
}

/**
 * Bộ nhớ分配合不合理（Dùng于界面提示 + 装Lớn包前提醒）。
 * @returns {{ level:'ok'|'tight'|'insufficient'|'unknown', ratio:number, note:string }}
 */
function memVerdict(allocMB, hostMB) {
  const alloc = toInt(allocMB);
  const host = toInt(hostMB);
  if (!alloc || !host) return { level: 'unknown', ratio: 0, note: '' };
  if (alloc < ABSOLUTE_MIN_MB) {
    return { level: 'insufficient', ratio: alloc / host, note: `Chỉ chia ${alloc} MB, Android có thể không lên được` };
  }
  const ratio = alloc / host;
  if (ratio > 1 - HOST_RESERVE_RATIO) {
    return {
      level: 'insufficient',
      ratio,
      note: `Chiếm của máy chủ ${Math.round(ratio * 100)}%  bộ nhớ, Windows sẽ bắt đầu hoán trang, trình giả lập càng giật hơn`,
    };
  }
  if (ratio > TIGHT_RATIO * (1 - HOST_RESERVE_RATIO)) {
    return { level: 'tight', ratio, note: `Đã dùng ${Math.round(ratio * 100)}%  bộ nhớ máy chủ, nên đóng các tab trình duyệt cùng lúc` };
  }
  return { level: 'ok', ratio, note: '' };
}

/** Cài đặt一cái包实际要占của数据Phân vùngTrống间（含解包与更新包冗余） */
function diskRequiredMB(packageBytes, ratio = 1.8, reserveMB = 2048) {
  const bytes = Math.max(0, Number(packageBytes) || 0);
  if (!bytes) return reserveMB;
  return Math.ceil((bytes / 1048576) * ratio) + reserveMB;
}

/**
 * 数据Phân vùng可填上限。Ổ đĩa chỉ còn一点时不能让人填 64GB 然后装到一半Thất bại。
 * @returns {{ maxGB:number, warnGB:number, freeMB:number }}
 */
function diskLimits(freeMB) {
  const free = Math.max(0, toInt(freeMB));
  // Phân vùng镜像本身还要占宿主Trống间（动态镜像会涨到接近Phân vùngLớnNhỏ），留 20% 缓冲
  const maxGB = Math.max(0, Math.floor((free / 1024) * 0.8));
  return { maxGB, warnGB: Math.max(0, maxGB - 8), freeMB: free };
}

/**
 * 收敛Dùng户填của数据Phân vùngLớnNhỏ（GB）。0 = Tự động。
 * @returns {{ gb:number, capped:boolean, reason:string }}
 */
function clampDataGB(gb, freeMB) {
  const want = toInt(gb);
  if (want <= 0) return { gb: 0, capped: false, reason: 'auto' };
  const lim = diskLimits(freeMB);
  if (!lim.freeMB) return { gb: want, capped: false, reason: '' };
  if (want > lim.maxGB) {
    return {
      gb: Math.max(0, lim.maxGB),
      capped: true,
      reason: `Ổ đĩa chứa chỉ còn ${(lim.freeMB / 1024).toFixed(1)} GB, tối đa chia được ${lim.maxGB} GB`,
    };
  }
  return { gb: want, capped: false, reason: '' };
}

/**
 * 存储是否够装这cái包。
 * @returns {{ ok:boolean, needMB:number, freeMB:number, shortMB:number, note:string }}
 */
function storageVerdict(freeMB, packageBytes) {
  const need = diskRequiredMB(packageBytes);
  const free = Math.max(0, toInt(freeMB));
  if (!free) return { ok: true, needMB: need, freeMB: 0, shortMB: 0, note: 'Không đọc được dung lượng đĩa còn trống, bỏ qua kiểm tra trước' };
  if (free >= need) return { ok: true, needMB: need, freeMB: free, shortMB: 0, note: '' };
  const short = need - free;
  return {
    ok: false,
    needMB: need,
    freeMB: free,
    shortMB: short,
    note: `Cần khoảng ${(need / 1024).toFixed(1)} GB, hiện chỉ còn ${(free / 1024).toFixed(1)} GB, còn thiếu ${(short / 1024).toFixed(1)} GB`,
  };
}

/**
 * 磁盘Trống间是否够装这cái包（50GB 级游戏最常见củaThất bại点）。
 * 和 storageVerdict của区别：这cái只看「够不够」，文案是给Cài đặt前拦下来Dùngcủa。
 * @returns {{ ok:boolean, unknown?:boolean, freeMB:number, requiredMB:number, message:string }}
 */
function diskVerdict(freeMB, requiredMB) {
  const free = Math.max(0, toInt(freeMB));
  const need = Math.max(0, toInt(requiredMB));
  if (!free) return { ok: true, unknown: true, freeMB: 0, requiredMB: need, message: '' };
  if (free >= need) return { ok: true, freeMB: free, requiredMB: need, message: '' };
  return {
    ok: false,
    freeMB: free,
    requiredMB: need,
    message: `Không đủ dung lượng đĩa: cần thêm khoảng ${Math.ceil(need / 1024)} GB, nhưng ổ đĩa chứa bộ chạy ApkStart chỉ còn ${(free / 1024).toFixed(1)} GB。`
      + 'Hãy chuyển thư mục bộ chạy sang phân vùng lớn hơn trong Cài đặt, hoặc dọn dẹp rồi thử lại.',
  };
}

module.exports = {
  DEFAULT_STEP_MB,
  MIN_MEM_MB,
  HOST_RESERVE_RATIO,
  hostProfile,
  memoryLimits,
  clampMemoryMB,
  clampCores,
  memVerdict,
  diskRequiredMB,
  diskVerdict,
  diskLimits,
  clampDataGB,
  storageVerdict,
};
