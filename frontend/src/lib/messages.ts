/**
 * SRS Appendix B, in both languages.
 *
 * `MSG["MSG-99"]` still reads like a plain dictionary at every call site; it answers in the language
 * the user has chosen, read at the moment of the lookup. That is what error handlers want — they
 * build a string once and keep it — while anything rendered directly should go through `useMsg()`
 * so it follows a change of language.
 */

import { usePreferences } from "./preferences";

export const MSG_VI = {
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
  // Chat with a document: added after SRS v1.1, so these codes are named rather than numbered.
  "MSG-CHAT-EMPTY": "Câu hỏi không được để trống.",
  "MSG-CHAT-LONG": "Câu hỏi tối đa 2.000 ký tự.",
  "MSG-CHAT-QUOTA": "Bạn đã dùng hết lượt hỏi AI hôm nay. Lượt sẽ được làm mới lúc 00:00.",
  "MSG-CHAT-FULL": "Cuộc trò chuyện này đã quá dài. Hãy bắt đầu cuộc trò chuyện mới.",
  "MSG-CHAT-NOT-FOUND": "Không tìm thấy cuộc trò chuyện.",
  "MSG-CHAT-NO-TEXT": "Tài liệu này chưa có văn bản để trò chuyện.",
  "MSG-99": "Đã có lỗi xảy ra. Vui lòng thử lại.",
  // The server was never reached; not in SRS Appendix B because it never leaves the browser.
  "MSG-NET": "Không kết nối được máy chủ. Kiểm tra kết nối và thử lại.",
} as const;

export type MsgCode = keyof typeof MSG_VI;

export const MSG_EN: Record<MsgCode, string> = {
  "MSG-01": "That email address is not valid.",
  "MSG-02": "A password must be between 8 and 72 characters.",
  "MSG-03": "This email is already registered. Sign in, or use another address.",
  "MSG-04": "That email or password is wrong.",
  "MSG-05": "Too many attempts. Please try again in a few minutes.",
  "MSG-06": "Your session has expired. Please sign in again.",
  "MSG-07": "A display name is required and can be at most 255 characters.",
  "MSG-08": "The profile picture must be a JPEG, PNG or WebP image.",
  "MSG-09": "The profile picture must be 2 MB or smaller.",
  "MSG-10": "Only PDF and EPUB files are supported.",
  "MSG-11": "The file is larger than the 50 MB limit.",
  "MSG-12": "The file could not be uploaded. Please try again.",
  "MSG-13": "The file could not be opened. It may be damaged.",
  "MSG-14": "This PDF is password-protected, so its text cannot be read.",
  "MSG-15": "No text was found in this document (it may be a scan). You can still read the original.",
  "MSG-16": "That link is not valid. It has to start with http:// or https://.",
  "MSG-17": "This link cannot be saved.",
  "MSG-18": "The page could not be reached. Check the link or try again later.",
  "MSG-18-REFUSED":
    "This site does not let PureMind fetch its pages. You can save the page as a PDF (Ctrl+P) and upload it.",
  "MSG-19": "Document not found.",
  "MSG-20": "Changes saved.",
  "MSG-21": "This document could not be opened.",
  "MSG-22": "That selection is too long. Please select at most 5,000 characters.",
  "MSG-23": "Could not save. Check your connection and try again.",
  "MSG-24": "A note can be at most 10,000 characters.",
  "MSG-25": "You have used all of today's AI credits. They are renewed at midnight.",
  "MSG-26": "The AI service is having trouble. Please try again in a few minutes.",
  "MSG-27": "Please select at least one highlight.",
  "MSG-28": "A notebook can be built from at most 100 highlights.",
  "MSG-29": "The notebook is longer than the limit.",
  "MSG-30": "Your library is empty.",
  "MSG-31": "0 results.",
  "MSG-32": "No highlights yet.",
  "MSG-33": "This document has no summary yet.",
  "MSG-34": "Make some highlights before building a notebook.",
  "MSG-35": "No notebooks yet.",
  "MSG-36": "Nothing matched. Try another keyword or clear the filters.",
  "MSG-CHAT-EMPTY": "The question cannot be empty.",
  "MSG-CHAT-LONG": "A question can be at most 2,000 characters.",
  "MSG-CHAT-QUOTA": "You have used all of today's chat credits. They are renewed at midnight.",
  "MSG-CHAT-FULL": "This conversation has grown too long. Please start a new one.",
  "MSG-CHAT-NOT-FOUND": "Conversation not found.",
  "MSG-CHAT-NO-TEXT": "This document has no text to chat about.",
  "MSG-99": "Something went wrong. Please try again.",
  "MSG-NET": "The server could not be reached. Check your connection and try again.",
};

const TABLES = { vi: MSG_VI, en: MSG_EN } as const;

export function messageIn(lang: "vi" | "en", code: MsgCode): string {
  return TABLES[lang][code] ?? MSG_VI[code];
}

/**
 * The messages, in the language chosen right now. A Proxy rather than a plain object so the 70-odd
 * `MSG["MSG-xx"]` call sites did not have to change when the app became bilingual.
 */
export const MSG = new Proxy({} as Record<MsgCode, string>, {
  get: (_t, code: string) => messageIn(usePreferences.getState().language, code as MsgCode),
  has: (_t, code: string) => code in MSG_VI,
  ownKeys: () => Reflect.ownKeys(MSG_VI),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

export function messageFor(code: string | null | undefined): string {
  return (code && code in MSG_VI ? MSG[code as MsgCode] : null) || MSG["MSG-99"];
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
