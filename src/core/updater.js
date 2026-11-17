'use strict';
/**
 * 在线更新：从 GitHub Releases（RoutineMiku/apkstart）取最新版本，下载并原地替换。
 *
 * 三cái形态都要照顾到：
 *   - Cài đặt版（NSIS）：下载 `ApkStart-x.y.z-Setup.exe`，静默Cài đặt（/S）；
 *   - 轻量版（便携 zip，Bộ chạy按需下载）：下载 `ApkStart-vX-win64-portable.zip`，
 *     Giải nén后覆盖程序目录 —— Thư mục bộ chạy (%APPDATA%\apkstart\runtime）与Ứng dụng đã cài、
 *     快照全都在Dùng户目录里，替换程序文件不会动它们；
 *   - 完整版（便携但带 runtime）：同轻量版，只是目录里多了 resources\runtime。
 *
 * 替换不能在本进程里做（exe 正被占Dùng），所以生成一段 PowerShell 脚本，
 * Dùng EncodedCommand 交给独立进程：等本进程Thoát → 复制文件 → 重新拉起。
 * Dùng base64 传脚本而不是写 .ps1 文件，是为了绕开「Đường dẫn含中文时脚本被按 GBK 解码」
 * 这类老问题（PowerShell 5.1 读无 BOM 脚本会按 ANSI 解释）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadAnyParallel, downloadMulti } = require('./download');
const { ZipFile, resolveZipEntry } = require('./zip');
const { cmpVer } = require('./version');
const { Sources } = require('./sources');

const OWNER = 'RoutineMiku';
const REPO = 'apkstart';

/** PowerShell 单引号字符串：内部của ' 要写成 '' */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** 在目录第一层里按名字（LớnNhỏ写不敏感）找文件，返回实际名字或 null */
function findInDir(dir, name) {
  try {
    const lower = name.toLowerCase();
    return fs.readdirSync(dir).find((n) => n.toLowerCase() === lower) || null;
  } catch (_) {
    return null;
  }
}

/**
 * 在程序目录里找 NSIS Gỡ cài đặt器，Không tìm thấy返回 null。
 * electron-builder của默认命名是 `Uninstall <productName>.exe`（updater.flavor 认这cái），
 * 老版本/自定义打包也可能叫 `uninstaller.exe`（main.js 旧代码只认这cái）。
 * 两处必须Dùng同一套规则，否则Cài đặt版点「Gỡ cài đặt một chạm」会被误判成便携版（issue #51）。
 */
function findUninstaller(installDir) {
  try {
    const names = fs.readdirSync(installDir);
    return names.find((n) => /^Uninstall .*\.exe$/i.test(n))
      || names.find((n) => /^uninstall(er)?\.exe$/i.test(n))
      || null;
  } catch (_) {
    return null;
  }
}

class Updater {
  /**
   * @param {{currentVersion:string, exePath:string, isPackaged:boolean, dataDir:string,
   *          onProgress?:Function}} o
   */
  constructor(o) {
    this.current = o.currentVersion || '0.0.0';
    this.exePath = o.exePath;
    this.installDir = path.dirname(o.exePath || '');
    this.isPackaged = !!o.isPackaged;
    this.dataDir = o.dataDir;
    this.onProgress = o.onProgress || (() => {});
    this.settings = typeof o.settings === 'function' ? o.settings : () => (o.settings || {});
    // settings() 给 sources Dùng：决定「走 GitHub 还是 Gitee」「Có没Có镜像前缀」
    this.sources = new Sources(this.settings);
    this.latest = null;
    this._last = null;
  }

  /** Cài đặt形态：Cài đặt版（CóGỡ cài đặt器）还是便携包 */
  get flavor() {
    return findUninstaller(this.installDir) ? 'setup' : 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /**
   * Kiểm tra cập nhật：GitHub / Gitee 并发问，取版本号更高của，资产取并集。
   * 具体下载地址在 prepare() 里再做一次真实测速排序。
   */
  /**
   * @param {{force?:boolean}} [opts] force=true 时跳过 10 phútcủa版本缓存
   *        （Dùng户主动点「Kiểm tra cập nhật」应该拿到最新结果；启动时của静默检查走缓存）
   */
  async check(opts = {}) {
    const merged = await this.sources.latest({ force: !!opts.force });
    const pick = (re) => merged.assets.find((a) => re.test(String(a.name || '')));
    // 发行版里同时挂着「便携包」和「Toàn bộ gói bộ chạy」（ApkStart-runtime-*.zip）。
    // 兜底của .zip 匹配必须把Toàn bộ gói bộ chạy排除掉：某次发布如果只CóToàn bộ gói bộ chạy、
    // 没Có便携包，旧逻辑会把它当更新包Giải nén进程序目录（多出 1.5GB 文件、程序也被换坏）。
    const isRuntimePack = (a) => /runtime/i.test(String((a && a.name) || ''));

    const wantSetup = this.flavor === 'setup';
    const asset = wantSetup
      ? (pick(/Setup\.exe$/i) || merged.assets.find((a) => /\.exe$/i.test(a.name) && !isRuntimePack(a)))
      : (pick(/portable.*\.zip$/i) || pick(/win64.*\.zip$/i)
        || merged.assets.find((a) => /\.zip$/i.test(a.name) && !isRuntimePack(a)));

    this.latest = {
      version: merged.version,
      tag: merged.tag,
      name: merged.name,
      notes: merged.notes,
      htmlUrl: merged.htmlUrl,
      publishedAt: merged.publishedAt,
      // 注意带上 parts：Gitee củaPhân mảnh包没Có单一 url，丢掉 parts 就变成「Có资产但没地址」
      asset: asset
        ? {
          name: asset.name,
          size: asset.size,
          url: asset.url,
          // 同名资产在 GitHub / Gitee 都Có：两cái地址都带着，prepare() 里测速择快。
          // sizes 是「每cái地址各自củaLớnNhỏ」——两cái源压出来củabyte数并不相同。
          urls: asset.urls,
          sizes: asset.sizes,
          source: asset.source,
          parts: asset.parts,
          partial: asset.partial,
        }
        : null,
      assets: merged.assets,
      // 两cái源各自của最新版本 / 谁Không truy cập được，界面上可以如实显示「这次走của哪cái源」
      sources: merged.sources,
      unreachable: merged.unreachable,
      flavor: this.flavor,
      hasUpdate: cmpVer(merged.tag, this.current) > 0,
      current: this.current,
      canAutoApply: !!asset && (!!asset.url || !!(asset.parts && asset.parts.length)),
    };
    this._last = this.latest;
    return this.latest;
  }

  /**
   * 下载并准备好「载荷」：便携版Giải nén到 update/<ver>/payload，Cài đặt版直接留 Setup.exe。
   * @returns {Promise<{mode:'zip'|'setup', payload:string, version:string}>}
   */
  async prepare(info) {
    const it = info || this.latest;
    if (!it || !it.asset) throw new Error('Phiên bản này không có gói cài đặt tự động, hãy tải thủ công ở trang phát hành GitHub');
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, it.asset.name);
    let total = it.asset.size || 0;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    // Gitee 附件单文件上限 100MB，所以发布时会把包切成 .part1/.part2。
    // 每cáiPhân mảnh单独测速Chọn源（可以一部分来自 Gitee、一部分来自 GitHub 镜像），
    // 下完按顺序拼回整包 —— 对Dùng户来说仍然只是「下载 + Giải nén」。
    if (it.asset.parts && it.asset.parts.length) {
      await this._downloadParts(it.asset, file, conns, total);
    } else {
      this.onProgress({ stage: 'download', percent: 1, message: `Đang tải xuống ${it.asset.name}…` });
      // 候Chọn地址 = 源站 + 镜像前缀；先各下 256KB 实测速度，再拿最快của那cái分块下载。
      // 这是「GitHub 直连几十 KB/s、镜像能跑几 MB/s」时唯一靠谱củaChọn路方式：
      // 按域名猜没Dùng，同一天不同时段差别很Lớn。
      const cands = this.sources.candidates(it.asset);
      const ranked = await this.sources.rank(cands, { onProgress: (p) => this.onProgress(p) }).catch(() => cands);
      // 进度Dùngcủa总LớnNhỏ要取「真正在下那cái源」của：GitHub 与 Gitee của包不是同一份byte
      // （压缩器不同，能差好几 MB），拿错就会一直显示 92% 再突然跳到Hoàn tất。
      const sizes = it.asset.sizes || {};
      for (const u of ranked) {
        if (sizes[u]) { total = sizes[u]; break; }
      }
      // downloadMulti：分块同时从「GitHub 直连」和「镜像」拉，带宽叠加；
      // 只Có一cái源Khả dụng或对方Không hỗ trợ Range 时，它自己退回单源分块。
      await downloadMulti(ranked, file, {
        connections: conns,
        onProgress: (pr) => {
          const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
          const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
          const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
          this.onProgress({
            stage: 'download',
            percent: Math.max(1, Math.min(99, pct)),
            message: `Đang tải ${mb}${sp}`,
            speed: pr.speed,
          });
        },
      });
    }

    if (/\.zip$/i.test(file)) {
      const out = path.join(dir, 'payload');
      // issue #98：上一次已经下载+Giải nénHoàn tất，但替换/重启没成功时，
      // 直接复Dùng这份载荷，绝不再下一遍 100MB —— 这正是「更新死循环」của来源。
      // Sẵn sàng标记由本函数写、替换脚本成功后清掉，所以只Có完整Giải nén过của载荷才会被复Dùng。
      if (this._payloadReady(out, it.version)) {
        this.onProgress({ stage: 'ready', percent: 100, message: 'Đã có gói cập nhật tải sẵn, dùng lại trực tiếp' });
        return { mode: 'zip', payload: out, version: it.version };
      }
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await this._extract(file, out);
      this._markPayloadReady(out, it.version);
      this.onProgress({ stage: 'ready', percent: 100, message: 'Đã giải nén xong gói cập nhật' });
      return { mode: 'zip', payload: out, version: it.version };
    }
    this.onProgress({ stage: 'ready', percent: 100, message: 'Đã tải xong gói cài đặt' });
    return { mode: 'setup', payload: file, version: it.version };
  }

  /**
   * 下载并拼装Phân mảnh包。
   * @param {{name:string, size:number, parts:Array<{index:number,size:number,urls:string[]}>}} asset
   */
  async _downloadParts(asset, target, conns, total) {
    const dir = path.dirname(target);
    let doneBytes = 0;
    const fd = fs.openSync(target, 'w');
    try {
      for (const part of asset.parts) {
        const tmp = path.join(dir, `${asset.name}.${part.index}.tmp`);
        const cands = [];
        for (const u of part.urls) {
          for (const c of this.sources.candidates(u)) if (!cands.includes(c)) cands.push(c);
        }
        // eslint-disable-next-line no-await-in-loop
        const ranked = await this.sources.rank(cands, {
          onProgress: (p) => this.onProgress({ ...p, percent: Math.max(1, Math.min(99, Math.round((doneBytes / (total || 1)) * 100))) }),
        }).catch(() => cands);
        // eslint-disable-next-line no-await-in-loop
        await downloadAnyParallel(ranked, tmp, {
          connections: conns,
          onProgress: (pr) => {
            const got = doneBytes + (pr.got || 0);
            const pct = total ? Math.round((got / total) * 100) : 0;
            const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
            this.onProgress({
              stage: 'download',
              percent: Math.max(1, Math.min(99, pct)),
              message: `Đang tải ${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`
                + `(thứ ${part.index}/${asset.parts.length} mảnh)${sp}`,
              speed: pr.speed,
            });
          },
        });
        const buf = fs.readFileSync(tmp);
        if (part.size && buf.length !== part.size) {
          throw new Error(`Phân mảnh ${part.index} Kích thước không đúng (${buf.length} ≠ ${part.size}), đã hủy, có thể thử lại`);
        }
        fs.writeSync(fd, buf, 0, buf.length, doneBytes);
        doneBytes += buf.length;
        fs.rmSync(tmp, { force: true });
      }
    } finally {
      fs.closeSync(fd);
    }
    if (total && doneBytes !== total) {
      throw new Error(`Kích thước sau khi ghép gói cập nhật không đúng (${doneBytes} ≠ ${total}), đã hủy, có thể thử lại`);
    }
  }

  async _extract(zipPath, dest) {
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names().filter((n) => !n.endsWith('/'));
      let i = 0;
      for (const n of names) {
        i += 1;
        // 防 zip-slip：统一走 zip.js của守卫（挡 ../、绝对Đường dẫn、盘符、反斜杠绕过）
        const target = resolveZipEntry(dest, n);
        if (!target) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await zf.pipeTo(n, fs.createWriteStream(target));
        if (i % 20 === 0) {
          this.onProgress({
            stage: 'extract',
            percent: Math.min(99, Math.round((i / names.length) * 100)),
            message: `Đang giải nén ${i}/${names.length}`,
          });
        }
      }
    } finally {
      try { zf.close(); } catch (_) { /* ignore */ }
    }
  }

  /** 载荷Sẵn sàng标记文件：Giải nén完整落盘后才写，供跨进程复Dùng判断 */
  _readyFile(payload) { return path.join(payload, '.apkstart-ready'); }

  _markPayloadReady(payload, version) {
    try {
      fs.writeFileSync(this._readyFile(payload), JSON.stringify({ version, at: Date.now() }), 'utf8');
    } catch (_) { /* 标记写不了就下次重下，不影响正确性 */ }
  }

  _payloadReady(payload, version) {
    try {
      if (!fs.existsSync(this._readyFile(payload))) return false;
      const m = JSON.parse(fs.readFileSync(this._readyFile(payload), 'utf8'));
      // 版本不符 = Lần trước下của是别của版本，不能复Dùng
      if (m.version !== version) return false;
      // 关键：程序主 exe 必须在载荷里。没Có它说明Giải nén被中断/被杀软删过。
      const exeName = path.basename(this.exePath || 'ApkStart.exe');
      return !!findInDir(payload, exeName);
    } catch (_) {
      return false;
    }
  }

  /**
   * 启动时调Dùng：找回「Lần trướcĐã tải xuốngGiải nén、但替换/重启Thất bại」của更新并续做。
   * 直接走本地载荷，不再重新下载（issue #98 của死循环根治）。
   * @returns {{mode:'zip', payload:string, version:string}|null}
   */
  findResumableJob() {
    try {
      if (!fs.existsSync(this.updateDir)) return null;
      const versions = fs.readdirSync(this.updateDir)
        .filter((n) => cmpVer(n, this.current) > 0)   // 只认比当前更新của版本，避免反复重启
        .sort((a, b) => cmpVer(b, a));
      for (const v of versions) {
        const payload = path.join(this.updateDir, v, 'payload');
        if (this._payloadReady(payload, v)) return { mode: 'zip', payload, version: v };
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  /**
   * 生成并启动「替换 + 重启」脚本，然后调Dùng方负责ThoátÁp dụng。
   * @param {{mode:'zip'|'setup', payload:string, version:string}} job
   * @param {{waitPid?:number, spawn?:boolean}} [opts] 测试时可指定别của pid / 不真启动
   */
  apply(job, opts = {}) {
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      `Note 'updater start'`,
      `$applyOk = $true`,
      // 等本进程真正Thoát（最多 90 giây)，否则 exe/dll 仍被占Dùng
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      // issue #98：旧脚本只测「Mục tiêu exe 是否存在」——它本来就存在，于是 copy
      // Thất bại也被当成成功，接着删掉载荷、重启旧版本 → 下次开机又检测到更新 → 死循环。
      // 改成：复制前先把Mục tiêu exe 改名成 .old，复制后Xác nhận新 exe 真của落盘且byte数
      // 与载荷一致；Thất bại则回滚 .old，并**保留载荷**交给下次启动续做。
      const exeName = path.basename(exe);
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$exeName = ${psq(exeName)}`,
        `$target = Join-Path $dst $exeName`,
        `$srcExe = Join-Path $src $exeName`,
        `$expected = (Get-Item $srcExe).Length`,
        `$backup = "$target.old"`,
        `$hasBackup = $false`,
        `if (Test-Path $target) {`,
        `  try { Move-Item -LiteralPath $target -Destination $backup -Force; $hasBackup = $true } catch { Note "backup failed: $_" }`,
        `}`,
        `$ok = $false`,
        `for ($i = 1; $i -le 12; $i++) {`,
        `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
        `  if ((Test-Path $target) -and ((Get-Item $target).Length -eq $expected)) { $ok = $true; Note "copy pass $i ok"; break }`,
        `  Note "copy pass $i failed, retry"; Start-Sleep -Milliseconds 600`,
        `}`,
        `if (-not $ok) {`,
        `  Note 'copy FAILED - keeping payload for next launch'`,
        `  $applyOk = $false`,
        `  if ($hasBackup) { try { Move-Item -LiteralPath $backup -Destination $target -Force } catch {} }`,
        `} else {`,
        `  if ($hasBackup) { try { Remove-Item -LiteralPath $backup -Force } catch {} }`,
        // 只CóXác nhận复制成功，才清掉载荷与Sẵn sàng标记；否则留给 findResumableJob 续做。
        `  try { Remove-Item -LiteralPath (Join-Path $src '.apkstart-ready') -Force } catch {}`,
        `  Remove-Item -Path $src -Recurse -Force`,
        `}`,
      );
    } else {
      lines.push(
        `Note 'run installer'`,
        `$p = Start-Process -FilePath ${psq(job.payload)} -ArgumentList '/S' -PassThru -Wait`,
        `Note ("installer exit " + $p.ExitCode)`,
        `Start-Sleep -Milliseconds 800`,
      );
    }

    lines.push(
      // issue #98：只 Start-Process 一次、Thất bại就无声无息 → Dùng户看到「关了但没重启」。
      // 加 -WorkingDirectory（便携版相对Đường dẫn资源），Thất bại再退回 cmd /c start，并写Nhật ký。
      `if (Test-Path ${psq(exe)}) {`,
      `  try {`,
      `    Start-Process -FilePath ${psq(exe)} -WorkingDirectory ${psq(dir)} -ErrorAction Stop`,
      `    Note 'relaunched via Start-Process'`,
      `  } catch {`,
      `    Note ("Start-Process failed: " + $_.Exception.Message + "; fallback to cmd start")`,
      `    try {`,
      `      Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','start','""',${psq(exe)} -WorkingDirectory ${psq(dir)} -WindowStyle Hidden`,
      `      Note 'relaunched via cmd start'`,
      `    } catch { Note ("cmd start failed: " + $_.Exception.Message) }`,
      `  }`,
      `} else { Note 'relaunch skipped: exe missing' }`,
      `Note 'updater done'`,
      `Start-Sleep -Milliseconds 400`,
      // 复制Thất bại时保留整cái版本目录（载荷 + Sẵn sàng标记），交给下次启动续做；
      // 否则会前脚说「保留载荷」后脚又把它删掉，续做永远拿不到文件。
      `if ($applyOk) { Remove-Item -Path ${psq(path.join(this.updateDir, job.version))} -Recurse -Force }`,
      `else { Note 'version dir kept for resume on next launch' }`,
      // 收尾củaDọn dẹp语句Thất bại（目录已被删/被杀软占Dùng）不应该让调Dùng方以为Cập nhật thất bại
      `exit 0`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    // -EncodedCommand 走 UTF-16LE base64：脚本里出现中文Đường dẫn也不会被 GBK 解码搞坏
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // 这里**不能**Dùng detached：某些安全软件 / 沙箱策略会直接拦掉「分离của控制台进程」，
    // 表现为脚本一声不响地根本没跑（更新界面卡在「正在替换程序并重启」）。
    // Windows 上父进程Thoát并不会杀掉普通子进程，所以Dùng「普通子进程 + unref」同样能在
    // 我们Thoát之后Tiếp tục干活，Tương thích性还更好。
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }

  /** 打不开 UI của场景（或没Có可Tự độngCài đặtcủa资产）时，把发布页丢给Duyệt器 */
  static repoUrl() {
    return `https://github.com/${OWNER}/${REPO}/releases`;
  }
}

module.exports = { Updater, cmpVer, OWNER, REPO, findUninstaller };
