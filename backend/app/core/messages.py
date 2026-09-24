"""User-facing messages (SRS Appendix B), in the language the request asked for.

`MSG["MSG-10"]` keeps reading like a plain dictionary at every call site, but resolves against the
language of the request being served, which `language_middleware` puts in a context variable.
"""

from contextvars import ContextVar
from typing import Literal

Language = Literal["vi", "en"]
DEFAULT_LANGUAGE: Language = "vi"

VI: dict[str, str] = {
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
    # MSG-18 when the site answers 401/403/429...: retrying will not help (not in SRS Appendix B).
    "MSG-18-REFUSED": "Trang web này không cho phép PureMind tải nội dung. Bạn có thể lưu trang thành PDF (Ctrl+P) rồi tải lên.",
    "MSG-19": "Không tìm thấy tài liệu.",
    "MSG-22": "Đoạn chọn quá dài. Hãy chọn tối đa 5.000 ký tự.",
    "MSG-20": "Đã lưu thay đổi.",
    "MSG-23": "Không thể lưu. Kiểm tra kết nối và thử lại.",
    "MSG-24": "Ghi chú tối đa 10.000 ký tự.",
    "MSG-25": "Bạn đã dùng hết lượt AI hôm nay. Lượt sẽ được làm mới lúc 00:00.",
    "MSG-26": "Dịch vụ AI đang gặp sự cố. Vui lòng thử lại sau ít phút.",
    "MSG-27": "Hãy chọn ít nhất một highlight.",
    "MSG-28": "Chỉ có thể chọn tối đa 100 highlight cho một notebook.",
    "MSG-29": "Notebook vượt quá giới hạn độ dài.",
    "MSG-33": "Tài liệu này chưa có bản tóm tắt.",
    "MSG-34": "Bạn cần tạo highlight trước khi tạo notebook.",
    "MSG-35": "Chưa có notebook nào.",
    # Chat with a document: a feature added after SRS v1.1, so these codes are named, not numbered.
    "MSG-CHAT-EMPTY": "Câu hỏi không được để trống.",
    "MSG-CHAT-LONG": "Câu hỏi tối đa 2.000 ký tự.",
    "MSG-CHAT-QUOTA": "Bạn đã dùng hết lượt hỏi AI hôm nay. Lượt sẽ được làm mới lúc 00:00.",
    "MSG-CHAT-FULL": "Cuộc trò chuyện này đã quá dài. Hãy bắt đầu cuộc trò chuyện mới.",
    "MSG-CHAT-NOT-FOUND": "Không tìm thấy cuộc trò chuyện.",
    "MSG-CHAT-NO-TEXT": "Tài liệu này chưa có văn bản để trò chuyện.",
    "MSG-CHAT-IMAGE": "Không đọc được hình này. Hãy thử hình khác.",
    "MSG-TR-EMPTY": "Hãy chọn đoạn văn cần dịch.",
    "MSG-TR-RATE": "Chưa dịch được lúc này. Vui lòng thử lại sau ít phút.",
    "MSG-99": "Đã có lỗi xảy ra. Vui lòng thử lại.",
    # Body that fails validation before a route sees it (SRS 3.4).
    "MSG-INVALID": "Dữ liệu không hợp lệ.",
}

EN: dict[str, str] = {
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
    "MSG-18-REFUSED": "This site does not let PureMind fetch its pages. You can save the page as a PDF (Ctrl+P) and upload it.",
    "MSG-19": "Document not found.",
    "MSG-22": "That selection is too long. Please select at most 5,000 characters.",
    "MSG-20": "Changes saved.",
    "MSG-23": "Could not save. Check your connection and try again.",
    "MSG-24": "A note can be at most 10,000 characters.",
    "MSG-25": "You have used all of today's AI credits. They are renewed at midnight.",
    "MSG-26": "The AI service is having trouble. Please try again in a few minutes.",
    "MSG-27": "Please select at least one highlight.",
    "MSG-28": "A notebook can be built from at most 100 highlights.",
    "MSG-29": "The notebook is longer than the limit.",
    "MSG-33": "This document has no summary yet.",
    "MSG-34": "Make some highlights before building a notebook.",
    "MSG-35": "No notebooks yet.",
    "MSG-CHAT-EMPTY": "The question cannot be empty.",
    "MSG-CHAT-LONG": "A question can be at most 2,000 characters.",
    "MSG-CHAT-QUOTA": "You have used all of today's chat credits. They are renewed at midnight.",
    "MSG-CHAT-FULL": "This conversation has grown too long. Please start a new one.",
    "MSG-CHAT-NOT-FOUND": "Conversation not found.",
    "MSG-CHAT-NO-TEXT": "This document has no text to chat about.",
    "MSG-CHAT-IMAGE": "This image could not be read. Try another one.",
    "MSG-TR-EMPTY": "Select the passage to translate.",
    "MSG-TR-RATE": "Could not translate right now. Please try again in a few minutes.",
    "MSG-99": "Something went wrong. Please try again.",
    "MSG-INVALID": "That data is not valid.",
}

TABLES: dict[Language, dict[str, str]] = {"vi": VI, "en": EN}

_current: ContextVar[Language] = ContextVar("language", default=DEFAULT_LANGUAGE)


def parse_language(header: str | None) -> Language:
    """The first language of an Accept-Language header that PureMind speaks.

    Quality values are ignored: browsers list languages in order of preference anyway, and the app
    sends a single tag of its own.
    """
    for part in (header or "").split(","):
        tag = part.split(";")[0].strip().lower()
        if tag.startswith("en"):
            return "en"
        if tag.startswith("vi"):
            return "vi"
    return DEFAULT_LANGUAGE


def set_language(language: Language) -> None:
    _current.set(language)


def current_language() -> Language:
    return _current.get()


class _Messages:
    """Reads like a dict of messages, answers in the language of the current request."""

    def __getitem__(self, code: str) -> str:
        table = TABLES[_current.get()]
        # A message missing from a translation falls back to Vietnamese rather than to the code.
        return table.get(code) or VI.get(code, code)

    def get(self, code: str, default: str | None = None) -> str | None:
        table = TABLES[_current.get()]
        return table.get(code) or VI.get(code, default)

    def __contains__(self, code: str) -> bool:
        return code in VI or code in EN

    def __iter__(self):
        """The codes, so callers can look for one inside a validation error's text."""
        return iter(VI)


MSG = _Messages()
