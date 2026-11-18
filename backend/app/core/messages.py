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
    "MSG-18-PAYWALL": "Trang này chỉ cho xem trước: toàn văn dành cho người có quyền truy cập, nên PureMind không lấy được bài đầy đủ. Nếu bạn có quyền, hãy tải bản PDF về rồi tải lên.",
    "MSG-18-SHORT": "Trang này có quá ít nội dung để thành một bài đọc hoàn chỉnh (có thể chỉ là phần tóm tắt, trang danh mục, hoặc bài cần đăng nhập), nên PureMind không lưu. Nếu bài có bản PDF, hãy tải về rồi tải lên.",
    "MSG-19": "Không tìm thấy tài liệu.",
    # Explore page: searching arXiv (not in SRS Appendix B).
    "MSG-EXPLORE-LIMIT": "Bạn đã tìm quá nhiều lần trong một giờ. Vui lòng thử lại sau.",
    "MSG-EXPLORE-BUSY": "AI đang tìm cho yêu cầu trước của bạn. Vui lòng đợi.",
    # The feed (not in SRS Appendix B). The credit heads the copy of an article in the library.
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
    # Admin page (FR-ADM): added after SRS v1.1, so named like the chat codes.
    "MSG-ACC-DISABLED": "Tài khoản của bạn đã bị khóa. Vui lòng liên hệ quản trị viên.",
    "MSG-ADM-FORBIDDEN": "Bạn không có quyền truy cập trang quản trị.",
    "MSG-ADM-NOT-FOUND": "Không tìm thấy người dùng.",
    "MSG-ADM-PROTECTED": "Không thể khóa hoặc xóa tài khoản quản trị.",
    "MSG-99": "Đã có lỗi xảy ra. Vui lòng thử lại.",
    # Body that fails validation before a route sees it (SRS 3.4).
    "MSG-INVALID": "Dữ liệu không hợp lệ.",
    # Publishing, the community and collections (not in SRS Appendix B).
    "MSG-COLLECTION-404": "Không tìm thấy bộ sưu tập.",
    "MSG-COLLECTION-NAME": "Tên bộ sưu tập không được để trống.",
    "MSG-COLLECTION-DUP": "Bạn đã có bộ sưu tập tên này.",
    "CHECK-TITLE": "Bài cần có tiêu đề.",
    "CHECK-TOPIC": "Hãy chọn chủ đề cho bài.",
    "CHECK-CARD-COUNT": "Bài cần từ 3 đến 9 thẻ.",
    "CHECK-CARD-EMPTY": "Có thẻ còn trống. Hãy viết nội dung hoặc xóa thẻ đó.",
    "CHECK-LINK-CARD": "Bài chia sẻ link cần đúng một thẻ ghi lý do bạn giới thiệu.",
    "CHECK-LINK-URL": "Bài chia sẻ link cần một nguồn có đường link công khai.",
    "CHECK-SOURCE-REQUIRED": "Bài tóm tắt phải nêu tài liệu gốc. Hãy bật hiển thị ít nhất một nguồn.",
    "CHECK-CREDIT-REQUIRED": "Nguồn này có giấy phép mở nên phải được ghi công. Hãy bật hiển thị: {title}",
    "CHECK-SUMMARY-ND": "Không đăng được bài tóm tắt từ nguồn CC BY-ND vì giấy phép không cho phép phái sinh. Hãy đổi sang “Góc nhìn” và viết bằng lời của bạn, hoặc chỉ chia sẻ link: {title}",
    "CHECK-AI-ND": "Bài có phần do AI viết nên không thể dựa trên nguồn CC BY-ND. Hãy tạo bài mới và tự viết: {title}",
    "CHECK-ND-SOURCE": "Có nguồn CC BY-ND: hãy viết bằng lời của bạn, không dịch hay rút gọn bài gốc: {title}",
    "CHECK-OVERLAP-ND": "Bài chép nguyên văn {words} từ liên tiếp từ nguồn CC BY-ND. Hãy viết lại hoặc chỉ trích ngắn: {title}",
    "CHECK-OVERLAP": "Bài chép nguyên văn {words} từ liên tiếp từ nguồn. Hãy kiểm tra quyền đăng lại: {title}",
    "CHECK-CONFIRM-RIGHTS": "Bạn cần xác nhận mình có quyền đăng nội dung này.",
    "CHECK-CONFIRM-REVIEWED": "Bài có phần do AI viết. Bạn cần xác nhận đã đọc và kiểm tra.",
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
    "MSG-18-PAYWALL": "This page is only a preview: the full text is for readers with access, so PureMind cannot get the whole document. If you have access, download the PDF and upload it.",
    "MSG-18-SHORT": "This page has too little text to be a whole article (it may be an abstract, a listing page, or a page that needs sign-in), so PureMind did not save it. If the article has a PDF, download it and upload it.",
    "MSG-19": "Document not found.",
    "MSG-EXPLORE-LIMIT": "You have searched too many times in an hour. Please try again later.",
    "MSG-EXPLORE-BUSY": "The AI is still working on your last request. Please wait.",
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
    "MSG-ACC-DISABLED": "Your account has been locked. Please contact the administrator.",
    "MSG-ADM-FORBIDDEN": "You do not have access to the admin pages.",
    "MSG-ADM-NOT-FOUND": "User not found.",
    "MSG-ADM-PROTECTED": "Admin accounts cannot be locked or deleted.",
    "MSG-99": "Something went wrong. Please try again.",
    "MSG-INVALID": "That data is not valid.",
    "MSG-COLLECTION-404": "Collection not found.",
    "MSG-COLLECTION-NAME": "A collection needs a name.",
    "MSG-COLLECTION-DUP": "You already have a collection with this name.",
    "CHECK-TITLE": "The post needs a title.",
    "CHECK-TOPIC": "Choose a topic for the post.",
    "CHECK-CARD-COUNT": "A post has 3 to 9 cards.",
    "CHECK-CARD-EMPTY": "A card is empty. Write something on it or remove it.",
    "CHECK-LINK-CARD": "A shared link needs exactly one card saying why you recommend it.",
    "CHECK-LINK-URL": "A shared link needs a source with a public address.",
    "CHECK-SOURCE-REQUIRED": "A summary must name the original. Show at least one source.",
    "CHECK-CREDIT-REQUIRED": "This source is openly licensed and must be credited. Show it: {title}",
    "CHECK-SUMMARY-ND": "A summary of a CC BY-ND source cannot be posted: the licence allows no derivatives. Switch to “Insight” and write in your own words, or just share the link: {title}",
    "CHECK-AI-ND": "Part of this post was written by AI, so it cannot rest on a CC BY-ND source. Start a new post and write it yourself: {title}",
    "CHECK-ND-SOURCE": "A source is CC BY-ND: use your own words, and do not translate or shorten the original: {title}",
    "CHECK-OVERLAP-ND": "The post copies {words} consecutive words from a CC BY-ND source. Rewrite it or quote less: {title}",
    "CHECK-OVERLAP": "The post copies {words} consecutive words from a source. Check that you may republish them: {title}",
    "CHECK-CONFIRM-RIGHTS": "Confirm that you have the right to post this.",
    "CHECK-CONFIRM-REVIEWED": "Part of this post was written by AI. Confirm that you read and checked it.",
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
