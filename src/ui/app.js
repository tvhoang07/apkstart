'use strict';

const api = window.apkstart;
const $ = (id) => document.getElementById(id);

const state = {
  apps: [],
  settings: null,
  status: null,
  filter: '',
  installing: false,
  setupBusy: null,
  menuPkg: null,
};

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initialOf(label) {
  const t = String(label || '?').trim();
  return (t[0] || '?').toUpperCase();
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'Vừa xong';
  if (d < 3600000) return `${Math.floor(d / 60000)}  phút trước`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} giờ trước`;
  if (d < 86400000 * 30) return `${Math.floor(d / 86400000)}  ngày trước`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/**
 * 迷你 toast
 *
 * 同一类消息做去重 + 数量上限：
 * Cài đặt thất bại时里面Có「Bộ chạy启动Nhật ký」在持续推送，以前每条都新建一cái toast，
 * 于是屏幕上会不停叠加同一条错误，看起来像「Thất bại信息一直循环」。
 */
let _toastSeq = 0;
function toast({ title, body = '', type = 'info', progress = null, sticky = false, spinner = false }) {
  const wrap = $('toastWrap');
  // ① 去重：同样của标题 + 正文（4 秒内）只Làm mới那一条，不叠加
  const key = `${title}|${body}`;
  const dup = [...wrap.children].find((n) => n.dataset.key === key && Date.now() - Number(n.dataset.at || 0) < 4000);
  if (dup) {
    dup.dataset.at = String(Date.now());
    return {
      el: dup,
      dismiss: () => dup.remove(),
      update: ({ title: t2, body: b2 } = {}) => {
        if (t2 !== undefined) dup.querySelector('.t-title-text').textContent = t2;
        if (b2 !== undefined) dup.querySelector('.t-body').textContent = b2;
      },
    };
  }
  // ② 上限：同时最多 4 条，超出先挤掉最旧của
  while (wrap.children.length >= 4) wrap.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.dataset.key = key;
  el.dataset.at = String(Date.now());
  el.dataset.seq = String(++_toastSeq);
  el.innerHTML = `
    <div class="t-title">
      ${spinner ? '<span class="spinner"></span>' : ''}
      <span class="t-title-text">${esc(title)}</span>
    </div>
    <div class="t-body">${esc(body)}</div>
    ${progress === null ? '' : '<div class="bar"><i></i></div>'}
  `;
  $('toastWrap').appendChild(el);

  const dismiss = () => {
    el.style.transition = 'opacity .18s, transform .18s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 200);
  };

  const ctl = {
    el, dismiss,
    update({ title: t2, body: b2, progress: p2, type: ty } = {}) {
      if (t2 !== undefined) el.querySelector('.t-title-text').textContent = t2;
      if (b2 !== undefined) el.querySelector('.t-body').textContent = b2;
      if (p2 !== undefined && el.querySelector('.bar i')) {
        el.querySelector('.bar i').style.width = `${Math.max(2, Math.min(100, p2))}%`;
      }
      if (ty === 'error') el.classList.add('error');
      if (ty === 'ok') {
        el.querySelector('.spinner')?.remove();
        el.classList.remove('error');
      }
    },
  };

  if (!sticky) setTimeout(dismiss, type === 'error' ? 6000 : 3200);
  return ctl;
}

/* ---------------- 渲染 ---------------- */

function visibleApps() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.apps;
  return state.apps.filter((a) => (
    a.label.toLowerCase().includes(q)
    || a.package.toLowerCase().includes(q)
  ));
}

function renderGrid() {
  const apps = visibleApps();
  const grid = $('grid');
  const empty = $('empty');

  const hasAny = state.apps.length > 0;
  grid.classList.toggle('hidden', apps.length === 0);
  empty.classList.toggle('hidden', apps.length > 0);

  if (!hasAny) {
    const s = state.status;
    $('emptyHint').textContent = s && s.adbOk === false
      ? 'Lần đầu dùng: mở Cài đặt ở góc trên bên phải → Bộ chạy → hoàn tất bằng một cú nhấp, rồi quay lại cài ứng dụng.'
      : 'Mẹo: mọi ứng dụng dùng chung một bộ chạy Android nên ứng dụng thứ hai khởi động gần như tức thì.';
    grid.innerHTML = '';
    return;
  }

  // 末尾放一块「Thêm ứng dụng」虚线卡片。
  // 目của不只是好看：Áp dụng少của时候下面是一Lớn片Trống白，Dùng户不知道该干什么；
  // 这块卡片把「还能拖 APK 进来」这件事直接摆在眼前，也顺手填掉了Trống白。
  grid.innerHTML = apps.map((a) => `
    <div class="card" data-pkg="${esc(a.package)}" title="${esc(a.label)} · ${esc(a.package)}">
      ${a.pinned ? '<span class="pin">★</span>' : ''}
      ${a.running ? '<span class="badge-run" title="Đang chạy"></span>' : ''}
      <div class="icon">
        ${a.iconUrl
          ? `<img src="${esc(a.iconUrl)}" alt="" draggable="false" />`
          : `<div class="fallback" style="background:${esc(a.accent || '#9aa6b2')}">${esc(initialOf(a.label))}</div>`}
      </div>
      <div class="name">${esc(a.label)}</div>
      <div class="meta">${a.running ? 'Đang chạy' : `v${esc(a.versionName)}${a.lastLaunchAt ? ' · ' + relTime(a.lastLaunchAt) : ''}`}</div>
      <div class="open-hint">${a.running ? 'Chuyển ra tiền cảnh' : 'Mở'}</div>
    </div>
  `).join('') + `
    <div class="card card-add" id="cardAdd" role="button" tabindex="0" title="Kéo thả tệp APK, hoặc bấm để chọn">
      <div class="add-plus" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round"><path d="M12 6v12"/><path d="M6 12h12"/></svg>
      </div>
      <div class="name">Thêm ứng dụng</div>
      <div class="meta">Kéo APK vào để cài</div>
    </div>
  `;
}

/* ---------------- 数据Làm mới ---------------- */

async function refreshApps() {
  try {
    state.apps = await api.listApps();
    renderGrid();
    updateStats();
  } catch (e) {
    console.error(e);
  }
}

function updateStats() {
  const n = state.apps.length;
  $('statusStats').textContent = n ? `${n}  ứng dụng` : 'Chưa có ứng dụng';
}

async function refreshStatus() {
  try {
    state.status = await api.runtimeStatus();
    const s = state.status;
    const dot = $('statusDot');
    const text = $('statusText');
    const tag = $('engineTag');

    if (!s.adbOk) {
      dot.className = 'dot err';
      text.textContent = 'Chưa triển khai bộ chạy — mở Cài đặt → Bộ chạy để hoàn tất bằng một cú nhấp';
      tag.textContent = 'Cần triển khai';
      tag.className = 'brand-tag';
    } else if (s.deviceOnline) {
      dot.className = 'dot ok';
      text.textContent = `Bộ chạy đã sẵn sàng · Android ${s.android || '?'}${s.freeform ? ' · Đã bật cửa sổ riêng' : ''}`;
      tag.textContent = `Android ${s.android || ''}`.trim();
      tag.className = 'brand-tag ok';
    } else if (s.phase === 'booting' || s.vmStarting) {
      dot.className = 'dot warn';
      text.textContent = 'Đang khởi động Android…';
      tag.textContent = 'Đang khởi động';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'accel') {
      dot.className = 'dot warn';
      // 说清「怎么修」而不是只说「没开」——这句是状态条上最容易被看到của位置
      text.textContent = 'Chưa bật tăng tốc phần cứng: đã chuyển về giả lập phần mềm (rất chậm). Bấm “Tự kiểm tra môi trường → Sửa” ở góc dưới bên phải để bật';
      tag.textContent = 'Giả lập phần mềm';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'sysimg') {
      dot.className = 'dot err';
      text.textContent = 'Thiếu ảnh hệ thống chung Android 14 — tải trong Cài đặt → Bộ chạy (khoảng 1.5GB, chỉ tải một lần)';
      tag.textContent = 'Ảnh hệ thống chờ tải';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'emulator') {
      dot.className = 'dot err';
      text.textContent = 'Chưa cài lõi bộ chạy — mở Cài đặt → Bộ chạy để hoàn tất bằng một cú nhấp';
      tag.textContent = 'Cần triển khai';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'boot') {
      dot.className = 'dot warn';
      text.textContent = 'Bộ chạy đã sẵn sàng — cài APK hoặc nhấp đúp biểu tượng màn hình nền sẽ tự khởi động';
      tag.textContent = 'Chờ khởi động';
      tag.className = 'brand-tag';
    } else if (s.installing) {
      dot.className = 'dot warn';
      text.textContent = 'Trình cài đặt đang chạy - hãy hoàn tất cài đặt trong cửa sổ máy ảo';
      tag.textContent = 'Đang cài';
      tag.className = 'brand-tag';
    } else {
      dot.className = 'dot';
      text.textContent = s.installed
        ? 'Bộ chạy đang chờ (sẽ tự bật khi cài hoặc mở ứng dụng)'
        : 'Bộ chạy chưa cài hệ thống Android — mở Cài đặt → Bộ chạy để tiếp tục';
      tag.textContent = s.installed ? 'Chờ' : 'Chờ cài đặt';
      tag.className = 'brand-tag';
    }
    $('statusDevice').textContent = s.deviceOnline ? (s.serial || '') : '';
    // 网络状态：这是Dùng户最容易踩của坑（Áp dụng里一直「网络错误」，但看不出是虚拟机没网）。
    // 直接摆在状态栏，出问题时一眼能看到，不Dùng去翻Nhật ký。
    const netEl = $('statusNet');
    const netSep = $('statusNetSep');
    if (netEl) {
      const show = !!s.deviceOnline && !!s.network;
      netEl.hidden = !show;
      if (netSep) netSep.hidden = !show;
      if (show) {
        netEl.textContent = s.network.ok ? `Mạng bình thường ${s.network.ip || ''}`.trim() : 'Máy ảo chưa có mạng';
        netEl.className = 'status-item status-net ' + (s.network.ok ? 'ok' : 'warn');
        netEl.title = s.network.ok
          ? 'Máy ảo Android đã có mạng, các ứng dụng cần mạng tải bình thường'
          : 'Máy ảo Android không có mạng, trang cần mạng sẽ trống/báo lỗi. Có thể xử lý ở “Cài đặt → Sửa mạng”';
      }
    }

    renderSetup(s);
  } catch (e) {
    $('statusText').textContent = `Kiểm tra trạng thái thất bại:${e.message}`;
  }
}

/* ---------------- Bộ chạy部署（固定在Cài đặt里） ---------------- */

/**
 * Bộ chạy/部署/自检面板Hiện都收在「Cài đặt」里，主界面只留Đã cài đặtÁp dụng。
 * 保留 showSetup 给托盘菜单与 ui:navigate 复Dùng，语义改là “Mở cài đặt并定位到Bộ chạy」。
 */
function showSetup(on) {
  if (!on) { $('setupGuide').hidden = true; return; }
  openSettings().then(() => {
    const box = $('runtimeGroup');
    if (box) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }).catch(() => {});
}

function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(2)} GB` : ''; }

function stepRow(opt) {
  const cls = ['step'];
  if (opt.done) cls.push('done');
  if (opt.busy) cls.push('busy');
  return `
    <div class="${cls.join(' ')}" data-step="${opt.key}">
      <div class="idx">${opt.done ? '✓' : opt.index}</div>
      <div class="body">
        <div class="t">${esc(opt.title)}${opt.tag ? `<span class="tag ${opt.req ? 'req' : ''}">${esc(opt.tag)}</span>` : ''}</div>
        <div class="d" data-desc>${esc(opt.desc)}</div>
        <div class="bar"><i data-bar></i></div>
      </div>
      <div class="act">${opt.actions || ''}</div>
    </div>`;
}

function renderSetup(s) {
  if (!s) return;
  const env = s.env || {};
  const hv = env.hypervisor || {};
  const accel = env.accel || s.accel || {};

  // 启动即见Đã cài đặtÁp dụng：不再Dùng部署向导整屏接管主界面，
  // 状态只在Cài đặttrongBộ chạy面板 + 底部状态条上体现。
  const accelOk = accel.ok || hv.whpx;
  const adbDone = !!(env.adb && env.adb.ok);
  const emuDone0 = !!(env.emulator && env.emulator.ok);
  const imgDone0 = !!(env.sysimg && env.sysimg.ok);
  const allDone0 = adbDone && emuDone0 && imgDone0;
  const stateText = $('setupStateText');
  if (stateText) {
    const missing = [];
    if (!adbDone) missing.push('adb');
    if (!emuDone0) missing.push('Engine');
    if (!imgDone0) missing.push('Ảnh hệ thống');
    stateText.textContent = s.deviceOnline
      ? `Đã sẵn sàng · Android ${s.android || ''}`
      : s.phase === 'booting' || s.vmStarting
        ? 'Đang khởi động Android…'
        : allDone0
          ? 'Đủ thành phần · chờ khởi động (tự bật khi mở ứng dụng)'
          : `Thiếu ${missing.join('、')}${accelOk ? '' : '(không có tăng tốc phần cứng, sẽ chuyển sang giả lập phần mềm)'}`;
    stateText.title = s.autoProfile || accel.note || hv.note || '';
  }

  const emuDone = !!(env.emulator && env.emulator.ok);
  const imgDone = !!(env.sysimg && env.sysimg.ok);
  const busy = state.setupBusy;
  const booting = s.phase === 'booting';

  // 只保留一cái步骤：下载、参数自适应、开机全部由「Hoàn tất một chạm」串起来，
  // 且首次启动会在后台Tự động跑，Dùng户不Cần逐步点击。
  const allDone = !!(env.adb && env.adb.ok) && emuDone && imgDone;
  const left = [];
  if (!(env.adb && env.adb.ok)) left.push('adb Bộ công cụ');
  if (!emuDone) left.push('Android Bộ chạy');
  if (!imgDone) left.push('Ảnh hệ thống');
  const step = {
    key: 'all',
    index: 1,
    title: allDone ? 'Mọi thứ đã sẵn sàng' : 'Hoàn tất một chạm',
    tag: allDone ? 'Đã tự hoàn tất' : 'Tự động',
    done: allDone,
    busy: !!busy,
    desc: s.deviceOnline
      ? `Android ${s.android || ''} Đã sẵn sàng · cửa sổ ứng dụng tự khớp theo màn hình`
      : booting
        ? 'Đang khởi động Android…'
        : allDone
          ? 'Đủ thành phần, bấm đúp APK bất kỳ hoặc biểu tượng màn hình nền sẽ tự khởi động'
          : `Còn thiếu ${left.join('、')}; bấm “Hoàn tất bằng một cú nhấp” bên dưới, sẽ cài xong ở nền và tự khởi động`,
    actions: s.deviceOnline
      ? '<button class="btn ghost sm" data-act="vmStop">Dừng bộ chạy</button>'
      : '',
  };

  $('setupSteps').innerHTML = stepRow(step);
  $('btnDeployAll').disabled = !!busy;
  $('btnDeployAll').textContent = busy ? 'Đang chuẩn bị…' : (allDone ? 'Đã xong · bấm để kiểm tra lại' : 'Hoàn tất một chạm');
  // 「Lần trước为什么没起来」优先显示落盘củaThất bại记录：进程重启后Bộ nhớtrong diagnosis 是Trốngcủa，
  // 只显示 autoProfile 会让Dùng户完全看不出原因（issue #20/#25 của报告就是这样）。
  const lf = s.lastFailure;
  const lastMsg = (lf && lf.diagnosis && lf.diagnosis.title)
    ? `Lần khởi động trước thất bại:${lf.diagnosis.title}`
    : (s.diagnosis ? `Chẩn đoán tự động lần khởi động trước:${s.diagnosis.title}` : '');
  $('setupNote').textContent = lastMsg
    || s.autoProfile || 'Hoàn toàn tự động: không cần chọn ảnh hệ thống, không cần bật tăng tốc, không cần chỉnh RAM';
}

function store_getDiskSize() {
  return (state.settings && state.settings.runtime && state.settings.runtime.diskSizeGB) || 24;
}

function setStepBusy(key, on) {
  state.setupBusy = on ? key : null;
  // 五步已合并成一行，所Có子步骤của进度都落在这唯一của进度条上
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (row) {
    row.classList.toggle('busy', !!on);
    if (on) {
      const bar = row.querySelector('[data-bar]');
      if (bar) bar.style.width = '3%';
    }
  }
}

function updateStepProgress(component, p) {
  if (!component) return;
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (!row) return;
  if (p.percent !== undefined) {
    const bar = row.querySelector('[data-bar]');
    if (bar) bar.style.width = `${Math.max(3, Math.min(100, p.percent))}%`;
  }
  if (p.message) {
    const d = row.querySelector('[data-desc]');
    if (d) d.textContent = p.message;
  }
}

async function deployAll() {
  if (state.setupBusy) return;
  setStepBusy('all', true);
  try {
    // 一次调Dùng把 adb / Engine / Ảnh hệ thống全装完，进度统一显示在唯一那一行
    // Dùng户点「一键部署」属于明确của手动重试，绕过Thất bại冷却
    const r = await api.autoDeploy({ force: true });
    if (!r || !r.ok) {
      toast({ title: 'Chuẩn bị thất bại', body: (r && r.error) || 'Vui lòng kiểm tra mạng rồi thử lại', type: 'error', sticky: true });
      return;
    }
    await refreshStatus();
    toast({ title: 'Thành phần đã sẵn sàng, đang tự khởi động…', body: 'Lần đầu khoảng 1-3 phút, sau đó chỉ vài giây.', type: 'info' });
    const started = await api.runtimeStart();
    await refreshStatus();
    toast(started && started.ok
      ? { title: 'Bộ chạy đã sẵn sàng', body: 'Bây giờ hãy kéo APK vào cửa sổ, hoặc bấm đúp biểu tượng trên màn hình nền.', type: 'ok' }
      : { title: 'Khởi động chưa hoàn tất', body: (started && started.error) || 'Hãy xuất báo cáo chẩn đoán để xem nguyên nhân', type: 'error', sticky: true });
  } catch (e) {
    toast({ title: 'Chuẩn bị thất bại', body: e.message, type: 'error', sticky: true });
  } finally {
    setStepBusy('all', false);
    await refreshStatus();
    selfCheck();
  }
}

async function runStep(key) {
  if (state.setupBusy) return { ok: false, error: 'Đang có tác vụ triển khai' };
  setStepBusy(key, true);
  let r;
  try {
    if (key === 'adb') r = await api.installAdb();
    else if (key === 'emulator') r = await api.installEmulator();
    else if (key === 'sysimg') r = await api.installSysimg();
    else if (key === 'accel') {
      const t = toast({
        title: 'Đang cài driver tăng tốc phần cứng…',
        body: 'Trong cửa sổ hỏi cho phép hiện ra, hãy bấm “Có”',
        sticky: true,
        spinner: true,
      });
      r = await api.enableAccel();
      if (r.ok) t.update({ title: 'Đã bật tăng tốc phần cứng', type: 'ok' });
      else t.update({ title: 'Chưa bật tăng tốc', body: r.error, type: 'error', sticky: true });
    } else if (key === 'qemu') r = await api.installQemu();
    else if (key === 'iso') r = await api.downloadIso();
    else if (key === 'disk') r = await api.createDisk(store_getDiskSize());
    else r = { ok: false, error: 'Bước không xác định' };
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  setStepBusy(key, false);
  await refreshStatus();
  return r;
}

async function startInstall() {
  const r = await api.startInstaller();
  if (!r.ok) {
    toast({ title: 'Không thể khởi động môi trường cài đặt', body: r.error, type: 'error', sticky: true });
    return;
  }
  $('setupGuide').hidden = false;
  $('setupGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast({ title: 'Cửa sổ máy ảo đã mở', body: 'Hoàn tất cài đặt theo 6 bước dưới đây; cài xong bấm “Tôi đã cài xong”.', type: 'ok', sticky: true });
}

async function markInstalled() {
  await api.markInstalled();
  await api.runtimeStop();
  $('setupGuide').hidden = true;
  await refreshStatus();
  toast({ title: 'Cài đặt hoàn tất, bộ chạy đã tiếp quản', body: 'Bây giờ có thể kéo thẳng APK vào để cài đặt.', type: 'ok' });
}



/* ---------------- Cài đặt ---------------- */

/** 把Cài đặt thất bại翻译成「下一步该做什么」，只对最常见của几种做提示，其它原样显示 */
function friendlyInstallErrorText(msg) {
  const s = String(msg || 'Lỗi không xác định');
  if (/INSUFFICIENT_STORAGE|not enough space|Không đủ dung lượng|ENOSPC/i.test(s)) {
    return `${s}\nPhân vùng dữ liệu Android không đủ: Cài đặt → Hiệu năng và tài nguyên → tăng phân vùng dữ liệu Android rồi bấm “Mở rộng ngay”.`;
  }
  if (/NO_MATCHING_ABIS/i.test(s)) return `${s}\nGói này chỉ có thư viện ARM, đang tự chuyển sang ảnh hệ thống tương thích rồi thử lại.`;
  if (/INSTALL_FAILED_ALREADY_EXISTS|signatures do not match/i.test(s)) {
    return `${s}\nCùng tên gói nhưng khác chữ ký (thường gặp khi đã cài từ nguồn khác). Chuột phải thẻ ứng dụng chọn “Gỡ cài đặt” rồi cài lại.`;
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(s)) return `${s}\nPhiên bản đã cài cao hơn, hãy gỡ trong menu chuột phải rồi cài lại.`;
  if (/ERR_FS_FILE_TOO_LARGE|greater than possible Buffer|Cannot allocate|ENOMEM|out of memory/i.test(s)) {
    return `${s}\nGói cài đặt quá lớn hoặc thiếu bộ nhớ, hệ thống từ chối phân tích. Hãy đảm bảo đủ ổ đĩa và bộ nhớ rồi thử lại;`
      + 'Nếu vẫn lỗi, hãy đổi đường dẫn gói cài sang đường dẫn ngắn chỉ có chữ Latinh (ví dụ D:\\a.apk）。';
  }
  return s;
}

/* 当前那条「Đang cài đặt…」của sticky 提示。install:error 事件要能把它收掉：
 * 主进程是先 send('install:error') 再让 invoke Thất bạicủa，两者都可能到得很晚，
 * 只靠 catch 收会出现「报错了右下角还在转圈」。 */
let installToast = null;

async function installFiles(paths) {
  if (!paths || !paths.length) return;
  if (state.installing) {
    toast({ title: 'Đã có tác vụ cài đặt đang chạy', body: 'Hãy đợi ứng dụng hiện tại cài xong rồi tiếp tục.' });
    return;
  }
  state.installing = true;
  let ok = 0;
  let failed = 0;

  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    const t = toast({ title: `Đang cài đặt ${name}`, body: 'Đang phân tích APK…', progress: 8, sticky: true, spinner: true });
    installToast = t;
    let off = () => {};
    try {
      off = api.on('install:progress', (pr) => {
        const base = { parse: 12, 'parse-done': 24, runtime: 38, install: 62, shortcut: 88, done: 100 }[pr.stage] || 50;
        const pct = pr.percent != null ? Math.min(60, Math.round((pr.percent / 100) * 60)) : base;
        t.update({ title: pr.meta ? `Đang cài đặt ${pr.meta.label}` : `Đang cài đặt ${name}`, body: pr.message, progress: pct });
      });
      const r = await api.installApk(p);
      t.update({ title: `${r.app.label} Đã cài đặt`, body: r.app.shortcutPath ? 'Đã tạo lối tắt trên màn hình nền, bấm đúp để mở trực tiếp.' : 'Có thể bấm chuột phải thẻ ứng dụng để tạo lối tắt trên màn hình nền.', progress: 100, type: 'ok' });
      t.el.querySelector('.spinner')?.remove();
      setTimeout(t.dismiss, 3600);
      if (r.warnings && r.warnings.length) {
        toast({ title: `${r.app.label} Gợi ý tương thích`, body: r.warnings.join(' '), type: 'error', sticky: false });
      }
      ok++;
    } catch (e) {
      failed++;
      // 先把那条「Đang cài đặt…」của sticky 提示收掉，否则它会一直转圈、还Tiếp tục被
      // Bộ chạyNhật kýLàm mới —— Dùng户看到của就是「Thất bại信息一直在循环」。
      // 错误提示统一由下面của install:error 监听器负责（带文件名与中文原因），
      // 这里不再重复弹一条。
      try { off(); } catch (_) { /* ignore */ }
      t.dismiss();
      if (installToast === t) installToast = null;
    } finally {
      try { off(); } catch (_) { /* ignore */ }
    }
  }

  state.installing = false;
  await refreshApps();
  if (ok && !failed) $('search').value = '';
}

/* ---------------- Áp dụng操作 ---------------- */

async function launchApp(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  state.launchPkg = pkg;
  const t = toast({
    title: `Đang mở ${app ? app.label : pkg}`,
    body: 'Lần khởi động đầu cần làm nóng bộ chạy, vui lòng đợi…',
    sticky: true,
    spinner: true,
  });
  const r = await api.launch(pkg);
  if (r.ok) {
    // Áp dụngCó自己của窗口，主界面Tự động收起；这里只留一句提示，然后隐藏窗口
    t.update({ title: 'Đã khởi động', body: 'Ứng dụng đang chạy trong cửa sổ độc lập (có thể xoay màn hình ở phía trên).', type: 'ok' });
    setTimeout(t.dismiss, 1600);
    setTimeout(() => api.winHide(), 900);
    setTimeout(refreshApps, 1200);
  } else {
    t.update({ title: 'Khởi động thất bại', body: r.error, type: 'error' });
    setTimeout(t.dismiss, 6000);
  }
}

async function createShortcut(pkg) {
  try {
    const r = await api.createShortcut(pkg);
    toast({ title: 'Đã tạo lối tắt trên màn hình nền', body: r.path, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Tạo lối tắt thất bại', body: e.message, type: 'error' });
  }
}

async function uninstall(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  if (!app) return;
  const ok = window.confirm(`Gỡ cài đặt “${app.label}」？\n\nDữ liệu ứng dụng cũng sẽ bị xóa, lối tắt trên màn hình nền cũng bị xóa.`);
  if (!ok) return;
  try {
    await api.uninstall(pkg);
    toast({ title: 'Đã gỡ cài đặt', body: app.label, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Gỡ cài đặt thất bại', body: e.message, type: 'error' });
  }
}

/* ---------------- 右键菜单 ---------------- */

const MENU_ITEMS = [
  { key: 'open', label: 'Mở ứng dụng', kbd: 'Enter' },
  // 只在Áp dụng真của在Bộ chạy才出现（见 showMenu trong过滤）。
  // 以前完全没Có这一mục，独立窗口模式下又没Có可点củaĐóng按钮，
  // Áp dụng一起来就关不掉，只能退到托盘Thoát整cái ApkStart。
  { key: 'stop', label: 'Đóng ứng dụng', onlyRunning: true },
  { key: 'shortcut', label: 'Tạo lối tắt trên màn hình nền' },
  { key: 'pin', label: 'Ghim lên đầu' },
  { key: 'keymap', label: 'Ánh xạ phím…' },
  { divider: true },
  { key: 'reveal', label: 'Mở vị trí chứa APK' },
  { key: 'clear', label: 'Xóa dữ liệu ứng dụng' },
  { divider: true },
  { key: 'uninstall', label: 'Gỡ cài đặt', danger: true },
];

function showMenu(x, y, pkg) {
  const menu = $('ctxmenu');
  state.menuPkg = pkg;
  const app = state.apps.find((a) => a.package === pkg);
  const items = MENU_ITEMS.filter((it) => !it.onlyRunning || (app && app.running));
  menu.innerHTML = items.map((it) => {
    if (it.divider) return '<div class="divider"></div>';
    const label = it.key === 'pin' ? (app && app.pinned ? 'Bỏ ghim' : 'Ghim lên đầu') : it.label;
    return `<div class="item ${it.danger ? 'danger' : ''}" data-key="${it.key}" data-act="${it.key}">
      <span>${esc(label)}</span>${it.kbd ? `<span class="k">${it.kbd}</span>` : ''}
    </div>`;
  }).join('');
  menu.classList.add('on');

  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 10)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 10)}px`;
}

function hideMenu() {
  $('ctxmenu').classList.remove('on');
  state.menuPkg = null;
}

async function handleMenu(act) {
  const pkg = state.menuPkg;
  const app = state.apps.find((a) => a.package === pkg);
  hideMenu();
  if (!app) return;
  switch (act) {
    case 'open': return launchApp(pkg);
    case 'stop': {
      try {
        const r = await api.stop(pkg);
        if (r && r.ok) {
          toast({ title: 'Đã đóng', body: app.label, type: 'ok' });
        } else {
          toast({ title: 'Đóng thất bại', body: (r && r.error) || 'Lỗi không xác định', type: 'error' });
        }
      } catch (e) {
        toast({ title: 'Đóng thất bại', body: e.message, type: 'error' });
      }
      return refreshApps();
    }
    case 'shortcut': return createShortcut(pkg);
    case 'pin': return api.pin(pkg, !app.pinned).then(refreshApps);
    case 'keymap': return showKeymapPicker(pkg, app.label);
    case 'reveal': return api.revealApk(pkg);
    case 'clear': {
      if (!window.confirm(`Xóa “${app.label}” và toàn bộ dữ liệu? Thao tác này không thể hoàn tác.`)) return;
      try {
        await api.clearData(pkg);
        toast({ title: 'Đã xóa dữ liệu', body: app.label, type: 'ok' });
      } catch (e) {
        toast({ title: 'Xóa thất bại', body: e.message, type: 'error' });
      }
      return;
    }
    case 'uninstall': return uninstall(pkg);
    default: return undefined;
  }
}

/**
 * 按键映射预设Chọn择器。Dùng confirm + prompt 做最简交互（不引入新 UI 组件）。
 * 后续可以做成更精致của弹窗编辑器。
 */
async function showKeymapPicker(pkg, label) {
  try {
    const presets = await api.keymap.getPresets();
    const current = await api.keymap.getMap(pkg);
    const hasCurrent = current && current.length > 0;
    const lines = presets.map((p, i) => `${i + 1}. ${p.label} — ${p.desc}`);
    if (hasCurrent) lines.unshift('0. Xóa ánh xạ hiện tại');
    const msg = `là “${label}” chọn cấu hình ánh xạ phím có sẵn:\n\n${lines.join('\n')}\n\nNhập số thứ tự:`;
    const input = window.prompt(msg, hasCurrent ? '0' : '1');
    if (input === null) return; // Hủy
    const idx = parseInt(input, 10);
    if (hasCurrent && idx === 0) {
      await api.keymap.setMap(pkg, []);
      toast({ title: 'Đã xóa ánh xạ phím', body: label, type: 'ok' });
      return;
    }
    const presetIdx = hasCurrent ? idx - 1 : idx;
    if (presetIdx < 1 || presetIdx > presets.length) {
      toast({ title: 'Số hiệu không hợp lệ', type: 'error' });
      return;
    }
    const chosen = presets[presetIdx - 1];
    await api.keymap.applyPreset(pkg, chosen.id);
    toast({ title: `Đã áp dụng “${chosen.label}」`, body: `${label} · Mở ứng dụng là điều khiển được bằng bàn phím`, type: 'ok' });
  } catch (e) {
    toast({ title: 'Đặt ánh xạ phím thất bại', body: e.message, type: 'error' });
  }
}

/* ---------------- Cài đặt ---------------- */

// ---------------- 安卓系统Cài đặt ----------------

let volumeTimer = null;

async function refreshAndroid() {
  const el = $('androidStatus');
  if (!el) return;
  el.textContent = 'Đang đọc…';
  const r = await api.android.status().catch(() => null);
  if (!r || !r.ok) {
    el.textContent = r && r.error ? `Bộ chạy chưa sẵn sàng (${String(r.error).slice(0, 36)}）` : 'Bộ chạy chưa khởi động';
    return;
  }
  el.textContent = `Android ${r.sdk || '?'} · ${r.wifi ? 'Wi-Fi Đã bật' : 'Wi-Fi Đã tắt'}` +
    `${r.airplane ? ' · Chế độ máy bay' : ''} · Âm lượng ${r.volume}%`;
  $('setAndroidWifi').checked = !!r.wifi;
  $('setAndroidAirplane').checked = !!r.airplane;
  $('setAndroidAnim').checked = !r.animationsOff;
  $('setAndroidVolume').value = r.volume;
  $('androidVolumeText').textContent = `${r.volume}%`;
  if (r.fontScale) $('setAndroidFont').value = Number(r.fontScale).toFixed(2);
  if (r.density) {
    const opt = [...$('setAndroidDensity').options].find((o) => o.value === String(r.density));
    if (opt) $('setAndroidDensity').value = String(r.density);
  }
}

function bindAndroid() {
  const set = async (key, value, msg) => {
    const r = await api.android.set(key, value).catch(() => null);
    toast({
      type: r && r.ok ? 'ok' : 'error',
      title: r && r.ok ? (msg || 'Đã có hiệu lực') : `Thất bại:${(r && r.error) || 'Bộ chạy chưa sẵn sàng'}`,
    });
    if (r && r.ok) refreshAndroid();
  };
  $('setAndroidWifi').addEventListener('change', (e) => set('wifi', e.target.checked, e.target.checked ? 'Wi-Fi Đã bật' : 'Wi-Fi Đã đóng'));
  $('setAndroidAirplane').addEventListener('change', (e) => set('airplane', e.target.checked, e.target.checked ? 'Đã vào chế độ máy bay' : 'Đã thoát chế độ máy bay'));
  $('setAndroidAnim').addEventListener('change', (e) => set('animations', e.target.checked, e.target.checked ? 'Đã bật hoạt ảnh hệ thống' : 'Đã tắt hoạt ảnh hệ thống, giao diện nhanh hơn'));
  $('setAndroidFont').addEventListener('change', (e) => set('fontScale', Number(e.target.value), 'Đã chỉnh cỡ chữ'));
  $('setAndroidDensity').addEventListener('change', (e) => set('density', Number(e.target.value), 'Đã điều chỉnh kích thước hiển thị'));
  $('setAndroidVolume').addEventListener('input', (e) => {
    $('androidVolumeText').textContent = `${e.target.value}%`;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => set('volume', Number(e.target.value), 'Đã chỉnh âm lượng'), 260);
  });
  $('btnAndroidRefresh').addEventListener('click', () => refreshAndroid());
  $('btnAndroidTune').addEventListener('click', async () => {
    const r = await api.android.tune(state.launchPkg || '').catch(() => null);
    toast({ type: r && r.ok ? 'ok' : 'error', title: r && r.ok ? 'Đã tối ưu: tắt hiệu ứng, nới lỏng nền, danh sách trắng pin' : 'Tối ưu thất bại, bộ chạy có thể chưa khởi động' });
    if (r && r.ok) refreshAndroid();
  });
  const open = async (action) => {
    const r = await api.android.open(action).catch(() => null);
    if (!r || !r.ok) {
      toast({ type: 'error', title: 'Cần mở ứng dụng một lần để bộ chạy khởi động' });
    }
  };
  $('btnAndroidSettings').addEventListener('click', () => open('settings'));
  $('btnAndroidDisplay').addEventListener('click', () => open('display'));
  $('btnAndroidSound').addEventListener('click', () => open('sound'));
  $('btnAndroidLocale').addEventListener('click', () => open('locale'));
  $('btnAndroidApps').addEventListener('click', () => open('apps'));
}

/** Cài đặt页字段同步：Chỉ còn自带Bộ chạy，所Có资源mục都露出来，不Rồi nhấn底座切换 */
function syncBackendFields() {
  const perf = $('perfGroup');
  if (perf) perf.hidden = false;
  refreshResources();
}

/** Máy này资源上限 + 当前分配（Cài đặt页里那几行灰字） */
async function refreshResources() {
  const bNote = $('builtinResNote');
  if (!bNote) return;
  const gb = (mb) => (Number(mb) > 0 ? `${Math.round(Number(mb) / 1024)} GB` : 'Không rõ');
  const r = await api.resources().catch(() => null);
  if (!r || r.ok === false) {
    bNote.textContent = (r && (r.note || r.error)) || 'Tạm thời chưa đọc được thông tin phân bổ tài nguyên';
    return;
  }
  const host = r.host || {};
  const lim = r.limits || {};
  const free = Number(r.freeMB) || Number((r.current && r.current.freeMB) || 0);
  bNote.textContent = `Máy này ${gb(host.totalMB)} Bộ nhớ / ${host.cores} nhân;`
    + `Bộ nhớ tối đa có thể chia ${gb(lim.maxMB)}, nhân tối đa ${Math.max(1, (host.cores || 1) - 1)}  (chừa 1/4 bộ nhớ và 1 nhân cho Windows).`
    + `Giới hạn phân vùng dữ liệu ${lim.maxGB || 0} GB${free ? `(ổ đĩa chứa còn trống ${(free / 1024).toFixed(1)} GB）` : ''}。`
    + (r.verdict && r.verdict.note ? ` ${r.verdict.note}` : '');
}

/** Máy nàyKiểm tra sức khỏe：渲染报告（每条带等级点和可执行动作） */
function renderPreflight(res) {
  const list = $('preflightList');
  const sum = $('preflightSummary');
  const applyBtn = $('btnPreflightApply');
  if (!list) return;
  list.textContent = '';
  if (!res || !res.report) {
    if (sum) sum.textContent = (res && res.error) || 'Kiểm tra không trả về kết quả, vui lòng thử lại';
    return;
  }
  const { report, edition } = res;
  for (const it of report.items) {
    const item = document.createElement('div');
    item.className = 'pf-item';
    const head = document.createElement('div');
    head.className = 'pf-head';
    const dot = document.createElement('span');
    dot.className = `pf-dot ${it.level}`;
    const title = document.createElement('span');
    title.className = 'pf-title';
    title.textContent = it.title;
    head.append(dot, title);
    item.append(head);
    if (it.detail) {
      const d = document.createElement('div');
      d.className = 'pf-detail';
      d.textContent = it.detail;
      item.append(d);
    }
    if (it.action && it.action.kind === 'elevate') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action';
      const btn = document.createElement('button');
      btn.className = 'btn ghost sm';
      btn.textContent = it.action.label;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = 'Đang xử lý…';
        let r = null;
        if (it.action.id === 'accel') r = await api.enableAccel().catch(() => null);
        else r = await api.enableVirtualization().catch(() => null);
        btn.disabled = false;
        btn.textContent = old;
        if (!r) { toast({ type: 'error', title: 'Thao tác chưa hoàn tất', body: 'Có thể thử lại sau, hoặc làm thủ công theo hướng dẫn' }); return; }
        if (r.cancelled) toast({ type: 'warn', title: 'Đã hủy', body: 'Không thay đổi cài đặt hệ thống' });
        else if (r.ok || r.already) {
          const reboot = r.restartNeeded === true;
          toast({
            type: 'ok',
            title: r.already ? 'Tăng tốc phần cứng đã dùng được' : (reboot ? 'Đã gửi yêu cầu, cần khởi động lại' : 'Đã có hiệu lực'),
            body: r.already ? '' : (reboot ? 'Sau khi khởi động lại máy, tăng tốc phần cứng mới có hiệu lực; quay lại bấm “Bắt đầu kiểm tra” để xác nhận' : 'Có thể bấm “Bắt đầu kiểm tra” để xác nhận kết quả'),
          });
          if (r.already || !reboot) setTimeout(() => runPreflight().catch(() => {}), 1200);
        } else {
          toast({ type: 'error', title: 'Không tự hoàn thành được', body: (r.error || r.note || 'Hãy thao tác thủ công theo hướng dẫn') });
        }
      });
      wrap.append(btn);
      item.append(wrap);
    } else if (it.action && it.action.kind === 'manual') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action pf-detail';
      wrap.textContent = `⚠ ${it.action.label}`;
      item.append(wrap);
    }
    list.append(item);
  }
  const rec = report.recommended || {};
  if (sum) {
    sum.textContent = `${report.summary}. Cấu hình khuyến nghị:${Math.round((rec.memoryMB || 0) / 1024)} GB Bộ nhớ / `
      + `${rec.cores || 2} nhân / ${rec.renderSize || 'auto'} · Kết xuất ${rec.gpuMode || 'auto'}`
      + (edition === 'store' ? '(bản Store: chức năng hệ thống chỉ bật thủ công được trong “Windows Features”)' : '');
  }
  if (applyBtn) applyBtn.hidden = false;
}

async function runPreflight() {
  const btn = $('btnPreflight');
  const sum = $('preflightSummary');
  if (!btn) return null;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Đang kiểm tra…';
  if (sum) sum.textContent = 'Đang kiểm tra ảo hóa, card đồ họa, RAM… (lần đầu khoảng 2~3 giây)';
  let r = null;
  try {
    r = await api.preflightRun();
  } catch (e) {
    r = { error: e.message || 'Kiểm tra thất bại' };
  }
  btn.disabled = false;
  btn.textContent = old;
  renderPreflight(r);
  return r;
}

/** Trình điều khiển（Bản vá tương thích）：渲染清单 + 命中状态 */
function renderDrivers(r) {
  const list = $('drvList');
  const sum = $('drvSummary');
  if (!list) return;
  const host = (r && r.host) || {};
  const drivers = (r && r.drivers) || [];
  const errors = (r && r.errors) || [];
  const onCount = drivers.filter((d) => d.enabled && d.matched).length;
  if (sum) {
    const accel = host.accel === 'none' ? 'Không có tăng tốc phần cứng' : (host.accel || 'Không rõ');
    sum.textContent = `Máy này:${host.platform || ''}/${host.arch || ''} · ${host.gpuVendor || 'Không rõ'} Card đồ họa · ${accel}`
      + ` · emulator ${host.emulatorVersion || 'Không rõ'}; trình điều khiển ${drivers.length}  mục, đã có hiệu lực trên máy này ${onCount}  mục.`
      + (errors.length ? ` ${errors.length}  tệp tải thất bại (xem bên dưới).` : '');
  }
  list.textContent = '';
  for (const d of drivers) {
    const item = document.createElement('div');
    item.className = d.enabled ? 'drv-item on' : 'drv-item';

    const head = document.createElement('div');
    head.className = 'drv-head';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!d.enabled;
    cb.addEventListener('change', async () => {
      const res = await api.driversSetEnabled(d.id, cb.checked).catch(() => null);
      if (res && res.ok && res.overview) renderDrivers(res.overview);
      else { cb.checked = !cb.checked; toast({ type: 'error', title: 'Lưu thất bại', body: (res && res.error) || 'Vui lòng thử lại sau' }); }
    });
    const name = document.createElement('span');
    name.className = 'drv-name';
    name.textContent = d.name;
    head.append(cb, name);

    if (d.matched && d.enabled) {
      const b = document.createElement('span');
      b.className = 'drv-badge hit';
      b.textContent = 'Đã có hiệu lực';
      head.append(b);
    }
    if (d.builtin) {
      const b = document.createElement('span');
      b.className = 'drv-badge';
      b.textContent = 'Mẫu tích hợp sẵn';
      head.append(b);
    }
    item.append(head);

    const meta = document.createElement('div');
    meta.className = 'drv-meta';
    meta.textContent = `v${d.version || '?'}`
      + (d.author ? ` · ${d.author}` : '')
      + ` · priority ${d.priority}`
      + (d.hits && d.hits.length ? ` · Khớp:${d.hits.join(' / ')}` : ' · Không khớp với máy này');
    item.append(meta);

    if (d.description) {
      const desc = document.createElement('div');
      desc.className = 'drv-meta';
      desc.textContent = d.description;
      item.append(desc);
    }
    list.append(item);
  }
  for (const e of errors) {
    const err = document.createElement('div');
    err.className = 'drv-err';
    err.textContent = `${String(e.file || '').split(/[\\/]/).pop()}：${(e.errors || []).join('；')}`;
    list.append(err);
  }
  if (!drivers.length && !errors.length) {
    const empty = document.createElement('div');
    empty.className = 'drv-meta';
    empty.textContent = 'Chưa có trình điều khiển nào. Có thể bấm “Xuất mẫu máy này” để tạo một cái, hoặc nhập JSON do người khác làm.';
    list.append(empty);
  }
}

async function refreshDrivers() {
  if (!$('drvList')) return;
  const r = await api.driversList().catch(() => null);
  if (!r) {
    if ($('drvSummary')) $('drvSummary').textContent = 'Không đọc được danh sách trình điều khiển (có thể bộ chạy chưa được triển khai)';
    return;
  }
  renderDrivers(r);
}

function fillSettings(s) {
  syncBackendFields();
  refreshDrivers().catch(() => {});
  $('setAdbPath').value = s.adbPath || '';
  $('setSystemImage').value = s.runtime.isoPath || '';
  $('setMemory').value = s.engine.memoryMB;
  $('setCores').value = s.engine.cores;
  $('setIdle').value = s.engine.idleShutdownMinutes;
  if ($('setSourcePref')) $('setSourcePref').value = (s.runtime && s.runtime.sourcePreference) || 'auto';
  if ($('setAutoMirror')) $('setAutoMirror').checked = (s.runtime && s.runtime.autoMirror) !== false;
  if ($('setGiteeToken')) $('setGiteeToken').value = (s.runtime && s.runtime.giteeToken) || '';
  if ($('setMirrorPrefix')) $('setMirrorPrefix').value = (s.runtime && s.runtime.mirrorPrefix) || '';
  if ($('setConnections')) $('setConnections').value = Number((s.runtime && s.runtime.downloadConnections) || 8);
  $('setAudio').checked = s.engine.audio !== false;
  $('setLiteMode').checked = s.engine.liteMode !== false;
  $('setPrewarm').checked = s.engine.prewarm !== false;
  $('setPriorityMode').value = ['performance', 'game'].includes(s.engine.priorityMode)
    ? s.engine.priorityMode : 'balanced';
  $('setDeepTrim').checked = !!s.engine.deepTrim;
  $('setMouseRightBack').checked = s.engine.mouseRightBack !== false;
  $('setMouseWheelMode').value = ['smooth', 'native', 'off'].includes(s.engine.mouseWheelMode)
    ? s.engine.mouseWheelMode : 'smooth';
  $('setMouseSideButtons').checked = !!s.engine.mouseSideButtons;
  if ($('setKeymapEnabled')) $('setKeymapEnabled').checked = s.engine.keymapEnabled !== false;
  $('setCompat').checked = !!(s.runtime && s.runtime.compatImage);
  $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
  $('setStartMenuShortcut').checked = s.createStartMenuShortcut !== false;
  $('setShortcutDir').value = s.shortcutDir || '';
  $('setSharedDir').value = s.sharedDir || '';
  $('setDeviceSharedDir').value = s.deviceSharedDir || '';
  const d = s.display || {};
  $('setAutoStart').checked = s.autoStart !== false;
  const eng = s.engine || {};
  if ($('setResourceMode')) $('setResourceMode').value = eng.resourceMode || 'balanced';
  if ($('setRenderSize')) $('setRenderSize').value = eng.renderSize || 'auto';
  if ($('setDataGB')) $('setDataGB').value = String(Number(eng.dataPartitionGB || 0));
  if ($('setFastDns')) $('setFastDns').checked = eng.fastDns !== false;
  if ($('setLocale')) $('setLocale').value = eng.locale || 'zh-CN';
  if ($('setChineseIme')) $('setChineseIme').checked = eng.chineseIme !== false;
  if ($('setKeepSnapshot')) $('setKeepSnapshot').checked = eng.keepSnapshot !== false;
  $('setDisplayMode').value = d.mode === 'fullscreen' ? 'fullscreen' : 'window';
  if ($('setAutoFullscreen')) $('setAutoFullscreen').value = d.autoFullscreenOnLaunch === true ? 'on' : 'off';
  if ($('setLandscape')) $('setLandscape').value = d.landscape === true ? 'landscape' : 'portrait';
  if ($('setOrientationMode')) $('setOrientationMode').value = d.orientationMode || 'auto';
  if ($('setTabletMode')) $('setTabletMode').value = d.tabletMode === false ? 'off' : 'on';
  $('setPortrait').value = d.portrait || '900x1600';
  if ($('setWindowEmbed')) $('setWindowEmbed').value = d.windowEmbed === false ? 'detached' : 'embed';
  $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
}

/** 数据Phân vùng实际LớnNhỏ + 磁盘余量，显示在Cài đặt页容量Chọn择下方 */
async function refreshDataInfo() {
  const el = $('dataNote');
  if (!el) return;
  const info = await api.dataInfo().catch(() => null);
  if (!info) { el.textContent = 'Đọc thông tin phân vùng dữ liệu thất bại'; return; }
  const auto = Number(($('setDataGB') || {}).value || 0) === 0;
  // Có quickboot 差量盘时底座镜像củaLớnNhỏ不等于 guest 看到của容量（实测 8GB 镜像、guest 5.7GB），
  // 与其显示一cái会误导人số，不如明确说「以Bộ chạy为准」。
  const img = info.overlay
    ? 'Đĩa chênh lệch khởi động nhanh (dung lượng thực tế theo /data của bộ chạy)'
    : (info.fsGB ? `Hệ thống tệp thực tế ${info.fsGB} GB` : (info.imageGB ? `${info.imageGB} GB` : 'Chưa tạo'));
  const free = info.freeDiskMB ? `${(info.freeDiskMB / 1024).toFixed(1)} GB` : 'Không rõ';
  const pending = Number(info.pendingGB) > 0
    ? ` Mục tiêu ${info.configuredGB} GB Chưa có hiệu lực: Android đang dùng ổ chênh lệch khởi động nhanh, cần “Đặt lại dữ liệu Android” để dựng lại theo dung lượng mới (sẽ xóa các ứng dụng đã cài).`
    : '';
  el.textContent = `Phân vùng dữ liệu hiện tại:${img}${auto ? '(tự động)' : ''} · Ổ đĩa chứa còn trống ${free}。${pending}`
    + 'Nếu game báo “Không đủ dung lượng lưu trữ”, hãy tăng giá trị này rồi bấm “Mở rộng ngay”; khi mở rộng tại chỗ được thì không mất ứng dụng đã cài.';
}

async function openSettings() {
  state.settings = await api.getSettings();
  fillSettings(state.settings);
  const info = await api.info();
  $('setRuntimeDir').value = info.runtimeDir || info.dataDir;
  if ($('setAvdDir')) {
    const di = await api.dataInfo().catch(() => null);
    $('setAvdDir').value = (di && di.avdDir) || '';
  }
  const verEl = document.getElementById('aboutVer');
  if (verEl && info.version) verEl.textContent = `v${info.version}`;
  const curVerEl = document.getElementById('updateCurrent');
  if (curVerEl && info.version) curVerEl.textContent = `v${info.version}`;
  const assoc = await api.assocStatus();
  const btn = $('btnAssoc');
  btn.textContent = assoc.registered ? 'Đã liên kết · bấm để hủy' : 'Chưa liên kết · bấm để bật';
  btn.dataset.on = assoc.registered ? '1' : '0';

  api.doctorProfile().then((r) => {
    if (r && r.text) $('autoProfileText').textContent = r.text;
  }).catch(() => { $('autoProfileText').textContent = 'Chế độ tự động'; });
  api.runtimeUsage().then((u) => {
    $('usageText').textContent = u
      ? `Tổng ${u.totalText}${u.reclaimable ? ` · Có thể thu hồi ${u.reclaimableText}（${u.count} mục)` : ' · Đã ở trạng thái gọn nhất'}`
      : 'Không có số liệu thống kê';
  }).catch(() => { $('usageText').textContent = 'Không có số liệu thống kê'; });

  $('settingsMask').classList.add('on');
  refreshAndroid();
  refreshDataInfo();
}

function closeSettings() {
  $('settingsMask').classList.remove('on');
}

/* ---------------- Cập nhật phần mềm ---------------- */

let lastUpdate = null;

/** 把一次检查结果画到Cài đặt面板（也Dùng于启动时静默检查推送过来của状态） */
function renderUpdate(info) {
  lastUpdate = info || null;
  const cur = $('updateCurrent');
  const st = $('updateState');
  const btn = $('btnDoUpdate');
  const bar = $('updateBar');
  if (!cur || !st || !btn) return;
  if (!info) return;
  if (info.current) cur.textContent = `v${info.current}`;

  if (info.ok === false) {
    st.textContent = `Kiểm tra thất bại:${info.error || 'Không có mạng'}`;
    // 检查Thất bại也要给一条出路：直接把发布页Mở，Dùng户至少能手动下载。
    // 以前这里是「什么都不显示」，Dùng户只会觉得「更新功能坏了」。
    showUpdateBtn(true);
    btn.textContent = 'Mở trang tải';
    btn.dataset.mode = 'manual';
    lastUpdate = { htmlUrl: info.htmlUrl || '' };
    if (bar) bar.hidden = true;
    return;
  }
  if (info.hasUpdate) {
    // 如实说明这次是哪cái源给出của版本、另一cái源为什么没参与 ——
    // Dùng户排查「为什么Kiểm tra cập nhật很慢」时，这一行比任何Nhật ký都直接。
    const src = (info.sources || []).map((x) => `${x.name} ${x.tag || ''}`.trim()).join(' / ');
    const bad = (info.unreachable || []).map((x) => x.name).join('、');
    const stale = info.stale ? '(bộ nhớ đệm ngoại tuyến, có thể không phải mới nhất)' : '';
    st.textContent = `Có phiên bản mới ${info.tag}${src ? `（${src}）` : ''}${bad ? `；${bad} Không truy cập được` : ''}${stale}`;
    showUpdateBtn(true);
    btn.textContent = info.asset ? 'Cập nhật ngay' : 'Mở trang tải';
    btn.dataset.mode = info.asset ? 'auto' : 'manual';
    const note = $('updateNote');
    if (note && info.notes) {
      const brief = String(info.notes).split('\n').slice(0, 8).join('\n').trim();
      if (brief) note.textContent = `Nội dung cập nhật:\n${brief}`;
    }
    if (bar) bar.hidden = true;
  } else {
    const src = (info.sources || []).map((x) => x.name).join(' / ');
    const stale = info.stale ? '(bộ nhớ đệm ngoại tuyến)' : '';
    st.textContent = `Đã là phiên bản mới nhất (v${info.current}）${src ? ` · Qua ${src}` : ''}${stale}`;
    showUpdateBtn(false);
    if (bar) bar.hidden = true;
  }
}

/** .btn 自带 display:inline-flex，会盖掉 hidden 属性，所以这里直接改 display */
function showUpdateBtn(on) {
  const btn = $('btnDoUpdate');
  if (!btn) return;
  btn.hidden = !on;
  btn.style.display = on ? '' : 'none';
}

function renderUpdateProgress(p) {
  if (!p) return;
  const st = $('updateState');
  const bar = $('updateBar');
  const fill = $('updateBarFill');
  if (p.stage === 'error') {
    if (st) st.textContent = `Cập nhật thất bại:${p.message || ''}`;
    if (bar) bar.hidden = true;
    toast({ title: 'Cập nhật thất bại', body: p.message || '', type: 'error' });
    return;
  }
  if (st) st.textContent = p.message || 'Đang cập nhật…';
  if (bar && fill) {
    bar.hidden = false;
    fill.style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
  }
}

function bindUpdate() {
  const check = $('btnCheckUpdate');
  const go = $('btnDoUpdate');
  if (!check || !go) return;

  const runCheck = async (silent) => {
    if (!silent) {
      check.disabled = true;
      const old = check.textContent;
      check.textContent = 'Đang kiểm tra…';
      $('updateState').textContent = 'Đang kết nối GitHub…';
      try {
        const info = await api.updateCheck();
        renderUpdate(info);
        if (info && info.hasUpdate) toast({ title: `Có phiên bản mới ${info.tag}`, body: 'Bấm “Cập nhật ngay” để tự tải và cài đặt', type: 'info' });
        else if (info && info.ok !== false) toast({ title: 'Đã là phiên bản mới nhất', body: `v${info.current}`, type: 'ok' });
      } catch (e) {
        $('updateState').textContent = `Kiểm tra thất bại:${e.message}`;
      } finally {
        check.disabled = false;
        check.textContent = old;
      }
      return;
    }
    const info = await api.updateCheck().catch(() => null);
    if (info) renderUpdate(info);
  };

  check.addEventListener('click', () => runCheck(false));

  go.addEventListener('click', async () => {
    if (go.dataset.mode === 'manual') {
      api.updateOpenRelease(lastUpdate && lastUpdate.htmlUrl);
      return;
    }
    go.disabled = true;
    go.textContent = 'Đang cập nhật…';
    const r = await api.updateApply().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) {
      go.disabled = false;
      go.textContent = 'Cập nhật ngay';
      if (r && r.error && !r.manual) {
        $('updateState').textContent = `Cập nhật thất bại:${r.error}`;
        toast({ title: 'Cập nhật thất bại', body: r.error, type: 'error' });
      }
    } else {
      $('updateState').textContent = `Đã tải xuống v${r.version}, đang khởi động lại để hoàn tất cài đặt…`;
    }
  });

  // Mở cài đặt时如果还没结果，就顺手查一次（放后台，不打扰）
  runCheck(true).catch(() => {});
}

function bindSettings() {
  const save = async (patch) => {
    state.settings = await api.setSettings(patch);
  };

  if ($('btnPreflight')) $('btnPreflight').addEventListener('click', () => runPreflight());
  if ($('btnPreflightApply')) {
    $('btnPreflightApply').addEventListener('click', async () => {
      const btn = $('btnPreflightApply');
      btn.disabled = true;
      const r = await api.preflightApply().catch(() => null);
      btn.disabled = false;
      if (!r || !r.ok) {
        toast({ type: 'error', title: 'Áp dụng thất bại', body: (r && r.error) || 'Vui lòng thử lại sau' });
        return;
      }
      state.settings = r.settings;
      toast({
        type: 'ok',
        title: 'Đã cấu hình theo máy này',
        body: `Bộ nhớ ${Math.round((r.recommended.memoryMB || 0) / 1024)} GB / ${r.recommended.cores} nhân / ${r.recommended.renderSize}`
          + (r.driverFile ? '; đã tạo trình điều khiển, lần khởi động sau sẽ tự áp dụng' : ''),
      });
      if (r.driverError) toast({ type: 'warn', title: 'Ghi trình điều khiển không thành công', body: r.driverError });
      fillSettings(r.settings);
      refreshStatus();
    });
  }
  if ($('btnDrvReload')) $('btnDrvReload').addEventListener('click', () => refreshDrivers());
  if ($('btnDrvFolder')) {
    $('btnDrvFolder').addEventListener('click', async () => {
      const r = await api.driversOpenFolder().catch(() => null);
      if (!r || !r.ok) toast({ type: 'error', title: 'Không mở được thư mục trình điều khiển' });
    });
  }
  if ($('btnDrvImport')) {
    $('btnDrvImport').addEventListener('click', async () => {
      const r = await api.driversImport().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) {
        toast({ type: 'error', title: 'Nhập thất bại', body: (r.errors || []).slice(0, 3).join('；') });
        return;
      }
      toast({ type: 'ok', title: 'Đã nhập và bật trình điều khiển', body: `${r.driver.name} v${r.driver.version}` });
      if (r.overview) renderDrivers(r.overview);
    });
  }
  if ($('btnDrvExport')) {
    $('btnDrvExport').addEventListener('click', async () => {
      const r = await api.driversExportTemplate().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) { toast({ type: 'error', title: 'Xuất thất bại' }); return; }
      toast({ type: 'ok', title: 'Đã xuất mẫu', body: 'Sửa xong effect, đặt vào thư mục trình điều khiển rồi bấm “Làm mới” là có hiệu lực' });
      refreshDrivers();
    });
  }

  $('setAdbPath').addEventListener('change', (e) => save({ adbPath: e.target.value.trim() }));
  $('setSystemImage').addEventListener('change', (e) => save({ runtime: { isoPath: e.target.value.trim() } }));
  // Bộ nhớ / nhân心：填了具体值就关掉「Tự động」，填 0 又回到Tự động。
  // 旧代码只写 memoryMB，而 overridesFromSettings 只在 autoMemory=false 时才认它，
  // 于是「手动填了Bộ nhớ」一直被忽略 —— 这是Cài đặt页最容易被当成“没Dùng”của一mục。
  $('setMemory').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { memoryMB: v, autoMemory: false } } : { engine: { memoryMB: 0, autoMemory: true } });
  });
  $('setCores').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { cores: v, autoMemory: false } } : { engine: { cores: 0, autoMemory: true } });
  });
  if ($('setResourceMode')) {
    $('setResourceMode').addEventListener('change', async (e) => {
      // Chính sách tài nguyên会连带改 liteMode / priorityMode / renderSize（主进程里翻译）
      state.settings = await api.setSettings({ engine: { resourceMode: e.target.value } });
      fillSettings(state.settings);
      toast({ title: 'Đã chuyển chính sách tài nguyên', body: 'Có hiệu lực ở lần mở ứng dụng tiếp theo', type: 'ok' });
    });
  }
  if ($('setRenderSize')) {
    $('setRenderSize').addEventListener('change', (e) => save({ engine: { renderSize: e.target.value } }));
  }
  if ($('setFastDns')) {
    $('setFastDns').addEventListener('change', (e) => save({ engine: { fastDns: e.target.checked } }));
  }
  if ($('setLocale')) {
    $('setLocale').addEventListener('change', async (e) => {
      state.settings = await api.setSettings({ engine: { locale: e.target.value } });
      toast({ title: 'Đã cập nhật ngôn ngữ hệ thống', body: 'Có hiệu lực sau lần khởi động lại bộ chạy Android tiếp theo', type: 'ok' });
    });
  }
  if ($('setChineseIme')) {
    $('setChineseIme').addEventListener('change', async (e) => {
      state.settings = await api.setSettings({ engine: { chineseIme: e.target.checked } });
      toast({
        title: e.target.checked ? 'Đã bật bộ gõ tiếng Trung' : 'Đã tắt bộ gõ tiếng Trung',
        body: 'Có hiệu lực sau lần khởi động lại bộ chạy Android tiếp theo',
        type: 'ok',
      });
    });
  }
  if ($('setKeepSnapshot')) {
    $('setKeepSnapshot').addEventListener('change', (e) => save({ engine: { keepSnapshot: e.target.checked } }));
  }
  if ($('setDataGB')) {
    $('setDataGB').addEventListener('change', (e) => {
      save({ engine: { dataPartitionGB: Number(e.target.value) || 0 } });
      refreshDataInfo();
    });
  }
  if ($('btnGrowData')) {
    $('btnGrowData').addEventListener('click', async () => {
      const gb = Number($('setDataGB').value) || 0;
      if (!gb) { toast({ title: 'Hãy chọn một dung lượng trước', body: '“Tự động” nghĩa là phần mềm quyết định theo dung lượng đĩa còn trống, không cần mở rộng', type: 'info' }); return; }
      const { response } = await api.confirm({
        title: 'Mở rộng phân vùng dữ liệu Android ngay?',
        message: `Sẽ điều chỉnh /data thành ${gb} GB(mở rộng tại chỗ, ứng dụng đã cài và dữ liệu lưu đều được giữ).`,
        detail: 'Mở rộng cần tắt các ứng dụng Android đang chạy trước; xong lần mở ứng dụng tới sẽ khởi động lại, lâu hơn khoảng chục giây.',
        okLabel: 'Bắt đầu mở rộng',
      });
      if (response !== 1) return;
      $('btnGrowData').disabled = true;
      const old = $('btnGrowData').textContent;
      $('btnGrowData').textContent = 'Đang mở rộng…';
      const r = await api.setDataSize(gb).catch((e) => ({ ok: false, error: e.message }));
      $('btnGrowData').disabled = false;
      $('btnGrowData').textContent = old;
      if (r && !r.ok && r.needsReset) {
        // 快速启动của差量盘挡着：就地扩容做不到，只能按新容量重建 /data。
        // 这是明确của数据丢失操作，必须单独Xác nhận lại lần nữa。
        const again = await api.confirm({
          title: 'Cần đặt lại dữ liệu Android mới mở rộng được dung lượng',
          message: `Android đang dùng đĩa chênh lệch khởi động nhanh nên không thể mở rộng tại chỗ. Để có được ${gb} GB dung lượng, buộc phải tạo lại /data theo dung lượng mới.`,
          detail: 'Dựng lại sẽ xóa các ứng dụng đã cài và dữ liệu lưu (trình giả lập và ảnh hệ thống không bị ảnh hưởng). Tiếp tục?',
          okLabel: 'Xóa sạch và tạo lại',
        });
        if (again.response !== 1) { refreshDataInfo(); return; }
        $('btnGrowData').disabled = true;
        $('btnGrowData').textContent = 'Đang dựng lại…';
        const rr = await api.resetAndResize(gb).catch((e) => ({ ok: false, error: e.message }));
        $('btnGrowData').disabled = false;
        $('btnGrowData').textContent = old;
        toast({
          type: rr && rr.ok ? 'ok' : 'error',
          title: rr && rr.ok ? 'Đã dựng lại theo dung lượng mới' : 'Dựng lại thất bại',
          body: rr && rr.ok
            ? `Lần mở ứng dụng sau sẽ theo ${gb} GB Dựng lại /data (lần vào đầu tiên sẽ chờ thêm vài chục giây)`
            : (rr && rr.error) || 'Lỗi không xác định',
        });
        refreshDataInfo();
        return;
      }
      toast({
        type: r && r.ok ? 'ok' : 'error',
        title: r && r.ok ? 'Đã mở rộng phân vùng dữ liệu' : 'Mở rộng thất bại',
        body: r && r.ok ? `Hiện khoảng ${r.fsGB || r.imageGB || gb} GB Khả dụng` : (r && r.error) || 'Lỗi không xác định',
      });
      refreshDataInfo();
    });
  }
  $('setIdle').addEventListener('change', (e) => save({ engine: { idleShutdownMinutes: Number(e.target.value) || 0 } }));
  if ($('setSourcePref')) {
    $('setSourcePref').addEventListener('change', (e) => save({ runtime: { sourcePreference: e.target.value } }));
  }
  if ($('setAutoMirror')) {
    $('setAutoMirror').addEventListener('change', (e) => save({ runtime: { autoMirror: e.target.checked } }));
  }
  if ($('setGiteeToken')) {
    $('setGiteeToken').addEventListener('change', (e) => save({ runtime: { giteeToken: e.target.value.trim() } }));
  }
  if ($('setMirrorPrefix')) {
    $('setMirrorPrefix').addEventListener('change', (e) => save({ runtime: { mirrorPrefix: e.target.value.trim() } }));
  }
  if ($('setConnections')) {
    $('setConnections').addEventListener('change', (e) => {
      const n = Math.max(1, Math.min(16, Number(e.target.value) || 8));
      e.target.value = n;
      save({ runtime: { downloadConnections: n } });
    });
  }
  $('setAudio').addEventListener('change', (e) => save({ engine: { audio: e.target.checked } }));
  $('setLiteMode').addEventListener('change', (e) => save({ engine: { liteMode: e.target.checked } }));
  $('setPrewarm').addEventListener('change', (e) => save({ engine: { prewarm: e.target.checked } }));
  $('setPriorityMode').addEventListener('change', (e) => save({ engine: { priorityMode: e.target.value } }));
  const savePointer = async (patch) => {
    await save({ engine: patch });
    // 立刻按当前窗口焦点重装/Gỡ cài đặt钩子，不Dùng等下次切窗口
    api.refreshPointerMapping().catch(() => {});
  };
  $('setMouseRightBack').addEventListener('change', (e) => savePointer({ mouseRightBack: e.target.checked }));
  $('setMouseWheelMode').addEventListener('change', (e) => savePointer({ mouseWheelMode: e.target.value }));
  $('setMouseSideButtons').addEventListener('change', (e) => savePointer({ mouseSideButtons: e.target.checked }));
  if ($('setKeymapEnabled')) {
    $('setKeymapEnabled').addEventListener('change', async (e) => {
      await api.keymap.setEnabled(e.target.checked);
      toast({ title: e.target.checked ? 'Đã bật ánh xạ phím' : 'Đã tắt ánh xạ phím', type: 'ok' });
    });
  }
  $('setDeepTrim').addEventListener('change', async (e) => {
    await save({ engine: { deepTrim: e.target.checked } });
    // 关掉深度裁剪必须把之前 pm disable-user của包恢复回来，否则影响是持久của
    if (!e.target.checked) {
      api.restoreSystemApps().catch(() => {});
      toast({ title: 'Đã khôi phục thành phần hệ thống', body: 'Đã tắt cắt giảm sâu, các gói nền đang được khôi phục', type: 'info' });
    }
  });
  $('setCompat').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await save({ runtime: { compatImage: on } });
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (on && !ok) toast({ title: 'ARM Đã bật chế độ tương thích', body: 'Cần tải thêm ảnh hệ thống tương thích Google Play (Android 14, khoảng 1.5GB), bấm nút bên dưới để bắt đầu', type: 'info' });
    else if (on) toast({ title: 'ARM Đã bật chế độ tương thích', body: 'Có hiệu lực sau khi khởi động lại bộ chạy', type: 'info' });
  });
  $('setAutoShortcut').addEventListener('change', (e) => save({ createShortcutOnInstall: e.target.checked }));
  $('setStartMenuShortcut').addEventListener('change', (e) => save({ createStartMenuShortcut: e.target.checked }));
  $('setShortcutDir').addEventListener('change', (e) => save({ shortcutDir: e.target.value.trim() }));
  $('setDeviceSharedDir').addEventListener('change', (e) => save({ deviceSharedDir: e.target.value.trim() }));
  $('setAutoStart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));
  $('setDisplayMode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    $('portraitField').hidden = mode === 'fullscreen';
    state.settings = await api.setSettings({ display: { mode } });
    toast({ title: mode === 'fullscreen' ? 'Đã chuyển sang toàn màn hình' : 'Đã chuyển sang cửa sổ dọc', type: 'ok' });
  });
  if ($('setAutoFullscreen')) {
    $('setAutoFullscreen').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { autoFullscreenOnLaunch: on } });
      toast({ title: on ? 'Đã bật tự động toàn màn hình' : 'Đã tắt tự động toàn màn hình', body: 'Có hiệu lực ở lần mở ứng dụng sau', type: 'ok' });
    });
  }
  if ($('setOrientationMode')) {
    $('setOrientationMode').addEventListener('change', async (e) => {
      const mode = e.target.value;
      state.settings = await api.setSettings({ display: { orientationMode: mode } });
      toast({
        title: mode === 'auto' ? 'Đã đặt theo ứng dụng' : (mode === 'landscape' ? 'Đã buộc màn hình ngang' : 'Đã buộc màn hình dọc'),
        body: mode === 'auto'
          ? 'Lần mở ứng dụng sau sẽ chọn khung theo hướng của ứng dụng; nếu hướng không khớp, bộ chạy sẽ khởi động lại một lần.'
          : 'Lần mở ứng dụng sau sẽ khởi động lại bộ chạy một lần để chuyển khung sang hướng đã chọn, sau đó không khởi động lại nữa.',
        type: 'ok',
      });
    });
  }
  if ($('setTabletMode')) {
    $('setTabletMode').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { tabletMode: on } });
      toast({
        title: on ? 'Đã bật bố cục máy tính bảng' : 'Đã tắt bố cục máy tính bảng',
        body: 'Có hiệu lực ở lần mở ứng dụng sau (sẽ khởi động lại bộ chạy một lần để đổi mật độ logic).',
        type: 'ok',
      });
    });
  }
  if ($('setLandscape')) {
    $('setLandscape').addEventListener('change', async (e) => {
      const landscape = e.target.value === 'landscape';
      state.settings = await api.setSettings({ display: { landscape } });
      toast({
        title: landscape ? 'Bảng đã đặt ở chế độ ngang' : 'Bảng đã đặt ở chế độ dọc',
        body: 'Lần mở ứng dụng sau sẽ khởi động lại bộ chạy một lần để đổi hướng khung vật lý (khoảng chục giây), sau đó sẽ không khởi động lại nữa.',
        type: 'ok',
      });
    });
  }
  $('setPortrait').addEventListener('change', async (e) => {
    state.settings = await api.setSettings({ display: { portrait: e.target.value } });
    toast({ title: 'Đã cập nhật kích thước khung hình', body: 'Có hiệu lực ở lần mở hoặc chuyển ứng dụng tiếp theo', type: 'ok' });
  });
  $('setWindowEmbed').addEventListener('change', async (e) => {
    const embed = e.target.value === 'embed';
    state.settings = await api.setSettings({ display: { windowEmbed: embed } });
    toast({
      title: embed ? 'Đã chuyển lại chế độ nhúng' : 'Đã chuyển sang chế độ cửa sổ độc lập',
      body: 'Có hiệu lực ở lần mở ứng dụng sau. Ở chế độ độc lập, trình giả lập tự mở cửa sổ cho hình Android, hướng và tỉ lệ thu phóng do nó xử lý.',
      type: 'ok',
    });
  });
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const r = await api.rebuildShortcuts();
    toast({
      title: r && r.fixed && r.fixed.length ? 'Đã bổ sung lối tắt' : 'Lối tắt vẫn còn đủ',
      body: r && r.fixed && r.fixed.length ? r.fixed.join('、') : 'Lối vào trên màn hình nền và menu Start hoạt động bình thường',
      type: 'ok',
    });
  });

  $('btnDiagnostics').addEventListener('click', async () => {
    try {
      const r = await api.doctorReport();
      toast({ title: 'Đã xuất báo cáo chẩn đoán', body: `${r.diagnosis.title} · ${r.file}`, type: 'ok', sticky: true });
    } catch (e) {
      toast({ title: 'Xuất thất bại', body: e.message, type: 'error' });
    }
  });

  $('btnCleanup').addEventListener('click', async () => {
    const btn = $('btnCleanup');
    const includeSnapshots = $('chkCleanSnapshots') && $('chkCleanSnapshots').checked;
    btn.disabled = true;
    try {
      const preview = await api.runtimeCleanup({ apply: false, includeSnapshots });
      if (!preview.candidates.length) {
        toast({ title: 'Đã ở trạng thái gọn nhẹ', body: 'Không có ảnh hệ thống hoặc snapshot cũ nào để thu hồi.', type: 'ok' });
        return;
      }
      const r = await api.runtimeCleanup({ apply: true, includeSnapshots });
      if (r.cancelled) return;
      toast({
        title: 'Dọn dẹp xong',
        body: `Giải phóng khoảng ${(r.saved / 1048576).toFixed(0)} MB（${r.removed.length} mục), ứng dụng đã cài được giữ lại.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Tổng ${u.totalText} · Có thể thu hồi ${u.reclaimableText}（${u.count} mục)`;
    } catch (e) {
      toast({ title: 'Dọn dẹp thất bại', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Đặt lại dữ liệu Android：二级Xác nhận（先Xác nhận意图，再Xác nhận不可撤销），清完Làm mới占Dùng统计
  $('btnResetData').addEventListener('click', async () => {
    const btn = $('btnResetData');
    btn.disabled = true;
    try {
      const first = await api.confirm({
        type: 'warning',
        title: 'Đặt lại dữ liệu Android?',
        message: 'Việc này sẽ đưa hệ thống Android về trạng thái sạch như “vừa cài xong”:',
        detail: '• Xóa toàn bộ ứng dụng bên thứ ba đã cài (gồm Hongguo, game...) cùng dữ liệu và trạng thái đăng nhập\n'
          + '• Xóa snapshot khởi động nhanh của AVD hiện tại\n'
          + '• Ảnh hệ thống không bị ảnh hưởng, mở lại ứng dụng sẽ khởi động nguội và tạo lại dữ liệu\n\n'
          + 'Thao tác này không thể hoàn tác. Tiếp tục?',
        buttons: ['Hủy', 'Tiếp tục'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!first || first.response !== 1) return;
      const second = await api.confirm({
        type: 'warning',
        title: 'Xác nhận lại lần nữa',
        message: 'Các ứng dụng đã cài và dữ liệu của chúng sẽ bị xóa vĩnh viễn. Bạn có chắc muốn đặt lại?',
        detail: 'Yên tâm là: ảnh hệ thống, các AVD khác, bộ nhớ đệm APK và biểu tượng trên máy đều không bị đụng đến.',
        buttons: ['Hủy', 'Xác nhận đặt lại'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!second || second.response !== 1) return;
      const r = await api.runtimeResetData();
      if (!r || !r.ok) {
        toast({ title: 'Đặt lại thất bại', body: (r && r.error) || 'Vui lòng thử lại', type: 'error' });
        return;
      }
      toast({
        title: 'Đã đặt lại dữ liệu Android',
        body: `Giải phóng khoảng ${r.reclaimedMB} MB, bản ghi ứng dụng đã cài đã được xóa.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Tổng ${u.totalText} · Có thể thu hồi ${u.reclaimableText}（${u.count} mục)`;
    } catch (e) {
      toast({ title: 'Đặt lại thất bại', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Sửa mạng：安卓里联网页面一直黑屏（红果点「同意并Tiếp tục」后整屏黑）时Dùng。
  // 根因是虚拟机 /data trong Wi-Fi 配置坏了，wlan0 没起来、没Có默认路由。
  // Play Store 镜像Không được phép root，只能整体重置 /data；Áp dụng清单保留，点开时会Tự động重装。
  $('btnRepairNetwork').addEventListener('click', async () => {
    const btn = $('btnRepairNetwork');
    btn.disabled = true;
    try {
      const ok = await api.confirm({
        type: 'warning',
        title: 'Sửa mạng máy ảo?',
        message: 'Trang cần mạng trong ứng dụng cứ đen màn hình/xoay vòng, thường là do máy ảo Android không có mạng.',
        detail: 'Sửa chữa sẽ thử lần lượt theo “chi phí từ thấp đến cao”:\n\n'
          + '1. Khởi động nguội máy ảo (không nạp snapshot) rồi chờ có mạng — không ảnh hưởng dữ liệu nào\n'
          + '2. Vẫn không được mới đặt lại dữ liệu Android — danh sách ứng dụng được giữ, bấm mở sẽ tự cài lại,\n'
          + '   nhưng trạng thái đăng nhập, lịch sử xem phim... trong ứng dụng sẽ mất\n\n'
          + 'Chỉ ảnh hưởng AVD hiện tại, ảnh hệ thống và bộ nhớ đệm APK trên máy đều không đụng đến. Toàn bộ quá trình khoảng 1–5  phút. Tiếp tục không?',
        buttons: ['Hủy', 'Bắt đầu sửa'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const r = await api.runtimeRepairNetwork();
      if (!r || !r.ok) {
        toast({
          title: 'Mạng vẫn chưa khôi phục',
          body: (r && r.error) || 'Sau khi đặt lại máy ảo vẫn không có mạng, hãy kiểm tra xem mạng/tường lửa của máy có chặn trình giả lập không.',
          type: 'error',
        });
        return;
      }
      toast({
        title: 'Mạng đã khôi phục',
        body: `${(r.network && r.network.ip) || 'Đã có mạng'}${r.wiped ? '(đã đặt lại dữ liệu Android để sửa mạng, mở ứng dụng sẽ tự cài lại)' : '(không động đến dữ liệu của bạn)'}`,
        type: 'ok',
      });
    } catch (e) {
      toast({ title: 'Sửa thất bại', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Dọn tàn dư bản cũ：扫描旧程序目录 / 失效Gỡ cài đặtmục / 更新临时文件，Xác nhận后一次性清掉。
  $('btnLeftovers').addEventListener('click', async () => {
    const btn = $('btnLeftovers');
    btn.disabled = true;
    try {
      const r = await api.leftoversScan();
      if (!r || !r.ok) {
        toast({ title: 'Quét thất bại', body: (r && r.error) || 'Vui lòng thử lại', type: 'error' });
        return;
      }
      const items = r.items || [];
      if (!items.length) {
        toast({ title: 'Rất sạch', body: 'Không thấy tàn dư của bản cũ.', type: 'ok' });
        return;
      }
      const mb = Math.round((r.totalBytes || 0) / 1048576);
      const lines = items.slice(0, 8).map((x) => `• ${x.note}：${x.path}`);
      if (items.length > 8) lines.push(`… và còn ${items.length - 8} mục`);
      const ok = await api.confirm({
        type: 'warning',
        title: 'Dọn tàn dư bản cũ?',
        message: `Tìm thấy ${items.length} mục còn sót, khoảng ${mb} MB：`,
        detail: `${lines.join('\n')}\n\nChỉ xóa “thư mục chương trình bản cũ / mục gỡ cài đặt đã hỏng / tệp tạm cập nhật”,`
          + 'Phiên bản đang chạy và dữ liệu ứng dụng của bạn sẽ không bị ảnh hưởng.',
        buttons: ['Hủy', 'Bắt đầu dọn dẹp'],
        defaultId: 1,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const c = await api.leftoversClean(items);
      if (!c || !c.ok) {
        toast({ title: 'Dọn dẹp thất bại', body: (c && c.error) || 'Vui lòng thử lại', type: 'error' });
        return;
      }
      const failNote = (c.failed && c.failed.length) ? `，${c.failed.length} mục đang bị chiếm dụng nên chưa xóa` : '';
      toast({
        title: 'Đã dọn phần còn sót của bản cũ',
        body: `Xóa ${c.removed.length} mục, giải phóng ${c.freedMB || 0} MB${failNote}。`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Tổng ${u.totalText} · Có thể thu hồi ${u.reclaimableText}（${u.count} mục)`;
    } catch (e) {
      toast({ title: 'Dọn dẹp thất bại', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  $('btnOpenShared').addEventListener('click', () => api.openSharedDir());

  // Tạo lại lối tắt：Màn hình nền图标被误删 / 被安全软件拦掉时của兜底入口
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const btn = $('btnRebuildShortcuts');
    btn.disabled = true;
    try {
      const r = await api.rebuildShortcuts().catch(() => ({ ok: false }));
      const fixed = (r && r.fixed) || [];
      toast(fixed.length
        ? { title: 'Đã tạo lại lối tắt', body: fixed.join('、'), type: 'ok' }
        : { title: 'Lối tắt đều còn', body: 'Không có lối vào nào cần tạo lại', type: 'info' });
    } finally {
      btn.disabled = false;
    }
  });

  // Tổng享目录：先DuyệtChọn目录，再「Lưu và di chuyển」把旧文件一次性搬到新目录
  $('btnBrowseShared').addEventListener('click', async () => {
    const picked = await api.openDir();
    if (!picked) return;
    $('setSharedDir').value = picked;
    toast({ title: 'Đã chọn thư mục mới', body: 'Bấm “Lưu và di chuyển” để chuyển tệp cũ sang', type: 'info' });
  });
  $('btnSaveShared').addEventListener('click', async () => {
    const dir = $('setSharedDir').value.trim();
    if (!dir) { toast({ title: 'Vui lòng nhập hoặc chọn thư mục trước', type: 'error' }); return; }
    const btn = $('btnSaveShared');
    btn.disabled = true;
    const r = await api.setSharedDir(dir).catch(() => ({ ok: false }));
    btn.disabled = false;
    if (r.ok) {
      const moved = r.oldDir && r.oldDir !== r.newDir;
      toast({ title: 'Đã cập nhật thư mục chia sẻ', body: moved ? 'Các tệp có sẵn trong thư mục cũ đã được chuyển sang thư mục mới' : 'Đã lưu', type: 'ok' });
    } else {
      toast({ title: 'Lưu thất bại', body: r.error, type: 'error' });
    }
  });

  // Gỡ cài đặt một chạm ApkStart 本体（Hủy .apk 关联 + 启动Gỡ cài đặt程序；便携版手动Xóa）
  $('btnUninstall').addEventListener('click', async () => {
    const ok = window.confirm('Gỡ cài đặt ApkStart?\n\nSẽ hủy liên kết tệp .apk và gỡ chương trình. Thao tác này không thể hoàn tác.');
    if (!ok) return;
    const btn = $('btnUninstall');
    btn.disabled = true;
    const r = await api.removeSelf().catch(() => ({ ok: false }));
    if (r.ok && r.portable) {
      btn.disabled = false;
      toast({
        title: 'Bản portable không thể tự gỡ cài đặt',
        body: `Hãy tự xóa thư mục chương trình (${r.exeDir}) và thư mục dữ liệu (${r.dataDir}）`,
        type: 'info', sticky: true,
      });
      return;
    }
    if (!r.ok) {
      btn.disabled = false;
      toast({ title: 'Gỡ cài đặt thất bại', body: r.error, type: 'error' });
      return;
    }
    toast({ title: 'Đang gỡ cài đặt…', body: 'Đã chạy trình gỡ cài đặt, ApkStart sắp thoát', type: 'ok', sticky: true });
  });

  // ARM Ảnh hệ thống tương thích下载（带进度 toast）
  $('btnInstallPlay').addEventListener('click', async () => {
    const btn = $('btnInstallPlay');
    btn.disabled = true;
    const t = toast({ title: 'Bắt đầu tải ảnh hệ thống tương thích ARM', body: 'Đang chuẩn bị…', sticky: true, spinner: true, progress: 3 });
    const un = api.on('provision:progress', (p) => {
      if (p.component !== 'playimg') return;
      t.update({ title: 'Tải ảnh hệ thống tương thích ARM', body: p.message || '', progress: p.percent });
    });
    try {
      const r = await api.installPlayImage();
      if (r && r.ok) {
        t.update({ title: 'ARM Ảnh hệ thống tương thích đã sẵn sàng', body: 'Có hiệu lực sau khi khởi động lại bộ chạy', progress: 100 });
        setTimeout(() => t.dismiss(), 3000);
        $('compatInstallField').hidden = true;
        refreshStatus();
      } else {
        t.update({ title: 'Tải ảnh hệ thống tương thích thất bại', body: (r && r.error) || 'Lỗi không xác định', progress: null });
        t.dismiss();
        toast({ title: 'Tải ảnh hệ thống tương thích thất bại', body: (r && r.error) || 'Lỗi không xác định', type: 'error' });
      }
    } catch (e) {
      t.dismiss();
      toast({ title: 'Tải ảnh hệ thống tương thích thất bại', body: e.message, type: 'error' });
    } finally {
      un();
      btn.disabled = false;
    }
  });

  // Ảnh hệ thống tương thích状态显示
  (async () => {
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const s = state.settings;
    const on = !!(s && s.runtime && s.runtime.compatImage);
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (env.playImage) {
      $('compatImgStatus').textContent = ok
        ? `Đã sẵn sàng (${(env.playImage.size / 1073741824).toFixed(2)} GB）` : 'Chưa tải';
    }
  })();
  $('btnOpenData').addEventListener('click', async () => {
    const info = await api.info();
    const dir = info.runtimeDir || info.dataDir;
    window.open(`file:///${dir.replace(/\\/g, '/')}`);
  });
  $('btnBrowseRuntimeDir').addEventListener('click', async () => {
    const info = await api.info();
    const picked = await api.openDir();
    if (!picked) return;
    await api.setSettings({ runtime: { dir: picked } });
    $('setRuntimeDir').value = picked;
    toast({ title: 'Đã cập nhật thư mục dữ liệu', body: 'Hãy khởi động lại ApkStart để có hiệu lực (dữ liệu cũ không tự chuyển)', type: 'ok', sticky: true });
  });

  // 安卓数据目录（AVD + 快照）：真正吃盘của那块，单独指到别của盘
  if ($('btnBrowseAvdDir')) {
    $('btnBrowseAvdDir').addEventListener('click', async () => {
      const picked = await api.openDir();
      if (!picked) return;
      await api.setSettings({ runtime: { avdDir: picked } });
      $('setAvdDir').value = picked;
      toast({
        title: 'Đã cập nhật thư mục dữ liệu Android',
        body: 'Hãy khởi động lại ApkStart để có hiệu lực. Có thể chuyển nguyên apkstart.avd từ thư mục cũ sang thư mục mới, rồi xóa bản cũ.',
        type: 'ok',
        sticky: true,
      });
    });
  }
  if ($('btnOpenAvdDir')) {
    $('btnOpenAvdDir').addEventListener('click', async () => {
      const info = await api.dataInfo().catch(() => null);
      const dir = (info && info.avdDir) || (await api.info()).dataDir;
      window.open(`file:///${String(dir).replace(/\\/g, '/')}`);
    });
  }

  $('btnRuntimeStart').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = 'Đang khởi động…';
    const r = await api.runtimeStart();
    el.textContent = r.ok ? `Đã sẵn sàng:${r.engine}` : `Khởi động thất bại:${r.error}`;
    refreshStatus();
  });

  $('btnRuntimeStop').addEventListener('click', async () => {
    await api.runtimeStop();
    $('probeResult').textContent = 'Đã dừng máy ảo tích hợp';
    refreshStatus();
  });

  $('btnAssoc').addEventListener('click', async () => {
    const btn = $('btnAssoc');
    if (btn.dataset.on === '1') {
      await api.assocUnregister();
      btn.textContent = 'Chưa liên kết · bấm để bật';
      btn.dataset.on = '0';
      toast({ title: '.apk Đã hủy liên kết' });
    } else {
      const r = await api.assocRegister();
      btn.textContent = 'Đã liên kết · bấm để hủy';
      btn.dataset.on = '1';
      toast({ title: '.apk Đã bật liên kết', body: r.ok ? 'Hiện giờ bấm đúp APK sẽ cài thẳng vào ApkStart' : '', type: r.ok ? 'ok' : 'error' });
    }
  });
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  // 链接统一走系统Duyệt器
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.getAttribute('href'));
  });

  $('btnSettings').addEventListener('click', openSettings);
  // 状态标签也当入口：点「Cần triển khai / Đang khởi động / Android 14」直接进Cài đặtcủaBộ chạy面板
  $('engineTag').addEventListener('click', () => showSetup(true));
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnDoneSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) closeSettings();
  });

  // Bộ chạy部署：入口已收进Cài đặt，这里只处理面板内của按钮
  $('btnDeployAll').addEventListener('click', deployAll);
  $('btnMarkInstalled').addEventListener('click', markInstalled);
  $('btnGuideClose').addEventListener('click', () => { $('setupGuide').hidden = true; });
  $('btnSetupAdvanced').addEventListener('click', () => {
    const adv = document.querySelector('.advanced-group');
    if (adv) {
      adv.open = true;
      adv.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  // 状态条上của自检计数：点开就是Cài đặttrongBộ chạy面板
  $('envChip').addEventListener('click', () => {
    openSettings().then(() => {
      const box = $('envCheck');
      if (box && !box.hidden) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else $('runtimeGroup').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }).catch(() => {});
  });

  $('setupSteps').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'emulator' || act === 'sysimg' || act === 'accel'
      || act === 'adb' || act === 'qemu' || act === 'iso' || act === 'disk') {
      const r = await runStep(act);
      if (!r.ok) toast({ title: 'Thao tác thất bại', body: r.error, type: 'error', sticky: true });
      return;
    }
    if (act === 'isoImport') {
      const r = await api.importIso();
      if (r.ok) { toast({ title: 'Đã nhập ảnh hệ thống', body: r.path, type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Nhập thất bại', body: r.error, type: 'error' });
      return;
    }
    if (act === 'diskImport') {
      const r = await api.importDisk();
      if (r.ok) { toast({ title: 'Đã nhập ổ đĩa ảo', body: 'Có thể khởi động bộ chạy ngay', type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Nhập thất bại', body: r.error, type: 'error' });
      return;
    }
    if (act === 'install') { await startInstall(); return; }
    if (act === 'vmStart') {
      const t = toast({ title: 'Đang khởi động bộ chạy…', body: 'Lần khởi động đầu cần nạp hệ thống Android', sticky: true, spinner: true });
      const r = await api.runtimeStart();
      if (r.ok) { t.update({ title: 'Bộ chạy đã sẵn sàng', type: 'ok' }); setTimeout(t.dismiss, 2200); }
      else t.update({ title: 'Khởi động thất bại', body: r.error, type: 'error' });
      refreshStatus();
      return;
    }
    if (act === 'vmStop') {
      await api.runtimeStop();
      toast({ title: 'Phiên bộ chạy đã kết thúc' });
      refreshStatus();
    }
  });

  const pick = async () => {
    const files = await api.pickApk();
    if (files.length) installFiles(files);
  };
  $('btnInstall').addEventListener('click', pick);
  $('btnInstall2').addEventListener('click', pick);
  // Tổng享目录入口移到Cài đặt里：同步 + Mở都在「Chia sẻ tệp」组内
  const btnSync = $('btnSyncShared');
  if (btnSync) btnSync.addEventListener('click', async () => {
    btnSync.disabled = true;
    try {
      await api.syncShared();
      toast({ title: 'Đã đồng bộ thư mục chia sẻ', type: 'ok' });
    } catch (_) {
      toast({ title: 'Đồng bộ thất bại', body: 'Khi bộ chạy chưa sẵn sàng sẽ bỏ qua đồng bộ', type: 'error' });
    } finally {
      btnSync.disabled = false;
    }
  });

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });

  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    // 「Thêm ứng dụng」卡片没Có data-pkg，走Cài đặt流程而不是启动。
    // 直接转调工具栏那cái「Cài đặt APK」按钮，复Dùng它của文件Chọn择逻辑。
    if (card.classList.contains('card-add')) { $('btnInstall').click(); return; }
    if (card.dataset.pkg) launchApp(card.dataset.pkg);
  });

  $('grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, card.dataset.pkg);
  });

  $('grid').addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) createShortcut(card.dataset.pkg);
  });

  $('ctxmenu').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item) handleMenu(item.dataset.act);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu')) hideMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      closeSettings();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  // 拖放Cài đặt
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('dropzone').classList.add('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropzone').classList.remove('on');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files
      .map((f) => { try { return api.pathForFile(f); } catch (_) { return null; } })
      .filter((p) => p && /\.apk$/i.test(p));
    if (paths.length) installFiles(paths);
    else toast({ title: 'Chỉ có thể kéo thả tệp .apk', type: 'error' });
  });

  // 主进程事件
  api.on('install:error', (p) => {
    // 报错了就别再让「Đang cài đặt…」那条一直转圈（可能来自双击 APK của另一条链路）
    if (installToast) { try { installToast.dismiss(); } catch (_) { /* ignore */ } installToast = null; }
    const name = p && p.file ? String(p.file).split(/[\\/]/).pop() : '';
    toast({
      title: name ? `Cài đặt thất bại:${name}` : 'Cài đặt thất bại',
      body: friendlyInstallErrorText((p && p.message) || 'Lỗi không xác định'),
      type: 'error',
    });
  });
  api.on('toast', (p) => toast({ title: p.message, type: p.type === 'error' ? 'error' : 'info' }));
  api.on('app:launched', () => setTimeout(refreshApps, 800));
  // Áp dụng被关掉（托盘「Đóng ứng dụng hiện tại」、右键菜单、或窗口被关）后要Làm mới「Đang chạy」标记
  api.on('apps:changed', () => setTimeout(refreshApps, 300));
  api.on('runtime:log', (m) => console.log('[runtime]', m));
  api.on('ui:navigate', (v) => {
    if (v === 'settings') openSettings();
    if (v === 'setup') { showSetup(true); refreshStatus(); }
  });
  api.on('provision:progress', (p) => updateStepProgress(p.component, p));
  api.on('update:state', (info) => {
    if (!info) return;
    renderUpdate(info);
    // 启动 8 秒后才拿到更新信息：欢迎卡若还开着，把「Có phiên bản mới」这条补进去
    const wm = $('welcomeMask');
    if (wm && !wm.hidden) renderWelcomeTips();
  });
  api.on('update:progress', (p) => renderUpdateProgress(p));
}

/* ---------------- 启动 ---------------- */

async function init() {
  bindEvents();
  bindSettings();
  bindUpdate();
  bindAndroid();
  bindWelcome();
  state.settings = await api.getSettings();
  await refreshStatus();
  await refreshApps();
  refreshAndroid();
  selfCheck();
  maybeShowWelcome();
  setInterval(refreshStatus, 6000);
  setInterval(refreshApps, 15000);
  setInterval(selfCheck, 60000);
}

/* ---------------- 启动欢迎卡 ---------------- */

let startupInfo = null;

function greetingOf(h) {
  if (h < 5) return 'Khuya rồi';
  if (h < 11) return 'Chào buổi sáng';
  if (h < 13) return 'Chào buổi trưa';
  if (h < 18) return 'Chào buổi chiều';
  return 'Chào buổi tối';
}

function bindWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  const close = () => { mask.hidden = true; };
  const never = $('welcomeNever');
  $('welcomeOk').addEventListener('click', () => {
    if (never && never.checked) api.setSettings({ welcome: { disabled: true } }).catch(() => {});
    close();
  });
  $('welcomeSettings').addEventListener('click', () => { close(); openSettings(); });
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mask.hidden) close(); });
}

/** 决定要不要弹：开机自启必弹；手动Mở则每天最多一次，且Dùng户可永久Đóng */
async function maybeShowWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  // 冒烟截图时不要弹欢迎卡：否则每次Tự động截图都被它挡住主界面
  try { if ((await api.startupInfo()).smoke) return; } catch (_) { /* ignore */ }
  try { startupInfo = await api.startupInfo(); } catch (_) { startupInfo = null; }
  const cfg = (state.settings && state.settings.welcome) || {};
  if (cfg.disabled) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!(startupInfo && startupInfo.autostart) && cfg.lastDate === today) return;

  const h = new Date().getHours();
  $('welcomeHi').textContent = `${greetingOf(h)}, chào mừng quay lại`;
  const ver = (startupInfo && startupInfo.version) || (state.status && state.status.version) || '';
  const ready = state.status && state.status.ready;
  $('welcomeSub').textContent = `ApkStart${ver ? ` v${ver}` : ''} · ${ready ? 'Bộ chạy sẵn sàng, mở là dùng' : 'Bộ chạy sẽ tự chuẩn bị khi cần'}`;

  const apps = (state.apps || []).length;
  const dev = $('statusDevice') ? $('statusDevice').textContent.trim() : '';
  const chips = [
    { k: String(apps), v: 'Ứng dụng đã cài' },
    { k: ready ? 'Sẵn sàng' : 'Chờ lệnh', v: 'Bộ chạy Android' },
    { k: dev ? dev.replace(/^.*?(\d+)/, '$1') : '—', v: 'Thiết bị / Cổng' },
  ];
  $('welcomeStats').innerHTML = chips
    .map((c) => `<div class="welcome-stat"><b>${esc(c.k)}</b><span>${esc(c.v)}</span></div>`)
    .join('');

  const tips = [];
  $('welcomeTips').innerHTML = '';
  mask.hidden = false;
  renderWelcomeTips();
  api.setSettings({ welcome: { lastDate: today } }).catch(() => {});
}

/** 提示区单独渲染：启动 8 秒后才拿到更新信息，那时卡片可能还开着，Cần补一次 */
function renderWelcomeTips() {
  const box = $('welcomeTips');
  if (!box) return;
  const apps = (state.apps || []).length;
  const tips = [];
  if (lastUpdate && lastUpdate.hasUpdate) {
    tips.push(`Có phiên bản mới <b>${esc(lastUpdate.tag || '')}</b>, có thể cập nhật bằng một cú nhấp tại “Cài đặt → Cập nhật phần mềm”`);
  }
  if (!apps) {
    tips.push('Kéo APK vào cửa sổ là cài được, cài xong tự tạo biểu tượng trên màn hình nền');
  } else {
    tips.push('Nhấp đúp thẻ ứng dụng để chạy trong cửa sổ riêng, góc trên phải có thể xoay / thu phóng / đóng');
  }
  tips.push('Đóng cửa sổ chỉ thoát ứng dụng đó, môi trường Android vẫn được giữ, lần sau mở nhanh hơn');
  box.innerHTML = tips
    .map((t, i) => `<div class="welcome-tip"><i>${i + 1}</i><span>${t}</span></div>`)
    .join('');
}

/* ---------------- Tự kiểm tra môi trường ---------------- */

let envBusy = false;

/** 拉取 doctor:selfCheck：把问题渲染到Cài đặttrong自检面板，并在状态条上留一cái计数 */
async function selfCheck() {
  if (envBusy) return;
  envBusy = true;
  try {
    const r = await api.selfCheck().catch(() => null);
    if (r) renderEnvCheck(r);
  } catch (_) { /* 自检Thất bại不阻断主流程 */ }
  finally { envBusy = false; }
}

function renderEnvCheck(r) {
  const box = $('envCheck');
  if (!box) return;
  // 「组件Thiếu失」在同一cái面板củaHoàn tất một chạm里已经覆盖，不再重复列出
  const needDeploy = !!(state.status && state.status.needsSetup);
  const issues = (r.issues || []).filter((i) => !(needDeploy && i.fix === 'deploy'));

  // 主界面不再放横幅：只在底部状态条上留一cái可点của计数，点开就是Cài đặttrong自检面板
  const chip = $('envChip');
  if (chip) {
    const errs = issues.filter((i) => i.severity === 'error').length;
    chip.hidden = issues.length === 0;
    chip.textContent = errs ? `${errs} mục cần sửa` : `${issues.length} mục lưu ý`;
    chip.className = `status-chip${errs ? ' err' : ''}`;
    chip.title = issues.map((i) => i.title).join('；');
  }

  if (!issues.length) {
    box.hidden = false;
    box.innerHTML = `
      <div class="env-check-ok">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
        <span>Tự kiểm tra môi trường đạt, không thấy vấn đề nào ảnh hưởng đến việc chạy.</span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" id="btnEnvRecheck">Kiểm tra lại</button>
      </div>`;
    const re = $('btnEnvRecheck');
    if (re) re.addEventListener('click', selfCheck);
    return;
  }
  const errs = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errs;
  box.hidden = false;
  box.innerHTML = `
    <div class="env-check-head">
      <span class="ec-title">Tự kiểm tra môi trường</span>
      ${errs ? `<span class="ec-count">${errs}  mục nghiêm trọng</span>` : ''}
      ${warns ? `<span class="ec-count warn">${warns}  lời nhắc</span>` : ''}
      <span class="ec-spacer"></span>
      <button class="btn ghost sm" id="btnEnvRecheck">Kiểm tra lại</button>
      <button class="btn primary sm" id="btnEnvFixAll">Sửa tất cả một chạm</button>
    </div>
    <div class="env-check-list">
      ${issues.map((i) => `
        <div class="env-check-item ${i.severity}">
          <span class="ec-sev"></span>
          <div class="ec-body">
            <div class="ec-name">${esc(i.title)}</div>
            <div class="ec-hint">${esc(i.hint || '')}</div>
          </div>
          ${i.fix ? `<button class="ec-fix" data-code="${esc(i.code)}">Sửa</button>` : ''}
        </div>`).join('')}
    </div>`;
  const re = $('btnEnvRecheck');
  if (re) re.addEventListener('click', selfCheck);
  const fixAll = $('btnEnvFixAll');
  if (fixAll) fixAll.addEventListener('click', () => fixAllIssues(issues));
  box.querySelectorAll('.ec-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
}

async function fixIssue(issue) {
  switch (issue.fix) {
    case 'vcRedist': {
      const r = await api.installVcRedist().catch(() => ({ ok: false }));
      if (!r.ok && r.reason === 'no-installer') {
        api.openExternal('https://learn.microsoft.com/zh-CN/cpp/windows/latest-supported-vc-redist?view=msvc-170#visual-studio-2015-2017-2019-and-2022');
        toast({ title: 'Không tìm thấy gói cài đặt tích hợp', body: 'Đã mở trang tải của Microsoft, hãy tải bản x64', type: 'info' });
        break;
      }
      toast(r.ok
        ? { title: 'VC++ Đã cài thư viện chạy', type: 'ok' }
        : { title: 'Cài đặt chưa hoàn tất', body: r.error || 'Vui lòng thử lại', type: 'error' });
      break;
    }
    case 'virtualization': {
      const t = toast({ title: 'Đang bật tăng tốc phần cứng…', body: 'Trong cửa sổ hiện ra, hãy bấm “Có”', sticky: true, spinner: true });
      const r = await api.enableVirtualization().catch(() => ({ ok: false }));
      if (r.ok) {
        t.update({ title: 'Đã bật tăng tốc phần cứng', body: r.restartNeeded ? 'Hãy khởi động lại máy tính để đạt hiệu năng tốt nhất' : (r.note || ''), type: 'ok' });
        setTimeout(t.dismiss, 3200);
      } else if (r.manual) {
        // 商店（MSIX）版：包固定 mediumIL，通常拿不到管理员授权。
        // 与其让Dùng户点一cái注定Thất bạicủa按钮，不如直接把「启Dùng或Đóng Windows 功能」
        // 对话框弹出来，并告诉他勾哪一mục。
        t.dismiss();
        await api.openWindowsFeatures?.().catch(() => null);
        toast({
          title: 'Cần bật thủ công một lần (chỉ một lần này)',
          body: r.note || 'Trong cửa sổ vừa mở, tích “Windows Hypervisor Platform”, bấm OK rồi khởi động lại máy.',
          type: 'info',
          sticky: true,
        });
      } else if (r.cancelled) {
        t.update({ title: 'Đã hủy', body: r.error || 'Chưa được cấp quyền quản trị, tăng tốc phần cứng không thay đổi.', type: 'info', spinner: false });
        setTimeout(t.dismiss, 4200);
      } else {
        t.update({ title: 'Không bật được', body: r.error || r.note || 'Vui lòng thử lại', type: 'error', sticky: true });
      }
      break;
    }
    case 'disk': {
      // 主进程会弹出原生Xác nhận框（含可释放Trống间预览），这里不再重复 confirm
      const r = await api.runtimeCleanup({ apply: true }).catch(() => null);
      if (!r) { toast({ title: 'Dọn dẹp thất bại', body: 'Vui lòng thử lại', type: 'error' }); break; }
      if (r.cancelled) break;
      toast({ title: 'Dọn dẹp xong', body: `Giải phóng khoảng ${((r.saved || 0) / 1048576).toFixed(0)} MB`, type: 'ok' });
      break;
    }
    case 'path': {
      toast({ title: 'Nên đổi sang thư mục chỉ có chữ tiếng Anh', body: 'Trong Cài đặt → Tích hợp hệ thống, sửa “Thư mục dữ liệu bộ chạy” rồi khởi động lại phần mềm.', type: 'info', sticky: true });
      openSettings();
      break;
    }
    case 'deploy': {
      toast({ title: 'Đang bổ sung các thành phần bộ chạy còn thiếu…', type: 'info', sticky: true, spinner: true });
      await deployAll();
      break;
    }
    case 'lock': {
      const r = await api.clearLocks().catch(() => ({ ok: false }));
      toast(r.ok ? { title: 'Đã dọn tệp khóa còn sót', type: 'ok' } : { title: 'Dọn dẹp thất bại', body: r.error, type: 'error' });
      break;
    }
    default:
      toast({ title: 'Chưa hỗ trợ tự sửa', body: issue.hint || '', type: 'info' });
  }
  // Sửa后重新自检，Làm mới横幅与状态
  setTimeout(selfCheck, 600);
  setTimeout(refreshStatus, 600);
}

async function fixAllIssues(issues) {
  const fixable = issues.filter((i) => i.fix);
  for (const i of fixable) {
    // eslint-disable-next-line no-await-in-loop
    await fixIssue(i);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 500));
  }
}

init().catch((e) => {
  console.error(e);
  toast({ title: 'Khởi tạo thất bại', body: e.message, type: 'error', sticky: true });
});
