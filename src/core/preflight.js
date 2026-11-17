'use strict';
/**
 * Máy nàyKiểm tra sức khỏe + Tự cấu hình。
 *
 * 为什么Cần它：ApkStart 装完之后能不能跑，取决于四件和软件无关của事 ——
 *   1. CPU 虚拟化（VT-x / AMD-V）在 BIOS 里Có没Có开；
 *   2. Windows của「虚拟机监控程序平台 / Hyper-V」Có没Có开（WHPX 靠它）；
 *   3. 显卡能撑到什么程度（厂商、VRAM、Trình điều khiển版本，能不能走硬件渲染）；
 *   4. Bộ nhớ / 磁盘够不够开一台 2~8GB của安卓虚拟机。
 *
 * 这些以前都是「Khởi động thất bại → Dùng户看Nhật ký → 自己猜」。Hiện先查一遍，能Tự động改của直接改
 * （Bộ nhớ、nhân心、画质、渲染后端），必须提权của给出一cái按钮（开功能 / 装Trình điều khiển），
 * 只能在 BIOS 里做của说清楚按哪cái键、改成什么。
 *
 * 分层：
 *   - collect()   —— 只做探测（Windows 上Dùng一次 PowerShell 取全部信息），Có降级Đường dẫn；
 *   - evaluate()  —— 纯函数：把探测结果翻译成「Kiểm tra sức khỏemục + 建议配置」，可单测；
 *   - Áp dụng动作在 main.js（保存Cài đặt / 调已Cócủa提权接口），本模块不碰权限。
 *
 * 注意：**不假装能替Dùng户开 BIOS 虚拟化**。那一步只能人去改，我们只负责判断和指路。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

// ---------------- 探测 ----------------

/**
 * 跑一段快捷脚本（Windows của powershell.exe），取 JSON；Thất bại/Hết thời gian返回 null。
 *
 * Dùng异步 execFile 而不是 execFileSync：脚本启动 + 两条 CIM 查询要 1~2 秒，
 * 同步跑会把主进程（也就是整cái界面）卡住，Dùng户会以为点「Kiểm tra sức khỏe」把程序点死了。
 */
function psJson(script, timeout = 15000) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const { execFile } = require('child_process');
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { encoding: 'utf8', windowsHide: true, timeout }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const t = String(stdout || '').trim();
        if (!t) { resolve(null); return; }
        try { resolve(JSON.parse(t)); } catch (_) { resolve(null); }
      });
    } catch (_) {
      resolve(null);
    }
  });
}

const HW_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,VirtualizationFirmwareEnabled,VMMonitorModeExtensions,SecondLevelAddressTranslationExtensions;',
  '$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 HypervisorPresent,TotalPhysicalMemory;',
  '$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,DriverDate,AdapterRAM,VideoProcessor,Status);',
  // AdapterRAM 在 >4GB 时会被截成 4294967295；真实值在注册表 qwMemorySize（每cái适配器一cái 000N 子键）
  '$vram = 0;',
  'Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}" -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $v = (Get-ItemProperty $_.PSPath -Name "HardwareInformation.qwMemorySize" -ErrorAction SilentlyContinue)."HardwareInformation.qwMemorySize";',
  '  if ($v -and $v -gt $vram) { $vram = $v }',
  '};',
  '[pscustomobject]@{ cpu = $cpu; cs = $cs; gpu = $gpu; vram = $vram } | ConvertTo-Json -Depth 6 -Compress',
].join(' ');

const FEATURE_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$o = [ordered]@{};',
  'foreach ($n in @("HypervisorPlatform","VirtualMachinePlatform","Microsoft-Hyper-V-All")) {',
  '  try { $o[$n] = (Get-WindowsOptionalFeature -Online -FeatureName $n -ErrorAction Stop).State } catch { $o[$n] = "unknown" }',
  '}',
  '$o | ConvertTo-Json -Compress',
].join(' ');

/** 判断文件存在（探测 WHPX của API 库 / AEHD Trình điều khiển / 虚拟机平台服务） */
function fileExists(rel) {
  try {
    return fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', rel));
  } catch (_) {
    return false;
  }
}

function dateToISO(v) {
  if (!v) return '';
  // PowerShell của DateTime → `/Date(1700000000000)/` 或 ISO 字符串
  const m = /\/Date\((\d+)\)\//.exec(String(v));
  if (m) {
    try { return new Date(Number(m[1])).toISOString().slice(0, 10); } catch (_) { return ''; }
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

/**
 * 探测Máy này硬件与虚拟化状态。
 *
 * 任何一mục查不到都返回 null/0，**绝不让探测Thất bại拖垮调Dùng方**：
 * 查不到就是「Không rõ」，Kiểm tra sức khỏemục里会写「读不到」，而不是编一cái结论。
 *
 * @param {object} o { accel } accel 由 provisioner.emulatorAccel() 传入，避免重复拉起 emulator
 * @returns {object} hw
 */
async function collect({ accel = null } = {}) {
  const [raw, feats] = process.platform === 'win32'
    ? await Promise.all([psJson(HW_SCRIPT), psJson(FEATURE_SCRIPT)])
    : [null, null];
  const cpu = (raw && raw.cpu) || {};
  const cs = (raw && raw.cs) || {};
  const gpus = Array.isArray(raw && raw.gpu) ? raw.gpu : (raw && raw.gpu ? [raw.gpu] : []);

  // Chọn「主显卡」：优先Không phải Microsoft Basic Display / Không phải虚拟显示适配器
  const usable = gpus.filter((g) => g && g.Name && !/microsoft basic|remote display|virtual display/i.test(g.Name));
  const gpu = (usable[0] || gpus[0]) || {};
  const name = String(gpu.Name || '');
  let vendor = 'unknown';
  if (/nvidia|geforce|rtx\s|gtx\s|quadro/i.test(name)) vendor = 'nvidia';
  else if (/(?<!virtual\s)(amd|radeon|rx\s\d)/i.test(name)) vendor = 'amd';
  else if (/intel|uhd\s|iris|arc\s/i.test(name)) vendor = 'intel';

  const ramBytes = Number(gpu.AdapterRAM) || 0;
  const qw = Number((raw && raw.vram) || 0);
  // AdapterRAM 是 32 位无符号，>4GB 会变成 4095MB，这种值不可信
  const vramMB = Math.round((qw > 0 ? qw : (ramBytes > 0 && ramBytes < 4096 * 1024 * 1024 ? ramBytes : 0)) / 1048576);

  const hypervisor = cs.HypervisorPresent === true;
  const accelOk = !!(accel && accel.ok);
  /**
   * 注意 WMI 这两cái字段của坑（Máy này实测）：
   * Hyper-V / VBS 一旦接管 VT，`VMMonitorModeExtensions` 与
   * `SecondLevelAddressTranslationExtensions` 会返回 False —— 但机器明明能跑Tăng tốc phần cứng。
   * 所以「False」只Có在「没Có Hypervisor、Tăng tốc也Không khả dụng」时才能当成「Không hỗ trợ」，
   * 否则一律当「Không rõ」，别把能Dùngcủa机器误判成Không hỗ trợ虚拟化。
   */
  const vmExt = cpu.VMMonitorModeExtensions;
  const slatRaw = cpu.SecondLevelAddressTranslationExtensions;
  let vtSupported = true;
  if (vmExt === false && !hypervisor && !accelOk) vtSupported = false;
  else if (vmExt !== true) vtSupported = 'unknown';
  const slat = slatRaw === true ? true : (slatRaw === false && !hypervisor && !accelOk ? false : 'unknown');
  // BIOS 侧：同理，Hypervisor 在跑时 firmware 字段也可能不可信
  let vtFirmware = null;
  if (cpu.VirtualizationFirmwareEnabled === true) vtFirmware = true;
  else if (cpu.VirtualizationFirmwareEnabled === false && !hypervisor && !accelOk) vtFirmware = false;
  const winHv = fileExists('System32\\WinHvPlatform.dll');
  const vmCompute = fileExists('System32\\vmcompute.exe');
  const aehd = fileExists('System32\\drivers\\aehd.sys');

  const state = (k) => {
    const v = feats && feats[k];
    return v ? String(v).toLowerCase() : 'unknown';
  };

  return {
    platform: process.platform,
    arch: process.arch,
    osBuild: (() => {
      const m = /(\d+)\s*$/.exec(os.release() || '');
      return m ? Number(m[1]) : 0;
    })(),
    cpu: {
      name: String(cpu.Name || '').trim(),
      cores: Number(cpu.NumberOfCores) || 0,
      threads: Number(cpu.NumberOfLogicalProcessors) || 0,
      vtSupported,
      vtFirmware,
      slat,
    },
    memory: {
      totalMB: Math.round((Number(cs.TotalPhysicalMemory) || os.totalmem()) / 1048576),
      freeMB: Math.round(os.freemem() / 1048576),
    },
    gpu: {
      name,
      vendor,
      vramMB,
      driverVersion: String(gpu.DriverVersion || ''),
      driverDate: dateToISO(gpu.DriverDate),
      status: String(gpu.Status || ''),
    },
    virtualization: {
      hypervisorPresent: hypervisor,
      hypervisorPlatform: state('HypervisorPlatform'),
      vmPlatform: state('VirtualMachinePlatform'),
      hyperV: state('Microsoft-Hyper-V-All'),
      winHvApi: winHv,
      vmCompute,
      aehdInstalled: aehd,
      accelOk,
      accelKind: accel && accel.ok ? String(accel.kind || 'whpx') : 'none',
    },
  };
}

// ---------------- 评估（纯函数） ----------------

/** 硬件推荐档位：Bộ nhớ / nhân心 / 画质。规则保守，宁可少给不可给多。 */
function recommendResources({ totalMB = 0, cores = 0, accelOk = false, vramMB = 0 } = {}) {
  const mem = Number(totalMB) || 0;
  const n = Number(cores) || 1;
  // 虚拟机最多吃宿主của一半，且留 1 nhân给 Windows；Rồi nhấn绝对区间收一次
  let memoryMB = 2048;
  if (mem >= 32768) memoryMB = 8192;
  else if (mem >= 16384) memoryMB = 6144;
  else if (mem >= 12288) memoryMB = 4096;
  else if (mem >= 8192) memoryMB = 3072;
  else memoryMB = 2048;
  if (mem && memoryMB > Math.floor(mem * 0.5 / 512) * 512) {
    memoryMB = Math.max(2048, Math.floor(mem * 0.5 / 512) * 512);
  }
  const wantCores = n >= 8 ? 4 : n >= 4 ? Math.max(2, n - 2) : 2;
  const c = Math.max(1, Math.min(wantCores, n - 1));
  // Giả lập phần mềm + NhỏVRAM：分辨率降到 540p，帧率优先（画面面积只Có 56%）
  const renderSize = (!accelOk || (vramMB > 0 && vramMB < 512)) ? '540x960' : 'auto';
  return { memoryMB, cores: c, renderSize };
}

/** 渲染后端建议：按厂商 + Tăng tốc状态 + VRAM给一cái「Thử trước这cái」của档位 */
function recommendGpu({ vendor = 'unknown', accelOk = false, vramMB = 0 } = {}) {
  if (!accelOk) return { gpuMode: 'software', why: 'Không có tăng tốc phần cứng khả dụng, dùng kết xuất phần mềm trước để hiện được hình' };
  if (vendor === 'unknown') return { gpuMode: 'auto', why: 'Không đọc được mẫu card đồ họa, giao cho chuỗi hạ cấp tự động thử' };
  if (!vramMB || vramMB < 512) return { gpuMode: 'swangle', why: 'VRAM rất nhỏ (hoặc không đọc được), dùng swangle sẽ ổn định hơn' };
  if (vendor === 'nvidia') return { gpuMode: 'host', why: 'NVIDIA Trình điều khiển ổn định, host passthrough thường nhanh nhất' };
  if (vendor === 'amd') return { gpuMode: 'swangle', why: 'AMD Với card đồ họa tích hợp/driver cũ, host có thể khởi động rồi sập, swangle ổn định hơn' };
  if (vendor === 'intel') return { gpuMode: 'swangle', why: 'Intel Card đồ họa tích hợp hỗ trợ GLES không đồng đều, swangle ổn định hơn' };
  return { gpuMode: 'auto', why: 'Không đọc được mẫu card đồ họa, giao cho chuỗi hạ cấp tự động thử' };
}

/**
 * 把探测结果翻译成Kiểm tra sức khỏe报告。
 *
 * @param {object} o { hw, settings, edition } edition: 'store' | 'installer'
 * @returns {{ level:string, items:Array, patch:object|null, driver:object|null, summary:string }}
 */
function evaluate({ hw = {}, settings = {}, edition = 'installer' } = {}) {
  const v = hw.virtualization || {};
  const cpu = hw.cpu || {};
  const gpu = hw.gpu || {};
  const mem = hw.memory || {};
  const items = [];

  const add = (item) => items.push(item);

  // ---- 1. CPU 虚拟化（BIOS） ----
  if (cpu.vtSupported === false) {
    add({
      key: 'vt-unsupported',
      level: 'bad',
      title: 'CPU này không hỗ trợ ảo hóa phần cứng',
      detail: 'Chỉ chạy được bằng giả lập phần mềm, tốc độ sẽ chậm 5~10  lần. Ứng dụng nhẹ vẫn dùng được, không khuyến nghị game lớn.',
      action: null,
    });
  } else if (cpu.vtFirmware === false) {
    add({
      key: 'vt-bios-off',
      level: 'bad',
      title: 'CPU Ảo hóa chưa bật trong BIOS',
      detail: 'Khởi động lại vào BIOS/UEFI, đặt Intel VT-x (Intel) hoặc SVM Mode (AMD) thành Enabled, lưu rồi quay lại kiểm tra máy.'
        + 'Lenovo/Dell/ASUS thường ở Advanced → CPU Configuration; máy hãng có thể gọi là Virtualization Technology.',
      action: { kind: 'manual', id: 'bios', label: 'Cần khởi động lại vào BIOS, không thể tự hoàn tất' },
    });
  } else if (cpu.vtFirmware === true) {
    add({
      key: 'vt-ok',
      level: 'ok',
      title: 'CPU Ảo hóa đã bật trong BIOS',
      detail: cpu.name ? `${cpu.name} · ${cpu.cores || '?'} nhân / ${cpu.threads || '?'} luồng` : '',
      action: null,
    });
  } else {
    add({
      key: 'vt-unknown',
      level: 'warn',
      title: 'Không đọc được trạng thái ảo hóa CPU',
      detail: 'Có thể do bo mạch chủ/giới hạn quyền. Nếu khi khởi động báo không có tăng tốc phần cứng, hãy tự vào BIOS xác nhận VT-x / SVM đã bật.',
      action: { kind: 'manual', id: 'bios', label: 'Xác nhận thủ công' },
    });
  }

  // ---- 2. Windows 侧：WHPX / Hyper-V ----
  const hp = String(v.hypervisorPlatform || 'unknown');
  const hpxOn = hp === 'enabled' || (hp === 'unknown' && v.winHvApi && v.hypervisorPresent);
  if (hpxOn) {
    add({
      key: 'whpx-ok',
      level: 'ok',
      title: 'Windows Nền tảng hypervisor đã được bật',
      detail: v.hypervisorPresent
        ? 'Hypervisor Đang chạy, WHPX khả dụng.'
        : 'Tính năng đã bật; nếu tăng tốc vẫn không dùng được, hãy khởi động lại một lần để Hypervisor hoạt động.',
      action: null,
    });
  } else if (edition === 'store') {
    add({
      key: 'whpx-off',
      level: 'bad',
      title: '“Nền tảng giám sát máy ảo” chưa được bật',
      detail: 'Bản Store không tự đổi được tính năng hệ thống. Nhấn Win+R → nhập optionalfeatures → tích “Windows Hypervisor Platform”'
        + '(HypervisorPlatform) và “Virtual Machine Platform” → OK → khởi động lại.',
      action: { kind: 'elevate', id: 'virtualization', label: 'Mở cửa sổ “Windows Features”' },
    });
  } else {
    add({
      key: 'whpx-off',
      level: 'bad',
      title: '“Nền tảng giám sát máy ảo” chưa được bật',
      detail: 'Nhấn nút bên dưới sẽ tự bật HypervisorPlatform + VirtualMachinePlatform (cần quản trị viên xác nhận), xong hãy khởi động lại máy.',
      action: { kind: 'elevate', id: 'virtualization', label: 'Bật bằng một cú nhấp (cần quyền quản trị)' },
    });
  }

  // ---- 3. Tăng tốc phần cứng当前是否真của能Dùng ----
  if (v.accelOk) {
    add({
      key: 'accel-ok',
      level: 'ok',
      title: `Tăng tốc phần cứng khả dụng (${v.accelKind === 'aehd' ? 'AEHD' : 'WHPX'}）`,
      detail: 'Khởi động sẽ dùng tăng tốc phần cứng; cấu hình dưới đây được đề xuất theo card đồ họa và bộ nhớ của máy này.',
      action: null,
    });
  } else {
    add({
      key: 'accel-off',
      level: 'warn',
      title: 'Hiện không có tăng tốc phần cứng nào dùng được',
      detail: edition === 'installer' && v.vtFirmware !== false
        ? 'Có thể cài trình điều khiển AEHD (cần quyền quản trị), hoặc bật “Nền tảng giám sát máy ảo” rồi khởi động lại; cả hai đều không được thì chỉ còn giả lập phần mềm.'
        : 'Sẽ dùng giả lập phần mềm để đảm bảo chạy được; chậm hơn tăng tốc phần cứng 5~10  lần.',
      action: edition === 'installer' && v.vtFirmware !== false
        ? { kind: 'elevate', id: 'accel', label: 'Cài trình điều khiển AEHD (cần quyền quản trị)' }
        : null,
    });
  }

  // ---- 4. 显卡 ----
  if (!gpu.name) {
    add({
      key: 'gpu-unknown',
      level: 'warn',
      title: 'Không đọc được thông tin card đồ họa',
      detail: 'Có thể do Remote Desktop / máy ảo / trình điều khiển bất thường. Chuỗi hạ cấp tự động sẽ xử lý phần kết xuất.',
      action: null,
    });
  } else {
    const integrated = /radeon\s+(graphics|vega)|uhd|iris|hd\s+graphics|vega/i.test(gpu.name);
    const vram = gpu.vramMB
      ? `${(gpu.vramMB / 1024).toFixed(1)} GB VRAM${integrated ? '(card đồ họa tích hợp, phần còn lại dùng bộ nhớ chia sẻ)' : ''}`
      : 'Không rõ VRAM';
    add({
      key: 'gpu-info',
      level: 'ok',
      title: `${gpu.name}`,
      detail: `${vram}${gpu.driverVersion ? ` · Trình điều khiển ${gpu.driverVersion}` : ''}${gpu.driverDate ? `（${gpu.driverDate}）` : ''}`,
      action: null,
    });
    const old = /^(19|20)\d{2}-\d{2}-\d{2}$/.test(gpu.driverDate || '')
      ? (Date.now() - new Date(gpu.driverDate).getTime()) / 31536000000 : 0;
    if (old > 3) {
      add({
        key: 'gpu-driver-old',
        level: 'warn',
        title: 'Trình điều khiển đồ họa khá cũ',
        detail: `Ngày của driver ${gpu.driverDate}(khoảng ${Math.floor(old)}  năm trước). Trình điều khiển cũ là nguyên nhân thường gặp gây màn hình đen / vỡ hình sau khi chạy, nên cập nhật từ trang chủ nhà sản xuất.`,
        action: null,
      });
    }
  }

  // ---- 5. Bộ nhớ / 磁盘 / 系统版本 ----
  const total = Number(mem.totalMB) || 0;
  if (!total) {
    add({ key: 'mem-unknown', level: 'warn', title: 'Không đọc được bộ nhớ vật lý', detail: '', action: null });
  } else if (total < 6144) {
    add({
      key: 'mem-low',
      level: 'warn',
      title: `Bộ nhớ hơi ít (${(total / 1024).toFixed(1)} GB）`,
      detail: 'Máy ảo Android tối đa chỉ được 2 GB, 2 nhân, chất lượng hình giảm xuống 540×960, nên đóng các tab trình duyệt trước khi mở ứng dụng.',
      action: null,
    });
  } else {
    add({
      key: 'mem-ok',
      level: 'ok',
      title: `Bộ nhớ vật lý ${(total / 1024).toFixed(0)} GB`,
      detail: '',
      action: null,
    });
  }

  const build = Number(hw.osBuild) || 0;
  if (build && build < 19041) {
    add({
      key: 'os-old',
      level: 'warn',
      title: `Windows Phiên bản khá cũ (build ${build}）`,
      detail: 'ApkStart Tối thiểu hỗ trợ Windows 10 2004 (build 19041). Trên hệ thống cũ hơn, emulator có thể thoát ngay.',
      action: null,
    });
  }

  // ---- 建议配置 ----
  const rec = recommendResources({ totalMB: total, cores: cpu.threads || cpu.cores, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const gpuRec = recommendGpu({ vendor: gpu.vendor, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const patch = {
    engine: {
      autoMemory: false,
      memoryMB: rec.memoryMB,
      cores: rec.cores,
      renderSize: rec.renderSize,
      // Tăng tốcKhông khả dụng → 直接锁定Giả lập phần mềm，省掉两轮白等；Khả dụng则交回 auto 让降级链工作
      gpuMode: v.accelOk ? 'auto' : 'software',
      forceTcg: !v.accelOk,
    },
  };

  // 给这台机器生成一份Trình điều khiển：以后每次开机都按它来，不Dùng重复Kiểm tra sức khỏe
  const vendor = gpu.vendor && gpu.vendor !== 'unknown' ? gpu.vendor : 'unknown';
  const driver = {
    format: 'apkstart-driver/1',
    id: `auto-${vendor}-${build || 'x'}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
    name: `Tự cấu hình theo máy (${gpu.name || vendor}）`,
    version: '1.0.0',
    author: 'ApkStart Kiểm tra sức khỏe',
    description: `Được tạo bởi “Kiểm tra máy · Tự cấu hình”:${gpuRec.why}。${v.accelOk ? 'Tăng tốc phần cứng khả dụng.' : 'Hiện không có tăng tốc phần cứng.'}`,
    priority: 5,
    match: {
      platform: [hw.platform || process.platform],
      arch: [hw.arch || process.arch],
      ...(vendor !== 'unknown' ? { gpuVendor: [vendor] } : {}),
      ...(build ? { osBuild: { min: build - 2000, max: build + 2000 } } : {}),
    },
    effect: {
      gpuMode: gpuRec.gpuMode,
      ...(v.accelOk ? {} : { forceTcg: true }),
      notes: [gpuRec.why],
    },
  };

  const bad = items.filter((i) => i.level === 'bad').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  const level = bad ? 'bad' : warn ? 'warn' : 'good';
  const summary = bad
    ? `Phát hiện ${bad} mục phải xử lý trước (${items.filter((i) => i.level === 'bad').map((i) => i.title).join('、')}）`
    : warn
      ? `Có ${warn} mục nên tối ưu (${items.filter((i) => i.level === 'warn').map((i) => i.title).join('、')}）`
      : 'Máy này chạy được tăng tốc phần cứng trực tiếp, cấu hình đã tối ưu';

  return {
    level,
    items,
    patch,
    driver,
    recommended: { ...rec, ...gpuRec },
    summary,
  };
}

module.exports = {
  collect,
  evaluate,
  recommendResources,
  recommendGpu,
  psJson,
};
