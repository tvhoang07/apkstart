'use strict';
/**
 * 底座注册表
 *
 * **只Có一cái底座：自带Bộ chạy（builtin）。**
 *
 * 0.5.6 起，ApkStart 在任何机器、任何情况下都只跑自己của Android Bộ chạy
 * （自带của adb / emulator / Ảnh hệ thống），不再探测、接管、Trình điều khiển任何第三方模拟器
 * （MuMu / 雷电 / 蓝叠 / WSA / FydeOS），也不提供「连接已CóBộ chạy」của模式。
 *
 * 为什么把可Chọn底座整条链路删掉，而不是只留cái开关关掉：
 *   - 只要代码里还留着探测分支，Dùng户机器上装了 MuMu 就随时可能被「顺手接管」，
 *     表现成「点开 ApkStart 却跑của是别人家của模拟器」，数据、存档、镜像都不在自己以为của地方；
 *   - 第三方模拟器升级、换端口、改配置都会让 ApkStart 直接失效，而这些不是我们能修của；
 *   - 商店包 / 便携版只带自己củaBộ chạy，本来也Không được phép捆绑或依赖任何第三方模拟器。
 * 所以这里保留注册表của形式（上层接口不变），内容固定为 builtin：
 * 读Cài đặt、读残留配置、导入旧 settings.json 都不会再切到别của底座。
 */

const { Backend, CAPS } = require('./base');
const { BuiltinBackend } = require('./builtin');

const REGISTRY = [
  BuiltinBackend,
];

/** 唯一底座。保留这cái常量，是给「以后真要加底座」của地方留cái明确落点。 */
const ONLY = 'builtin';

function byId(id) {
  return REGISTRY.find((B) => B.id === id) || null;
}

/** 给界面Dùngcủa描述清单（只留静态信息，能安全序列化） */
function describe() {
  return REGISTRY.map((B) => ({
    id: B.id,
    label: B.label,
    summary: B.summary,
    embedCapable: B.embedCapable,
  }));
}

/**
 * 按Cài đặtTạo一cái底座实例。
 *
 * 注意：**故意忽略 settings.engine.mode**。老版本可能留下 mode=mumu / fydeos / attach，
 * 手改 settings.json 也可能写成别của值 —— 这些都必须被当成 builtin，
 * 否则「无论什么情况都独立运行」就是一句Trống话。返回值trong id 一定是 'builtin'。
 *
 * @param {object} o { appRoot, settings, runtime, store, log, id }
 * @returns {{ backend: Backend, Cls: Function, id: string }}
 */
function create({ appRoot, runtime, store, log, id: forced } = {}) {
  // 显式传了别của id（旧代码của回退Đường dẫn）也一律落到 builtin
  const id = forced && byId(forced) ? forced : ONLY;
  const Cls = byId(id) || BuiltinBackend;
  const backend = new Cls(appRoot, { runtime, store, log });
  return { backend, Cls, id: Cls.id };
}

/**
 * Tự động挑Chọn底座。Hiện只Có一cái，永远返回 builtin，不做任何探测：
 * 探测本身就会去碰第三方模拟器của目录 / 注册表，那正是要去掉của行为。
 */
async function autoPick() {
  return { id: ONLY, reason: 'builtin-only' };
}

module.exports = {
  REGISTRY, ONLY, CAPS, byId, describe, create, autoPick, Backend,
};
