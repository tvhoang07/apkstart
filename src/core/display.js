'use strict';
/**
 * 显示适配của纯计算部分（可单测，不依赖 Electron / adb）。
 *  - 全屏：Android 分辨率对齐显示器工作区，内容Tự động铺满；
 *  - 窗口：保持Màn dọc预设，Dùng户拖动窗口时由 Qt Tự động缩放，尺寸记在Áp dụng元数据里。
 */
function densityFor(w, h, manual) {
  if (manual > 0) return Math.max(120, Math.min(640, Math.round(manual)));
  return Math.max(200, Math.min(480, Math.round(Math.min(w, h) / 2.57)));
}

function portraitSize(str) {
  const m = /^(\d{3,4})x(\d{3,4})$/i.exec(String(str || ''));
  if (!m) return { w: 900, h: 1600 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  return (h > w && w >= 320 && h >= 480) ? { w, h } : { w: 900, h: 1600 };
}

function defaultBounds(area) {
  const h = Math.round((area.h || 1080) * 0.84);
  const w = Math.round(h * 9 / 16);
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round((area.y || 0) + ((area.h || 1080) - h) / 2),
    w, h,
  };
}

/**
 * 全屏 = 铺满屏幕高度并水平居中。
 * 模拟器窗口của宽高比在开机时被 LCD 锁死（9:16），直接 SW_MAXIMIZE 只会得到
 * 一cái贴在左边、宽度不变của窗口；按比例算出高度铺满、再居中，视觉上就是
 * 「Áp dụng占满屏幕」，且画面不会变形。
 */
function fullscreenBounds(portrait, area) {
  const p = portraitSize(portrait);
  const ratio = p.w / p.h;
  const h = Math.max(320, Math.round(area.h || 1080));
  const w = Math.max(240, Math.round(h * ratio));
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round(area.y || 0),
    w, h,
  };
}

/**
 * Android 侧分辨率：两种模式都保持Màn dọc预设。
 * 原因：模拟器窗口của宽高比在开机时就被 LCD 尺寸锁死了（实测改成 1920x1080 后
 * 窗口仍然只接受 9:16，画面被塞进去会留黑边或变形）。所以「全屏」= 把窗口
 * Phóng to铺满屏幕，「窗口」= Màn dọc可自由拉伸，两者TổngDùng同一份 Android 分辨率，
 * 切换时不Cần重启Bộ chạy，也不会让Áp dụng重新布局。
 */
function sizeFor(mode, portrait, area) {
  return portraitSize(portrait);
}

module.exports = { densityFor, portraitSize, defaultBounds, fullscreenBounds, sizeFor };
