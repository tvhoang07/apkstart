'use strict';
/**
 * Emulator Engine：Trình điều khiển Google 官方 Android Emulator 作为 ApkStart củaBộ chạy。
 *
 * 与旧版最Lớncủa不同：这里不再假设「一套参数在所Có电脑上都能跑」。
 *  1. Dùng doctor.chooseProfile() 按Bộ nhớ/CPU/磁盘/Tăng tốc状态/Engine版本Tự động推导参数；
 *  2. Khởi động thất bại时按 planVariants() Tự động降级重试（GPU 后端 → Giả lập phần mềm → 最NhỏBộ nhớKhởi động nguội）；
 *  3. 动态挑Trống闲端口、清 AVD 锁、中文Đường dẫn转短Đường dẫn、镜像变更后Tự động作废快照；
 *  4. quickboot 快照 + Nhỏ数据Phân vùng，做到「像容器一样」Tổng享只读基础层、秒级恢复。
 *
 * probe 回调由上层（Runtime）提供，Dùng于判断 Android 是否真正Sẵn sàng。
 */
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');
const drivers = require('./drivers');
const userdata = require('./userdata');

const AVD_NAME = 'apkstart';
const SNAPSHOT_NAME = 'apkstart';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Windows 上把 emulator/qemu củaThoát码翻译成人话。
 * 0xC0000005（3221225477）是崩溃里最常见của那cái：访问冲突，实测多由
 * 显卡Trình điều khiển / Vulkan 后端在 guest 启动瞬间崩掉引起，换软件渲染即可绕过。
 */
function describeExitCode(code) {
  // 被信号结束时 code 是 null（Windows 上走 taskkill / adb emu kill 都会这样），
  // 不能当成 0 报「Thoát bình thường」，但也谈不上异常，返回Trống串让调Dùng方原样显示。
  if (code == null) return '';
  switch (Number(code)) {
    case 0: return 'Thoát bình thường';
    case 1: return 'Tham số khởi động hoặc môi trường bị lỗi';
    case 3221225477: return '0xC0000005 Lỗi truy cập, backend kết xuất bị sập';
    case 3221225725: return '0xC00000FD Tràn ngăn xếp';
    case 3221225781: return '0xC0000135 Thiếu DLL (thư viện VC++ / thành phần bộ chạy bị phần mềm diệt virus xóa)';
    case 3221225506: return '0xC0000022 Bị từ chối truy cập (lỗi trình điều khiển hoặc quyền)';
    case 3221225595: return '0xC000007B Số bit của ảnh không khớp hoặc DLL bị hỏng';
    default: return '';
  }
}

class EmulatorEngine {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this._log = [];
    this.port = 5554;
    this.adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044;
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    this.lastExitCode = null;
    /**
     * 本次开机生效củaTrình điều khiển（Bản vá tương thích）效果，以及命中củaTrình điều khiển清单。
     * 由 start() trong _resolveDrivers() 填；buildArgs / env / ensureAvd 只读它。
     */
    this._driverEffect = null;
    this._driversApplied = [];
    // 快照của ram.bin ≈ 分配给虚拟机củaBộ nhớ（2-4GB）。
    // Khởi động nguội本来就快của机器不该为它付出几cái GB của磁盘，只在「真慢」时才保存。
    this.snapshotWorthSaving = null;
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  /**
   * 把「最后一次Khởi động thất bại」落盘。
   * 旧版只放在Bộ nhớ里（this.attempts），Dùng户重启 ApkStart 后再Xuất báo cáo chẩn đoán，
   * 报告里就是 attempts: []、bootLog: [] 一片Trống白，只能在Nhật ký里翻 —— 这也是
   * issue #20/#25 里「附了报告却看不出原因」của直接原因。
   */
  _persistFailure(extra = {}) {
    try {
      const dir = path.join(store.DATA_DIR, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const data = {
        at: new Date().toISOString(),
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
        diagnosis: this.lastDiagnosis,
        attempts: this.attempts,
        ...extra,
      };
      fs.writeFileSync(path.join(dir, 'last-failure.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch (_) { /* 落盘Thất bại不影响主流程 */ }
  }

  /** 读回上一次Thất bại记录（Báo cáo chẩn đoán / 开机前提示Dùng） */
  lastFailure() {
    try {
      return JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), 'utf8'));
    } catch (_) { return null; }
  }

  _clearFailure() {
    try { fs.rmSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), { force: true }); } catch (_) { /* ignore */ }
  }

  get serial() { return `emulator-${this.port}`; }

  /** emulator.exe 与Ảnh hệ thống目录（优先Dùng户Bộ chạy目录，回退到仓库内 engine/） */
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

  /** Chọn镜像：Có通Dùng镜像（API 34 Play）就Dùng它，不再让Dùng户切「Tương thích模式」 */
  imageChoice() {
    const play = this.provisioner.playImageInfo();
    const base = this.provisioner.systemImageInfo();
    if (play.ok) {
      return { compat: true, api: play.api, tag: play.tag, dir: play.dir, abi: 'x86_64' };
    }
    return { compat: false, api: base.api, tag: base.tag, dir: base.dir, abi: base.abi || this.provisioner.paths().sysAbi };
  }

  /**
   * 作废 quickboot 快照。
   * 快照同时保存Bộ nhớ和磁盘镜像，装完新Áp dụng/清了数据后如果还加载旧快照，
   * Dùng户会看到「Vừa xong装好củaÁp dụng重启后又不见了」。
   */
  invalidateSnapshot() {
    this.cancelSnapshotSave();
    this._snapSaved = false;
    try {
      const snapDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots');
      fs.rmSync(snapDir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 清掉Lần trước异常Thoát留下của锁。
   * 注意 hardware-qemu.ini.lock 是**目录**不是文件，bsdtar 式của rmSync(force) 删不掉它，
   * 于是模拟器会一直报 "Running multiple emulators with the same AVD" 起不来
   * （被强杀过一次就会这样），必须递归删。
   */
  clearLocks(avdDir) {
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (!/\.lock$/i.test(f)) continue;
        try {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
        } catch (_) { /* 被占Dùng就跳过，下次再清 */ }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * AVD 目录里是否真củaCó一份**完整**của quickboot 快照。
   * 只判断「目录Không phảiTrống」是不够của：保存被中断时会留下一cái只Có 12 byte snapshot.pb củaTrống壳，
   * emulator 会尝试加载、Thất bại（Nhật ký "does not have the requested snapshot"）再回退Khởi động nguội，
   * 白等几秒。这里按文件LớnNhỏ校验，顺手清掉Trống壳和旧版遗留của default_boot（单cái 3GB）。
   */
  hasSnapshot() {
    const base = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
    const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const pb = size(path.join(base, 'snapshot.pb'));
    // 新版 emulator（37.x）写của是 ram.bin，老版本写 ram.img。
    // 只认 ram.img của后果Không phải常严重：刚存好của 3GB 快照会被当成Trống壳删掉，
    // 于是每次都带 -no-snapshot-load，永远Khởi động nguội —— 这是「Mở很慢」của一半原因。
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // 目录本来就没Có，别白删
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this._cleanLegacySnapshots();
    return false;
  }

  /** 清掉旧版遗留/Thất bại重命名留下của快照目录（default_boot trong ram.img Truy cập được 3GB） */
  _cleanLegacySnapshots() {
    const dir = path.dirname(path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (name === SNAPSHOT_NAME) continue;
      if (/^default_boot$|\.stale-\d+$/i.test(name)) {
        try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * 清掉占着 AVD 锁của孤儿模拟器。
   * emulator.exe 只是cái启动器，真正của qemu 被 spawn 成独立进程（detached），
   * 所以只 kill 自己手上của proc 句柄经常留cái孤儿在那占着 multiinstance.lock，
   * 下一次启动就会 FATAL "Running multiple emulators with the same AVD"。
   * 按「AVD 锁trong pid」+「命令行带本 AVD 名của qemu/emulator」两cái来源清。
   */
  /**
   * 当前 AVD 面板是横của还是竖của。
   *
   * 为什么要问这cái：Màn ngang**只能靠物理面板**实现 —— `wm size` 只改逻辑分辨率，画面会
   * 躺倒 90°；`adb emu rotate` 只转内容，系统里还是Màn dọc。真正生效của是
   * `hw.lcd.width/height` 互换 + 重启。而 config.ini 是每次开机时按当时củaCài đặt写của，
   * 所以读它就知道**Hiện跑着của这台**是什么方向。
   *
   * @returns {boolean|null} true=Bảng màn ngang，false=Bảng màn dọc，null=读不到
   */
  panelLandscape() {
    try {
      const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
      const cfg = fs.readFileSync(path.join(avdDir, 'config.ini'), 'utf8');
      const w = Number((/^hw\.lcd\.width=(\d+)$/m.exec(cfg) || [])[1]);
      const h = Number((/^hw\.lcd\.height=(\d+)$/m.exec(cfg) || [])[1]);
      if (!w || !h) return null;
      return w > h;
    } catch (_) {
      return null;
    }
  }

  async killOrphanProcesses({ onLog = () => {} } = {}) {
    if (process.platform !== 'win32') return 0;
    const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);

    // 快速Đường dẫn（每次Khởi động nguội都会走到）：
    //  - 没Có .lock → 不可能Có活着của emulator 占着这cái AVD，直接返回；
    //  - Có lock 但端口没人监听 → 只是Lần trước强杀留下của残留目录，清掉即可。
    // 以前无论什么情况都要跑一次 wmic（1~3 秒，还很吃 CPU），Khởi động nguội时明显拖慢。
    let locks = [];
    try { locks = fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)); } catch (_) { locks = []; }
    if (!locks.length) return 0;
    if (!(await this._anyEmulatorPortAlive())) {
      this.clearLocks(avdDir);
      return 0;
    }

    const pids = new Set();
    // 1) 锁文件里 emulator 自己写của pid（最可靠）
    try {
      const f = path.join(avdDir, 'hardware-qemu.ini.lock', 'pid');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (pid) pids.add(pid);
      }
    } catch (_) { /* ignore */ }
    // 2) 兜底：按进程名 + 端口找活着của qemu（tasklist/netstat 比 wmic 快一cái量级）
    try {
      const [tl, ns] = await Promise.all([
        new Promise((res) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
        new Promise((res) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
      ]);
      const qemuPids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) qemuPids.add(m[2]);
      }
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && qemuPids.has(m[2])) pids.add(Number(m[2]));
      }
    } catch (_) { /* 拿不到进程列表就只靠锁文件trong pid */ }
    pids.delete(process.pid);
    if (!pids.size) {
      this.clearLocks(avdDir);
      return 0;
    }
    onLog(`Dọn dẹp ${pids.size}  tiến trình trình giả lập còn sót`);
    await Promise.all([...pids].map((pid) => new Promise((r) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    })));
    await sleep(1200);
    this.clearLocks(avdDir);
    return pids.size;
  }

  /** 5554~5620 里是否Có emulator 控制台端口在监听（连接被拒会立刻返回，代价极Nhỏ） */
  async _anyEmulatorPortAlive() {
    const net = require('net');
    const probe = (port) => new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(120, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(port)) return true;
    }
    return false;
  }

  /**
   * 给界面/Chẩn đoánDùngcủaTrình điều khiển报告：这次开机Dùng了哪些、跳过了哪些、为什么。
   * @returns {{ applied:Array, effect:object|null, errors:Array, host:object|null }}
   */
  driverReport() {
    const pick = (d) => ({
      id: d.id, name: d.name, version: d.version, author: d.author || '',
      description: d.description || '', priority: d.priority, hits: d.hits || [],
      dir: d.dir || '', file: d.file || '',
    });
    return {
      applied: (this._driversApplied || []).map(pick),
      effect: this._driverEffect ? {
        gpuMode: this._driverEffect.gpuMode,
        forceTcg: this._driverEffect.forceTcg,
        notes: this._driverEffect.notes || [],
        ini: this._driverEffect.ini || {},
        env: this._driverEffect.env || {},
        args: (this._driverEffect.args || []).map((a) => (a.value ? `${a.flag}=${a.value}` : a.flag)),
      } : null,
      errors: this._driverErrors || [],
      host: this._driverHost || null,
    };
  }

  /**
   * 把Trình điều khiển声明của config.ini 覆盖mục套到默认配置上。
   * 已存在của键就地替换（不产生重复行），Không tồn tạicủa追加在后面。
   * 只处理 drivers.js 白名单trong键，Không phải法键在校验阶段就被拒了。
   */
  _iniWithDrivers(text) {
    const over = (this._driverEffect && this._driverEffect.ini) || {};
    const keys = Object.keys(over);
    if (!keys.length) return text;
    const seen = new Set();
    const out = String(text).split('\n').map((line) => {
      const m = /^([A-Za-z0-9_.]+)=/.exec(line);
      if (!m || !(m[1] in over)) return line;
      seen.add(m[1]);
      return `${m[1]}=${over[m[1]]}`;
    });
    for (const k of keys) if (!seen.has(k)) out.push(`${k}=${over[k]}`);
    return out.join('\n');
  }

  /**
   * 读一遍Trình điều khiển目录，挑出匹配这台机器của，存成本次开机của效果。
   *
   * 目录顺序即优先级：Mẫu tích hợp sẵn（只读，默认 enabled:false）在前，Dùng户Trình điều khiển在后，
   * 同 id 时Dùng户目录覆盖内置 —— Dùng户改了示例就能直接生效，不Dùng改Cài đặt目录。
   *
   * @returns {{ applied:Array, skipped:Array, errors:Array } | null}
   */
  _resolveDrivers({ accel, emulatorVersion }) {
    const s = this.settings || {};
    const disabled = (s.drivers && s.drivers.disabled) || [];
    const state = (s.drivers && s.drivers.state) || {};
    let gpuName = '';
    let osBuild = 0;
    try {
      const release = require('os').release() || '';
      const m = /(\d+)\s*$/.exec(release);
      osBuild = m ? Number(m[1]) : 0;
    } catch (_) { /* 拿不到就当 0，匹配条件里带 osBuild củaTrình điều khiển不会生效 */ }
    const host = drivers.hostContext({
      info: { ...doctor.hostInfo(), cpuVendor: (require('os').cpus() || [])[0]?.model || '' },
      gpuVendor: doctor.detectGpuVendor(),
      gpuName,
      osBuild,
      accel: accel && accel.ok ? (accel.kind || 'whpx') : 'none',
      emulatorVersion,
    });
    const loaded = drivers.loadAll([
      drivers.bundledDir(this.appRoot),
      drivers.userDir(store),
    ]);
    const r = drivers.resolve({ drivers: loaded.drivers, host, disabled, state });
    this._driverEffect = r.effect;
    this._driversApplied = r.applied;
    this._driverErrors = loaded.errors;
    this._driverHost = host;
    return { ...r, errors: loaded.errors, host };
  }

  /**
   * 准备 AVD：写 config.ini。每次启动按当前Tự cấu hình重写，保证降级重试即时生效。
   */
  ensureAvd({
    memoryMB = 2048, cores = 2, gpu = 'software', dataMB = 4096,
    heapMB = 256, accel = 'auto', snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });
    this.clearLocks(avdDir);

    // 屏幕分辨率：CóTăng tốc phần cứng时 720x1280@320 画面清晰、文字不糊；
    // Giả lập thuần phần mềm时降到 540x960，帧率优先（面积只Có 56%，肉眼差距远Nhỏ于流畅度差距）。
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
    const tagDisplay = choice.compat ? 'Google Play (ARM Tương thích)' : 'AOSP';

    fs.writeFileSync(
      path.join(home, `${AVD_NAME}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${api}\n`,
    );

    const cfgPath = path.join(avdDir, 'config.ini');
    const wantImg = choice.dir
      ? `${choice.dir.replace(/\\/g, '/')}/`
      : `system-images/android-${api}/${tag}/${choice.abi}/`;
    this.wipePending = false;
    if (fs.existsSync(cfgPath)) {
      const prev = fs.readFileSync(cfgPath, 'utf8');
      const prevTag = /tag\.id=(.+)$/m.exec(prev);
      const prevImg = /image\.sysdir\.1=(.+)$/m.exec(prev);
      // 比较「镜像身份」而不是绝对Đường dẫn：同一套镜像换盘/换目录不算换镜像，
      // 否则Dùng户一改Bộ chạy目录就会被清掉所CóỨng dụng đã cài（见 doctor.imageIdentity 注释）。
      const prevId = prevImg ? doctor.imageIdentity(prevImg[1].trim()) : '';
      const wantId = doctor.imageIdentity(wantImg);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevId && prevId !== wantId)) {
        // 旧 userdata 与新镜像不Tương thích（APEX 引导循环），必须重建
        this.wipePending = true;
      }
    }

    // 配置指纹变化 → 旧 quickboot 快照必然加载Thất bại或产生黑屏，主动作废。
    // 注意：这里只作废**快照**，绝不能顺手 -wipe-data —— Dùng户数据里是已装củaÁp dụng和存档。
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* 首次 */ }
    const snapshotStale = !!(prevKey && prevKey !== key);
    if (this.wipePending || snapshotStale || wipe) {
      // Xóa可能被系统/安全软件拦截（快照目录常Có几cái GB）。
      // Thất bại就改名让 emulator 不再加载它，绝不因为Dọn dẹp thất bại而中断启动。
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
    }
    // 只Có「镜像换了」（tag / sysdir 变化）才Cần -wipe-data：旧 userdata 与新镜像
    // của APEX 不Tương thích，不重建会一直卡在引导循环。改容量 / 改分辨率 / 换渲染后端都不算。
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch Phải là ABI 本身（x86_64 不能截成 x86）
    const cpuArch = choice.abi === 'arm64-v8a' ? 'arm64'
      : choice.abi === 'armeabi-v7a' ? 'arm' : choice.abi;

    const cfg = [
      `AvdId=${AVD_NAME}`,
      'avd.ini.displayname=ApkStart',
      'avd.ini.encoding=UTF-8',
      `abi.type=${choice.abi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      `vm.heapSize=${heapMB}`,
      `image.sysdir.1=${wantImg}`,
      `tag.id=${tag}`,
      `tag.display=${tagDisplay}`,
      // 旧版写死 16G，会在Nhỏ硬盘/配额环境下生成巨型文件并拖慢首次开机
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
      // 虚拟 Wi-Fi 必须显式Mở。API 34 của Play Store 镜像上网走của是
      // wlan0（netsim 虚拟网卡），不是早期của eth0。config.ini 里少了这一行，
      // 模拟器就不会给 wlan0 建链路——表现是 wlan0 一直 NO-CARRIER、
      // `dumpsys connectivity` 显示 Active default network: none，Áp dụng里就是
      // 一直「网络错误，Vui lòng thử lại sau」。命令行của -netdelay/-netspeed/-dns-server
      // 都只是 QEMU Dùng户态 NAT của参数，跟 guest 内部của网卡Có没Có被拉起来无关。
      'hw.wifi=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      `PlayStore.enabled=${choice.compat}`,
      // 快照完全由命令行 -snapshot apkstart 控制: dùng独立名字，绝不误加载
      // 旧版遗留của default_boot（那是 API30 镜像củaBộ nhớ状态，加载必进引导循环）。
      'hw.sdCard=no',
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
      // 方向/Tăng tốc度传感器必须关：一旦开启，Android 会按传感器Tự động旋转，把Màn dọc
      // 内容转成横của（画面整体躺倒 90°、文字竖着、四周黑边）。排版切换Hiện只靠
      // wm density（改 smallestWidth），不Cần也Không được phép传感器参与。
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, this._iniWithDrivers(cfg));

    // /data Phân vùng必须先「真của能Dùng」，否则后面一切都是白等（见 ensureDataPartition 注释）
    const data = this.ensureDataPartition(avdDir, dataMB);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen, data,
    };
  }

  /**
   * 保证 userdata Phân vùng是一cái**真正Khả dụng**của ext4 —— 这是「点开Áp dụng 30 秒进Màn hình nền」của地基。
   *
   * 为什么必须自己做（三条都是实测踩出来của）：
   *  1. Ảnh hệ thống包trong userdata.img 是 1MB 全零占位，真正Định dạng靠 avdmanager 调 SDK của
   *     mke2fs。ApkStart 直接写 config.ini 拉 emulator，跳过那一步 → /data 全零 →
   *     内nhân "Invalid ext4 superblock on /dev/block/vdc" → guest 掉进 recovery 重启循环 →
   *     adbd 永远不上线 → 上层 probe 一直 pending，最后 240s Hết thời gian。原表现：点开要等好几phút。
   *  2. emulator 自带của e2fsck/resize2fs 是 cygwin 版 e2fsprogs 1.42.12，**不认识 encrypt
   *     特性**，带这cái位它直接 exit 8 拒绝干活，所以「扩文件系统」必须排在补位之前。
   *  3. 文件系统必须 ≥ Phân vùngLớnNhỏ：只给 64MB của话，APEX Giải nén + dexopt 立刻写满，
   *     之后所Có setxattr 返回 ENOSPC → SELinux 标签写不进去 → netd/media/tombstoned
   *     一起 exit 1 → 开机卡在启动动画，adb 永远 offline。
   */
  ensureDataPartition(avdDir, dataMB = 4096) {
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) return { ok: false, reason: 'no-emulator' };
    try { fs.mkdirSync(avdDir, { recursive: true }); } catch (_) { /* ignore */ }
    const emuDir = path.dirname(emulatorExe);
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    let size = 0;
    try { size = fs.statSync(img).size; } catch (_) { /* Không tồn tại */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // 文件够Lớn + 文件系统也真của长到了这cáiLớnNhỏ，才算「不Dùng动」。
      // 只看文件LớnNhỏ会漏掉一种真实故障：qemu-img 撑开了文件、resize2fs 却Thất bại了，
      // 于是文件 6GB、安卓只Có 64MB —— Dùng户看到của就是「装游戏说Không đủ dung lượng」。
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // 容量配置变Lớn了（或文件系统没长到位）：就地扩容，不重建、保留Ứng dụng đã cài
      try {
        userdata.clearEncryptFlag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        this._resize2fs(img);
        userdata.setEncryptFlag(img);
        const grown = userdata.fsBytes(img);
        this.log(`userdata Mở rộng: tệp ${size} → ${wantBytes}, hệ thống tệp ${fsBytes} → ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        this.log(`Mở rộng userdata thất bại (tiếp tục dùng phân vùng hiện có):${e.message}`);
        // 老Phân vùng仍然Khả dụng，但必须如实告诉调Dùng方「这次没扩成」，不能让Cài đặt页显示成功
        return { ok: false, created: false, size, fsBytes, error: e.message };
      }
    }

    // 首次 / 旧版留下của全零占位 / 镜像损坏：全新造一cái
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // 先不带 encrypt 位（老 e2fsck/resize2fs 才肯干活）
      fs.writeFileSync(img, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      this._qemuImg('resize', img, wantBytes);
      this._resize2fs(img);
      userdata.setEncryptFlag(img);
      this.log(`Đã dựng lại userdata:${(wantBytes / 1024 / 1024 / 1024).toFixed(1)}GB ext4(4K block, hỗ trợ FBE)`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // 尽力而为：哪怕Mở rộng thất bại，也要把 encrypt 位补回去，让 FBE 能初始化（Phân vùng会偏Nhỏ）
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`Dựng lại userdata thất bại:${e.message}`);
      return { ok: false, created: true, error: e.message };
    }
  }

  /** emulator 自带 qemu-img.exe：把原始镜像文件撑到Mục tiêuLớnNhỏ（稀疏，瞬间Hoàn tất）
   *  注意参数顺序：`qemu-img <命令> -f raw <文件> <LớnNhỏ>`。
   *  把 -f 放命令前面会被它当成全局参数直接报 unrecognized option。 */
  _qemuImg(op, ...rest) {
    const exe = path.join(path.dirname(this.locate().emulatorExe), 'qemu-img.exe');
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: path.dirname(exe), windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`qemu-img ${op} Thất bại: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator 自带 resize2fs.exe（cygwin 版，必须在 bin64 目录下跑才能Tìm thấy DLL） */
  _resize2fs(img) {
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = path.join(bin, 'resize2fs.exe');
    if (!fs.existsSync(exe)) throw new Error('Thiếu resize2fs.exe');
    const r = spawnSync(exe, [img], {
      cwd: bin, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.status !== 0) throw new Error(`resize2fs Thất bại: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator 依赖这些环境变量定位 SDK / AVD；中文Đường dẫn一律转 8.3 短Đường dẫn */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // AVD 目录必须与 provisioner.paths().avdHome 一致：bundled 只读Bộ chạy（EXE 旁
    // resources/runtime）时 root/avd Không tồn tại也不可写，AVD 要落到Dùng户数据目录。
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
    const adbPort = String(plan.adbPort || process.env.ANDROID_ADB_SERVER_PORT || '5044');
    return {
      ...process.env,
      ANDROID_SDK_ROOT: safeRoot,
      ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
      ANDROID_ADB_SERVER_PORT: adbPort,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
      // Trình điều khiển声明của环境变量：只放行 ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_ 前缀（见 drivers.js）
      ...((this._driverEffect && this._driverEffect.env) || {}),
    };
  }

  /**
   * 要注入củaNgôn ngữ hệ thống。默认简体中文；Dùng户可在Cài đặt里改（engine.locale），
   * 设成 'en-US' 或 'off' 就回到镜像原生英文。
   */
  _guestLocale() {
    const v = String(this.settings?.engine?.locale || 'zh-CN').trim();
    if (!v || v === 'off' || /^false$/i.test(v)) return '';
    return v;
  }

  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null,
  } = {}) {
    // Trình điều khiển可以固定渲染后端 / 强制Giả lập phần mềm。放在最前面算进 gpu/accel，
    // 这样后面所Có逻辑（-accel off、config.ini của hw.gpu.mode）都跟着它走。
    const eff = this._driverEffect || null;
    const drvGpu = eff ? drivers.gpuModeToArg(eff.gpuMode) : '';
    if (drvGpu) gpu = drvGpu;
    if (eff && eff.forceTcg) accel = 'off';
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      // 音频：默认开启（让Ứng dụng Androidcủa提示音/视频声音能放出来）。      // 仅当Dùng户在Cài đặt里显式Đóng时才传 -no-audio 省一点 CPU。
      ...(this.settings?.engine?.audio === false ? ['-no-audio'] : []),
      '-no-boot-anim',
      '-no-metrics',
      // 关掉崩溃上报：一旦历史崩溃报告存在，emulator 会弹「同意上传」模态框，
      // 主luồng被卡住、永远不开机（Nhật ký表现为 Showing crashdialog to get consent）。
      '-crash-report-mode', 'disabled',
      '-gpu', gpu,
      '-memory', String(memoryMB),
      '-cores', String(cores),
    ];
    // 网络：AOSP 模拟器默认走 QEMU Dùng户态 NAT（-netdev user），安卓侧拿到
    // 10.0.2.x của虚拟地址，出口直接复Dùng主机của物理网卡 NAT 出去。
    // 这种模式【不会】在 Windows 上Tạo任何虚拟网卡 / 虚拟交换机
    // （那必须 -netdev tap 或桥接才会发生，我们全程不启Dùng）。
    // 所以Ứng dụng AndroidDùngcủa是"一台挂在主机 NAT 后面của设备"，主机网络栈完全不动，
    // 不Cần装Trình điều khiển、也不多一cái网络适配器。
    // 显式声明不限速：默认值虽然是 full，但某些 -gpu / -net 组合下会被带上
    // 模拟器của保守配置，视频类Áp dụng（红果、抖音）首屏就会明显慢半拍。
    args.push('-netdelay', 'none', '-netspeed', 'full');
    // Ngôn ngữ hệ thống：默认简体中文。
    // 实测 `-prop persist.sys.locale=zh-CN` 完全Không hợp lệ —— 模拟器会拦截 persist.sys.*
    // 这类受保护属性，ro.product.locale 又被镜像 build.prop 覆盖；guest 里 getprop
    // 一cái都看不到。官方专门给了 -change-locale：它会真正改Ngôn ngữ hệ thống并重启 framework，
    // 且会写进 /data，从快照恢复也能保留。
    // Dùng户可在Cài đặt里改成其它 locale 或关掉（engine.locale='off'）。
    const locale = this._guestLocale();
    if (locale) args.push('-change-locale', locale);
    // DNS：安卓默认Dùng 10.0.2.3（转发到主机 DNS）。主机走 VPN / 公司网 / 某些运营商
    // 时，一次解析能拖到几百毫秒，表现là “页面转圈半天才开始加载」。给一份国内公Tổng
    // DNS 作为首Chọn，Thất bại时系统仍会回退。Dùng户可在Cài đặt里关掉（内网域名场景）。
    if (this.settings?.engine?.fastDns !== false) {
      args.push('-dns-server', '223.5.5.5,119.29.29.29');
    }
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
      // 注意：**不能再传 -no-skin**。它会覆盖上面của -skin，让面板尺寸退回
      // config.ini trong旧值 —— 表现就是「Cài đặt里切了Màn ngang、实际还是Màn dọc」，
      // 以及「画面只占左上角一条」。面板尺寸必须由 -skin 决定。
      // 设备外壳本来就不会画（ShowDeviceFrame=no + 下面这组 style 参数）。
      // 注意：不能Dùng -qt-hide-window。它会让模拟器**根本不Tạo**那cái Qt 窗口，
      // 而窗口代理正是靠 SetParent 把这cái窗口嵌进Cửa sổ ứng dụng来显示画面của ——
      // Dùng了它之后 probe 永远Không tìm thấy窗口，Dùng户看到của是一cái全黑củaCửa sổ ứng dụng。
      // 窗口của隐藏改由窗口代理常驻压制Hoàn tất（见 win/agent.ps1 của QuietSweep）。
    }
    // 只Có快照真của存在才传 -snapshot：全新 AVD（或快照刚被作废）时传了它，
    // qemu 会一直等一份Không tồn tạicủaBộ nhớ状态，进程活着但永远不开机——
    // 上层只看到「开机Hết thời gian」，接着换参数重试，反而被 AVD 锁挡成
    // "Running multiple emulators with the same AVD"。
    // 快照参数决定「下次开机是 8 秒还是 90 秒」，这里是第二cái致命点：
    // 老实现「没Có快照就传 -no-snapshot」，而 -no-snapshot 同时禁掉了**Thoát时保存**，
    // 于是第一次Khởi động nguội结束后永远产生不了快照，Dùng户每次点开都是全量引导。
    // 正确做法是 -no-snapshot-load：这次不加载（避免等一cáiKhông tồn tạicủa快照），
    // 但Thoát时照常把Bộ nhớ状态写成 apkstart，下次就直接恢复。
    // 快照要占一份约 2~3GB của ram.bin（磁盘紧张củaDùng户可以关掉，只影响启动速度）
    const wantSnapshot = this.settings?.engine?.keepSnapshot !== false;
    if (wipe) {
      // 重置数据时不能加载旧快照（数据都对不上了），但**必须允许保存新快照**：
      // Sửa mạng就是靠「重置后第一次开机Có网 → 立刻存快照 → 下次恢复」这条链路，
      // 老写法这里推của是 -no-snapshot，会把保存一起关掉，快照永远存不下来。
      args.push('-no-snapshot-load');
    } else if (!wantSnapshot) {
      args.push('-no-snapshot');
    } else if (snapshot !== false) {
      args.push('-snapshot', SNAPSHOT_NAME);
      // 网络自愈要求这次Khởi động nguội：快照可能是在「没网」时存của，恢复出来依旧没网。
      if (!this.hasSnapshot() || this._coldBoot) args.push('-no-snapshot-load');
    } else {
      args.push('-no-snapshot');
    }
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
    // Trình điều khiển声明của其它参数：-gpu / -accel 已经由上面của gpu/accel 统一处理，这里跳过，
    // 避免同一cái参数出现两次（emulator 对重复参数của行为在不同版本上不一致）。
    for (const a of ((eff && eff.args) || [])) {
      if (a.flag === '-gpu' || a.flag === '-accel') continue;
      if (a.value === '') args.push(a.flag);
      else args.push(a.flag, a.value);
    }
    return args;
  }

  /** 拉起单cái进程（不做开机等待，开机等待在 start() của probe 循环里） */
  spawnOnce(plan, { headless, onLog, logFile }) {
    const loc = this.locate();
    const env = this.env(loc.root, plan);
    const args = this.buildArgs({
      headless, accel: plan.accel, port: plan.port, gpu: plan.gpu,
      memoryMB: plan.memoryMB, cores: plan.cores,
      snapshot: plan.snapshot, wipe: plan.wipe, lcd: plan.lcd,
    });
    this._logWrite(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      // detached: 让模拟器独立于 ApkStart 进程组。
      // Electron Thoát时会把自己Tạocủa job 对象关掉，顺带把子进程一起杀掉——
      // 表现就是"关掉 ApkStart 再Mở又要Khởi động nguội 20 多秒"。独立出去之后模拟器留着，
      // 下次启动直接接管（见 Runtime.adoptExisting），点开就是秒进。
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    try { proc.unref(); } catch (_) { /* ignore */ }

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          this.log(l.trim());
          this._logWrite(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      this.lastExitCode = code;
      const meaning = describeExitCode(code);
      this.log(`emulator exit ${code}${meaning ? `（${meaning}）` : ''}`);
      this._logWrite(logFile, `emulator exit ${code}${meaning ? `（${meaning}）` : ''}\n`);
      this.proc = null;
      onLog(`Bộ chạy đã thoát (code=${code}${meaning ? `，${meaning}` : ''}）`);
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this._logWrite(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });

    // qemu 是 detached của独立进程，等它真正起来再把优先级降下来。
    // 不降của话 2~4 cái vCPU luồng会以 Normal 优先级和 Windows Màn hình nền抢 CPU，
    // Dùng户最直观của感受就是「一Mở ApkStart，鼠标就发飘、整机变卡」。
    const perf = this.settings?.engine?.priorityMode === 'performance';
    setTimeout(() => {
      this.setPriority(perf ? 'normal' : 'below').catch(() => {});
    }, 3500).unref?.();
    return { proc, args };
  }

  /** 写模拟器Nhật ký：带LớnNhỏ滚动，避免长期使Dùng把磁盘写满 */
  _logWrite(file, text) {
    const limit = Math.max(2048, Number(this.settings?.engine?.logLimitKB || 2048) * 4);
    require('./logfile').append(file, text, limit);
  }

  /** 当前 /data 镜像của实际情况（Cài đặt页展示Dùng，不启动安卓也能取） */
  dataInfo() {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    let bytes = 0;
    try { bytes = fs.statSync(img).size; } catch (_) { /* 还没建 */ }
    let fsBytesNow = 0;
    try { fsBytesNow = userdata.fsBytes(img); } catch (_) { /* 还没建或损坏 */ }
    const configuredGB = Number(this.settings?.engine?.dataPartitionGB || 0);
    const fsGB = fsBytesNow ? Number((fsBytesNow / 1073741824).toFixed(1)) : 0;
    return {
      avdDir: dir,
      imageBytes: bytes,
      imageGB: bytes ? Number((bytes / 1073741824).toFixed(1)) : 0,
      // 文件系统实际LớnNhỏ（≠ 镜像文件LớnNhỏ）：扩了镜像但 resize2fs 没到位时这两cái数会不一样
      fsGB,
      configuredGB,
      // Dùng户设了Mục tiêu、但文件系统还没长到Mục tiêu
      pendingGB: configuredGB && fsGB ? Math.max(0, configuredGB - fsGB) : 0,
      // quickboot 会给 userdata 建一层 qcow2 覆盖层，guest 看到của是它，不是底座镜像
      overlay: this._hasDataOverlay(img),
    };
  }

  /** userdata 是否被 quickboot của qcow2 覆盖层接管（Có它就只能重置，不能就地扩容） */
  _hasDataOverlay(img) {
    try { return fs.existsSync(`${img}.qcow2`); } catch (_) { return false; }
  }

  /**
   * 立即把 /data Phân vùng扩容到指定LớnNhỏ（必须保证模拟器已停止，否则镜像被占Dùng）。
   *
   * 两种Đường dẫn，取舍是实测出来của：
   *  - 没Có quickboot 覆盖层：就地扩（qemu-img resize + resize2fs），不丢Ứng dụng đã cài；
   *  - Có覆盖层：guest 真正挂载của是 `userdata-qemu.img.qcow2`，底座扩到 8GB、
   *    文件系统也长到 8GB，guest 里 `df /data` 依旧是 5.7GB（覆盖层还是旧LớnNhỏ），
   *    而覆盖层trong文件系统没Có root 权限改不了。这种时候必须如实返回「Cần重置」，
   *    不能再像以前那样返回成功 —— Dùng户会以为扩好了，装 50GB 游戏依旧半路Thất bại。
   */
  resizeDataPartition(dataMB) {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    const wantGB = Math.max(1, Math.round(Number(dataMB || 0) / 1024));
    if (this._hasDataOverlay(img)) {
      return {
        ok: false,
        needsReset: true,
        fsGB: this.dataInfo().fsGB,
        error: `Android đang dùng đĩa chênh lệch của khởi động nhanh, mở rộng tại chỗ không tác động được (mục tiêu ${wantGB} GB）。`
          + 'Cần “Đặt lại dữ liệu Android” rồi dựng lại /data theo dung lượng mới — ứng dụng đã cài và bản lưu sẽ bị xóa, hãy xác nhận trước.',
      };
    }
    const r = this.ensureDataPartition(dir, dataMB);
    // ensureDataPartition 在 resize2fs Thất bại时会返回 ok:false；再nhân一次文件系统LớnNhỏ，
    // 防止「文件撑开了、文件系统没长」被当成功（Dùng户看到của就是装游戏说Không đủ dung lượng）。
    let fsAfter = 0;
    try { fsAfter = userdata.fsBytes(img); } catch (_) { /* ignore */ }
    const wantBytes = Math.max(1024, Math.round(Number(dataMB || 0))) * 1048576;
    if (r && r.ok && fsAfter < wantBytes * 0.95) {
      return {
        ok: false,
        ...r,
        fsGB: Number((fsAfter / 1073741824).toFixed(1)),
        error: `Ảnh đã mở rộng đến ${wantGB} GB, nhưng hệ thống tệp chỉ tới ${(fsAfter / 1073741824).toFixed(1)} GB(resize2fs không thành công).`
          + 'Có thể nhấn “Mở rộng ngay” thêm lần nữa, hoặc dọn đĩa rồi thử lại.',
      };
    }
    return r;
  }

  /**
   * 调整Máy này qemu/emulator 进程của优先级（只匹配命令行里带本 AVD 名của进程）。
   * level: idle（容器停放）| below（CóÁp dụng在前台）| normal（性能优先）。
   */
  setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const script = path.join(__dirname, 'win', 'priority.ps1');
    if (!fs.existsSync(script)) return Promise.resolve(0);
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Avd', AVD_NAME, '-Level', level,
      ], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const m = /CHANGED=(\d+)/.exec(String(out || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /** 强杀当前尝试（含 qemu 子进程树） */
  async killAttempt() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* ignore */ }
      }
    }
    await sleep(800);
    // proc 句柄常常已经没了（emulator.exe 启动完就Thoát，qemu 是 detached của独立进程），
    // 不按进程名兜底清一遍，下一轮就会被 AVD 锁挡成 FATAL。
    await this.killOrphanProcesses().catch(() => {});
  }

  /**
   * 重建本专Dùng端口上của adb server。
   *
   * 这里是「Mở ứng dụng要等两phút」最主要của元凶，历史实现只 kill-server 就返回了：
   * emulator 在启动瞬间会去连 ANDROID_ADB_SERVER_PORT 上của adb daemon，
   * 连不上就**再也不注册这台设备** —— adb devices 里要么没Có emulator-5554，
   * 要么永远停在 offline（Nhật ký里就是那句 "Unable to connect to adb daemon on port: 5044"）。
   * 于是上层 probe 一直拿不到 sys.boot_completed，白等 3 phútHết thời gian后重试，
   * 每次重试都是全量Khởi động nguội，快照也因là “设备不在线」保存不了，形成死循环。
   *
   * 所以必须先 kill（清掉旧设备记录）再 start，并等到端口真của在监听才返回。
   */
  /** 供上层在 adb 传输卡住（offline / unauthorized）时主动重启一次 server */
  async resetAdbServer() {
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    return this._resetAdbServer(port);
  }

  async _resetAdbServer(adbPort) {
    let adb = 'adb';
    try { adb = this.provisioner.adbVersionPath() || 'adb'; } catch (_) { /* Dùng PATH trong */ }
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) };
    const run = (args, timeout) => new Promise((resolve) => {
      try {
        execFile(adb, args, { timeout, windowsHide: true, env }, () => resolve());
      } catch (_) { resolve(); }
    });
    await run(['kill-server'], 6000);
    await run(['start-server'], 12000);
    // adb start-server 在部分机器上同步返回得很快，但端口还没真正 listen，
    // 这里等到能连上为止（最多 ~3 秒，正常几十毫giây)。
    const net = require('net');
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const alive = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: Number(adbPort) });
        let done = false;
        const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
        sock.setTimeout(150, () => fin(false));
        sock.once('connect', () => fin(true));
        sock.once('error', () => fin(false));
      });
      if (alive) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(120);
    }
    return false;
  }

  /**
   * 等待「spawn 后马上退」của情况。
   * 参数错误/DLL Thiếu失时 emulator 通常 1 秒内就退；进程还在则立刻返回，
   * 不必再干等固定 2.5 秒 —— 快照恢复时这段时间足够开机跑完一半。
   */
  _waitSpawnSettled(ms = 900) {
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const onExit = () => fin(true);
      const fin = (exited) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.removeListener('exit', onExit); } catch (_) { /* ignore */ }
        resolve(exited);
      };
      const timer = setTimeout(() => fin(false), ms);
      proc.once('exit', onExit);
    });
  }

  /**
   * 让「下一次启动」强制Khởi động nguội（不加载快速启动快照）。
   *
   * 快照里连网卡状态一起被保存：如果快照是在「没网」của时候存của，之后每次恢复都会
   * Tiếp tục没网。网络自愈时先Khởi động nguội一次能绕开这份坏快照。
   */
  forceColdBootOnNextStart() { this._coldBoot = true; }

  /**
   * 让「下一次启动」带上 -wipe-data（仅「Sửa mạng」在多种尝试都Thất bại后使Dùng）。
   * 「删掉 userdata 镜像文件」与 emulator của `-wipe-data` 并不等价，必须走后者。
   */
  forceWipeOnNextStart() { this._forceWipe = true; }

  /**
   * Kiểm tra sức khỏe虚拟机内是否真của能联网。
   *
   * 为什么Cần这一步：安卓虚拟机của Wi-Fi 配置存在 /data 里，一旦写坏（典型表现是
   * `cmd wifi list-networks` 里同一cái AndroidWifi 出现两条、网络 id 撞车），
   * wlan0 就会一直 NO-CARRIER、拿不到 IP。这时「Cần联网của页面」在Áp dụng里就是一块
   * 黑屏 —— Dùng户看到của「红果点同意后黑屏」就是这么来của，跟 GPU/渲染完全无关。
   *
   * @param {string} [adbPath] 显式指定 adb 可执行文件（Runtime Có更权威của解析）
   * @returns {Promise<{ok:boolean, reason:string, gateway?:string, ip?:string}>}
   */
  async checkNetwork(adbPath = '', { waitMs = 0, interval = 3000 } = {}) {
    const fs = require('fs');
    const path = require('path');
    // 同 repairWifi：防住「把函数当Đường dẫn传进来」这种调Dùng错误
    let adb = typeof adbPath === 'function' ? adbPath() : (adbPath || '');
    if (!adb) {
      try { adb = this.provisioner.adbVersionPath() || ''; } catch (_) { adb = ''; }
    }
    if (!adb) {
      // adbVersionPath() 只查「版本文件」，很多Cài đặt形态下是Trốngcủa；
      // 直接按Bộ chạy根目录找 bundled của platform-tools 才稳。
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 8000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // 安卓của多路由表会让 `ip route` của主表看起来是Trốngcủa（默认路由在 per-interface 表里），
    // 而且 shell của uid 不在Áp dụngcủa network 组里，`ping` 经常误报 "Network is unreachable"，
    // 哪怕 Wi-Fi 其实已经连上、Áp dụng也能正常上网。所以这里只认「Có没Có拿到 IPv4 地址」，
    // 再叠加 `cmd wifi status` của连接状态做交叉Xác nhận，不Dùng ping 判断。
    const addr = await sh('ip -o addr');
    const ips = [];
    const re = /inet ((?:\d{1,3}\.){3}\d{1,3})\//g;
    let m = re.exec(addr);
    while (m) {
      const ip = m[1];
      if (!/^127\./.test(ip)) ips.push(ip);
      m = re.exec(addr);
    }
    const wifi = await sh('cmd wifi status');
    const connected = /Wifi is connected/i.test(wifi);
    if (!ips.length) {
      // Wi-Fi 关联 + DHCP 往往比 sys.boot_completed 晚几十秒才Hoàn tất。
      // 调Dùng方给了 waitMs 就Tiếp tục等，不要在这一刻就断定「没Có网络」。
      if (waitMs > 0) {
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, interval));
          // eslint-disable-next-line no-await-in-loop
          const again = await this.checkNetwork(adbPath, { waitMs: 0 });
          if (again.ok) return again;
        }
      }
      return { ok: false, reason: connected ? 'no-ip-address' : 'wifi-not-connected', addrs: ips };
    }
    const ip = ips[0];
    const gw = /^10\.0\.2\./.test(ip) ? '10.0.2.2' : ip.replace(/\.\d+$/, '.1');
    // Có IP 不等于能上网。实测拿到 10.0.2.16 但 DNS/路由被掐时，Áp dụng首页还是
    // 「网络错误」，而上层却以为Mạng bình thường。这里补一次真实 HTTP 探测。
    // Dùng nc 直连 80 端口而不是 ping：QEMU Dùng户态 NAT 会拦 ICMP，ping 必然误报。
    // 只在「等待网络Sẵn sàng」那条Đường dẫn（waitMs>0）上做，快速轮询跳过——否则每 3 秒
    // 就要花 4 秒探测，反而把启动拖慢。结论放进 reachable，不改 ok：Có IP 就先
    // 让Áp dụng起来，一次 DNS 抖动不该卡住整cái启动。
    let reachable = null;
    if (waitMs > 0) {
      const probe = await sh(
        "echo -e 'GET /generate_204 HTTP/1.0\\r\\nHost: connect.rom.miui.com\\r\\n\\r\\n' "
        + "| nc -w 4 connect.rom.miui.com 80 2>/dev/null | head -1",
        7000,
      );
      reachable = /HTTP\/1\.[01]\s+204/.test(probe);
    }
    return { ok: true, reason: '', gateway: gw, ip, wifiConnected: connected, reachable };
  }

  /**
   * 把「Đã lưu但不会Tự động连」của AndroidWifi 主动连上。
   *
   * 这是实机踩出来của：模拟器自带của虚拟热点 AndroidWifi 在配置库里可能落成
   * 两条记录（open + owe），系统据此判定为
   *   「Saved / Won't automatically connect」
   * 于是开机后 wlan0 永远 NO-CARRIER，Áp dụng里一直报网络错误。
   *
   * 麻烦của是 shell（uid 2000）没Có NETWORK_SETTINGS 权限，
   * `cmd wifi connect-network` 会直接抛 SecurityException，所以不能走命令行。
   * 这里改为拉起 Wi-Fi Cài đặt页、点一下那条Đã lưucủa网络——和Dùng户手动点của效果一样。
   *
   * @returns {Promise<boolean>} 是否已连上
   */
  async repairWifi(adbPath = '') {
    const fs = require('fs');
    const path = require('path');
    // 防御：调Dùng方可能误把函数本身传进来（rt.adbPath 是cái方法）。
    let adb = typeof adbPath === 'function' ? adbPath() : (adbPath || '');
    if (!adb) {
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 10000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // 连上之后顺手把「联网验证」của探测地址换成国内Truy cập đượccủa。
    // 安卓默认拿 connectifitycheck.gstatic.com 判断「是否真能上网」，国内连不上它，
    // 系统就一直给网络打「!」标记（已连接但无法访问互联网）。部分Áp dụng会因此
    // 自我判定为离线、拒绝加载内容。换成一cái返回 204 của国内端点即可。
    const tune = async () => {
      await sh('settings put global captive_portal_http_url http://connect.rom.miui.com/generate_204');
      await sh('settings put global captive_portal_https_url https://connect.rom.miui.com/generate_204');
      await sh('settings put global captive_portal_mode 0');
    };
    // 已经连上就别折腾了
    if (/Wifi is connected/i.test(await sh('cmd wifi status'))) {
      await tune();
      return true;
    }
    // 开关被关掉时（Dùng户手滑 / 之前 -svc wifi disable）先Mở
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 1500));

    // Mở Wi-Fi Cài đặt页，Dùng uiautomator Tìm thấy AndroidWifi 那一行再点它。
    // 比按坐标点稳：不同分辨率 / 语言下坐标都不一样。
    await sh('am start -a android.settings.WIFI_SETTINGS');
    await new Promise((r) => setTimeout(r, 2500));
    await sh('uiautomator dump /sdcard/ui.xml');
    const xml = await new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', 'cat', '/sdcard/ui.xml'],
          { timeout: 10000, windowsHide: true, env, maxBuffer: 8 * 1024 * 1024 },
          (e, out) => resolve(e ? '' : String(out || '')));
      } catch (_) { resolve(''); }
    });
    // 节点形如 <node text="AndroidWifi" ... bounds="[x1,y1][x2,y2]" />
    const re = /<node[^>]*\btext="([^"]*)"[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    let m = re.exec(xml);
    while (m) {
      const label = m[1];
      if (/AndroidWifi/i.test(label)) {
        const cx = Math.round((Number(m[2]) + Number(m[4])) / 2);
        const cy = Math.round((Number(m[3]) + Number(m[5])) / 2);
        await sh(`input tap ${cx} ${cy}`);
        await new Promise((r) => setTimeout(r, 6000));
        if (/Wifi is connected/i.test(await sh('cmd wifi status'))) {
          await tune();
          return true;
        }
      }
      m = re.exec(xml);
    }
    // 兜底：直接重连一次看看（Có些版本 dump 里没Có text，只Có content-desc）
    await sh('svc wifi disable');
    await new Promise((r) => setTimeout(r, 1500));
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 6000));
    const ok = /Wifi is connected/i.test(await sh('cmd wifi status'));
    if (ok) await tune();
    return ok;
  }

  /**
   * 启动 + Tự động重试。
   * @param {Function} probe 异步回调，返回 'ok' | 'pending' | 'fatal'
   */
  async start({ headless = false, onLog = () => {}, probe = null, maxAttempts = 4 } = {}) {
    if (this.proc && !this.proc.killed) {
      // 关键：emulator.exe 只是启动器，spawn 完 qemu 自己就Thoát了，而这cái proc
      // 对象会一直留着（killed 仍是 false）。只看它会把「已经关掉của机器」当成
      // 还活着 —— 重启换面板后紧接着 ensure() 就踩过这cái坑：start() 直接返回
      // reused，调Dùng方拿着一cái已经死掉của serial 去 adb，报 `device not found`，
      // 表现就是「切换Áp dụng到另一cái方向của App 直接Thất bại」。
      // 所以必须再Xác nhận控制台端口上真củaCó机器在跑，才算复Dùng。
      if (await this._consoleAlive()) {
        return { ok: true, reused: true, serial: this.serial, port: this.port };
      }
      onLog('Trình giả lập lần trước đã thoát, đang khởi động lại…');
      this.proc = null;
    }

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error('Chưa cài engine của bộ chạy, hãy triển khai trước ở trang “Bộ chạy”');
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error('Ảnh hệ thống chưa sẵn sàng, hãy tải ảnh hệ thống Android ở trang “Bộ chạy” trước');
    }

    const s = this.settings;
    // 开机前先看一眼磁盘：模拟器写của是 AVD（数据Phân vùng + 快照，几cái GB），
    // 只Có它所在磁盘của余量才决定能不能开机；Bộ chạy目录只写Nhật ký，要求低得多。
    // 之前把两者của余量取最Nhỏ值，结果「数据目录已经挪到 D 盘、C 盘Chỉ còn 400MB」
    // 会被误判成磁盘不足 —— 挪盘等于白挪。
    const avdHome = this.provisioner.paths().avdHome;
    const avdFreeMB = doctor.freeDiskMB(avdHome);
    const diskMB = doctor.freeDiskMB(loc.root);
    const needMB = 2500;
    if (avdFreeMB && avdFreeMB < needMB) {
      const msg = `Không đủ dung lượng đĩa: thư mục dữ liệu Android (${avdHome}) chỉ còn ${(avdFreeMB / 1024).toFixed(1)} GB，`
        + `Bộ chạy cần ít nhất ${(needMB / 1024).toFixed(1)} GB Khả dụng. Hãy vào “Cài đặt → Tích hợp hệ thống → Thư mục dữ liệu Android”`
        + 'Hãy đổi sang ổ còn dư dung lượng (ví dụ D:) hoặc dọn đĩa trước. Ứng dụng và dữ liệu lưu của bạn không bị tự xóa.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    if (diskMB && diskMB < 300) {
      const msg = `Thư mục bộ chạy (${loc.root}) chỉ còn ${(diskMB / 1024).toFixed(1)} GB，`
        + 'Ngay cả nhật ký và tệp tạm cũng không ghi được. Hãy dọn đĩa, hoặc đổi cả “Thư mục dữ liệu bộ chạy” sang ổ khác.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
    // 让本进程里所Có adb 调Dùng和 emulator Dùng同一cái server 端口
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;

    // 这四件事互不依赖，并行做：以前是「Tăng tốc检查 → 版本 → 探端口 → 清 adb server」串行，
    // Khởi động nguội前白等 3~5 秒，正好是Dùng户点开Áp dụng后盯着加载框của那段时间。
    // 上一次运行留下của adb server 可能还挂着旧设备记录（会把新模拟器挤成 offline），
    // 所以清 server 仍然要做，只是不必单独等它。
    const [accelInfo, verInfo, startPort] = await Promise.all([
      this.provisioner.emulatorAccel(),
      this.provisioner.emulatorVersion(),
      doctor.freePortPair(5554),
      this._resetAdbServer(adbPort),
    ]);
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;

    // Trình điều khiển（Bản vá tương thích）：先看清这台机器是什么样，再看Có没Có人给它写过补丁。
    // 这一步只读 JSON，Không chạy bất kỳ mã nào；匹配不上就是Trống效果，行为和以前完全一致。
    let drv = { applied: [], skipped: [], errors: [], effect: null };
    try {
      drv = this._resolveDrivers({ accel: accelInfo, emulatorVersion: emuVersion });
    } catch (e) {
      this.log(`Tải trình điều khiển thất bại:${e.message}`);
      onLog(`Tải trình điều khiển thất bại (đã bỏ qua, khởi động với tham số mặc định):${e.message}`);
    }
    if (drv.applied.length) {
      onLog(`Đã áp dụng trình điều khiển:${drv.applied.map((d) => `${d.name} v${d.version}`).join('、')}`);
      for (const n of (this._driverEffect.notes || []).slice(0, 4)) onLog(`· ${n}`);
    } else {
      onLog('Không khớp trình điều khiển nào, khởi động với tham số mặc định');
    }
    if (drv.errors && drv.errors.length) {
      onLog(`Có ${drv.errors.length}  tệp trình điều khiển không nạp được (xem lý do ở Cài đặt → Trình điều khiển)`);
    }

    // 与Cài đặt页 / Báo cáo chẩn đoánTổngDùng同一cái入口，保证「显示của」就是「实跑của」
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    let variants = doctor.planVariants(profile).slice(0, maxAttempts);
    // Trình điều khiển指定了渲染后端 / 要求Giả lập phần mềm时，每一轮都按它来：
    // Dùng户装Trình điều khiểncủa目của就是「这台机器只能Dùng这一档」，Tiếp tụcThử trước崩过của后端只会白等。
    if (drv.applied.length && this._driverEffect) {
      const gpuFixed = drivers.gpuModeToArg(this._driverEffect.gpuMode);
      if (gpuFixed) {
        variants = variants.map((v) => ({ ...v, gpu: gpuFixed }));
        onLog(`Trình điều khiển cố định backend kết xuất là ${gpuFixed}`);
      }
      if (this._driverEffect.forceTcg) {
        variants = variants.map((v) => ({ ...v, accel: 'off', label: `${v.gpu} / Trình điều khiển yêu cầu giả lập phần mềm` }));
        onLog('Trình điều khiển yêu cầu tắt tăng tốc phần cứng (dùng giả lập phần mềm)');
      }
    }

    // 记住「Lần trước拉起就崩」của GPU 后端，下次把它排到最后。
    // 实测：AMD Radeon 780M 上 `-gpu host` 能通过 emulator 自己của硬件检查，
    // 但 VM 起来十几秒后进程直接 exit 1（Nhật ký里只Có "AEHD is operational"），
    // 每次都要白等 20 多秒再退到 swangle。key 里带上 emulator 版本，
    // 升级Bộ chạy后Tự động重新给它一次机会。
    const badGpuKey = this.settings.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    if (badGpu && badVer === emuVersion) {
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (variants[0] && variants[0].gpu === badGpu && variants.length > 1) {
        onLog(`Lần trước ${badGpu} Backend kết xuất sập ngay khi khởi động, lần này chuyển sang dùng ${variants[1].gpu} Thử trước`);
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);
    this._logWrite(logFile, `drivers: ${drv.applied.length ? drv.applied.map((d) => `${d.id}@${d.version}`).join(', ') : '(none)'}\n`);

    // 屏幕规格在整cái启动过程中保持一致，否则每次重试都换分辨率会狂清快照。
    // 分辨率来自 doctor của profile（Cài đặt里可改「画质」），auto 时按Tăng tốc状态Chọn。
    const screen = (profile && profile.lcd) || doctor.lcdFor({ accelOk: accelInfo.ok });
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';

    // 冷启前先清孤儿：上一次运行留下của qemu 仍占着 AVD 锁时，
    // 所Có尝试都会立刻 FATAL "Running multiple emulators with the same AVD"。
    // eslint-disable-next-line no-await-in-loop
    await this.killOrphanProcesses({ onLog }).catch(() => {});

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // 端口占Dùng也会导致Thất bại，每次重试重新探测一次
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen };
      this.port = port;
      // 每轮重置Thoát码：上一轮 0xC0000005 不能带进下一轮củaChẩn đoán里
      this.lastExitCode = null;
      // Nhật ký也按轮切分：Bộ nhớNhật ký是跨轮累积của，第 1 轮của崩溃行若留在尾部，
      // 第 2 轮（比如换后端后端口冲突）会被误诊成同一cái崩溃。
      const logStart = this._log.length;
      onLog(`Đang khởi động bộ chạy (lần ${i + 1}/${variants.length} lần:${plan.label}）…`);

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
        // _forceWipe 也要参与「删旧快照」：重置数据后旧快照必然加载Thất bại
        // （实测报 Failed to load snapshot 后退回Khởi động nguội），必须先清掉再重建。
        wipe: plan.wipe || !!this.wipePending || !!this._forceWipe,
      });
      // 埋点：上层（main）Dùng它在拉起模拟器**之前**Mở黑窗压制。
      // 控制台窗口在 spawn 之后几十毫秒就冒出来，事后再补一次扫描必然闪一下，
      // 所以这里必须先把它Mở、再拉起进程。
      if (this.onBeforeSpawn) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
      }
      // eslint-disable-next-line no-await-in-loop
      const forceWipe = !!this._forceWipe;
      this._forceWipe = false;
      // _coldBoot 只对这次 spawn 生效，避免之后每次开机都退化成长时间Khởi động nguội
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending || forceWipe }, { headless, onLog, logFile });
      this._coldBoot = false;

      // 参数错误 / DLL Thiếu失会立刻Thoát
      // eslint-disable-next-line no-await-in-loop
      const dead = await this._waitSpawnSettled(2200);
      if (dead || !this.proc) {
        const d = doctor.diagnose(this._attemptLines(logStart, 60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code, exitCode: this.lastExitCode });
        this.lastDiagnosis = d;
        lastError = `${d.title}：${d.hint}`;
        // 磁盘写满不是「换组参数就能好」của问题：Tiếp tục重试只会反复Thất bại，
        // 而且历史上最后那组参数带 wipe，会把Dùng户数据一起抹掉。直接收工、如实报错。
        if (d.code === 'DISK_FULL') {
          onLog('Không đủ dung lượng đĩa, đã dừng thử lại (không động đến ứng dụng và bản lưu của bạn).');
          this._persistFailure({ profile, why: 'disk-full' });
          return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts, exitCode: this.lastExitCode };
        }
        // Tăng tốc/镜像类结论可能是缓存trong旧数据，作废掉，下次启动重新探测
        if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL', 'ACCESS_VIOLATION'].includes(d.code)) {
          try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
        }
        onLog(`${d.title}, tự đổi bộ tham số và thử lại…`);
        this._noteGpuFailure(plan);
        continue;
      }

      if (!probe) {
        return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile, attempts: this.attempts };
      }

      const started = Date.now();
      const timeout = plan.bootTimeoutMs || 240000;
      let ok = false;
      let fatal = false;
      let sawBooting = false;
      // 快照恢复往往几秒内就能起，固定 3 秒一次意味着平均要多等 1.5 秒才「Phát hiện」
      // 它已经好了。这里从 200ms 起步逐步放宽到 1.2 秒：开机早期能立刻抓到，
      // 长引导过程也不会把 CPU 花在轮询上。
      let interval = 200;
      let lastNotice = 0;
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() - started < timeout) {
        if (!this.proc) { fatal = true; break; }
        let state = 'pending';
        try {
          // eslint-disable-next-line no-await-in-loop
          state = await probe({ serial: this.serial, port, adbPort });
        } catch (_) { state = 'pending'; }
        if (state === 'ok') { ok = true; break; }
        if (state === 'fatal') { fatal = true; break; }
        // 只要 adb 能执行 shell，说明内nhân已经在引导，Nhật kýtrong普通 Vulkan/EGL 信息不算Thất bại
        if (state === 'booting') sawBooting = true;
        // 45 秒仍完全没连上，且Nhật ký出现明确致命错误 → 提前换方案，不干等 4 phút
        if (!sawBooting && Date.now() - started > 45000) {
          const d = doctor.diagnose(this._attemptLines(logStart, 80));
          if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY', 'ACCESS_VIOLATION'].includes(d.code)) {
            this.lastDiagnosis = d;
            try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
            fatal = true;
            break;
          }
        }
        // 每 15 秒一条进度：以前Dùng「取模」判断，自适应间隔下会连着打两三条重复của
        if (Date.now() - lastNotice > 15000) {
          lastNotice = Date.now();
          onLog(`Đang khởi động… ${Math.round((Date.now() - started) / 1000)}s`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(interval);
        interval = Math.min(1200, Math.round(interval * 1.6));
      }

      if (ok) {
        const bootMs = Date.now() - started;
        // 这一次真của起来了：清掉Lần trướccủaThất bại记录，避免以后「Chẩn đoán」翻出旧账
        this._clearFailure();
        // 一定要存 quickboot 快照：模拟器进程会随 ApkStart Thoát而结束（Electron của
        // job 对象会连带杀掉子进程），下次MởCó没Có快照直接决定是 25 秒还是 7 秒。
        // 装完新Áp dụng时 installer 会作废快照，避免"重启后Áp dụng消失"。
        this.snapshotWorthSaving = true;
        onLog(`Bộ chạy sẵn sàng (${Math.round(bootMs / 1000)}s，${plan.label}）`);
        // 开机成功不等于能Dùng：顺手Kiểm tra sức khỏe网络。虚拟机没网时，Cần联网của页面会一直黑屏，
        // Dùng户只会说「这 ứng dụng黑屏」，很难联想到是网络。这里主动查一次并说清楚。
        //
        // 但不能「查一次就下结论」：Wi-Fi 关联 + DHCP 普遍比 sys.boot_completed 晚
        // 5~20 秒，以前这里只调 checkNetwork() 一次，于是**每次Khởi động nguội**都会打一条
        // 「⚠ 没Có网络，请Đặt lại dữ liệu Android」，而 5 秒后网络Sẵn sàng了 —— Dùng户照着做就会
        // 丢光Ứng dụng đã cài。Hiện给它 12 秒等待窗口（Sẵn sàng即返回），真Hết thời gian才提示，
        // 而且不再建议破坏性操作。
        let network = null;
        try {
          network = await this.checkNetwork('', { waitMs: 12000, interval: 3000 });
        } catch (_) { /* Kiểm tra thất bại不算Khởi động thất bại */ }
        if (network && !network.ok) {
          onLog('⚠ Máy ảo Android tạm thời chưa có mạng (Wi-Fi chưa kết nối hoặc chưa nhận địa chỉ).'
            + 'Ứng dụng cần mạng có thể bị đen màn hình sau khi mở: mở lại ứng dụng sau một lúc là được;'
            + 'Nếu vẫn không có mạng, vào “Cài đặt → Sửa mạng” để kết nối lại (không xóa ứng dụng đã cài).');
        }
        return {
          ok: true, serial: this.serial, port, accel: accelInfo, logFile,
          profile, attempts: this.attempts, bootMs, quickBoot: true, network,
        };
      }

      const attemptLines = this._attemptLines(logStart, 80);
      const d = fatal ? (this.lastDiagnosis || doctor.diagnose(attemptLines)) : doctor.diagnose(attemptLines);
      this.attempts.push({ plan: plan.label, diagnosis: d.code, timeout: !fatal, exitCode: this.lastExitCode });
      this.lastDiagnosis = d;
      lastError = fatal ? `${d.title}：${d.hint}` : 'Khởi động quá thời gian (có thể lần khởi động đầu chậm hoặc tăng tốc phần cứng chưa có hiệu lực)';
      onLog(`${lastError}, tự đổi bộ tham số và thử lại…`);
      // 授权对话框卡住不是渲染后端của问题，别把当前 GPU 记进「启动即崩」黑名单，
      // 否则下次启动会无缘无故跳过Dùng户机器本来能Dùngcủa后端。
      if (d.code !== 'ADB_UNAUTHORIZED') this._noteGpuFailure(plan);
      // eslint-disable-next-line no-await-in-loop
      await this.killAttempt();
    }

    const d = this.lastDiagnosis || doctor.diagnose(this.recentLog(120));
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: {
        attempts: this.attempts,
        diagnosis: d,
        image: choice,
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
      },
    });
    const err = new Error(
      `Bộ chạy thử nhiều lần vẫn không khởi động được (${d.title}）。\n${d.hint}\n\n`
      + `Đã thử:${this.attempts.map((a) => `${a.plan} → ${a.diagnosis}`).join('；')}\n`
      + `Báo cáo chẩn đoán:${report.file}`,
    );
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    this._persistFailure({ profile, why: 'boot-failed', report: report.file });
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

  /**
   * 保存 quickboot 快照（下次开机直接恢复Bộ nhớ状态，像 WSA/Áp dụng宝của快速启动）。
   *
   * 时机很重要：以前của实现是开机后 6 秒就存，正好和Dùng户点开Áp dụng抢磁盘 I/O
   * （快照要写 1~3GB），体感反而更慢。改成「Trống闲时再存」，并由 Runtime 在
   * 最后一 cửa sổ ứng dụngĐóng时触发；关机前若还没来得及存，也会补一次。
   */
  async saveSnapshotNow(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    const ok = await this._saveViaAdb(adbPath, { timeout });
    // emulator của save 命令可能在写盘中途就回 OK，这里按文件完整性Xác nhận lại lần nữa，
    // 只Có snapshot.pb 真正落盘才算数（否则下次加载会Thất bại并白等几giây)。
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /**
   * 安排一次「Trống闲时保存快照」。
   * 只排一次；如果到点时容器还CóÁp dụng在前台，就推迟到真正Trống闲。
   */
  scheduleSnapshotSave(adbPath, { delay = 20000, isIdle = () => true } = {}) {
    if (!adbPath) return;
    if (this._snapTimer) clearTimeout(this._snapTimer);
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        this._snapTimer = null;
        if (!this.running()) return;
        if (!isIdle()) { arm(15000); return; }
        // 磁盘余量不够写快照（Bộ nhớLớnNhỏ + 1GB 余量）就跳过：硬写只会把磁盘写满，
        // 进而让下一次开机直接Thất bại。快照只影响启动速度，不写也不影响数据。
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`Bỏ qua lưu snapshot: dung lượng đĩa còn ${(freeMB / 1024).toFixed(1)}GB < Cần ${(needMB / 1024).toFixed(1)}GB`);
          return;
        }
        await this.saveSnapshotNow(adbPath).catch(() => false);
        this._snapSaved = true;
      }, ms);
      if (this._snapTimer.unref) this._snapTimer.unref();
    };
    arm(delay);
  }

  cancelSnapshotSave() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
  }

  /** 优雅停止：慢机器先保存 quickboot 快照，再走控制台关机，最后强杀进程树 */
  async stop({ adbPath } = {}) {
    if (!this.proc) {
      // 接管来của实例没Có proc 句柄，但端口上确实Có机器在跑，不能直接返回 true 走人
      if (!(await this._anyEmulatorPortAlive())) return true;
    }
    this.cancelSnapshotSave();
    const serial = this.serial;
    // 关机前先判断 guest 是否健康，只在这一次判断里问一遍 adb：
    //  - 健康 → 补存一次快照（Trống闲Đường dẫn没来得及存时，下次仍能秒进）；
    //  - 不健康（adb 卡在 unauthorized / 没开机Hoàn tất）→ 不存，并且**在Thoát后作废快照**：
    //    `adb emu kill` 会让 emulator 自己按 quickboot 存一份Bộ nhớ状态，那份同样会
    //    冻结未授权状态。不在这里清掉，下次恢复又是一份「开机必Hết thời gian」của毒快照。
    const healthy = adbPath ? await this._adbGuestHealthy(adbPath) : false;
    if (adbPath && this.snapshotWorthSaving !== false && healthy) {
      // 3GB Bộ nhớ写盘要几秒到二十几秒，Hết thời gian给足，别让快照写一半就被 kill 掉。
      await this._saveViaAdb(adbPath, { timeout: 60000 });
    }
    if (!healthy && this.snapshotWorthSaving !== false) {
      this.log('Khi tắt máy guest chưa được cấp quyền/chưa sẵn sàng: sẽ hủy snapshot, lần sau khởi động nguội để cấp lại quyền gỡ lỗi');
    }
    if (adbPath) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'kill'],
          { timeout: 10000, windowsHide: true }, () => resolve());
      });
    }
    // 等它自己走完「落盘 → Thoát」của流程。以前固定等 6 秒就强杀，
    // 正好把快照写盘掐断，留下一cái只Có ram.img 没Có snapshot.pb củaTrống壳。
    //
    // 注意不能等 this.proc：emulator.exe 只是cái启动器，spawn 完 qemu 自己就退了，
    // 拿它của exit 当「关机Hoàn tất」会立刻进入强杀分支。这里以控制台端口为准。
    for (let i = 0; i < 100 && (await this._consoleAlive()); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    await this.killAttempt();
    // 关干净了就把启动器句柄丢掉。留着它会让 running() 永远返回 true、
    // start() 以为还能复Dùng（见 start() trong注释）。
    this.proc = null;
    // 进程Đã thoát，这时再作废它可能在Thoát时Tự động存của毒快照。顺序很重要：必须放在
    // emu kill + 端口Đóng之后，否则它会把刚删của快照又写回来。
    if (!healthy && this.snapshotWorthSaving !== false) {
      try { this.invalidateSnapshot(); } catch (_) { /* ignore */ }
    }
    return true;
  }

  /**
   * 记下「拉起就崩」của GPU 后端，下次启动把它排到最后。
   * 只对 auto 模式生效: dùng户显式指定后端时尊重Dùng户Chọn择，不偷偷改。
   */
  _noteGpuFailure(plan) {
    try {
      const gpu = plan && plan.gpu;
      if (!gpu) return;
      // 软件渲染是兜底mục，它已经是最慢/最稳củaChọn择，没Có更差của替代品可退
      if (/software|swiftshader|swangle/.test(gpu)) return;
      if ((this.settings.engine.gpuMode || 'auto') !== 'auto') return;
      store.saveSettings({ engine: { badGpu: `${this._emuVersion || ''}|${gpu}` } });
    } catch (_) { /* ignore */ }
  }

  /** 本实例của控制台端口（5554）上是否还Có机器在跑 —— 判断「到底关干净了没Có」 */
  _consoleAlive() {
    const net = require('net');
    const port = this.port || 5554;
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(200, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
  }

  /**
   * guest 是否处于「可以安全存快照」của健康状态：adb authorized + boot Hoàn tất。
   * Khởi động nguội时若「允许 USB 调试吗？」对话框还挂着，state 是 unauthorized —— 这时存下
   * Bộ nhớ + 磁盘，guest 里就没Có host của adbkey.pub，下次恢复还是 unauthorized，
   * 每轮探测của shell 都抛异常，干等 240s 还被误诊成显卡/虚拟化问题。
   */
  async _adbGuestHealthy(adbPath) {
    if (!adbPath) return false;
    try {
      const { AdbClient } = require('./adb');
      const probe = new AdbClient({ adbPath, serial: this.serial });
      const state = await probe.deviceState();
      const out = await probe.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '');
      return state === 'device' && String(out).trim() === '1';
    } catch (_) {
      return false; // 读不到就按不健康处理
    }
  }

  /**
   * Dùng adb 触发一次快照保存（Thất bại返回 false，调Dùng方决定要不要再试）。
   * 只Có guest 健康时才存，宁可下次Khởi động nguội 20 多秒，也不能存一份「开机必Thất bại」của毒快照。
   */
  async _saveViaAdb(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    if (!(await this._adbGuestHealthy(adbPath))) {
      this.log('Bỏ qua lưu snapshot: guest chưa được cấp quyền hoặc chưa khởi động xong (tránh lưu snapshot lỗi chưa cấp quyền)');
      return false;
    }
    return new Promise((resolve) => {
      execFile(adbPath, ['-s', this.serial, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
        { timeout, windowsHide: true }, (err) => resolve(!err));
    });
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }

  /**
   * 只取「本轮启动尝试」产生củaNhật ký行。
   * Bộ nhớNhật ký是跨轮累积của（Báo cáo chẩn đoán要看到全部尝试），但Chẩn đoán结论必须只看本轮：
   * 否则第 1 轮của `emulator exit 3221225477` 会让第 2 轮của任何Thất bại都被判成同一cái崩溃。
   * 本轮一条Nhật ký都没Có时（进程压根没起来）退回整体尾部，至少给cái结论。
   */
  _attemptLines(from, max = 80) {
    const lines = this._log.slice(Math.max(0, from || 0)).map((x) => x.line);
    return lines.length ? lines.slice(-max) : this.recentLog(max);
  }

  /**
   * 从 emulator.log 文件尾部读最近 n 行（Bộ nhớ缓冲为Trống时Dùng）。
   * Dùng户重启 ApkStart 再Xuất báo cáo chẩn đoán时，Bộ nhớtrong this._log 已经Trống了，
   * 旧版报告因此Chỉ còn一句 UNKNOWN —— 真实崩溃原因全在Nhật ký文件里。
   */
  tailLogFile(n = 300) {
    try {
      const file = path.join(store.DATA_DIR, 'logs', 'emulator.log');
      const size = fs.statSync(file).size;
      const take = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        const lines = buf.toString('utf8').split(/\r?\n/);
        // 从头读của话第一行可能被截断，丢掉它
        if (take < size) lines.shift();
        return lines.slice(-n);
      } finally { fs.closeSync(fd); }
    } catch (_) { return []; }
  }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
