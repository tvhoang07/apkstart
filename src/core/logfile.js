'use strict';
/**
 * 轻量Nhật ký写入 + 滚动。
 *
 * 以前 app.log / emulator.log 是纯 append，长期使Dùng会一直长：
 * emulator 每次开机của内nhânNhật ký就Có几十 KB，一天开关十几次、再加上 qemu của
 * verbose 输出，几cái月就是几百 MB —— 磁盘就是这么被悄悄吃掉của。
 * 这里按LớnNhỏ滚动，只保留一份 .1.log 备份，上限由Cài đặttrong「Nhật ký上限」控制。
 */
const fs = require('fs');
const path = require('path');

const counters = new Map();

function rotate(file, limitKB) {
  try {
    const st = fs.statSync(file);
    if (st.size < limitKB * 1024) return false;
    const bak = file.replace(/\.log$/i, '.1.log');
    // 文件名不以 .log 结尾时 bak 会等于原文件：先删后 rename 就把Nhật ký删没了。
    // 显式跳过这种边界，宁可Nhật kýLớn一点也不能丢。
    if (path.resolve(bak) === path.resolve(file)) return false;
    try { fs.rmSync(bak, { force: true }); } catch (_) { /* ignore */ }
    fs.renameSync(file, bak);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} file Mục tiêuNhật ký
 * @param {string} line 一行内容（Tự động补换行）
 * @param {number} [limitKB] 超过这cáiLớnNhỏ就滚动
 */
function append(file, line, limitKB = 2048) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const n = (counters.get(file) || 0) + 1;
    counters.set(file, n);
    // 每次进程启动检查一次，之后每 200 行检查一次（statSync 很便宜，但没必要每行都做）
    if (n === 1 || n % 200 === 0) rotate(file, Math.max(256, Number(limitKB) || 2048));
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

/** 启动时Dọn dẹp：把过LớncủaNhật ký先滚掉（不看计数器） */
function trimNow(file, limitKB = 2048) {
  return rotate(file, Math.max(256, Number(limitKB) || 2048));
}

module.exports = { append, rotate, trimNow };
