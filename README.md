# GymHome Demo

Hệ thống demo cho GymHome - quản lý phòng gym 5 tầng với database và giao diện thân thiện.

## Tính năng

- **Đăng nhập**: Cho admin, lễ tân, PT (database)
- **Đăng ký hội viên**: Với validation số điện thoại (10 số, số mạng hợp lệ)
- **Sinh mã QR động**: Cho truy cập
- **Kiểm soát truy cập**: Theo tầng, loại hội viên, hạn sử dụng
- **Quản lý buổi tập PT**: Xem, xác nhận, trừ buổi tập
- **Cấu hình thiết bị**: Cập nhật IP với validation IPv4
- **Dashboard**: Báo cáo mật độ tầng (1 giờ gần đây)
- **Cảnh báo hệ thống**: 
  - Thẻ sắp hết hạn (< 5 ngày)
  - Buổi PT sắp hết (< 2 buổi)
- **Báo cáo doanh thu**: Thống kê hội viên, truy cập, PT xác nhận
- **Session management**: Giữ đăng nhập 24h
- **Responsive**: Hoạt động trên điện thoại

## Cài đặt

1. npm install
2. npm start
3. Mở http://localhost:3000

## Tài khoản demo

- **Admin**: admin/admin → Dashboard quản trị
- **Lễ tân**: letan/letan → Dashboard lễ tân  
- **PT**: pt/pt → Dashboard PT
- **Hội viên**: member/member → Dashboard hội viên

## Session Management

- Đăng nhập sẽ được lưu trong session (24 giờ)
- Không cần đăng nhập lại khi refresh hoặc quay lại
- Sử dụng nút "Đăng xuất" để thoát

## Giao diện

- Responsive cho điện thoại và máy tính
- Dashboard riêng cho từng vai trò
- Giao diện thân thiện, dễ dùng