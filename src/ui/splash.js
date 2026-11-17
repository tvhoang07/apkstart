'use strict';
/* ApkStart 开机动画脚本：接收主进程của进度更新，控制淡出 */

const api = window.apkstartSplash;
if (!api) { /* preload 未注入时静默Thoát */ }

const $ = (id) => document.getElementById(id);

// 版本号
api?.version?.().then((v) => { if ($('ver')) $('ver').textContent = v || ''; }).catch(() => {});

// 首次Cài đặt标记 + 组件是否随包自带
Promise.all([
  api?.isFirstRun?.().catch(() => false),
  api?.bundled?.().catch(() => false),
]).then(([first, bundled]) => {
  if (!first || !$('firstRun')) return;
  $('firstRun').hidden = false;
  // 内置Bộ chạy（完整版Gói cài đặt / 微软商店 MSIX 版）：一cái字都不该提「下载」。
  // Dùng户抱怨của就是「装了 850MB 还在下镜像」，实际那只是把包trong压缩镜像
  // 展开到Dùng户目录，不Cần联网。
  if (bundled) {
    if ($('firstRunTitle')) $('firstRunTitle').textContent = 'Khởi động lần đầu · đang chuẩn bị cục bộ (không cần mạng)';
    if ($('firstRunList')) {
      $('firstRunList').innerHTML = [
        '<li>Các thành phần bộ chạy đã tích hợp trong gói cài đặt, không tải thêm gì nữa</li>',
        '<li>Giải nén ảnh hệ thống vào thư mục người dùng (khoảng 1 phút, chỉ cần một lần)</li>',
        '<li>Chuẩn bị tăng tốc phần cứng và bộ gõ tiếng Trung</li>',
        '<li>Xong là nhấp đúp APK hoặc biểu tượng trên màn hình nền để mở ứng dụng ngay</li>',
      ].join('');
    }
  }
}).catch(() => {});

// 进度更新
api?.onProgress?.((p) => {
  if (!p) return;
  if (p.percent != null && $('progressBar')) {
    $('progressBar').style.width = Math.min(100, Math.max(0, p.percent)) + '%';
  }
  if (p.message && $('status')) {
    $('status').textContent = p.message;
  }
});

// Hoàn tất → 淡出
api?.onDone?.(() => {
  const splash = $('splash');
  if (splash) {
    splash.classList.add('out');
    setTimeout(() => { api?.close?.(); }, 520);
  }
});
