'use strict';
/**
 * Trình điều khiển（Bản vá tương thích）扩展模块。
 *
 * 背景：ApkStart Dùngcủa是官方 emulator + 固定镜像, nhưng “能不能跑起来」Không phải常吃机器：
 * 老显卡của GLES 只到 3.1、没Có WHPX 只能走 TCG、某些nhân显 + 老Trình điều khiển一开 host 渲染就崩……
 * 这些差异没法靠一份默认参数覆盖所Có机器，而发版周期又跟不上Dùng户của机器型号。
 *
 * 所以把它做成**数据Trình điều khiển**của扩展：一cáiTrình điều khiển就是一份 JSON，声明「我匹配哪些机器」
 * + 「匹配上以后改哪些启动参数」。Dùng户可以自己写、自己导入、互相分享，不Cần改代码。
 *
 * 设计上của三条硬约束：
 *   1. **只认 JSON，Không chạy bất kỳ mã nào**。没Có require / eval / 脚本钩子 —— Trình điều khiển文件
 *      可以从网上下载、可以互相传，绝不能因此获得在Máy này执行任意代码của能力。
 *   2. **白名单**。能改của只Có启动参数里明确列出của那些：`-gpu=…`、`-accel=…`、
 *      少量 config.ini 键、少量环境变量。`-wipe-data`、`-datadir`、`-sysdir`、
 *      `disk.dataPartition.size` 这类会毁数据 / 改落点của键一律拒绝。
 *   3. **可预期**。匹配不上就不生效；多cáiTrình điều khiển同时命中时按 `priority` 从Nhỏ到Lớn叠加，
 *      后Áp dụngcủa覆盖前面của；每次开机把「Dùng了哪些Trình điều khiển」写进Nhật ký和Cài đặt页。
 *
 * 文件格式见 docs/drivers.md，Mẫu tích hợp sẵn在 src/drivers/。
 */

const fs = require('fs');
const path = require('path');

const DRIVER_FORMAT = 'apkstart-driver/1';
const MAX_DRIVER_BYTES = 256 * 1024;
const MAX_DRIVERS = 200;

/** Trình điều khiển能改của启动参数：`-flag=value` 形式，value 必须匹配白名单正则 */
const ARG_RULES = {
  '-gpu': /^(auto|host|swiftshader|swiftshader_indirect|swangle|software|angle|angle_indirect|mesa)$/,
  '-accel': /^(auto|off|on|whpx|hax|haxm|aehd|tcg)$/,
  '-feature': /^[A-Za-z0-9_,.\-]{1,160}$/,
  '-gltransport': /^(pipe|asgpu|virtio)$/,
  // 直通给 qemu của单cái参数。限制字符集，且不许出现 -drive/-virtfs 这类挂载/写盘参数
  '-qemu': /^-?[A-Za-z0-9_+=,.:/\-]{1,120}$/,
};

/** 只允许「开关型」参数（不带 giá trị) */
const FLAG_ONLY = new Set([
  '-no-audio',
  '-no-boot-anim',
  '-no-metrics',
  '-no-snapshot',
  '-no-snapshot-load',
  '-no-snapshot-save',
]);

/**
 * 明确拒绝của参数：会删数据、改落点、绕过我们của端口/AVD 管理。
 * 单独列出来是为了在报错时说清楚「为什么不行」，而不是只说「不在白名单里」。
 */
const FORBIDDEN_ARGS = {
  '-wipe-data': 'Sẽ xóa ứng dụng đã cài và dữ liệu lưu của người dùng',
  '-datadir': 'Sẽ đổi vị trí AVD, làm hỏng cách ly nhiều phiên bản',
  '-sysdir': 'Sẽ đổi nguồn ảnh hệ thống',
  '-partition-size': 'Sẽ đổi dung lượng phân vùng dữ liệu, hãy dùng trang cài đặt',
  '-avd': 'AVD  tên do ApkStart quản lý',
  '-port': 'Cổng do ApkStart tự cấp phát',
  '-http-proxy': 'Proxy hãy đặt trong cài đặt hệ thống',
};

/** Trình điều khiển能改của config.ini 键 */
const INI_RULES = {
  'hw.gpu.mode': /^(auto|host|swiftshader|swiftshader_indirect|swangle|software|angle|angle_indirect|mesa)$/,
  'hw.gpu.enabled': /^(yes|no)$/,
  'hw.gltransport': /^(pipe|asgpu|virtio)$/,
  'hw.keyboard': /^(yes|no)$/,
  'hw.audioInput': /^(yes|no|none)$/,
  'hw.audioOutput': /^(yes|no)$/,
  'hw.camera.back': /^(none|emulated|webcam0)$/,
  'hw.camera.front': /^(none|emulated|webcam0)$/,
  'hw.gps': /^(yes|no)$/,
  'vm.heapSize': /^\d{2,4}$/,
  'hw.lcd.density': /^\d{3,4}$/,
};

/** Trình điều khiển能改của环境变量名 */
const ENV_NAME_RULES = [
  /^ANDROID_[A-Z0-9_]{2,40}$/,
  /^QEMU_[A-Z0-9_]{2,40}$/,
  /^LIBGL_[A-Z0-9_]{2,40}$/,
  /^MESA_[A-Z0-9_]{2,40}$/,
  /^EMUGL_[A-Z0-9_]{2,40}$/,
];

/** match 里允许出现của键（多一cái都算错，避免Dùng户以为自己写了但没生效） */
const MATCH_KEYS = new Set([
  'any', 'platform', 'arch', 'gpuVendor', 'gpuName', 'cpuVendor',
  'osBuild', 'totalMB', 'cores', 'accel', 'emulatorVersion',
]);

const EFFECT_KEYS = new Set([
  'gpuMode', 'forceTcg', 'emulatorArgs', 'configIni', 'env', 'notes',
]);

// ---------------- Nhỏ工具 ----------------

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function asArray(v) {
  return Array.isArray(v) ? v : [v];
}

/** 编译Dùng户写của正则：长度与语法都要能兜住，编译Thất bại返回 null（校验阶段会报错） */
function safeRegex(pattern) {
  const s = String(pattern || '');
  if (!s || s.length > 200) return null;
  try {
    return new RegExp(s, 'i');
  } catch (_) {
    return null;
  }
}

/** 版本号只取前四段数字比较，'36.4.9' vs '36.4.10' 不能按字符串比 */
function versionParts(v) {
  return String(v || '')
    .split(/[^\d]+/)
    .filter(Boolean)
    .slice(0, 4)
    .map(Number);
}

function cmpVersion(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function inRange(value, range) {
  if (range === undefined || range === null) return true;
  const { min, max } = isObj(range) ? range : { min: range };
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  if (min !== undefined && n < Number(min)) return false;
  if (max !== undefined && n > Number(max)) return false;
  return true;
}

// ---------------- 校验 ----------------

function validateMatch(match, errors) {
  if (match === undefined) return {};
  if (!isObj(match)) {
    errors.push('match Phải là đối tượng');
    return {};
  }
  for (const k of Object.keys(match)) {
    if (!MATCH_KEYS.has(k)) errors.push(`match.${k} Không phải điều kiện khớp được hỗ trợ`);
  }
  const out = {};
  if (match.any !== undefined) out.any = !!match.any;
  if (match.platform !== undefined) out.platform = asArray(match.platform).map(String);
  if (match.arch !== undefined) out.arch = asArray(match.arch).map(String);
  if (match.gpuVendor !== undefined) out.gpuVendor = asArray(match.gpuVendor).map((v) => String(v).toLowerCase());
  if (match.cpuVendor !== undefined) out.cpuVendor = asArray(match.cpuVendor).map((v) => String(v).toLowerCase());
  if (match.accel !== undefined) out.accel = asArray(match.accel).map((v) => String(v).toLowerCase());
  if (match.gpuName !== undefined) {
    if (!safeRegex(match.gpuName)) errors.push('match.gpuName Không phải regex hợp lệ (và độ dài cần ≤200）');
    else out.gpuName = String(match.gpuName);
  }
  for (const k of ['osBuild', 'totalMB', 'cores', 'emulatorVersion']) {
    if (match[k] === undefined) continue;
    if (!isObj(match[k]) && typeof match[k] !== 'number' && typeof match[k] !== 'string') {
      errors.push(`match.${k} Phải là số hoặc {min,max}`);
      continue;
    }
    if (isObj(match[k])) {
      const bad = ['min', 'max'].filter((x) => match[k][x] !== undefined && !Number.isFinite(Number(match[k][x])));
      if (bad.length) {
        errors.push(`match.${k}.${bad.join('/')} Phải là số`);
        continue;
      }
      out[k] = { min: match[k].min, max: match[k].max };
    } else {
      out[k] = { min: match[k] };
    }
  }
  return out;
}

function validateArgs(args, errors) {
  const out = [];
  if (args === undefined) return out;
  if (!Array.isArray(args)) {
    errors.push('effect.emulatorArgs Phải là mảng chuỗi');
    return out;
  }
  for (const raw of args) {
    const s = String(raw || '').trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    const flag = eq > 0 ? s.slice(0, eq) : s;
    const value = eq > 0 ? s.slice(eq + 1) : '';
    if (FORBIDDEN_ARGS[flag]) {
      errors.push(`emulatorArgs Không được phép ${flag}：${FORBIDDEN_ARGS[flag]}`);
      continue;
    }
    if (eq < 0) {
      if (!FLAG_ONLY.has(flag)) errors.push(`emulatorArgs Không hỗ trợ tham số riêng lẻ ${flag}(nếu có giá trị, hãy viết thành ${flag}= giá trị)`);
      else out.push({ flag, value: '' });
      continue;
    }
    const rule = ARG_RULES[flag];
    if (!rule) {
      errors.push(`emulatorArgs Không hỗ trợ ${flag}`);
      continue;
    }
    if (!rule.test(value)) {
      errors.push(`emulatorArgs của ${flag} Giá trị không hợp lệ:${value}`);
      continue;
    }
    out.push({ flag, value });
  }
  return out;
}

function validateIni(ini, errors) {
  const out = {};
  if (ini === undefined) return out;
  if (!isObj(ini)) {
    errors.push('effect.configIni Phải là đối tượng');
    return out;
  }
  for (const [k, v] of Object.entries(ini)) {
    const rule = INI_RULES[k];
    if (!rule) {
      errors.push(`configIni Không hỗ trợ ${k}(từ chối mọi khóa làm hỏng phân vùng dữ liệu / vị trí đích)`);
      continue;
    }
    const s = String(v);
    if (!rule.test(s)) {
      errors.push(`configIni của ${k} Giá trị không hợp lệ:${s}`);
      continue;
    }
    out[k] = s;
  }
  return out;
}

function validateEnv(env, errors) {
  const out = {};
  if (env === undefined) return out;
  if (!isObj(env)) {
    errors.push('effect.env Phải là đối tượng');
    return out;
  }
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME_RULES.some((re) => re.test(k))) {
      errors.push(`env Không cho phép đặt ${k}(chỉ cho phép ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_  tiền tố)`);
      continue;
    }
    const s = String(v);
    if (s.length > 200 || /[\r\n\0]/.test(s)) {
      errors.push(`env.${k} có giá trị không hợp lệ (độ dài ≤200, và không được chứa xuống dòng)`);
      continue;
    }
    out[k] = s;
  }
  return out;
}

/**
 * 校验一份Trình điều khiển（就是 JSON.parse 之后của对象）。
 * 返回 errors 是给人看của，能一次列全，不要「修一cái报一cái」。
 * @param {object} raw
 * @param {object} [opts] { file } 出错时带上文件名
 * @returns {{ ok:boolean, errors:string[], driver:object|null }}
 */
function validateDriver(raw, { file = '' } = {}) {
  const errors = [];
  const where = file ? `${file}: ` : '';
  if (!isObj(raw)) return { ok: false, errors: [`${where}Trình điều khiển phải là đối tượng JSON`], driver: null };

  if (raw.format !== DRIVER_FORMAT) {
    errors.push(`${where}format Phải là "${DRIVER_FORMAT}"(hiện tại ${JSON.stringify(raw.format)}）`);
  }
  const id = String(raw.id || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(id)) {
    errors.push(`${where}id Phải gồm chữ cái, chữ số và . _ - gồm3~64  ký tự (ví dụ amd-igpu-swangle)`);
  }
  const name = String(raw.name || '').trim();
  if (!name || name.length > 80) errors.push(`${where}name Bắt buộc, và không quá 80 ký tự`);
  const version = String(raw.version || '').trim();
  if (!/^\d+(\.\d+){0,3}(-[A-Za-z0-9.]+)?$/.test(version)) errors.push(`${where}version Phải có dạng 1.0.0`);
  if (raw.priority !== undefined && (!Number.isFinite(Number(raw.priority)) || Math.abs(Number(raw.priority)) > 100)) {
    errors.push(`${where}priority Phải là -100 ~ 100 số`);
  }

  const match = validateMatch(raw.match, errors);
  if (raw.match !== undefined && isObj(raw.match) && Object.keys(raw.match).length === 0) {
    errors.push(`${where}match Không được là đối tượng rỗng; muốn khớp mọi máy hãy ghi {"any": true}`);
  }
  const effectRaw = isObj(raw.effect) ? raw.effect : null;
  if (!effectRaw) errors.push(`${where}effect Phải là đối tượng`);
  let effect = {
    gpuMode: '', forceTcg: null, args: [], ini: {}, env: {}, notes: [],
  };
  if (effectRaw) {
    for (const k of Object.keys(effectRaw)) {
      if (!EFFECT_KEYS.has(k)) errors.push(`${where}effect.${k} Không phải trường được hỗ trợ`);
    }
    if (effectRaw.gpuMode !== undefined) {
      const v = String(effectRaw.gpuMode);
      if (!ARG_RULES['-gpu'].test(v)) errors.push(`${where}effect.gpuMode Giá trị không hợp lệ:${v}`);
      else effect.gpuMode = v;
    }
    if (effectRaw.forceTcg !== undefined) {
      if (typeof effectRaw.forceTcg !== 'boolean') errors.push(`${where}effect.forceTcg Phải là true/false`);
      else effect.forceTcg = effectRaw.forceTcg;
    }
    effect.args = validateArgs(effectRaw.emulatorArgs, errors);
    effect.ini = validateIni(effectRaw.configIni, errors);
    effect.env = validateEnv(effectRaw.env, errors);
    if (effectRaw.notes !== undefined) {
      if (!Array.isArray(effectRaw.notes)) errors.push(`${where}effect.notes Phải là mảng chuỗi`);
      else {
        effect.notes = effectRaw.notes
          .map((n) => String(n).trim())
          .filter(Boolean)
          .slice(0, 8)
          .map((n) => (n.length > 200 ? `${n.slice(0, 200)}…` : n));
      }
    }
  }

  if (errors.length) return { ok: false, errors, driver: null };
  return {
    ok: true,
    errors: [],
    driver: {
      format: DRIVER_FORMAT,
      id,
      name,
      version,
      author: String(raw.author || '').slice(0, 60),
      description: String(raw.description || '').slice(0, 400),
      homepage: String(raw.homepage || '').slice(0, 200),
      priority: Number(raw.priority || 0),
      // Mẫu tích hợp sẵn统一 disabled，Dùng户自己của默认启Dùng
      enabled: raw.enabled !== false,
      match,
      effect,
      file,
    },
  };
}

// ---------------- 匹配 ----------------

/**
 * 组装「这台机器」của画像，喂给 match。
 * @param {object} o { info, gpuVendor, gpuName, osBuild, accel, emulatorVersion }
 */
function hostContext({ info = {}, gpuVendor = 'unknown', gpuName = '', osBuild = 0, accel = 'unknown', emulatorVersion = '' } = {}) {
  const rel = String(process.release && process.release.name === 'node' ? '' : '');
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB: toInt(info.totalMB),
    cores: toInt(info.cores) || 1,
    gpuVendor: String(gpuVendor || 'unknown').toLowerCase(),
    gpuName: String(gpuName || ''),
    cpuVendor: String((info.cpuVendor || '')).toLowerCase(),
    osBuild: toInt(osBuild),
    accel: String(accel || 'unknown').toLowerCase(),
    emulatorVersion: String(emulatorVersion || rel || ''),
  };
}

/**
 * 匹配结果里同时返回「命中了哪几条」，界面能解释「为什么这cáiTrình điều khiển生效了」。
 * @returns {{ ok:boolean, hits:string[] }}
 */
function matchHost(match, host) {
  if (!isObj(match) || !Object.keys(match).length) return { ok: false, hits: [] };
  const hits = [];
  if (match.any) hits.push('any');
  if (match.platform && !match.platform.includes(host.platform)) return { ok: false, hits: [] };
  if (match.platform) hits.push(`platform=${host.platform}`);
  if (match.arch && !match.arch.includes(host.arch)) return { ok: false, hits: [] };
  if (match.arch) hits.push(`arch=${host.arch}`);
  if (match.gpuVendor && !match.gpuVendor.includes(host.gpuVendor)) return { ok: false, hits: [] };
  if (match.gpuVendor) hits.push(`gpu=${host.gpuVendor}`);
  if (match.gpuName) {
    const re = safeRegex(match.gpuName);
    if (!re || !re.test(host.gpuName || '')) return { ok: false, hits: [] };
    hits.push(`gpuName≈${match.gpuName}`);
  }
  if (match.cpuVendor && !match.cpuVendor.includes(host.cpuVendor)) return { ok: false, hits: [] };
  if (match.cpuVendor) hits.push(`cpu=${host.cpuVendor}`);
  if (match.accel && !match.accel.includes(host.accel)) return { ok: false, hits: [] };
  if (match.accel) hits.push(`accel=${host.accel}`);
  if (match.osBuild !== undefined) {
    const b = host.osBuild;
    if (!b || !inRange(b, match.osBuild)) return { ok: false, hits: [] };
    hits.push(`osBuild=${b}`);
  }
  if (match.totalMB !== undefined) {
    if (!inRange(host.totalMB, match.totalMB)) return { ok: false, hits: [] };
    hits.push(`mem=${host.totalMB}MB`);
  }
  if (match.cores !== undefined) {
    if (!inRange(host.cores, match.cores)) return { ok: false, hits: [] };
    hits.push(`cores=${host.cores}`);
  }
  if (match.emulatorVersion !== undefined) {
    const v = host.emulatorVersion;
    if (!v) return { ok: false, hits: [] };
    if (match.emulatorVersion.min !== undefined && cmpVersion(v, match.emulatorVersion.min) < 0) return { ok: false, hits: [] };
    if (match.emulatorVersion.max !== undefined && cmpVersion(v, match.emulatorVersion.max) > 0) return { ok: false, hits: [] };
    hits.push(`emu=${v}`);
  }
  return { ok: hits.length > 0, hits };
}

/** 匹配条件越多越"具体"：同等 priority 时，泛化Trình điều khiển先Áp dụng，专门củaTrình điều khiển后Áp dụng（覆盖它） */
function specificity(match) {
  return Object.keys(match || {}).filter((k) => k !== 'any').length;
}

/**
 * 把命中củaTrình điều khiển按「泛化 → 具体 → priority」顺序叠成一份效果。
 * 后面của覆盖前面của：gpuMode/forceTcg 取最后一cái，args 同 flag 取最后一cái，ini/env 合并。
 */
function mergeEffect(drivers) {
  const effect = {
    gpuMode: '', forceTcg: null, args: [], ini: {}, env: {}, notes: [],
  };
  const argIndex = new Map();
  for (const d of drivers) {
    const e = d.effect;
    if (e.gpuMode) effect.gpuMode = e.gpuMode;
    if (e.forceTcg !== null) effect.forceTcg = e.forceTcg;
    for (const a of e.args) {
      const key = a.flag;
      if (argIndex.has(key)) effect.args[argIndex.get(key)] = a;
      else {
        argIndex.set(key, effect.args.length);
        effect.args.push(a);
      }
    }
    Object.assign(effect.ini, e.ini);
    Object.assign(effect.env, e.env);
    for (const n of e.notes) effect.notes.push(`${d.name}：${n}`);
  }
  return effect;
}

/**
 * 从一堆（已校验của）Trình điều khiển里挑出这台机器要Dùngcủa，并合成最终效果。
 *
 * `state` 是Dùng户在界面上做của显式开关（id → true/false），优先级高于文件trong
 * `enabled`：Mẫu tích hợp sẵn默认 `enabled:false`，Dùng户点一下「启Dùng」就写进 state，
 * 不Cần去Cài đặt目录改 JSON（商店版目录是只读của，改不了）。
 *
 * @param {object} o { drivers, host, state, disabled }
 * @returns {{ applied:Array, skipped:Array, effect:object }}
 */
function resolve({ drivers = [], host = {}, state = {}, disabled = [] } = {}) {
  const off = new Set((Array.isArray(disabled) ? disabled : []).map(String));
  const applied = [];
  const skipped = [];
  for (const d of drivers) {
    if (!d || !d.id) continue;
    const forced = state && typeof state[d.id] === 'boolean' ? state[d.id] : null;
    const on = forced !== null ? forced : (d.enabled !== false);
    if (!on || off.has(d.id)) {
      skipped.push({ id: d.id, name: d.name, reason: 'disabled' });
      continue;
    }
    const m = matchHost(d.match, host);
    if (!m.ok) {
      skipped.push({ id: d.id, name: d.name, reason: 'no-match' });
      continue;
    }
    applied.push({ ...d, hits: m.hits, matchCount: specificity(d.match) });
  }
  applied.sort((a, b) => (a.priority - b.priority)
    || (a.matchCount - b.matchCount)
    || String(a.id).localeCompare(String(b.id)));
  return { applied, skipped, effect: mergeEffect(applied) };
}

// ---------------- 文件 IO ----------------

/** Dùng户Trình điều khiển目录（与Cài đặt、Nhật ký同级，跟着数据目录走） */
function userDir(store) {
  return path.join(store.DATA_DIR, 'drivers');
}

/** 随包内置của示例Trình điều khiển（只读；默认 enabled:false，作为模板给人抄） */
function bundledDir(appRoot) {
  return path.join(appRoot || '.', 'src', 'drivers');
}

/**
 * 读一cái目录trong全部Trình điều khiển。坏文件不阻断其它Trình điều khiển：
 * 报错收集起来交给界面显示，能Dùngcủa照常Dùng。
 * @returns {{ drivers:Array, errors:Array<{file:string, errors:string[]}>, dir:string }}
 */
function loadDir(dir) {
  const out = { drivers: [], errors: [], dir };
  if (!dir || !fs.existsSync(dir)) return out;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.json$/i.test(n));
  } catch (e) {
    out.errors.push({ file: dir, errors: [e.message] });
    return out;
  }
  names.sort();
  for (const n of names.slice(0, MAX_DRIVERS)) {
    const file = path.join(dir, n);
    let raw;
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_DRIVER_BYTES) {
        out.errors.push({ file, errors: [`Tệp quá lớn (${st.size}  byte, tối đa ${MAX_DRIVER_BYTES}）`] });
        continue;
      }
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      out.errors.push({ file, errors: [`Không đọc được:${e.message}`] });
      continue;
    }
    const r = validateDriver(raw, { file });
    if (!r.ok) out.errors.push({ file, errors: r.errors });
    else out.drivers.push({ ...r.driver, dir });
  }
  return out;
}

/** 读多cái目录并按 id 去重: dùng户目录优先（同 id 时覆盖内置） */
function loadAll(dirs = []) {
  const all = [];
  const errors = [];
  for (const dir of dirs) {
    const r = loadDir(dir);
    errors.push(...r.errors);
    for (const d of r.drivers) {
      const i = all.findIndex((x) => x.id === d.id);
      if (i >= 0) all[i] = d;
      else all.push(d);
    }
  }
  return { drivers: all, errors };
}

/**
 * 导入一份Trình điều khiển：先校验，Rồi nhấn id 存成 `<id>.json`。
 * 文件名只由校验过của id 决定，Dùng户给của文件名不参与拼接（挡住 ../ 之类củaĐường dẫn穿越）。
 * @returns {{ ok:boolean, file?:string, driver?:object, errors?:string[] }}
 */
function importDriver(srcFile, destDir) {
  let raw;
  try {
    const st = fs.statSync(srcFile);
    if (st.size > MAX_DRIVER_BYTES) return { ok: false, errors: ['Tệp quá lớn, trình điều khiển tối đa 256 KB'] };
    raw = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`Không đọc được:${e.message}`] };
  }
  const r = validateDriver(raw, { file: path.basename(srcFile) });
  if (!r.ok) return { ok: false, errors: r.errors };
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${r.driver.id}.json`);
    fs.writeFileSync(dest, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return { ok: true, file: dest, driver: r.driver };
  } catch (e) {
    return { ok: false, errors: [`Ghi thất bại:${e.message}`] };
  }
}

/**
 * 导出一份「Máy này模板」：把当前机器của画像填进 match，
 * Dùng户只要改 effect 就能做出「只对我这台机器生效」củaTrình điều khiển。
 */
function templateFromHost(host = {}, { name = 'Máy của tôi' } = {}) {
  const gpu = host.gpuVendor && host.gpuVendor !== 'unknown' ? host.gpuVendor : 'unknown';
  return {
    format: DRIVER_FORMAT,
    id: `my-${gpu}-${toInt(host.osBuild) || 'custom'}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
    name: `${name} Bản vá tương thích`,
    version: '1.0.0',
    author: '',
    description: 'Được tạo bởi “Xuất mẫu cho máy này” của ApkStart: match đã điền theo máy này, sửa effect nếu cần.',
    priority: 0,
    match: {
      platform: host.platform || process.platform,
      arch: host.arch || process.arch,
      ...(gpu !== 'unknown' ? { gpuVendor: gpu } : {}),
      ...(host.totalMB ? { totalMB: { min: Math.max(2048, Math.round(host.totalMB * 0.9)) } } : {}),
    },
    effect: {
      gpuMode: 'swangle',
      forceTcg: false,
      emulatorArgs: [],
      configIni: {},
      env: {},
      notes: ['Ví dụ: đổi gpuMode thành host / software hoặc bật forceTcg để thử'],
    },
  };
}

/** 把 gpuMode 翻译成 emulator của -gpu 值（auto 表示不改） */
function gpuModeToArg(mode) {
  const v = String(mode || '').trim();
  return v && v !== 'auto' ? v : '';
}

module.exports = {
  DRIVER_FORMAT,
  ARG_RULES,
  FLAG_ONLY,
  FORBIDDEN_ARGS,
  INI_RULES,
  ENV_NAME_RULES,
  MATCH_KEYS,
  EFFECT_KEYS,
  MAX_DRIVER_BYTES,
  safeRegex,
  cmpVersion,
  validateDriver,
  hostContext,
  matchHost,
  specificity,
  mergeEffect,
  resolve,
  userDir,
  bundledDir,
  loadDir,
  loadAll,
  importDriver,
  templateFromHost,
  gpuModeToArg,
};
