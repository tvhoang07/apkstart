'use strict';
/**
 * Engine bộ chạy：ApkStart 自带của QEMU + Android-x86 虚拟机
 *
 * 设计原则：
 *  - 默认完全自持（builtin）：adb / QEMU / Ảnh hệ thống都由 ApkStart 自己管理，不依赖任何第三方模拟器
 *  - 所Có对安卓của操作统一走 adb，因此Engine可替换
 *  - 虚拟机按需启动，Trống闲Tự động回收；启动后常驻复Dùng，装/开Áp dụng几乎零等待
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { AdbClient, isUnauthorizedError } = require('./adb');
const store = require('./store');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const container = require('./container');
const backends = require('./backends');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;
const EMU_PORT = 5554;
const EMU_SERIAL = `emulator-${EMU_PORT}`;

/** TCP 端口是否Có人监听（Dùng来判断Lần trước留下của模拟器还在不在） */
function portAlive(port, timeout = 150) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new EmulatorEngine(appRoot);
    this.vmProc = null;
    this.vmStarting = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._client = null;
    this._bootLog = [];
    this._activeApps = new Set();  // 容器会话：当前MởcủaCửa sổ ứng dụng
    // 多窗口模式下被墓碑化（force-stop 但保留数据）của后台Áp dụng；下次点开走热恢复。
    this._tombstoned = new Set();
    // 最近一次网络Kiểm tra sức khỏe结果。状态栏要显示「Mạng bình thường/未联网」，但状态是高频轮询của，
    // 不能每次都去 guest 里跑一遍 shell；这里只缓存结论，过期（>5 phút）就不采信。
    this._lastNetwork = null;
    this.emuSerial = EMU_SERIAL;   // 端口是动态挑của，serial 跟着变
    /**
     * 后端适配层：把「安卓从哪来」从本类里抽出去。
     *
     * 0.5.6 起这里**只Có一cái实现**：builtin（自带 emulator + Ảnh hệ thống）。
     * 不再Có mumu / fydeos / attach 这些分支 —— 任何机器、任何Cài đặt、任何残留配置
     * 都只会拿到自带Bộ chạy，保证 ApkStart 永远独立运行、与第三方模拟器无关。
     */
    this._backend = null;
    this._backendId = '';
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  /**
   * 当前后端实例（只Có一cái：builtin）。
   * @returns {import('./backends/base').Backend}
   */
  get backend() {
    if (!this._backend) {
      const made = backends.create({
        appRoot: this.appRoot, settings: this.settings, runtime: this, store, log: (l) => this.log(l),
      });
      this._backend = made.backend;
      this._backendId = made.id;
    }
    return this._backend;
  }

  /**
   * Cài đặt里要của底座Máy này到底Có没Có。
   *
   * Hiện只Có自带Bộ chạy，它永远Khả dụng（Thiếu镜像那是 provision 阶段của事，不是「底座Không tồn tại」）。
   * 保留这cái方法是为了不改上层调Dùng点。
   */
  async backendAvailable() {
    return { ok: true, id: 'builtin' };
  }

  /** 后端 id，永远是 'builtin'；界面和Nhật kýDùng */
  get backendId() { return this.backend.id; }

  /** 丢掉旧của连接与端口假设（换Bộ chạy目录、重置数据后调Dùng） */
  resetBackend() {
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this._backend = null;
    this._backendId = '';
  }

  get settings() { return store.getSettings(); }

  /** emulator Engine是否在运行 */
  get emuRunning() { return this.emulator.running(); }

  // ---------------- 基础 ----------------

  adbPath() {
    const s = this.settings;
    const p = this.provisioner.paths();
    // 自带 adb 永远排在第一位：同一台设备只认一份 adb 状态，不会出现 offline 反复抖动。
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    const local = path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe');
    if (fs.existsSync(local)) return local;
    return AdbClient.resolveAdb('', this.appRoot);
  }

  client(serial) {
    const useSerial = serial || this.emuSerial;
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath) {
      // 换端口/换 adb 时别把旧của常驻 adb shell 留在后台占着连接
      if (this._client && this._client.disposeInput) this._client.disposeInput();
      this._client = new AdbClient({ adbPath, serial: useSerial });
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // ---------------- 状态 ----------------

  /**
   * 给状态栏Dùngcủa网络快照（最近一次Kiểm tra sức khỏe结论）。
   * 超过 5 phút就不采信：中间可能断过网，宁可显示「Không rõ」也不要骗Dùng户说还行。
   */
  _networkSnapshot() {
    const n = this._lastNetwork;
    if (!n) return null;
    if (Date.now() - n.at > 5 * 60 * 1000) return null;
    return { ok: n.ok, ip: n.ip, reason: n.reason };
  }

  /**
   * 后台补一次网络Kiểm tra sức khỏe（不阻塞 status 返回）。
   * 状态栏要显示网络状态，但 status() 是高频轮询của，不能每次都去 guest 里跑 shell。
   * 所以第一次（或过期后）在后台跑一遍，结论缓存进 _lastNetwork，下一次轮询就能显示。
   */
  _probeNetworkInBackground() {
    if (this._netProbing) return;
    const n = this._lastNetwork;
    if (n && Date.now() - n.at < 60000) return;  // 一phút内刚查过，别重复
    this._netProbing = true;
    this.emulator.checkNetwork(this.adbPath())
      .then((r) => {
        this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      })
      .catch(() => { /* 查不到就保持原样，下一轮再试 */ })
      .finally(() => { this._netProbing = false; });
  }

  async status() {
    const backend = this.backend;
    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      backend: backend.id,
      backendLabel: backend.label,
      installed: !!s.runtime.installed,
      env,
      engineKind: env.engine,
      emulatorOk: env.emulator.ok,
      emulatorVersion: env.emulator.version,
      sysimgOk: env.sysimg.ok,
      sysimgNote: env.sysimg.note,
      accel: env.accel,
      vmRunning: this.emulator.running() || !!(this.vmProc && !this.vmProc.killed),
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
      serial: this.emuSerial,
      network: this._networkSnapshot(),
      autoProfile: this.emulator.profile ? doctor.describeProfile(this.emulator.profile) : '',
      diagnosis: this.emulator.lastDiagnosis || null,
      attempts: this.emulator.attempts || [],
      // 「Lần trước为什么没起来」：Bộ nhớ里没Có就回落到落盘记录，Cài đặt页/Chẩn đoán都能显示真实原因
      lastFailure: (this.emulator.lastFailure ? this.emulator.lastFailure() : null),
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = 'Thiếu adb: bấm “Triển khai một chạm” để tự tải';
      return result;
    }

    try {
      result.deviceOnline = await client.isOnline();
      if (result.deviceOnline) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
        this._probeNetworkInBackground();
      }
    } catch (e) {
      result.error = e.message;
    }

    if (result.deviceOnline) result.ready = true;
    else if (!env.emulator.ok) result.needsSetup = 'emulator';
    else if (!env.sysimg.ok) result.needsSetup = 'sysimg';
    // 不再把「没CóTăng tốc phần cứng」当成阻塞步骤：doctor 会Tự động回退Giả lập phần mềm，
    // 并在开机Thất bại时按 GPU/Tăng tốc/Bộ nhớ组合依次重试。
    else result.needsSetup = 'boot';

    result.phase = result.deviceOnline
      ? 'ready'
      : this.installing
        ? 'installing'
        : result.vmRunning
          ? 'booting'
          : 'idle';

    return result;
  }

  /**
   * Máy này adb 已连上của设备清单（只读Chẩn đoánDùng）。
   *
   * 0.5.6 起不再Có「连接已CóBộ chạy」模式：这里不会去主动 connect 别của模拟器端口，
   * 只把 adb 当前看到của设备如实列出来，方便排障时Xác nhận「是不是我们của emulator-5554」。
   */
  async probe() {
    try {
      const devices = await this.client().devices();
      return devices
        .filter((d) => d.state === 'device')
        .map((d) => ({ name: d.serial, serial: d.serial }));
    } catch (_) {
      return [];
    }
  }

  // ---------------- 启动 / 停止虚拟机 ----------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { whpx: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.whpx ? 'whpx' : 'tcg';

    const args = [
      '-name', 'ApkStart Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.whpx ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async boot({ install = false, onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    this._hv = env.hypervisor;

    // 首Chọn：官方 emulator（自带设备模型与 GPU 转译，体验最好）
    if (env.emulator.ok && env.sysimg.ok) {
      return this.bootEmulator({ env, onLog });
    }

    return this.bootQemu({ install, env, onLog });
  }

  /**
   * Dùng官方 emulator 启动 Android。
   * 与 QEMU+ISO 不同，这里没Có"Cài đặt系统"这一步：镜像本身就是系统，首次启动即开机。
   */
  async bootEmulator({ env, onLog = () => {} } = {}) {
    if (this.vmStarting) {
      const started = Date.now();
      while (this.vmStarting && Date.now() - started < 300000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
      }
      const c = this.client();
      if (await c.isOnline()) {
        await this.prepare(c);
        return { ok: true, client: c, reused: true };
      }
    }

    const accel = env && env.accel ? env.accel : await this.provisioner.emulatorAccel();
    if (!accel.ok) {
      onLog('Không phát hiện tăng tốc phần cứng: sẽ tự chuyển sang giả lập phần mềm (lần khởi động đầu chậm rõ rệt, không cần cài đặt thủ công)');
    }

    this.vmStarting = true;
    try {
      // probe 交给 EmulatorEngine của开机循环：进程Thoát/致命Nhật ký时它会换一组参数重试
      // 每轮只发一次 adb 命令：以前是 get-state + getprop + pm path 三次进程拉起，
      // 快照恢复时一轮就差 300~500ms，正好卡在「点开Áp dụng」của观感上。
      let probeStart = Date.now();
      let errStreak = 0;
      let lastHeal = 0;
      let authHealed = false;  // 本次 start() 是否已因「未授权」作废旧快照Khởi động nguội过
      const diagUnauthorized = () => ({
        code: 'ADB_UNAUTHORIZED',
        title: 'Chưa hoàn tất cấp quyền gỡ lỗi Android (hộp thoại cấp quyền)',
        hint: 'Hệ thống kẹt ở hộp thoại “Cho phép gỡ lỗi USB?”, đã tự hủy snapshot cũ và khởi động nguội một lần để bộ chạy'
          + 'Tiêm lại khóa công khai adb. Nếu lặp lại nhiều lần, hãy xóa %USERPROFILE%\\.android\\adbkey*  rồi thử lại.',
      });
      const probe = async ({ serial }) => {
        if (!this.emulator.running()) return 'fatal';
        if (!this._probeClient || this._probeClient.serial !== serial) {
          this._probeClient = new AdbClient({ adbPath: this.adbPath(), serial });
        }
        const c = this._probeClient;
        try {
          const out = String(await c.shell('getprop sys.boot_completed; pm path android', { timeout: 8000 }));
          const lines = out.split(/\r?\n/).map((l) => l.trim());
          const booted = lines[0] === '1' || /^1$/.test(lines[0] || '');
          const pmReady = lines.some((l) => /^package:/.test(l));
          errStreak = 0;
          if (booted && pmReady) return 'ok';
          return booted ? 'pending' : 'booting';
        } catch (e) {
          errStreak += 1;
          // 关键分支：adb shell 报错可能是「还没开机」也可能是「授权对话框卡住」。
          // 后者每轮 shell 都抛异常，旧实现只当普通 offline：重启 server 后Tiếp tục按
          // 240s×4 组参数干等，最后报「Bộ chạy không khởi động xong」，让Dùng户以为是显卡/虚拟化。
          // 这里先按报错文本、Rồi nhấn devices của state 列（get-state 分不清 authorized）
          // 双重Xác nhận unauthorized，命中就作废旧快照Khởi động nguội + 给出准确Chẩn đoán，不再Trống等。
          const raw = String((e && (e.raw || e.stdout || e.message)) || '');
          let unauthorized = isUnauthorizedError(raw);
          if (!unauthorized) {
            const st = await c.deviceState().catch(() => '');
            unauthorized = st === 'unauthorized';
          }
          if (unauthorized) {
            this.emulator.lastDiagnosis = diagUnauthorized();
            if (!authHealed) {
              authHealed = true;
              onLog('adb Kẹt ở hộp thoại cấp quyền “Cho phép gỡ lỗi USB”, đang hủy snapshot cũ và khởi động nguội để chèn lại khóa công khai…');
              try { this.emulator.invalidateSnapshot(); } catch (_) { /* ignore */ }
              this.emulator._coldBoot = true; // 下一轮强制Khởi động nguội，让 emulator 重新注入 adb 公钥
              await this.emulator.resetAdbServer().catch(() => {});
              this._probeClient = null;
            }
            // 交给 start() 立刻换一组参数重试；Khởi động nguội后 dialog 问题会消失
            return 'fatal';
          }
          // 其它 adb 传输异常：沿Dùng原来của重启 server 自愈
          const now = Date.now();
          if (errStreak >= 6 && now - probeStart > 25000 && now - lastHeal > 30000) {
            lastHeal = now;
            onLog('adb Kết nối bất thường, khởi động lại adb server rồi tiếp tục chờ…');
            await this.emulator.resetAdbServer().catch(() => {});
            this._probeClient = null;
          }
          return 'pending';
        }
      };

      const st = await this.emulator.start({
        headless: this.settings.engine.headless !== false,
        onLog,
        probe,
      });
      // start() Thất bại时是「返回 {ok:false}」而不是抛异常（磁盘不足、多次重试仍Thất bại等）。
      // 老实现不看这cái字段，直接把 ok:true 往上返回 —— 上层于是认là “已经Sẵn sàng」，
      // 接着 adb 一顿报 device not found，Dùng户看到của是「点开没反应」而不是真实原因。
      if (!st || st.ok === false) {
        return {
          ok: false,
          error: (st && st.error) || 'Bộ chạy Android không khởi động được',
          needsSpace: !!(st && st.needsSpace),
          attempts: (st && st.attempts) || [],
          diagnosis: this.emulator.lastDiagnosis,
          exitCode: st && st.exitCode,
        };
      }
      this.lastActivity = Date.now();
      this.emuSerial = st.serial || this.emulator.serial;
      const client = this.client(this.emuSerial);
      await this.prepare(client);
      // 快照改成「Trống闲时再存」：立刻存要写 1~3GB，会和Dùng户刚点开củaÁp dụng抢磁盘 I/O
      this._armSnapshotSave(20000);
      return { ok: true, client, engine: 'emulator', serial: this.emuSerial, profile: st.profile, network: st.network || null };
    } catch (e) {
      // 把Tự động重试/Chẩn đoán结论原样抛给 UI，避免再包一层含糊của「Khởi động thất bại」
      return { ok: false, error: e.message, diagnosis: e.diagnosis, report: e.report, attempts: e.attempts };
    } finally {
      this.vmStarting = false;
    }
  }

  // ---------------- 预热（像 WSA 一样让环境常驻） ----------------

  /** Trống闲时保存 quickboot 快照：只在没CóCửa sổ ứng dụng时写盘，避免和Áp dụng启动抢 I/O */
  _armSnapshotSave(delay = 20000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), {
      delay,
      isIdle: () => this._activeApps.size === 0,
    });
  }

  /** 供Cài đặt器等外部调Dùng：装完Áp dụng后重新存一份快照，下次开机仍是秒进 */
  scheduleSnapshotSave(delay = 12000) { this._armSnapshotSave(delay); }

  /**
   * 强制存一份快照，**不等Trống闲**。
   *
   * 什么时候Cần：刚修好网络、马上就要启动Áp dụngcủa时候。正常của
   * scheduleSnapshotSave 只在没CóCửa sổ ứng dụng时才写盘，而Áp dụng一起来就永远不Trống闲，
   * 于是「网络已连上」这cái状态从来没被存下来 —— 下次开机又从旧快照恢复成
   * 断网状态，每次都要重连一遍。这里显式绕过Trống闲判断，一次写盘换之后次次省。
   */
  forceSnapshotSave(delay = 3000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), { delay, isIdle: () => true });
  }

  /**
   * Làm nóng:在Dùng户点开Áp dụng之前，先把安卓环境在后台引导好。
   * WSA / Áp dụng宝电脑版都是这cái思路 —— 环境常驻，点图标时Chỉ còn一次 am start。
   *  - 完全静默：不弹窗、不报错，Thất bại不影响正常Mở ứng dụng；
   *  - 幂等：正在开机或Đã sẵn sàng时复Dùng同一cái Promise，不会重复拉起第二台；
   *  - 省资源：开机Hoàn tất后把 qemu 降到最低优先级停放。
   */
  prewarm({ onLog = () => {} } = {}) {
    if (this._prewarmPromise) return this._prewarmPromise;
    if (this._activeApps.size > 0) return Promise.resolve({ ok: true, skipped: 'busy' });
    const t0 = Date.now();
    const p = (async () => {
      try {
        const env = await this.provisioner.checkEnv();
        if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) return { ok: false, skipped: 'not-ready' };
        const r = await this.ensure({ onLog: (m) => onLog(`Làm nóng:${m}`) });
        if (r && r.ok) {
          // 预热期间Dùng户可能已经点开了Áp dụng：这时不能把它摁到 idle 优先级
          if (this._activeApps.size === 0) await this.emulator.setPriority('idle').catch(() => {});
          const ms = Date.now() - t0;
          this.log(`Làm nóng xong (${Math.round(ms / 1000)}s）`);
          return { ok: true, bootMs: ms };
        }
        return { ok: false, error: r && r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
    this._prewarmPromise = p;
    const clear = () => { if (this._prewarmPromise === p) this._prewarmPromise = null; };
    p.then(clear, clear);
    return p;
  }

  async bootQemu({ install = false, env, onLog = () => {} } = {}) {
    if (!env.qemu.ok) throw new Error('Chưa cài QEMU, hãy hoàn tất triển khai bộ chạy trước');
    if (install && !env.iso.ok) throw new Error('Ảnh hệ thống (ISO) chưa sẵn sàng');

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error('Chưa cài hệ thống Android vào ổ đĩa ảo');

    this.vmStarting = true;
    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

    onLog(`Đang khởi động bộ chạy (${env.hypervisor.whpx ? 'WHPX Tăng tốc phần cứng' : 'Giả lập thuần phần mềm'}）…`);
    if (!env.hypervisor.whpx) onLog(env.hypervisor.note);

    const proc = spawn(env.qemu.path, args, {
      cwd: path.dirname(env.qemu.path),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    this.vmProc = proc;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      onLog(`Khởi động thất bại:${e.message}`);
      this.vmProc = null;
      this.vmStarting = false;
    });
    proc.on('exit', (code) => {
      this.log(`qemu exit ${code}`);
      onLog(`Bộ chạy đã thoát (code=${code}）`);
      this.vmProc = null;
      this.vmStarting = false;
      this.installing = false;
    });

    await new Promise((r) => setTimeout(r, 1500));
    this.vmStarting = false;
    if (!this.vmProc) throw new Error(`QEMU Khởi động thất bại, xem chi tiết trong nhật ký:${logFile}`);

    // 装机模式：ISO 里是 Linux Cài đặt程序，没Có adb，不能按「等 adb」处理
    if (install) {
      onLog('Trình cài đặt đã khởi động, hãy làm theo hướng dẫn trong cửa sổ máy ảo để hoàn tất cài');
      return { ok: true, install: true, needsManualInstall: true };
    }

    const client = this.client('127.0.0.1:5555');
    const timeout = env.hypervisor.whpx ? 180000 : 900000;
    const linked = await this.waitAdb(client, timeout, onLog);
    if (!linked) {
      return {
        ok: false,
        error: 'Máy ảo đã khởi động nhưng adb không kết nối được: hãy bật “Tùy chọn nhà phát triển → ADB over network” trong máy ảo rồi thử lại',
      };
    }
    const ready = await this.waitAndroidReady(client, Math.max(60000, timeout / 2), onLog);
    if (!ready.ok) {
      return {
        ok: false,
        error: ready.stage === 'kernel'
          ? 'Android Nhân hệ thống chưa khởi động xong, hãy xem nhật ký bộ chạy (có thể ảnh hỏng hoặc tăng tốc chưa có hiệu lực)'
          : 'Android Đã khởi động nhưng dịch vụ hệ thống chưa sẵn sàng (có thể dừng ở màn hình thiết lập lần đầu, hãy hoàn tất trình hướng dẫn trong cửa sổ máy ảo)',
      };
    }
    await this.prepare(client);
    return { ok: true, client };
  }

  /**
   * 等待 Android 真正Khả dụng：adb 在线 ≠ 系统Khả dụng。
   * 必须等到 sys.boot_completed=1 且包管理器可响应，否则 am start 会直接Thất bại。
   */
  async waitAndroidReady(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let bootCompleted = false;
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      /* eslint-disable no-await-in-loop */
      const online = await client.isOnline();
      if (!online) {
        await client.connect().catch(() => false);
      } else {
        if (!bootCompleted) {
          const v = await client.shell('getprop sys.boot_completed').catch(() => '');
          if (String(v).trim() === '1') {
            bootCompleted = true;
            onLog(`Android Nhân hệ thống đã chạy, đang chờ dịch vụ hệ thống sẵn sàng…(${Math.round((Date.now() - start) / 1000)}s）`);
          }
        }
        if (bootCompleted) {
          const pm = await client.shell('pm path android').catch(() => '');
          if (/package:/.test(pm)) {
            onLog(`Android Đã sẵn sàng (${Math.round((Date.now() - start) / 1000)}s）`);
            return { ok: true, ms: Date.now() - start };
          }
        }
      }
      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        onLog(bootCompleted
          ? `Đang chờ dịch vụ hệ thống… ${Math.round((Date.now() - start) / 1000)}s`
          : `Đang khởi động Android… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      /* eslint-enable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage: bootCompleted ? 'services' : 'kernel', ms: Date.now() - start };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let lastNotice = 0;
    const needConnect = String(client.serial || '').includes(':')
      && !/^emulator-/.test(client.serial);
    while (Date.now() - start < timeoutMs) {
      // emulator-5554 这类由 emulator 自己注册，不Cần adb connect
      if (needConnect) {
        // eslint-disable-next-line no-await-in-loop
        await client.connect().catch(() => false);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return true;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(`Đang chờ Android khởi động… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client) {
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    // 中文环境（Ngôn ngữ hệ thống + 中文输入法）每次**开机**只做一次。
    // Ngôn ngữ hệ thống靠 emulator -prop 注入（SELinux 保护，Bộ chạy改不了），这里补của是
    // Áp dụng级 locale / 时区，以及静默装好并启Dùng随包带của谷歌拼音输入法。
    // Dùng户可在Cài đặt里关掉Tự cấu hình（engine.chineseIme=false）。
    if (!this._chineseReady && this.settings.engine.chineseIme !== false) {
      try {
        const locale = this.settings.engine.locale || 'zh-CN';
        await client.ensureChineseLocale(locale);
        const path = require('path');
        const apk = path.join(this.appRoot, 'assets', 'PinyinIME.apk');
        const r = await client.ensureChineseIme(apk, {
          setDefault: this.settings.engine.chineseImeDefault !== false,
        });
        // 只Có真của成功了才置位。Thất bại时允许下一次 prepare() 重试 ——
        // 否则一次偶发của adb 抖动就会让这台机器永远没Có中文输入法。
        if (r && r.ok) this._chineseReady = true;
        this.log(`Bộ gõ tiếng Trung:${r.ok ? (r.installed ? 'Đã cài đặt và bật' : 'Đã sẵn sàng') : (r.reason || 'Chưa sẵn sàng')}`);
        // -change-locale 只在「全量引导」时执行并重启 framework；从 quickboot 快照
        // 恢复时会被跳过。旧快照是英文của，所以检测到Ngôn ngữ hệ thống不对就作废快照、
        // 让下次开机Khởi động nguội一次（带 -change-locale）。之后存của新快照就是中文của，
        // 不Dùng再重启。marker 保证一生只纠正一次。
        await this._ensureSystemLocale(client, locale);
      } catch (e) {
        this.log(`Bỏ qua khởi tạo môi trường tiếng Trung:${e.message}`);
      }
    }
    this.startWatchdog();
  }

  /**
   * 系统 UI 语言校正（一次性）。
   *
   * 实测结论（很容易踩错）：-change-locale 生效后**不会**写 persist.sys.locale，
   * ro.product.locale 也仍是镜像của en-US；它真正改của是
   * `settings system system_locales`（Cài đặt ngôn ngữ页显示「中文（中国）」，系统 UI 全中文）。
   * 所以判断「中文是否已经生效」要看 system_locales，不是 getprop。
   *
   * -change-locale 只在「全量引导」时执行并重启 framework；从 quickboot 快照恢复时
   * 会被跳过。旧快照是英文của，所以检测到不对就作废快照、让下次开机Khởi động nguội一次。
   * 之后存của新快照就是中文của，不Dùng再重启。marker 保证一生只纠正一次。
   */
  async _ensureSystemLocale(client, locale) {
    const fs = require('fs');
    const path = require('path');
    const want = String(locale || 'zh-CN');
    if (want === 'off' || want === 'en-US') return;
    // 已经生效（system_locales 是Mục tiêu语言，或语言列表里第一mục是它）
    const cur = await client.shell('settings get system system_locales', { timeout: 8000 }).catch(() => '');
    const s = String(cur).trim();
    if (s === want || s.indexOf(want) === 0 || /^zh[-_]/.test(s)) return;
    const marker = path.join(store.DATA_DIR, 'locale-' + want.replace(/[^a-zA-Z0-9_-]/g, '_') + '.done');
    if (fs.existsSync(marker)) return;
    try {
      fs.writeFileSync(marker, String(Date.now()));
      this.log(`Ngôn ngữ hệ thống vẫn là ${s || '(Trống)'}, hủy snapshot cũ, lần khởi động sau sẽ khởi động nguội và chuyển sang ${want}`);
      this.emulator.invalidateSnapshot();
      this.emulator.forceColdBootOnNextStart();
    } catch (e) {
      this.log(`Bỏ qua chỉnh ngôn ngữ hệ thống:${e.message}`);
    }
  }

  /** 优雅停止：emulator 走控制台关机，QEMU 走 monitor */
  async stop({ graceful = true } = {}) {
    const adbPath = this.adbPath();
    if (this.emulator.running()) {
      await this.emulator.stop({ adbPath });
      return true;
    }
    // 接管来của模拟器（adoptExisting）在本进程里没Có proc 句柄，旧逻辑会直接
    // return false —— 结果Trống闲看门狗永远关不掉它，容器一直占着 CPU/Bộ nhớ。
    // 这条Đường dẫn改Dùng adb 控制台关机，必要时Rồi nhấn端口强杀兜底。
    //
    // 注意：emulator.exe 只是cái启动器，spawn 完 qemu 自己就退了，所以「自己拉起来của」
    // 机器也常常落到这条分支。关机前必须补一次 saveSnapshotNow，否则快照永远存不下来，
    // Dùng户每次点开都是全量Khởi động nguội（25 秒 vs 8 秒của差别就在这一步）。
    let online = false;
    try { online = await this.client().isOnline(); } catch (_) { /* ignore */ }
    if (online && this.emuSerial) {
      if (adbPath && this.emulator.snapshotWorthSaving !== false) {
        await this.emulator.saveSnapshotNow(adbPath, { timeout: 60000 }).catch(() => false);
      }
      await this.client().exec(['emu', 'kill'], { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 400));
        // eslint-disable-next-line no-await-in-loop
        const still = await this.client().isOnline().catch(() => false);
        if (!still) break;
      }
      const still = await this.client().isOnline().catch(() => false);
      if (still) {
        const m = /:(\d+)$/.exec(this.emuSerial);
        const port = m ? Number(m[1]) - 1 : this.emulator.port;
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
      }
      this._activeApps.clear();
      return true;
    }
    if (!this.vmProc) return false;
    if (graceful) {
      try { await this.monitorCmd('system_powerdown'); } catch (_) { /* ignore */ }
      for (let i = 0; i < 16; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        if (!this.vmProc) return true;
      }
      try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
    return true;
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: MONITOR_PORT });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('monitor Hết thời gian')));
      sock.on('error', (e) => {
        // QEMU 执行 quit 等命令后会主动断开连接（ECONNRESET/EPIPE），属于正常现象
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ---------------- Cài đặt系统到Ổ đĩa ảo ----------------

  async startInstaller({ onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    if (!env.iso.ok) {
      throw new Error(env.iso.reason || 'Hãy tải/nhập ảnh hệ thống Android (ISO) trước');
    }
    if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
    this.installing = true;
    const r = await this.boot({ install: true, onLog });
    if (!r.ok) throw new Error(r.error || 'Môi trường cài đặt khởi động thất bại');
    return r;
  }

  /** Cài đặt hoàn tất后：关掉Cài đặt程序 → 写标记 → 之后直接从磁盘启动 */
  async markInstalled() {
    if (this.installing) {
      try { await this.stop({ graceful: true }); } catch (_) { /* ignore */ }
    }
    store.saveSettings({ runtime: { installed: true } });
    this.installing = false;
    return true;
  }

  // ---------------- ensure ----------------

  /**
   * 接管上一次运行留下của模拟器。
   * 每台模拟器都Có自己của控制台端口（5554/5556/…），adb 端口是 +1。
   * 端口能连上并且 system 已经 boot_completed，就直接当成我们củaBộ chạyDùng，
   * 这样「关掉 ApkStart 再点开Áp dụng」是秒进，而不是再冷启一台。
   */
  /**
   * 找出所Có还活着của模拟器控制台端口。
   * 不能Dùng「从 5554 顺序试」：端口会随着多次启动往上漂（5554→5556→5558…），
   * 试固定范围总Có试漏của时候，漏了就会再开一台新机器。这里直接按进程名
   * 找出 qemu 监听của所Có TCP 端口，一cái都不会漏。
   */
  async emulatorPorts() {
    const run = (cmd, args) => new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        resolve(err ? '' : String(out || ''));
      });
    });
    const ports = new Set();
    try {
      const tl = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const pids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) pids.add(m[2]);
      }
      if (!pids.size) return [];
      const ns = await run('netstat', ['-ano', '-p', 'TCP']);
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && pids.has(m[2])) ports.add(Number(m[1]));
      }
    } catch (_) { /* 退回到端口探测 */ }

    if (ports.size) {
      // 控制台端口（偶数）和 adb 端口（+1）都会被监听，只保留控制台端口
      const all = [...ports].sort((a, b) => a - b);
      const consoles = all.filter((p) => ports.has(p + 1));
      return consoles.length ? consoles : all;
    }
    // 兜底：没Có qemu 进程信息时，直接探测（连接被拒绝会立刻返回，代价很Nhỏ）
    const found = [];
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await portAlive(port, 120)) found.push(port);
    }
    return found;
  }

  async adoptExisting({ onLog = () => {} } = {}) {
    const alive = await this.emulatorPorts();
    if (!alive.length) {
      onLog('Không thấy bộ chạy trước đó, chuẩn bị khởi động nguội');
      return null;
    }
    onLog(`Phát hiện ${alive.length}  bộ chạy còn sót (cổng ${alive.join(', ')}), thử tiếp quản`);

    // adb server 里可能还留着上cái进程của offline 记录（模拟器重启过 adbd 就会这样），
    // 先清掉再连，否则 get-state 永远返回 offline，会误判成"没Sẵn sàng"把好好của机器杀掉。
    await this.client().exec(['kill-server'], { withSerial: false, timeout: 8000 }).catch(() => {});

    for (const port of alive) {
      const serial = `127.0.0.1:${port + 1}`;
      const c = this.client(serial);
      let booted = '';
      for (let i = 0; i < 6 && booted !== '1'; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await c.connect().catch(() => false);
        // eslint-disable-next-line no-await-in-loop
        const state = (await c.exec(['get-state'], { timeout: 5000 }).then((r) => r.stdout).catch(() => '')).trim();
        if (state === 'device') {
          // eslint-disable-next-line no-await-in-loop
          booted = (await c.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '')).trim();
        }
        if (booted !== '1') await new Promise((r) => setTimeout(r, 700));
      }
      if (booted !== '1') {
        onLog(`Phát hiện bộ chạy trước đó (${serial}) nhưng chưa sẵn sàng, hãy tắt nó rồi khởi động lại`);
        // AVD 目录Có锁：留着这台会让新实例直接Thoát，表现成"怎么都开不了机"。
        // adb 都连不上了，只能按控制台端口Tìm thấy进程强杀。
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            const { execFile } = require('child_process');
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      this.emuSerial = serial;
      this.emulator.port = port;
      store.saveSettings({ device: serial });
      onLog(`Đã tiếp quản bộ chạy đang chạy (${serial}）`);
      // eslint-disable-next-line no-await-in-loop
      await this.prepare(c);
      return { ok: true, client: c, engine: 'emulator', reused: true };
    }
    return null;
  }

  /** 某cái TCP 端口是哪cái进程在监听（Dùng于强杀卡死của模拟器） */
  async pidOnPort(port) {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(0);
        const line = stdout.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l));
        const m = line && /(\d+)\s*$/.exec(line.trim());
        return resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /**
   * Dọn dẹp上一次运行遗留、却没被接管của孤儿模拟器。
   * 关掉 ApkStart 时 emulator 是 detached của，qemu 会存活；下次启动时它仍占着 AVD 锁，
   * 表现为冷启直接 FATAL "Running multiple emulators with the same AVD"。
   * 实现收敛到 EmulatorEngine，重试Đường dẫn（killAttempt）也Dùng同一份逻辑。
   */
  async killOrphanEmulators({ onLog = () => {} } = {}) {
    return this.emulator.killOrphanProcesses({ onLog });
  }

  /**
   * 幂等入口：预热与Dùng户点击可能同时发生，TổngDùng一cái Promise，
   * 避免两边各判断一次「没在线」后各自拉起一台模拟器（AVD 锁冲突 + 双倍Bộ nhớ）。
   */
  async ensure({ onLog = () => {} } = {}) {
    if (this._ensurePromise) return this._ensurePromise;
    const p = this._ensureInner({ onLog });
    this._ensurePromise = p;
    const clear = () => { if (this._ensurePromise === p) this._ensurePromise = null; };
    p.then(clear, clear);
    return p;
  }

  async _ensureInner({ onLog = () => {} } = {}) {
    const client = this.client();
    if (await client.isOnline()) {
      await this.prepare(client);
      return { ok: true, client, engine: 'builtin', reused: true };
    }

    // 上一次 ApkStart Thoát时模拟器会留着（下次点开秒进），但新进程里没Có它của
    // 句柄，adb server 也可能被重启过——只靠 isOnline() 会判成"没CóBộ chạy"，
    // 于是又开一台新của。这里先把还活着của模拟器接管过来，避免重复开机器吃Bộ nhớ。
    const adopted = await this.adoptExisting({ onLog });
    if (adopted) return adopted;

    // Lần trước会话遗留 / 别của进程拉起của emulator：换cái端口也要复Dùng，绝不重复开一台
    try {
      const devices = await client.devices();
      const running = devices.find((d) => /^emulator-\d+$/.test(d.serial) && d.state === 'device');
      if (running) {
        this.emuSerial = running.serial;
        const m = /(\d+)$/.exec(running.serial);
        if (m) this.emulator.port = Number(m[1]);
        const c2 = this.client(running.serial);
        await this.prepare(c2);
        return { ok: true, client: c2, engine: 'emulator', reused: true };
      }
    } catch (_) { /* 没Tìm thấy就正常拉起 */ }

    // 进程还在但设备离线（多半卡在引导）：先停掉再重新拉起，避免干等
    if (this.emulator.running()) {
      onLog('Phát hiện bộ chạy bị treo, đang khởi động lại…');
      await this.emulator.stop({ adbPath: this.adbPath() });
    }

    const s = this.settings;

    // 唯一Đường dẫn：自带Bộ chạy
    // 单文件发行版của镜像是压缩của，先展开（已展开过就秒过）。
    // 展开Thất bại不要把错误吞掉：否则后面 checkEnv() 只会说「Còn thiếuẢnh hệ thống」，
    // Dùng户会以为是没下载，而不是Giải nénThất bại（磁盘满 / 文件损坏）。
    await this.provisioner.materializeImages(onLog).catch((e) => {
      onLog(`Giải nén ảnh hệ thống thất bại:${e.message}`);
      this.log(`materialize failed: ${e.message}`);
    });
    const env = await this.provisioner.checkEnv();

    // emulator Đường dẫn：镜像即系统，没Có"Cài vào磁盘"这一步
    if (env.emulator.ok && env.sysimg.ok) {
      // 关掉 ApkStart 后可能残留未接管của模拟器（detached của qemu 仍存活），
      // 它一直占着 AVD 锁，会让冷启直接 FATAL "Running multiple emulators with the same AVD"。
      // 接管Thất bại时先把这些孤儿清掉，再冷启，保证「关掉再开」一定能起来。
      await this.killOrphanEmulators({ onLog }).catch(() => {});
      try {
        const r = await this.boot({ onLog });
        if (r.ok) return { ok: true, client: r.client, engine: 'emulator', profile: r.profile, network: r.network || null };
        return {
          ok: false, error: r.error, env,
          diagnosis: r.diagnosis, report: r.report, attempts: r.attempts, exitCode: r.exitCode,
        };
      } catch (e) {
        return { ok: false, error: e.message, env };
      }
    }

    // QEMU Đường dẫn（Dùng户自备 ISO 并已装到Ổ đĩa ảo）
    if (!s.runtime.installed) {
      return {
        ok: false,
        needsSetup: env.emulator.ok ? 'sysimg' : 'provision',
        error: env.emulator.ok
          ? 'Còn thiếu ảnh hệ thống: bấm “Tải ảnh hệ thống” là được'
          : 'Thành phần bộ chạy chưa triển khai xong',
        env,
      };
    }

    try {
      const r = await this.boot({ onLog });
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------- Áp dụng级容器会话 ----------------

  /**
   * 「像容器一样Mở」của具体实现：
   * Android 环境只引导一次并常驻（quickboot 快照 + adoptExisting 接管），
   * 之后每次Mở App 只是 am start + 把已Có窗口挂进来，不再重跑整cái系统。
   * 这里额外做三件降低系统压力của事：
   *   - 停掉其他Dùng户 App của进程，让环境里只跑当前 App Cầncủa东西；
   *   - Có窗口时给 qemu 一cái「让着前台」của优先级；
   *   - 只在Có窗口时才开启文件同步 / 通知轮询（由 onActive 回调交给 UI 层）。
   */
  async beginApp(pkg, { onActive = () => {} } = {}) {
    const first = this._activeApps.size === 0;
    this._activeApps.add(pkg);
    this.touch();
    const s = this.settings;
    const mode = (s.engine && s.engine.priorityMode) || 'balanced';
    // CóÁp dụng在前台时của调度级别。balanced Dùng normal（不是 below）：
    // below 会让 qemu 在系统繁忙时被饿到，表现为视频解码掉帧、点击要等一下才响应 ——
    // 这正是「点击不跟手」của主因。normal 只是与Màn hình nền同档，并不额外吃 CPU/Bộ nhớ/GPU。
    const level = mode === 'game' ? 'game' : 'normal';

    if (first) {
      // CóÁp dụng要开了：把「Trống闲存快照」推迟，别在Áp dụng启动时抢磁盘
      this.emulator.cancelSnapshotSave();
    }
    // 每次Mở/切回Áp dụng都确保优先级到位：endApp 会把Trống闲của qemu 降到 idle，
    // 切换回来时若不重新提，就会停在低优先级 → 点起来发木。setPriority 幂等，
    // 已经是Mục tiêu值时脚本内部不改、开销极Nhỏ。
    await this.emulator.setPriority(level).catch(() => {});
    if (first) {
      try { onActive(true); } catch (_) { /* 轮询Khởi động thất bại不影响Mở ứng dụng */ }
    }

    // 多窗口模式（B 方案）：开新Áp dụng**不再** force-stop 其它Áp dụng，否则等于没多开。
    // 改为按墓碑策略回收「太久没看của后台」，既允许多cái并存、又不会Bộ nhớ失控。
    // 关掉 multiWindow 时退回旧của「只留当前这cái」行为，保证可回退。
    if (s.engine && s.engine.multiWindow) {
      const roles = container.sessionRoles([...this._activeApps], pkg);
      const { tombstone } = container.planTombstones({
        background: roles.background,
        keepRecent: Number(s.engine.keepBackground) >= 0 ? Number(s.engine.keepBackground) : 1,
      });
      const cmds = container.buildTombstoneCommands(tombstone);
      if (cmds.length) {
        await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
        for (const p of tombstone) this._tombstoned.add(p);   // 记下被挂起của，下次点开热恢复
        this.log(`Nhiều cửa sổ: tiền cảnh ${pkg}, giữ lại nền ${roles.background.length - tombstone.length}  cái, đánh dấu bỏ ${tombstone.length} cái`);
      } else {
        this.log(`Nhiều cửa sổ:${roles.count}  ứng dụng cùng chạy, không cần thu hồi`);
      }
      return { ...roles, plan: { commands: cmds, stopped: tombstone } };
    }

    const installed = store.getApps().map((a) => a && a.package).filter(Boolean);
    const state = container.nextSessionState([...this._activeApps], 'open', pkg);
    const plan = container.buildSessionCommands({
      pkg,
      installed,
      deep: !!(s.engine && s.engine.deepTrim),
      // App 刚 am start 完，此刻清后台可能误伤正在进前台của进程；Dọn dẹp放到 endApp
      killBackground: false,
    });
    if (plan.commands.length) {
      await this.client().shell(plan.commands.join(' ; '), { timeout: 20000 }).catch(() => '');
    }
    this.log(container.describeSession(state, plan));
    return { ...state, plan };
  }

  /**
   * 关掉一 cửa sổ ứng dụng：停掉它của进程；如果是最后一cái窗口，让容器进入
   * 「常驻但几乎不耗资源」của停放状态（清后台 + Android idle + qemu 降优先级）。
   * 不关机、不删 AVD —— 下次点开还是秒进。
   */
  async endApp(pkg, { onIdle = () => {} } = {}) {
    this._activeApps.delete(pkg);
    await this.client().forceStop(pkg).catch(() => {});
    const state = container.nextSessionState([...this._activeApps], 'close', pkg);
    if (state.idle) {
      const s = this.settings;
      const cmds = container.buildIdleCommands({ deep: !!(s.engine && s.engine.deepTrim) });
      await this.client().shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => '');
      // game 模式下即使暂时没CóCửa sổ ứng dụng也保持高优先级，
      // 否则下次点开要重新提权、首cái输入会Có明显延迟。
      const keepHigh = (s.engine && s.engine.priorityMode) === 'game';
      await this.emulator.setPriority(keepHigh ? 'normal' : 'idle').catch(() => {});
      // Hiện最Trống闲：把Bộ nhớ状态存成快照，下次开机走恢复而不是Khởi động nguội
      this._armSnapshotSave(8000);
      try { onIdle(true); } catch (_) { /* ignore */ }
      this.log('Container đã tạm nghỉ (Android chạy nền, 0 tiến trình ứng dụng, qemu ở mức ưu tiên thấp nhất)');
    }
    return state;
  }

  get activeApps() { return [...this._activeApps]; }
  get containerIdle() { return this._activeApps.size === 0; }

  /** 供Cài đặt页切换「深度裁剪」时恢复被禁Dùngcủa系统包 */
  async restoreSystemApps() {
    const cmds = container.buildRestoreCommands();
    await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
    return true;
  }

  setGuestPriority(level) { return this.emulator.setPriority(level); }

  // ---------------- Trống闲回收 ----------------

  /**
   * Tự phục hồi hướng:保证「逻辑显示Trống间」和「物理面板」方向一致。
   *
   * 判断依据（实机 dumpsys window displays）：
   *   init=1280x720 ... cur=1280x720   → 正常（Bảng màn ngang + Màn ngang逻辑）
   *   init=1280x720 ... cur=720x1280   → 躺倒：逻辑Trống间被旋转了 90°
   * 一旦看到 cur 与 init của宽高顺序相反，就说明CóÁp dụng/系统把方向改回去了，
   * 此时重新锁方向并忽略Áp dụngcủa方向请求即可纠正，不Dùng重启虚拟机。
   *
   * 只在真của不一致时写 settings，正常情况下每 60 秒只Có一次只读 shell。
   */
  async _healOrientation() {
    if (!this.emulator || !this.emulator.running()) return;
    const wantLand = !!this.settings.display.landscape;
    const panelLand = typeof this.emulator.panelLandscape === 'function'
      ? this.emulator.panelLandscape() : null;
    // 面板方向和Cài đặt不一致 → 该重启，不是这里能修của（runLaunch.beforeStart 会处理）
    if (panelLand !== null && panelLand !== wantLand) return;
    const c = this.client();
    const out = await c.shell('dumpsys window displays', { timeout: 12000 }).catch(() => '');
    const init = /init=(\d+)x(\d+)/.exec(out);
    const cur = /cur=(\d+)x(\d+)/.exec(out);
    if (!init || !cur) return;
    const initLand = Number(init[1]) > Number(init[2]);
    const curLand = Number(cur[1]) > Number(cur[2]);
    if (initLand !== curLand) {
      // 真躺倒了：重新锁方向 + 忽略Áp dụng方向请求 + 恢复 density
      this.log(`Tự phục hồi hướng:init=${init[1]}x${init[2]} cur=${cur[1]}x${cur[2]} Đã sập, đang ổn định lại`);
      await c.resetDisplayOverrides(wantLand).catch(() => {});
      await c.setOrientation(wantLand).catch(() => {});
      return;
    }
    // 没躺倒 ≠ 状态就对。Bố cục máy tính bảng依赖两cái易丢củaBộ chạy状态：
    //   - mSetIgnoreOrientationRequest（Màn ngang时必须为 true，否则面板会被Áp dụng方向带歪）
    //   - wm density 覆盖为 190（720 宽 → sw606dp ≥ 600dp 才走Bố cục máy tính bảng）
    // 这两mục一旦丢失，会退回手机形态 —— 正是「平板模式不稳定」của表现。
    // 这里做一次轻量校验，Thiếu哪cái补哪cái（都是幂等命令，正常情况不写）。
    const densityWanted = (this.settings.display || {}).tabletMode !== false ? 190 : null;
    let ignoreOk = true;
    if (wantLand) {
      const win = await c.shell('dumpsys window | grep -oE "mSetIgnoreOrientationRequest=(true|false)"', { timeout: 8000 }).catch(() => '');
      ignoreOk = /mSetIgnoreOrientationRequest=true/.test(String(win));
    }
    let densityOk = true;
    if (densityWanted) {
      const dens = await c.shell('wm density', { timeout: 6000 }).catch(() => '');
      // 「Override density: N」行存在且等于Mục tiêu值才算对
      const m = /Override density:\s*(\d+)/.exec(String(dens));
      densityOk = !!m && Number(m[1]) === densityWanted;
    }
    if (!ignoreOk || !densityOk) {
      this.log(`Ổn định hiển thị:ignore-orientation=${ignoreOk} density=${densityOk} → bổ sung`);
      if (!ignoreOk) await c.shell('wm set-ignore-orientation-request true', { timeout: 8000 }).catch(() => {});
      // density 只在**没CóÁp dụng在前台**时才补。
      // 改密度会触发配置变更 + Activity 重建，而缓存了 DisplayMetrics củaÁp dụng
      // （墨读）会按旧密度重算一遍 dp，画面缩成左上角一Nhỏ块、右边全是Trống白 ——
      // Dùng户看到của就是「墨读没Có填满窗口」。CóÁp dụng在跑时留给下一次启动Đường dẫn，
      // installer.launch của resetDisplayOverrides 会在 am start 之前设好。
      if (!densityOk) {
        if (this._activeApps.size === 0) {
          await c.shell(`wm density ${densityWanted}`, { timeout: 8000 }).catch(() => {});
        } else {
          this.log(`density=${densityWanted} Thiếu nhưng có ứng dụng đang ở nền trước: bỏ qua, thiết lập vào lần khởi động sau (tránh thu nhỏ hình)`);
        }
      }
    }
  }

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      // Tự phục hồi hướng:Áp dụng启动 / Activity 重建 / 系统弹窗都可能把 user-rotation 或
      // 「忽略Áp dụng方向请求」改回去。一旦被改回去，Bảng màn ngang上của画面就会躺倒 90°
      // （Dùng户说của「平板模式软件总是 90 度躺着」）。这里每轮巡检读一次真实状态，
      // 只Có在**确实不一致**时才纠正，正常情况零写入。
      await this._healOrientation().catch(() => {});
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit) return;
      // 接管来của模拟器没Có本地 proc 句柄，vmRunning 会是 false：
      // 以前这里直接 return，导致容器永不回收。改成同时看 adb 是否在线。
      if (!this.vmRunning) {
        const online = await this.client().isOnline().catch(() => false);
        if (!online) return;
      }
      if (this._activeApps.size > 0 || Date.now() - this.lastActivity < limit) return;
      try {
        const running = await this.client().runningPackages();
        const alive = running.filter((p) => !/launcher|systemui|settings|inputmethod|android\.systemui/i.test(p));
        if (alive.length === 0) await this.stop();
        else this.lastActivity = Date.now();
      } catch (_) { /* ignore */ }
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  get vmRunning() { return this.emulator.running() || !!(this.vmProc && !this.vmProc.killed); }

  // ---------------- Chẩn đoán / 瘦身（供 UI 调Dùng） ----------------

  async diagnostics() {
    const env = this.provisioner.paths();
    const checked = await this.provisioner.checkEnv();
    const profile = this.emulator.profile || doctor.autoProfile({
      settings: this.settings,
      accel: checked.accel,
      emulatorVersion: checked.emulator.version || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // Bộ nhớtrong attempts 只在本次会话Có效；Dùng户重启后再导出报告时它是Trốngcủa。
    // 这时改DùngLần trước落盘củaThất bại记录，并把 emulator.log của尾部带上 —— 否则报告
    // 只Có一句 UNKNOWN，看不到真正原因（issue #20/#25 都栽在这里）。
    const persisted = this.emulator.lastFailure ? this.emulator.lastFailure() : null;
    const liveAttempts = this.emulator.attempts || [];
    const attempts = liveAttempts.length ? liveAttempts : ((persisted && persisted.attempts) || []);
    const diagnosis = this.emulator.lastDiagnosis || (persisted && persisted.diagnosis) || null;
    const exitCode = this.emulator.lastExitCode != null ? this.emulator.lastExitCode
      : (persisted ? persisted.exitCode : null);
    let logLines = this.emulator.recentLog(300);
    if (!logLines.length && this.emulator.tailLogFile) logLines = this.emulator.tailLogFile(300);
    return doctor.writeReport({
      dataDir: store.DATA_DIR,
      profile,
      logLines,
      extra: {
        attempts,
        diagnosis,
        exitCode,
        exitMeaning: persisted && persisted.exitMeaning ? persisted.exitMeaning : '',
        lastFailure: persisted,
        runtimeDir: env.root,
        serial: this.emuSerial,
        bootLog: this.bootLog,
      },
    });
  }

  usage() { return require('./layers').summary(this.provisioner.paths().root); }

  /**
   * 回收Bộ chạytrong旧镜像 / 旧 AVD / 锁文件 / 快照。
   * 之前「点Dọn dẹp却清不掉」của根因：Bộ chạy正在跑时 keepSnapshots 把当前 AVD của
   * 快速启动快照（≈几 GB của ram.img）排除掉了，单 AVD 环境下几乎没Có可清mục。
   * Hiện调Dùng方可以显式传 includeSnapshots：先停Bộ chạy再裁，快照就能真正回收。
   */
  async cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    let stoppedVm = false;
    if (includeSnapshots && this.vmRunning) {
      await this.stop().catch(() => {});
      stoppedVm = true;
    }
    const report = require('./layers').prune(this.provisioner.paths().root, {
      apply, aggressive, keepSnapshots: !includeSnapshots && this.vmRunning,
    });
    // 预览阶段若停了机，给Dùng户一 lời nhắc：清完可手动重启Bộ chạy
    return { ...report, apply, stoppedVm };
  }

  /**
   * 彻底Đặt lại dữ liệu Android（清Trống /data Dùng户Phân vùng + Ứng dụng đã cài + 快速启动快照），
   * 把 AVD 还原成「刚装好系统、没Có任何第三方 app」của干净状态。
   * 这一mục会真实Xóa 8–16GB củaDùng户数据镜像，必须二次Xác nhận（UI 负责），且只动
   * 当前活动 AVD（apkstart.avd），不动只读基础镜像、不动其它 AVD。
   * 保留 config.ini / hardware-qemu.ini，AVD 仍Có效，下次点开Áp dụng会重新Khởi động nguội建数据。
   * @returns {{ok:boolean, reclaimed:number, avdDir:string, error?:string}}
   */
  async resetAndroidData() {
    const fs = require('fs');
    const path = require('path');
    try {
      if (this.vmRunning) await this.stop().catch(() => {});
      const avdDir = path.join(this.provisioner.paths().avdHome, 'apkstart.avd');
      let reclaimed = 0;
      if (fs.existsSync(avdDir)) {
        for (const e of fs.readdirSync(avdDir, { withFileTypes: true })) {
          const p = path.join(avdDir, e.name);
          // Xóa: dùng户数据镜像（含 qcow2 差量 + 基址）、快速启动快照、残留锁文件/锁目录。
          // 保留：config.ini / hardware-qemu.ini / AVD.conf / cache.img / encryptionkey* / initrd /
          //       modem_simulator / 各类 *.ini / *.txt / *.cache —— 它们是 AVD của身份与基础设施，
          //       删了 AVD 直接失效或下次开机异常。下次点开Áp dụng，模拟器会按 -wipe-data 语义重建 /data。
          const isUserdata = /^userdata(-qemu)?(-[0-9]+)?\.img(\.qcow2)?$/.test(e.name)
            || /^userdata\.img(\.qcow2)?\.\d+$/.test(e.name);
          const isSnapshot = /^snapshots(\.stale-\d+)?$/.test(e.name);
          const isLock = /\.lock$/.test(e.name);
          if (!e.isDirectory() && !isUserdata && !isLock) continue;
          if (e.isDirectory() && !isSnapshot && !isLock) continue;
          try {
            if (e.isDirectory()) {
              const s = require('./layers').dirSize(p);
              fs.rmSync(p, { recursive: true, force: true });
              reclaimed += s;
            } else {
              const s = fs.statSync(p).size;
              fs.rmSync(p, { force: true });
              reclaimed += s;
            }
          } catch (_) { /* 占Dùng中của暂跳，下次再清 */ }
        }
      }
      // Dùng户数据镜像被删后，Dùng户侧「Đã cài đặt app」của记录也要清掉，
      // 否则Màn hình nền/启动器还显示着其实已Không tồn tạicủa app。
      try { store.saveApps([]); } catch (_) { /* ignore */ }
      return { ok: true, reclaimed, avdDir };
    } catch (e) {
      return { ok: false, reclaimed: 0, avdDir: '', error: e.message };
    }
  }

  /**
   * 把「Đã lưu但不会Tự động连」của AndroidWifi 连上（Không phải破坏性，不重启、不清数据）。
   * 具体实现与实机原因见 emulator.repairWifi。
   *
   * @returns {Promise<boolean>} 是否已连上
   */
  async repairWifi(adbPath = '') {
    const adb = adbPath || (typeof this.adbPath === 'function' ? this.adbPath() : '');
    return this.emulator.repairWifi(adb).catch(() => false);
  }

  /**
   * 等待虚拟机联网。
   *
   * 实测：`sys.boot_completed` 只代表系统起来了，Wi-Fi 关联 + DHCP 还要再等
   * 十几秒到一分多钟才会拿到 10.0.2.16。红果这类Áp dụng一进去就拉首页数据，
   * 没网时页面渲染成一整块黑底（隐私弹窗是本地页面所以正常显示），
   * Dùng户看到của就是「点同意并Tiếp tục之后一直黑屏」。所以拉起Áp dụng前先等网络Sẵn sàng。
   *
   * @returns {Promise<{ok:boolean,reason:string,ip?:string,gateway?:string}>}
   */
  async waitForNetwork({ timeoutMs = 90000, onLog = () => {}, adbPath = '' } = {}) {
    const done = (r) => {
      this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      return r;
    };
    const t0 = Date.now();
    let last = null;
    let lastNotice = 0;
    let offlineSince = 0;
    let notConnectedStreak = 0;
    while (Date.now() - t0 < timeoutMs) {
      const online = await this.client().isOnline().catch(() => false);
      if (!online) {
        // 刚重启của虚拟机会Có一段时间连 adb 都还没上线，不能一看到 offline 就放弃
        // （之前就是这样：重置数据后立刻返回 device-offline，判定「Sửa thất bại」）。
        if (!offlineSince) offlineSince = Date.now();
        if (Date.now() - offlineSince > 45000) return done({ ok: false, reason: 'device-offline' });
      } else {
        offlineSince = 0;
        // eslint-disable-next-line no-await-in-loop
        last = await this.emulator.checkNetwork(adbPath || this.adbPath()).catch(() => null);
        if (last && last.ok) return done(last);
        // `wifi-not-connected` 是「Wi-Fi 压根没关联上」，不是「关联了还在等 DHCP」。
        // 这种状态下死等Hết thời gian纯属浪费：本轮开机它不会自己连上（实机上 AndroidWifi
        // 常落成「Đã lưu但不会Tự động连接」）。连续几次都是这cái原因就提前收工，
        // 让调Dùng方赶紧去做真正Có效của重连，别把 20 秒耗在原地。
        // 取 3 次（≈9 giây)而不是 2 lần:刚开机时 Wi-Fi 本来就要几秒关联，
        // 判太早会去点Cài đặt页，反而打断它自己连上của过程。
        if (last && last.reason === 'wifi-not-connected') {
          notConnectedStreak += 1;
          if (notConnectedStreak >= 3) return done(last);
        } else {
          notConnectedStreak = 0;
        }
      }
      if (Date.now() - lastNotice > 10000) {
        lastNotice = Date.now();
        onLog(`Đang chờ máy ảo Android có mạng… ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    return done(last || { ok: false, reason: 'timeout' });
  }

  /**
   * Sửa「安卓虚拟机没Có网络」。
   * 绝Lớn多数情况只是 Wi-Fi 关联比开机Hoàn tất慢，重启并等一会儿就能好，
   * **不Cần**清掉Dùng户数据；只Có在等待Hết thời gian后才提示Dùng户走「Đặt lại dữ liệu Android」。
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, error?:string}>}
   */
  /**
   * 确保虚拟机联网：先等，等不到就Khởi động nguội一次（绕开可能「没网」của快照）再等。
   * 这是「红果点同意后黑屏」của根治手段：Áp dụng一定要在网络Sẵn sàng后才启动。
   *
   * @returns {Promise<{ok:boolean,reason?:string,ip?:string,gateway?:string}>}
   */
  async ensureNetwork({ onLog = () => {}, firstWaitMs = 25000, secondWaitMs = 90000 } = {}) {
    let net = await this.waitForNetwork({ onLog, timeoutMs: firstWaitMs });
    if (net && net.ok) return net;
    // Thử trước便宜của办法：把「Đã lưu但不会Tự động连」của AndroidWifi 点一下。
    // 这一步比Khởi động nguội、比清数据都轻几cái数量级——不重启虚拟机、不动Dùng户数据。
    // 实机上这才是绝Lớn多数「虚拟机没网」của真正原因（见 emulator.repairWifi 注释）。
    if (!this._wifiRepairTried) {
      this._wifiRepairTried = true;
      onLog('Máy ảo không kết nối được Wi-Fi, đang thử kết nối lại…');
      try {
        const fixed = await this.emulator.repairWifi(this.adbPath());
        if (fixed) {
          net = await this.waitForNetwork({ onLog, timeoutMs: 15000 });
          if (net && net.ok) {
            onLog(`Mạng đã khôi phục (${net.ip || ''}), đang lưu trạng thái dùng được, lần sau vào thẳng.`);
            try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
            return net;
          }
        }
      } catch (_) { /* Sửa thất bại就走下面của重Đường dẫn */ }
    }
    // Khởi động nguội很贵（几十giây)，一cái进程里只做一lần:否则每次点开Áp dụng都要重来一遍，
    // Dùng户感受到của就是「点开要等好几phút」。
    if (this._netColdBootTried) return net;
    this._netColdBootTried = true;
    onLog('Mạng vẫn chưa sẵn sàng, đang khởi động nguội máy ảo một lần (không nạp snapshot) rồi thử lại…');
    try {
      await this.stop({ graceful: false }).catch(() => {});
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) return { ok: false, reason: 'boot-failed' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    net = await this.waitForNetwork({ onLog, timeoutMs: secondWaitMs });
    if (net && net.ok) {
      // Mạng bình thường后立刻存快照，下次恢复时网卡状态一起还原
      try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
    }
    return net;
  }

  /**
   * Sửa「安卓虚拟机没Có网络」。
   * 顺序：Khởi động nguội（不动数据）→ 等网络 → 还不行才重置数据（会丢Áp dụng内数据）。
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, wiped?:boolean, error?:string}>}
   */
  async repairNetwork({ onLog = () => {} } = {}) {
    try {
      // 阶梯式Sửa，从最便宜của开始，能不丢数据就绝不丢：
      //   1) 重新连一次 Wi-Fi（不重启、不动数据）
      //   2) Khởi động nguội（不加载快照，仍不动数据）
      //   3) 最后才重置数据
      onLog('Đang sửa mạng máy ảo: thử kết nối lại Wi-Fi trước (không ảnh hưởng ứng dụng đã cài)…');
      if (!this.vmRunning) {
        const boot0 = await this.ensure({ onLog });
        if (!boot0 || !boot0.ok) {
          return { ok: false, error: (boot0 && boot0.error) || 'Máy ảo không khởi động được', boot: false };
        }
      }
      this._wifiRepairTried = true;
      let fixed = false;
      try { fixed = await this.emulator.repairWifi(this.adbPath()); } catch (_) { fixed = false; }
      if (fixed) {
        const net1 = await this.waitForNetwork({ onLog, timeoutMs: 30000 });
        if (net1 && net1.ok) {
          try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
          onLog(`Mạng đã khôi phục (${net1.ip || ''}), đã lưu snapshot dùng được.`);
          return { ok: true, network: net1, boot: true, wiped: false };
        }
      }
      // 第 2 步：Khởi động nguội，绕开可能「没网」của快照
      onLog('Kết nối lại không được, đang khởi động nguội máy ảo một lần (không nạp snapshot, giữ nguyên dữ liệu)…');
      await this.stop({ graceful: false }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) {
        return { ok: false, error: (boot && boot.error) || 'Máy ảo không khởi động được', boot: false };
      }
      let network = await this.waitForNetwork({ onLog, timeoutMs: 90000 });
      if (network && network.ok) {
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`Mạng đã khôi phục (${network.ip || ''}), đã lưu snapshot dùng được.`);
        return { ok: true, network, boot: true, wiped: false };
      }
      // 第 3 步：还没网，只能重置数据了（会丢Áp dụng内数据）
      onLog('Vẫn không có mạng, đang đặt lại dữ liệu Android và khởi động lại (danh sách ứng dụng được giữ, tự cài lại khi mở)…');
      if (this.vmRunning) await this.stop({ graceful: false }).catch(() => {});
      // 给上一次của qemu / netsimd 一点时间退干净，否则 -wipe-data 会撞 AVD 锁
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceWipeOnNextStart();
      const boot2 = await this.ensure({ onLog });
      if (!boot2 || !boot2.ok) {
        return { ok: false, error: (boot2 && boot2.error) || 'Máy ảo không khởi động được', boot: false, wiped: true };
      }
      network = await this.waitForNetwork({ onLog, timeoutMs: 240000 });
      if (network && network.ok) {
        // 立刻把「Mạng bình thường」của状态存成快照：下次恢复时网卡状态一起还原，
        // 否则关掉再开又会回到没网状态。
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`Mạng đã khôi phục (${network.ip || ''} Gateway ${network.gateway || 'Truy cập được'}), đã lưu snapshot dùng được.`);
      } else {
        onLog('Đặt lại xong vẫn không có mạng. Hãy kiểm tra mạng/tường lửa của máy có chặn trình giả lập không (netsimd dùng cổng loopback cục bộ).');
      }
      return { ok: !!(network && network.ok), network, boot: true, wiped: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._client && this._client.disposeInput) this._client.disposeInput();
    // 后端适配层只Có自带Bộ chạy；dispose 只做自己củaDọn dẹp，不会去动任何外部模拟器
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this.emulator.cancelSnapshotSave();
    // 这里【绝对不能】强杀 qemu：
    //  1) 强杀会把正在写盘của quickboot 快照截断，只留下几 GB của ram.img Trống壳，
    //     下次开机加载Thất bại → 全量Khởi động nguội，这就是「每次Mở都要等两phút」của直接原因；
    //  2) 留着它，下次Mở ApkStart 可以直接接管，点Áp dụng秒开（WSA / Áp dụng宝电脑版同款行为）。
    // Gỡ cài đặt时另走一条路（app:removeSelf 会显式Dọn dẹp进程）。
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT };
