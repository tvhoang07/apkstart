# ApkStart tiếng Việt

Bản giao diện tiếng Việt của [ApkStart](https://github.com/RoutineMiku/apkstart) (tác giả RoutineMiku, giấy phép MIT), dịch từ phiên bản **v0.5.8**.
ApkStart chạy ứng dụng Android (.apk) trên Windows 10/11, mỗi ứng dụng một cửa sổ và một biểu tượng riêng.

Nhánh này chỉ thay chữ hiển thị, không đổi chức năng. Bản dịch làm bằng máy rồi rà lại, nên có thể còn câu chưa mượt. Mời góp ý qua Issues.

## Dùng ngay với bản đã tải

1. Tải bản `ApkStart-v0.5.8-win64-portable.zip` ở [trang phát hành gốc](https://github.com/RoutineMiku/apkstart/releases/tag/v0.5.8) và giải nén.
2. Tải nhánh này (nút **Code → Download ZIP**).
3. Chép đè thư mục `src` của nhánh này vào `resources\app\src` trong thư mục vừa giải nén.
4. Mở `ApkStart.exe`.

Nếu bấm **Kiểm tra cập nhật** trong ứng dụng, bản mới sẽ ghi đè và giao diện quay lại tiếng Trung.

## Dịch phiên bản mới hơn

Cần Python 3. Chạy trong thư mục `resources\app` của bản mới (hoặc thư mục gốc mã nguồn):

```
python đường-dẫn\i18n-vi\apply-vi.py .
```

Đoạn chữ có trong `vi.json` sẽ được thay, đoạn mới chưa có thì giữ nguyên tiếng Trung.

## Lưu ý khi chạy

- Windows 11 bật **Smart App Control** sẽ chặn `ApkStart.exe` vì file chưa ký số.
- Cần bật tăng tốc phần cứng: vào **Cài đặt → Kiểm tra môi trường → Sửa** (cần quyền admin và khởi động lại máy một lần).
