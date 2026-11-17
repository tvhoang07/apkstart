'use strict';
/**
 * 后端适配层（backend driver）—— 把「安卓从哪来」这件事从 Runtime 里抽出来。
 *
 * 背景：ApkStart 原本只Có一cái底座（自带 Google Android Emulator / QEMU），
 * Enginecủa生命周期（开机、快照、Trống闲回收、镜像下载）全部写死在 core/engine.js 里。
 * 但「双击 APK 装好、双击图标Mở、每 ứng dụng一cái干净窗口」这部分体验，
 * 对底座其实只Có三cái要求：
 *
 *   1. Có一cái能连上của adb 设备（装包 / 启动 / 输入 / 截图都靠它）；
 *   2. Có一块能拿到 HWND của安卓画面窗口（Dùng SetParent 嵌进我们自己của窗口）；
 *   3. 能把这台设备启动 / 停掉。
 *
 * 0.5.6 起只保留一cái实现：builtin（自带 emulator + Ảnh hệ thống）。
 * 这层接口留着，是为了让 engine.js 里「安卓从哪来」这件事仍然只Có一处入口，
 * 也方便以后真要替换Bộ chạycủa时候不Dùng再动Engine主流程；
 * 但**不再支持任何第三方模拟器 / 系统级Bộ chạy**（MuMu / 雷电 / 蓝叠 / WSA 都不接）。
 *
 * 约定（所Có实现都必须遵守）：
 *  - 所Có方法都可能被并发调Dùng，实现要幂等；重复 ensure() 不能起两台。
 *  - 任何一步Thất bại都返回 { ok:false, error }，不要抛异常给上层（上层只做提示）。
 *  - 不要假设自己独占 adb server：能Dùng自带 adb 就Dùng，Dùng别人của要自己 connect。
 */

/** 底座能力位：上层据此决定哪些菜单/回调要显示或要跳过 */
const CAPS = {
  /** 能自己下载/部署Bộ chạy（镜像、emulator、adb） */
  provision: 'provision',
  /** 能保存快速启动快照（二次开机秒进） */
  snapshot: 'snapshot',
  /** 能调整数据Phân vùngLớnNhỏ */
  resizeData: 'resizeData',
  /** 能彻底Đặt lại dữ liệu Android（/data） */
  resetData: 'resetData',
  /** 能改物理面板方向（真Màn ngang，靠重启实现） */
  rotatePanel: 'rotatePanel',
  /** 能调进程优先级（把虚拟机让给前台Áp dụng） */
  priority: 'priority',
  /** 能彻底关掉自己（Gỡ cài đặt/Thoát时调Dùng） */
  shutdown: 'shutdown',
  /** 画面窗口由第三方软件Tạo，不能过多「借」它của窗口（避免抢走Dùng户自己của模拟器） */
  sharedHost: 'sharedHost',
};

class Backend {
  /**
   * @param {object} appRoot 程序根目录（打包后是 resources/app）
   * @param {object} deps    Tổng享依赖：{ store, log }
   */
  constructor(appRoot, deps = {}) {
    this.appRoot = appRoot || '';
    this.deps = deps || {};
    /** adb serial（Ví dụ emulator-5554 / 127.0.0.1:16384） */
    this.serial = '';
    /** adb.exe của绝对Đường dẫn */
    this.adbPath = '';
    /** 最近一次错误，供Chẩn đoánDùng */
    this.lastError = '';
  }

  /** 底座của稳定 id（写入Cài đặt，不能随意改） */
  static get id() { return 'base'; }

  /** 界面上显示của名字 */
  static get label() { return 'Backend chưa đặt tên'; }

  /** 一句话说明，Cài đặt页Dùng它解释这cái底座是什么 */
  static get summary() { return ''; }

  /** 这cái底座是否满足「嵌入式窗口」要求（不满足của只能当 attach Dùng） */
  static get embedCapable() { return false; }

  get id() { return this.constructor.id; }

  get label() { return this.constructor.label; }

  /** 能力位集合，见 CAPS */
  get caps() {
    return new Set();
  }

  has(cap) { return this.caps.has(cap); }

  /** 当前底座是否已经在跑（不要求已连上 adb） */
  running() { return false; }

  /**
   * 探测：机器上Có没Có这cái底座。
   * Dùng于「Tự động挑一cái能Dùngcủa底座」，必须快（<1.5s）且不产生副作Dùng。
   * @returns {Promise<{ok:boolean, found:boolean, path?:string, detail?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async probe() { return { ok: true, found: false }; }

  /**
   * Sẵn sàng检查: dùng户能不能Hiện就Dùng它装Áp dụng。
   * @returns {Promise<{ok:boolean, reason?:string, needs?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async check() { return { ok: false, reason: 'Chưa triển khai' }; }

  /** 解析Khả dụngcủa adb Đường dẫn（优先自带，其次底座自带của，最后系统 PATH） */
  async resolveAdb() { return ''; }

  /**
   * 确保Bộ chạyKhả dụng：没开机就开机、没连上就 connect。
   * @param {object} o { onLog }
   * @returns {Promise<{ok:boolean, serial?:string, adbPath?:string, reused?:boolean, error?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async ensure(o = {}) { return { ok: false, error: 'Chưa triển khai' }; }

  /**
   * 安卓画面窗口của候Chọn HWND（十六进制或十进制của字符串数组，按优先级排序）。
   * 上层（WinAgent）拿到后逐cái试 SetParent，第一cái成立của就算嵌入成功。
   * @returns {Promise<string[]>}
   */
  // eslint-disable-next-line class-methods-use-this
  async windowTargets() { return []; }

  /**
   * 画面窗口是否已经Sẵn sàng（可以停止隐藏/开始嵌入）。
   * 默认：拿得到候Chọn窗口就算Sẵn sàng。自带 emulator của窗口是我们自己拉起来của，
   * 默认实现就够Dùng；保留这cái钩子是为了将来换Bộ chạy时Có地方等画面。
   *
   * @param {object} o { isEmbedded?: () => boolean }
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async windowReady(o = {}) { // eslint-disable-line no-unused-vars
    const targets = await this.windowTargets().catch(() => []);
    return targets.length ? { ok: true } : { ok: false, reason: 'no-window' };
  }

  /**
   * 把画面窗口藏起来（开机 / 预热阶段，Dùng户不该看到模拟器）。
   * 拿不到窗口时静默返回 null。
   * @returns {Promise<string|null>} 藏起来của HWND
   */
  async hideWindow() { return null; }

  /** Dừng bộ chạy */
  // eslint-disable-next-line class-methods-use-this
  async stop(o = {}) { return { ok: false, error: 'Chưa triển khai' }; }

  /** 下载/部署Thiếu失组件（只Có带 CAPS.provision của底座Cần实现） */
  // eslint-disable-next-line class-methods-use-this
  async install(component, onProgress) { return { ok: false, error: 'Backend này không hỗ trợ tự triển khai' }; }

  /** 占Dùng统计（Cài đặt页「Bộ chạy占Dùng」） */
  // eslint-disable-next-line class-methods-use-this
  usage() { return { total: 0, items: [] }; }

  /** 数据Phân vùng信息 */
  // eslint-disable-next-line class-methods-use-this
  dataInfo() { return { ok: false }; }

  /** 调整数据Phân vùng */
  // eslint-disable-next-line class-methods-use-this
  async resizeData(mb) { return { ok: false, error: 'Backend này không hỗ trợ điều chỉnh phân vùng dữ liệu' }; }

  /** 彻底Đặt lại dữ liệu Android */
  // eslint-disable-next-line class-methods-use-this
  async resetData() { return { ok: false, error: 'Backend này không hỗ trợ đặt lại dữ liệu' }; }

  /** 释放资源（ApkStart Thoát时调Dùng；默认什么都不做） */
  // eslint-disable-next-line class-methods-use-this
  dispose() {}

  /** Chẩn đoán信息（写进问题报告） */
  // eslint-disable-next-line class-methods-use-this
  diagnose() { return {}; }
}

module.exports = { Backend, CAPS };
