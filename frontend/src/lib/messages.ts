/** SRS Appendix B. */
export const MSG = {
  "MSG-01": "Email không hợp lệ.",
  "MSG-02": "Mật khẩu phải có từ 8 đến 72 ký tự.",
  "MSG-03": "Email này đã được đăng ký. Hãy đăng nhập hoặc dùng email khác.",
  "MSG-04": "Email hoặc mật khẩu không đúng.",
  "MSG-05": "Bạn đã thử quá nhiều lần. Vui lòng thử lại sau ít phút.",
  "MSG-06": "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  "MSG-07": "Họ tên không được để trống và tối đa 255 ký tự.",
  "MSG-08": "Ảnh đại diện phải là JPEG, PNG hoặc WebP.",
  "MSG-09": "Ảnh đại diện không được vượt quá 2 MB.",
  "MSG-10": "Chỉ hỗ trợ tệp PDF hoặc EPUB.",
  "MSG-11": "Tệp vượt quá giới hạn 50 MB.",
  "MSG-12": "Không thể tải tệp lên. Vui lòng thử lại.",
  "MSG-13": "Không mở được tệp. Tệp có thể bị hỏng.",
  "MSG-14": "PDF được bảo vệ bằng mật khẩu nên không thể trích xuất nội dung.",
  "MSG-15": "Không tìm thấy văn bản trong tài liệu (có thể là bản scan). Bạn vẫn có thể xem bản gốc.",
  "MSG-16": "Đường link không hợp lệ. Link phải bắt đầu bằng http:// hoặc https://.",
  "MSG-17": "Không thể lưu đường link này.",
  "MSG-18": "Không truy cập được trang web. Kiểm tra lại đường link hoặc thử lại sau.",
  "MSG-18-REFUSED": "Trang web này không cho phép PureMind tải nội dung. Bạn có thể lưu trang thành PDF (Ctrl+P) rồi tải lên.",
  "MSG-19": "Không tìm thấy tài liệu.",
  "MSG-20": "Đã lưu thay đổi.",
  "MSG-21": "Không thể mở tài liệu này.",
  "MSG-22": "Đoạn chọn quá dài. Hãy chọn tối đa 5.000 ký tự.",
  "MSG-23": "Không thể lưu. Kiểm tra kết nối và thử lại.",
  "MSG-24": "Ghi chú tối đa 10.000 ký tự.",
  "MSG-25": "Bạn đã dùng hết lượt AI hôm nay. Lượt sẽ được làm mới lúc 00:00.",
  "MSG-26": "Dịch vụ AI đang gặp sự cố. Vui lòng thử lại sau ít phút.",
  "MSG-27": "Hãy chọn ít nhất một highlight.",
  "MSG-28": "Chỉ có thể chọn tối đa 100 highlight cho một notebook.",
  "MSG-29": "Notebook vượt quá giới hạn độ dài.",
  "MSG-30": "Thư viện của bạn đang trống.",
  "MSG-31": "0 kết quả.",
  "MSG-32": "Chưa có highlight nào.",
  "MSG-33": "Tài liệu này chưa có bản tóm tắt.",
  "MSG-34": "Bạn cần tạo highlight trước khi tạo notebook.",
  "MSG-35": "Chưa có notebook nào.",
  "MSG-36": "Không tìm thấy kết quả phù hợp. Thử từ khóa khác hoặc bỏ bộ lọc.",
  "MSG-99": "Đã có lỗi xảy ra. Vui lòng thử lại.",
} as const;

export type MsgCode = keyof typeof MSG;

export function messageFor(code: string | null | undefined): string {
  return (code && MSG[code as MsgCode]) || MSG["MSG-99"];
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
