'use strict';
/**
 * 双源（GitHub / Gitee）+ 镜像前缀của统一下载来源管理。
 *
 * 国内直连 GitHub Có两cái坑：
 *   1. api.github.com 经常几十秒才响应，甚至直接Hết thời gian —— 表现是「Kiểm tra cập nhật转圈」；
 *   2. 资产下载（objects.githubusercontent.com）单连接限速，常在 100KB/s 上下 ——
 *      1.5 GB củaBộ chạy包要下 4 cáiNhỏ时。
 *
 * 所以这里不预设「谁是主源」，而是每次Dùng真实byte测速：
 *   - 版本信息：GitHub / Gitee 两边**并发**问，谁先给出更高版本Dùng谁của；
 *   - 下载地址：把「GitHub 直连 / Gitee 同名资产 / 镜像前缀拼接」全部列出来，
 *     每cái地址真下 128KB，按实测速度排序，取最快của那 mục.
 *
 * 测速结果在Bộ nhớ里缓存 30 phút（同一进程内反复Kiểm tra cập nhật/下多cái组件不必重复测）。
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { cmpVer } = require('./version');

const OWNER_GH = 'RoutineMiku';
const OWNER_GITEE = 'daily-miku';
const REPO = 'apkstart';

const SOURCES = {
  github: {
    id: 'github',
    name: 'GitHub',
    api: `https://api.github.com/repos/${OWNER_GH}/${REPO}`,
    web: `https://github.com/${OWNER_GH}/${REPO}`,
  },
  gitee: {
    id: 'gitee',
    name: 'Gitee',
    api: `https://gitee.com/api/v5/repos/${OWNER_GITEE}/${REPO}`,
    web: `https://gitee.com/${OWNER_GITEE}/${REPO}`,
  },
};

/** 已知Khả dụngcủa GitHub Tăng tốc前缀。只在Dùng户开启 autoMirror 且未自定义时参与测速。 */
const KNOWN_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
];

/**
 * 一次测速của采样byte数。
 * 128KB 太Nhỏ：握手 + TLS 就Có几百毫秒，测出来của「速度」其实主要在测延迟，
 * 会把「延迟高但带宽Lớn」của源误判成慢。256KB 能把两者分开，流量也可以接受。
 */
const SAMPLE_BYTES = 256 * 1024;

function openUrl(url, { timeout = 10000, headers = {}, redirects = 0, followRedirect = true } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Quá nhiều lần chuyển hướng'));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('Địa chỉ không hợp lệ')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'ApkStart/0.3 (Windows)',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && followRedirect) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        openUrl(next, { timeout, headers, redirects: redirects + 1, followRedirect }).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Hết thời gian kết nối')));
    req.on('error', reject);
    req.end();
  });
}

/** 取一Nhỏ段 JSON（带重定向、Hết thời gian、LớnNhỏ上限） */
async function getJson(url, timeout = 10000) {
  const res = await openUrl(url, { timeout });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`${new URL(url).host} ${res.statusCode}`);
  }
  const chunks = [];
  let len = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      len += c.length;
      if (len > 4 * 1024 * 1024) { res.destroy(); resolve(); return; }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 真下载一Nhỏ段byte来测速度。
 * @returns {Promise<{url:string, ok:boolean, speed:number, got:number, ms:number, error?:string}>}
 */
function measure(url, { bytes = SAMPLE_BYTES, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let firstAt = 0;
    let got = 0;
    let settled = false;
    let req = null;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch (_) { /* ignore */ }
      const now = Date.now();
      // 吞吐只算「开始收到byte之后」của时间：TLS 握手 + DNS 那几百毫秒是固定开销，
      // 对 1.4GB của包几乎不影响总耗时，混进速度里会把判断带偏。
      const span = Math.max(1, now - (firstAt || t0));
      resolve({
        url,
        ok: ok && got > 0,
        got,
        ms: now - t0,
        ttfb: firstAt ? firstAt - t0 : 0,
        speed: ok && got > 0 ? (got / span) * 1000 : 0,
        error,
      });
    };
    const timer = setTimeout(() => done(got > 0), timeoutMs);
    if (timer.unref) timer.unref();

    openUrl(url, {
      timeout: timeoutMs,
      headers: { Range: `bytes=0-${bytes - 1}` },
    }).then((res) => {
      req = res;
      if (res.statusCode >= 400) {
        res.resume();
        clearTimeout(timer);
        done(false, `HTTP ${res.statusCode}`);
        return;
      }
      res.on('data', (c) => {
        if (!firstAt) firstAt = Date.now();
        got += c.length;
        if (got >= bytes) { clearTimeout(timer); done(true); }
      });
      // 资产本身比样本还Nhỏ：读到 EOF 也算成功
      res.on('end', () => { clearTimeout(timer); done(got > 0); });
      res.on('error', (e) => { clearTimeout(timer); done(false, e.message); });
    }).catch((e) => { clearTimeout(timer); done(false, e.message); });
  });
}

/** 把 GitHub 资产地址套上镜像前缀 */
function withMirror(url, prefix) {
  if (!prefix || !/^https?:\/\//i.test(prefix)) return '';
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${p}${url}`;
}

/**
 * Gitee 发行版附件单文件上限 100MB，Gói cài đặt 105~110MB 装不下，所以发布时切成
 * xxx.zip.part1 / xxx.zip.part2。这里把Phân mảnh还原成一cái逻辑资产：
 *   { name: 'xxx.zip', size: 总和, parts: [{index, size, urls:[...]}] }
 * Phân mảnh必须从 part1 开始连续，否则视为残Thiếu、丢弃（宁Khả dụng整包，也不下一cái坏包）。
 */
function groupParts(assets) {
  const groups = new Map();
  const out = [];
  for (const a of assets) {
    const m = /^(.*)\.part(\d+)$/i.exec(String(a.name || ''));
    if (!m) { out.push(a); continue; }
    const base = m[1];
    const idx = Number(m[2]);
    let g = groups.get(base);
    if (!g) {
      g = { name: base, size: 0, parts: [], partial: true };
      groups.set(base, g);
      out.push(g);
    }
    let p = g.parts.find((x) => x.index === idx);
    if (!p) {
      p = { index: idx, size: Number(a.size) || 0, urls: [] };
      g.parts.push(p);
    }
    if (a.url && !p.urls.includes(a.url)) p.urls.push(a.url);
    if (!p.size) p.size = Number(a.size) || 0;
  }
  for (const g of groups.values()) {
    g.parts.sort((x, y) => x.index - y.index);
    const contiguous = g.parts.every((p, i) => p.index === i + 1);
    g.size = g.parts.reduce((n, p) => n + (Number(p.size) || 0), 0);
    // 注意：Gitee của发行版资产条目只Có name/url，**没Có size**。
    // 以「size>0」作为完整性条件会把整组Phân mảnh判成残Thiếu而丢弃（实测踩过），
    // 所以这里只要求「Phân mảnh连续 + 每cáiPhân mảnhCó地址」；LớnNhỏKhông rõ时进度按已收byte显示。
    if (!contiguous || !g.parts.every((p) => p.urls.length)) g.broken = true;
  }
  return { list: out.filter((a) => !a.broken), broken: [...groups.values()].filter((g) => g.broken).map((g) => g.name) };
}

/** mirrors 列表: dùng户自定义优先，其次内置（autoMirror 关掉就Chỉ dùng自定义của） */
function mirrorList(settings) {
  const r = (settings && settings.runtime) || {};
  const custom = String(r.mirrorPrefix || process.env.APKSTART_MIRROR || '').trim();
  if (custom) return [custom];
  if (r.autoMirror === false) return [];
  return KNOWN_MIRRORS.slice();
}

class Sources {
  constructor(settingsFn) {
    this.settings = typeof settingsFn === 'function' ? settingsFn : () => ({});
    this._rankCache = new Map();   // url -> {at, speed, ok}
    this._rankTtl = 30 * 60 * 1000;
    // 版本检查结果缓存：Gitee của匿名调Dùng限流很紧（连续几次就 403），
    // 而「Có没Có新版本」本来也不Cần秒级新鲜度。
    this._relCache = { at: 0, key: '', value: null };
    this._relTtl = 10 * 60 * 1000;
    // 熔断：某cái源被限流/报错后，一段时间内直接跳过它，不再每次启动都撞墙
    this._blocked = new Map();     // sourceId -> until(ms)
    this._blockMs = 15 * 60 * 1000;
  }

  /** 该源是否处于熔断期；返回 null 表示Khả dụng，否则返回给Dùng户看của原因 */
  blockedReason(id) {
    const until = this._blocked.get(id) || 0;
    if (until <= Date.now()) return null;
    return `Tạm bỏ qua (${Math.ceil((until - Date.now()) / 60000)}  phút sẽ không thử lại)`;
  }

  /** 各源của最新 release（并发，任何一cáiThất bại都不影响另一cái） */
  /**
   * 不依赖 API của兜底：直接跟随 `/releases/latest` của 302 拿到 tag。
   *
   * 为什么必须Có这一条：GitHub của匿名 API 每cái IP 每Nhỏ时只Có 60 次，
   * Gitee của匿名 API 更紧（实测连点几次就 403 Rate Limit Exceeded）。
   * 公司/校园网、运营商 NAT 出口下，Dùng户很容易「Kiểm tra cập nhậtThất bại」——
   * 而 `releases/latest` 这cái网页跳转是走 CDN của，不消耗 API 额度。
   *
   * 拿到 tag 之后资产名可以按发布约定拼出来：
   *   ApkStart-<tag>-win64-portable.zip / ApkStart-<version>-Setup.exe / ApkStart-runtime-<tag>.zip
   */
  async _releaseTagViaRedirect(id) {
    const s = SOURCES[id];
    const page = `${s.web}/releases/latest`;
    const res = await openUrl(page, { timeout: 9000, followRedirect: false });
    const loc = String(res.headers.location || '');
    try { res.resume(); } catch (_) { /* ignore */ }
    const m = /\/releases\/tag\/([^/?#]+)/i.exec(loc);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /** Dùng tag 拼一份「最NhỏKhả dụng」của release（没Có API 时Dùng） */
  _syntheticRelease(id, tag) {
    const s = SOURCES[id];
    const ver = String(tag).replace(/^v/i, '');
    const names = [
      `ApkStart-${tag}-win64-portable.zip`,
      `ApkStart-${ver}-Setup.exe`,
      `ApkStart-runtime-${tag}.zip`,
    ];
    // GitHub 和 Gitee 都支持 /releases/download/<tag>/<文件名> 这种规范地址
    // （实测 Gitee 会 302 到 foruda.gitee.com của附件地址，能正常下到完整byte），
    // 所以没Có API 时也能拼出Khả dụngcủa下载地址。Gitee 上没Cócủa资产会 404，
    // 后面của测速排序会Tự động跳过它。
    const assets = names.map((n) => ({
      name: n,
      size: 0,
      browser_download_url: `${s.web}/releases/download/${tag}/${n}`,
    }));
    return {
      tag_name: tag,
      name: tag,
      body: '',
      html_url: `${s.web}/releases/tag/${tag}`,
      published_at: '',
      assets,
      synthetic: true,
    };
  }

  async fetchReleases() {
    const prefs = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const ids = prefs === 'github' || prefs === 'gitee' ? [prefs] : ['github', 'gitee'];
    // 公开仓库của releases 接口匿名就能读；仓库若是私Cócủa，Gitee 会回 404
    // "Not Found Project"（而不是 401），那种情况才Cần在这里填一cái只读 token。
    // 另外匿名调DùngCó频率限制，感兴趣củaDùng户可以填 token 提高额度。
    const token = String((this.settings().runtime || {}).giteeToken || '').trim();
    const withToken = (id, url) => (id === 'gitee' && token
      ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
      : url);

    const jobs = ids.map(async (id) => {
      const s = SOURCES[id];
      const skip = this.blockedReason(id);
      if (skip) return { source: id, name: s.name, web: s.web, error: skip };
      try {
        const rel = await getJson(withToken(id, `${s.api}/releases/latest`), 9000);
        return { source: id, name: s.name, web: s.web, rel };
      } catch (e) {
        // Gitee 没Có正式 release、或 GitHub 被墙，都退回列表取第一条
        try {
          const list = await getJson(withToken(id, `${s.api}/releases?per_page=10`), 9000);
          const first = (Array.isArray(list) ? list : []).find((r) => r && !r.draft);
          if (first) return { source: id, name: s.name, web: s.web, rel: first };
        } catch (_) { /* Tiếp tục尝试不依赖 API của兜底 */ }
        // API 被限流/被墙时của兜底：网页跳转拿 tag，资产名按约定拼
        try {
          const tag = await this._releaseTagViaRedirect(id);
          if (tag) {
            return { source: id, name: s.name, web: s.web, rel: this._syntheticRelease(id, tag), degraded: true };
          }
        } catch (_) { /* 兜底也不行 */ }
        const limited = /\b(403|429)\b/.test(e.message);
        if (limited) this._blocked.set(id, Date.now() + this._blockMs);
        const hint = limited
          ? '(bị giới hạn tốc độ, tạm ngưng dùng nguồn này một lúc)'
          : (id === 'gitee' && !token ? '(thử lại sau, hoặc điền token chỉ đọc trong Cài đặt để tăng hạn mức)' : '');
        return { source: id, name: s.name, web: s.web, error: `${e.message}${hint}` };
      }
    });
    return Promise.all(jobs);
  }

  /**
   * 合并两边của最新版本：版本号更高của胜出，但**资产列表取并集**，
   * 这样即使 Gitee 只放了元数据、资产在 GitHub，也能两条路都试。
   */
  async latest({ force = false } = {}) {
    const pref = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const cached = this._relCache;
    if (!force && cached.value && cached.key === pref && Date.now() - cached.at < this._relTtl) {
      return cached.value;
    }
    const all = await this.fetchReleases();
    // 被限流của源记入熔断（放在这里而不是 fetchReleases 内部，是为了让「谁来提供
    // 结果」这件事可被替换/测试，同时保证任何入口拿到của 403 都会触发熔断）
    for (const x of all) {
      if (x && x.error && /\b(403|429)\b/.test(x.error)) {
        this._blocked.set(x.source, Date.now() + this._blockMs);
      }
    }
    const ok = all.filter((x) => x && x.rel);
    if (!ok.length) {
      const why = all.map((x) => `${x.name || x.source}: ${x.error || 'Không có dữ liệu'}`).join('；');
      // 全挂了但手里Có上一次của结果：宁可给一份「可能是旧của」版本信息，
      // 也不要让界面直接报错 —— Dùng户至少还能看到Phiên bản hiện tại和发布页入口。
      if (cached.value) return { ...cached.value, stale: true, staleReason: why };
      throw new Error(`Không kết nối được máy chủ cập nhật (${why}）`);
    }
    ok.sort((a, b) => cmpVer(b.rel.tag_name || b.rel.name, a.rel.tag_name || a.rel.name));
    const top = ok[0];
    const tag = String(top.rel.tag_name || top.rel.name || '');
    const version = tag.replace(/^v/i, '');

    // 只Có同版本của资产才算数（不同源của旧版本资产不能拿来装）。
    // 同名整包 + Phân mảnh组同时存在时优先Dùng整包：Phân mảnh要拼装，多一cáiThất bại点。
    let raw = [];
    for (const item of ok) {
      const t = String(item.rel.tag_name || item.rel.name || '').replace(/^v/i, '');
      if (t !== version) continue;
      for (const a of (item.rel.assets || [])) {
        const key = String(a.name || '');
        if (!key) continue;
        // Gitee 会把「源码包」Tự động挂成资产（v0.3.2.zip / v0.3.2.tar.gz），
        // 这些不是Gói cài đặt，`\.zip$` của匹配规则会把它当成更新包下载下来 —— 必须排除。
        // 我们自己của发布资产统一以 ApkStart 开头，按这cái前缀白名单更安全。
        if (!/^ApkStart/i.test(key)) continue;
        raw.push({
          name: key,
          size: Number(a.size) || 0,
          url: a.browser_download_url || a.url || '',
          source: item.source,
        });
      }
    }
    const grouped = groupParts(raw);
    const wholeNames = new Set(grouped.list.filter((a) => !a.partial).map((a) => a.name));
    raw = grouped.list.filter((a) => !(a.partial && wholeNames.has(a.name)));

    // 同名资产两cái源都Có（整包不再切Phân mảnh以后就是这种常态）：把地址都留着当候Chọn。
    // 以前是「按名字去重、谁先来Dùng谁」—— GitHub 排在前面，Gitee của地址就被丢掉了，
    // 「Tự độngChọn网络更好của源」实际退化成只走 GitHub。Hiện按实测速度挑（见 rank()）。
    // 每cái地址củaLớnNhỏ单独记：两cái源của包不是同一份byte（压缩器/构建机不同，能差几 MB），
    // downloadMulti 只会混Dùng「声明总LớnNhỏ一致」của地址，所以绝不能把两者củaLớnNhỏ平均掉。
    const assets = [];
    const byName = new Map();
    for (const a of raw) {
      const hit = byName.get(a.name);
      if (!hit) {
        const item = { ...a, urls: a.url ? [a.url] : [], sizes: {} };
        if (a.url && a.size) item.sizes[a.url] = a.size;
        byName.set(a.name, item);
        assets.push(item);
        continue;
      }
      if (a.url && !hit.urls.includes(a.url)) hit.urls.push(a.url);
      if (a.url && a.size) hit.sizes[a.url] = a.size;
      if (!hit.size && a.size) hit.size = a.size;
    }

    const result = {
      version,
      tag,
      name: top.rel.name || tag,
      notes: top.rel.body || '',
      htmlUrl: top.rel.html_url || top.web,
      publishedAt: top.rel.published_at || top.rel.created_at || '',
      assets,
      sources: ok.map((x) => ({ source: x.source, name: x.name, tag: x.rel.tag_name || x.rel.name || '' })),
      unreachable: all.filter((x) => x && x.error).map((x) => ({ source: x.source, name: x.name, error: x.error })),
      bySource: top.source,
    };
    this._relCache = { at: Date.now(), key: pref, value: result };
    return result;
  }

  /**
   * 某cái资产在所Có源 + 镜像下của候Chọn地址（去重、保序：源站优先，其次镜像）。
   * 镜像只套在 GitHub của地址上：ghfast / gh-proxy 只代理 GitHub，
   * 把 Gitee của链接拼上去只会得到一cái 403，白白多测一次速。
   */
  candidates(assetOrUrl) {
    // 支持三种入参：单cái地址、资产对象（url）、合并后của资产对象（urls 数组，含两cái源）
    const urls = (typeof assetOrUrl === 'string'
      ? [assetOrUrl]
      : (assetOrUrl && (assetOrUrl.urls && assetOrUrl.urls.length ? assetOrUrl.urls : [assetOrUrl.url])))
      .filter(Boolean);
    const out = [];
    if (!urls.length) return out;
    const mirrors = mirrorList(this.settings());
    for (const url of urls) {
      if (out.includes(url)) continue;
      out.push(url);
      let host = '';
      try { host = new URL(url).host.toLowerCase(); } catch (_) { continue; }
      const isGithub = /(^|\.)github\.com$/.test(host) || /(^|\.)githubusercontent\.com$/.test(host);
      if (!isGithub) continue;
      for (const m of mirrors) {
        const u = withMirror(url, m);
        if (u && !out.includes(u)) out.push(u);
      }
    }
    return out;
  }

  /**
   * 按实测速度排序候Chọn地址。测速结果缓存 30 phút；
   * 全部测速Thất bại就退回原始顺序（保证「最坏情况还是能下」）。
   */
  async rank(urls, { onProgress } = {}) {
    const list = (urls || []).filter(Boolean);
    if (list.length <= 1) return list;
    const now = Date.now();
    const need = [];
    for (const u of list) {
      const c = this._rankCache.get(u);
      if (!c || now - c.at > this._rankTtl) need.push(u);
    }
    if (need.length) {
      onProgress?.({ stage: 'probe', message: `Đang đo tốc độ ${need.length}  nguồn tải…` });
      // 顺序测而不是并发测：并发会互相抢带宽，测出来của名次变成「谁抢得凶」，
      // 而不是「谁真của快」。每cái源 256KB，正常也就一秒左右。
      // 单cái源最多等 6 秒就放弃（旧版 9 秒 × 4 cái源 = 最长 36 秒没Có任何byte进度，
      // Dùng户看到của就是「卡在准备Bộ chạy」）；测速Thất bại只会排到最后，不影响能下载。
      let i = 0;
      for (const u of need) {
        i += 1;
        let host = u;
        try { host = new URL(u).host; } catch (_) { /* 地址不合法就原样显示 */ }
        onProgress?.({ stage: 'probe', message: `Đang đo tốc độ lần ${i}/${need.length}  nguồn:${host}…` });
        // eslint-disable-next-line no-await-in-loop
        const r = await measure(u, { timeoutMs: 6000 });
        this._rankCache.set(u, { at: Date.now(), ok: r.ok, speed: r.speed });
      }
    }
    const score = (u) => {
      const c = this._rankCache.get(u);
      return c && c.ok ? c.speed : -1;
    };
    const sorted = list.slice().sort((a, b) => score(b) - score(a));
    const best = sorted[0];
    const s = score(best);
    if (s > 0) {
      onProgress?.({
        stage: 'probe',
        message: `Đã chọn nguồn nhanh nhất:${new URL(best).host}(khoảng ${(s / 1048576).toFixed(2)} MB/s）`,
      });
    }
    return sorted;
  }

  /** 测速缓存清Trống（Dùng户改了镜像前缀 / 换了网络后调Dùng） */
  reset() {
    this._rankCache.clear();
    this._relCache = { at: 0, key: '', value: null };
    this._blocked.clear();
  }
}

module.exports = { Sources, SOURCES, measure, KNOWN_MIRRORS, withMirror, mirrorList };
