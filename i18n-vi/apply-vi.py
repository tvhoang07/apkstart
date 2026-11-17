"""Dịch giao diện ApkStart sang tiếng Việt bằng từ điển vi.json.

Cách dùng (chạy ở thư mục gốc repo, hoặc thư mục resources/app của bản đã cài):
    python i18n-vi/apply-vi.py .
Script thay từng đoạn chữ Trung trong src/**/*.js và src/**/*.html bằng bản dịch,
đoạn dài thay trước. Đoạn nào chưa có trong từ điển thì giữ nguyên.
"""
import glob
import json
import os
import re
import sys

root = sys.argv[1] if len(sys.argv) > 1 else '.'
here = os.path.dirname(os.path.abspath(__file__))
m = json.load(open(os.path.join(here, 'vi.json'), encoding='utf-8'))
rx = re.compile('|'.join(re.escape(k) for k in sorted(m, key=len, reverse=True)))
files = glob.glob(os.path.join(root, 'src', '**', '*.js'), recursive=True) + \
    glob.glob(os.path.join(root, 'src', '**', '*.html'), recursive=True)
changed = 0
for f in files:
    s = open(f, encoding='utf-8').read()
    t = rx.sub(lambda mo: m[mo.group(0)], s)
    if f.endswith('index.html'):
        t = t.replace('<html lang="zh-CN">', '<html lang="vi">')
    if t != s:
        open(f, 'w', encoding='utf-8', newline='').write(t)
        changed += 1
print('Đã dịch', changed, 'file')
