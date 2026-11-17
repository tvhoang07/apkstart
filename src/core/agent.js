'use strict';
/**
 * Windows 窗口代理：与 src/core/win/agent.ps1 trong常驻进程通信。
 *
 * 为什么不是每次 spawn 一cái PowerShell：窗口跟随鼠标拖动时会频繁改尺寸，
 * 每次起一cái powershell.exe 要 150~300ms，拖动就会一顿一顿của。
 * 这里只启动一次，之后走Máy này回环 TCP（一行一cái JSON），单次往返 <2ms。
 *
 * 代理可Chọn负责 WH_MOUSE_LL 鼠标钩子：右键返回 / 滚轮滑动 / 侧键前进后退。
 * 该钩子是全局của，会介入系统里每一次鼠标事件，因此只在「Cửa sổ ứng dụng处于前台」
 * 且至少启Dùng一mục映射时Cài đặt，失焦立即Gỡ cài đặt；回调只处理我们关心của 7 cái消息。
 * 见 setHook(on, opts)。
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'win', 'agent.ps1');
const CALL_TIMEOUT = 6000;

class WinAgent extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.port = 0;
    this.ready = null;
    this.buf = '';
    this.pending = [];
    this.dead = false;
    this.hooked = false;
    this.hookConf = null;
  }

  get available() { return process.platform === 'win32' && fs.existsSync(SCRIPT); }

  /** 启动代理并等到 TCP 连上（幂等） */
  ensure() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      if (!this.available) { reject(new Error('Proxy cửa sổ không khả dụng')); return; }
      let out = '';
      let settled = false;
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Port', '0',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      this.proc = proc;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        this.ready = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const onData = (chunk) => {
        out += chunk.toString('utf8');
        const m = /PORT=(\d+)/.exec(out);
        if (!m || settled) return;
        settled = true;
        this.port = Number(m[1]);
        this._connect().then(resolve).catch(fail);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => { out += d.toString('utf8'); });
      proc.on('error', fail);
      proc.on('exit', () => {
        const wasReady = !!this.sock;
        this.proc = null;
        this.sock = null;
        this.ready = null;
        this.hooked = false;
        this.hookConf = null;
        this._failAll('Proxy cửa sổ đã thoát');
        if (wasReady) this.emit('exit');
        fail(new Error('Proxy cửa sổ khởi động thất bại'));
      });
      setTimeout(() => { if (!settled) fail(new Error('Proxy cửa sổ khởi động quá thời gian')); }, 15000);
    });
    return this.ready;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port }, () => resolve(this));
      sock.setEncoding('utf8');
      sock.setNoDelay(true);
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => { reject(e); });
      sock.on('close', () => {
        this.sock = null;
        this.ready = null;
        this._failAll('Proxy cửa sổ bị ngắt kết nối');
      });
      this.sock = sock;
      this.buf = '';
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      // 事件带负载（滚轮của dx/dy/nx/ny），老监听器忽略多余参数即可
      if (msg.ev) { this.emit(msg.ev, msg); continue; }
      const p = this.pending.shift();
      if (p) { clearTimeout(p.timer); p.resolve(msg); }
    }
  }

  _failAll(reason) {
    const list = this.pending;
    this.pending = [];
    for (const p of list) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  /** 发送一条命令并等待回包 */
  async call(obj, timeout = CALL_TIMEOUT) {
    await this.ensure();
    if (!this.sock) throw new Error('Proxy cửa sổ chưa kết nối');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Proxy cửa sổ hết thời gian: ${obj.cmd}`)), timeout);
      this.pending.push({ resolve, reject, timer });
      this.sock.write(`${JSON.stringify(obj)}\n`);
    });
  }

  // ---------------- 便捷方法 ----------------

  /**
   * 声明「哪些目录trong进程才算我们của」。
   * 必须在 bootHide / embed 之前调Dùng：窗口代理只允许碰这些进程Tạocủa窗口。
   * 不传（或传Trống）时代理一cái窗口都不动 —— 宁可偶尔漏一cái黑窗，
   * 也绝不把别của Qt Áp dụng（微信 4.x 就是 Qt6、MuMu、音乐播放器）của窗口藏掉或嵌进来。
   * @param {string[]} dirs Bộ chạy根目录 / 随包của engine 目录
   * @param {number} [appPid] 主进程 pid：代理只允许把窗口嵌进这cái进程của窗口，
   *        并以此为据决定「鼠标事件của当前窗口是不是我们của」（防止句柄被回收复Dùng）
   */
  async scope(dirs, appPid) {
    const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
    const req = { cmd: 'scope', dirs: list.join(';') };
    if (Number(appPid) > 0) req.pid = Number(appPid);
    return this.call(req, 4000).catch(() => ({ ok: false, n: 0 }));
  }

  /**
   * 把画面窗口嵌进宿主窗口，并摆到 x,y,w,h（宿主客户区坐标）。
   *
   * @param {number|string} hostHwnd 宿主窗口句柄
   * @param {object} rect { x, y, w, h, clipTop }
   * @param {string[]} [targets] 第三方底座报上来của候Chọn句柄（"0x…"）。
   *        不传 = 老行为：由代理按进程作Dùng域自己找自带 emulator của窗口。
   *        传了 = 只嵌这些句柄trong一cái（MuMu / 其它模拟器của画面窗口）。
   */
  async embed(hostHwnd, rect, targets = null) {
    const req = {
      cmd: 'embed', host: String(hostHwnd),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    };
    if (Array.isArray(targets) && targets.length) {
      req.target = targets.map((t) => String(t)).join(',');
    }
    return this.call(req, 6000);
  }

  /** 候Chọn句柄Hiện还存在几cái(thứ三方底座Sẵn sàng门禁Dùng） */
  async windowReady(targets = []) {
    if (!Array.isArray(targets) || !targets.length) return { ok: false, alive: 0 };
    return this.call({ cmd: 'winready', target: targets.join(',') }, 3000)
      .catch(() => ({ ok: false, alive: 0 }));
  }

  async fit(rect) {
    return this.call({
      cmd: 'fit',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
      // 模拟器 Qt 窗口比 LCD 多出 EMU_PAD của外框，我们让它向上/向左溢出把这cái外框
      // 挤出客户区；溢出到标题栏上của那一条会被裁掉（否则点标题栏按钮时会冒黑边）。
      clipTop: Math.round(rect.clipTop || 0),
    }, 3000);
  }

  async rotate(dir = 'left') { return this.call({ cmd: 'rotate', dir }, 8000); }
  async hide() { return this.call({ cmd: 'hide' }, 3000); }
  async show() { return this.call({ cmd: 'show' }, 3000); }
  /** 通知代理进入低延迟模式：Lớn幅降低窗口扫描频率，把 CPU 留给安卓渲染 */
  async setPerformanceMode(on) { return this.call({ cmd: 'perf', on: on ? 1 : 0 }, 3000); }
  /** @param {boolean} keep true=切到独立窗口模式（别把模拟器窗口藏掉，并保留句柄） */
  async detach(keep = false) { return this.call({ cmd: 'detach', keep: keep ? 1 : 0 }, 5000); }
  /** 独立窗口模式：把模拟器原生窗口摆到指定屏幕矩形（不嵌入） */
  async layout(rect) {
    return this.call({
      cmd: 'layout',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    }, 4000);
  }
  /**
   * 把模拟器原生窗口của标题从 "Android Emulator - apkstart:5554" 改成Dùng户看得懂của名字。
   * 传Trống串时默认 "ApkStart"。代理会在巡检里持续补设（Qt 偶尔会自己改回去）。
   */
  async setTitle(text = 'ApkStart') {
    return this.call({ cmd: 'title', text: String(text || 'ApkStart') }, 4000);
  }
  /**
   * 给模拟器原生窗口设图标（独立窗口模式下任务栏/Alt+Tab 显示当前Áp dụng图标）。
   * @param {string} file PNG/ICO 绝对Đường dẫn
   */
  async setIcon(file) {
    return this.call({ cmd: 'icon', file: String(file || '') }, 4000);
  }
  async probe() { return this.call({ cmd: 'probe' }, 4000); }
  /** 列出当前可见của顶层窗口（Dùng于验证「只Có软件界面 / 只CóỨng dụng Android窗口」） */
  async windows() { return this.call({ cmd: 'windows' }, 4000); }

  /**
   * 把头号可疑窗口「摘下 + 藏好」。
   * 宿主窗口销毁前必须调Dùng：Windows 会在父窗口销毁时把跨进程của子窗口重新挂到Màn hình nền，
   * 并保持它原来của可见状态 —— Màn hình nền上凭Trống多出来của Android Emulator 黑窗就是这么来của。
   * 代理很忙（可能在编译 C#）时也不能拖着不关窗，所以这里给 700ms 硬上限。
   */
  async park(maxWaitMs = 700) {
    const call = this.call({ cmd: 'park' }, 2000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /**
   * 开启「常驻压制」：模拟器主窗（QWindowIcon）+ 工具栏 + qemu / netsimd của控制台黑窗
   * 一律Không được phép露面，只Có被 embed 进我们窗口của那一cái除外。
   * 这是「Mở软件只看到软件界面」của关键：emulator 拉起 detached của qemu / netsimd
   * 控制台子进程，Node của windowsHide 覆盖不到它们，只能由窗口代理周期性压住。
   * Hiện模拟器还带 -qt-hide-window（窗口Tạo即隐藏），双保险，连第一帧都不会闪。
   *
   * maxWaitMs：代理本身要现编译启动（几百毫秒，异常时可能十几giây)。调Dùng点是在
   * 「拉起模拟器之前」，绝不能因为代理起不来把开机拖住，所以这里给cái硬上限。
   * @param {number} maxWaitMs
   */
  async bootHide(maxWaitMs = 3000) {
    const call = this.call({ cmd: 'boothide', on: 1 }, 4000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /** 关掉常驻压制（正常情况下不再Cần：嵌入后压制会Tự động跳过被嵌入của那cái窗口） */
  async bootShow() {
    return this.call({ cmd: 'boothide', on: 0 }, 4000).catch(() => ({ ok: false }));
  }

  /**
   * 全局鼠标钩子开关（幂等）。
   * 只在Cửa sổ ứng dụng前台、且至少一mục映射开启时才Cài đặt；opts 变化时不重装luồng，
   * 只把新开关发给常驻代理，避免窗口反复 focus / 改Cài đặt时反复装卸钩子。
   * @param {boolean} on
   * @param {{rightBack?:boolean, wheel?:boolean, side?:boolean}} opts
   */
  async setHook(on, opts = {}) {
    const want = !!on;
    const conf = {
      right: !!(opts && opts.rightBack),
      wheel: !!(opts && opts.wheel),
      side: !!(opts && opts.side),
    };
    // 默认Đóng状态下不为了「关」而拉起 PowerShell 进程（Khởi động nguội零开销）
    if (!want && !this.hooked) return { ok: true, hooked: false };
    const sameConf = this.hookConf
      && this.hookConf.right === conf.right
      && this.hookConf.wheel === conf.wheel
      && this.hookConf.side === conf.side;
    if (want === this.hooked && sameConf) return { ok: true, hooked: this.hooked };
    const req = { cmd: 'hook', on: want ? 1 : 0, right: conf.right ? 1 : 0, wheel: conf.wheel ? 1 : 0, side: conf.side ? 1 : 0 };
    if (!want) {
      this.hooked = false;
      this.hookConf = null;
      return this.call(req, 3000).catch(() => ({ ok: false, hooked: false }));
    }
    const r = await this.call(req, 3000).catch(() => null);
    this.hooked = !!(r && r.hooked !== false);
    this.hookConf = this.hooked ? conf : null;
    return { ok: this.hooked, hooked: this.hooked };
  }

  dispose() {
    // 先Gỡ cài đặt全局钩子再结束进程：即使代理被强杀，也不给系统留残留钩子
    if (this.hooked && this.sock) {
      try { this.sock.write('{"cmd":"hook","on":0}\n'); } catch (_) { /* ignore */ }
    }
    this.hooked = false;
    this.hookConf = null;
    try { this.sock?.end(); } catch (_) { /* ignore */ }
    try { this.sock?.destroy(); } catch (_) { /* ignore */ }
    // 故意不 kill 代理进程：断开连接后它会自己进入「守卫」状态（见 agent.ps1 của
    // _lingerUntil）。模拟器可能还在开机，几十秒后才把窗口显示出来；那时如果
    // 代理已经死了，Màn hình nền上就会留一cái Android Emulator 黑窗。模拟器进程消失后
    // 代理会自行Thoát，最多守 3 phút。
    this.sock = null;
    this.proc = null;
    this.ready = null;
  }
}

module.exports = { WinAgent, AGENT_SCRIPT: SCRIPT };
