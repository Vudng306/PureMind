"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";
import { accountKey } from "./queries";
import type { Lang, User } from "./types";

/**
 * The version of the terms below. It must equal TERMS_VERSION in backend/app/models.py: the sign-up form
 * records it in the user's metadata, and the server asks everyone again when it changes.
 */
export const TERMS_VERSION = "2026-11-05";

/** The terms are accepted as a whole; sending content to OpenAI is a separate choice (NFR-PRV-01). */
export function useAcceptTerms() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (aiConsent: boolean) =>
      api<User>("/account/terms", { method: "POST", body: JSON.stringify({ ai_consent: aiConsent }) }),
    onSuccess: (user) => qc.setQueryData(accountKey, user),
  });
}

/** Settings › Account: turn the OpenAI choice on or off at any time. */
export function useSetAiConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (aiConsent: boolean) =>
      api<User>("/account", {
        method: "PATCH",
        body: JSON.stringify({ reading_preferences: { ai_consent: aiConsent } }),
      }),
    onSuccess: (user) => qc.setQueryData(accountKey, user),
  });
}

/** A paragraph, or a bulleted list. */
export type TermsBlock = string | string[];

export interface TermsSection {
  title: string;
  body: TermsBlock[];
}

/** What /terms says. A change here is a new TERMS_VERSION (here and in the backend). */
export const TERMS: Record<Lang, { updated: string; intro: string; sections: TermsSection[] }> = {
  vi: {
    updated: "Cập nhật ngày 05/11/2026",
    intro:
      "Khi tạo tài khoản và dùng PureMind, bạn đồng ý với các điều khoản dưới đây. Riêng việc gửi nội dung tới OpenAI là một lựa chọn riêng, không bắt buộc: bạn bật hoặc tắt được bất cứ lúc nào.",
    sections: [
      {
        title: "1. PureMind là gì",
        body: [
          "PureMind giúp bạn lưu tài liệu (PDF, EPUB, bài viết trên web), đọc ở dạng văn bản sạch, highlight, ghi chú và tạo sổ ghi chú. Một số tính năng dùng AI của OpenAI.",
        ],
      },
      {
        title: "2. Dữ liệu PureMind lưu",
        body: [
          [
            "Tài khoản: email, tên hiển thị, ảnh đại diện. Đăng nhập do Supabase xử lý (email và mật khẩu, hoặc Google); PureMind không lưu mật khẩu của bạn.",
            "Nội dung của bạn: tệp tài liệu, văn bản và hình được trích ra từ tệp, highlight, ghi chú, sổ ghi chú, bản tóm tắt và các cuộc hỏi đáp.",
            "Thiết lập đọc, số lượt AI đã dùng trong ngày và lần cuối bạn dùng ứng dụng.",
          ],
          "Nội dung của bạn chỉ bạn xem được, trừ bài đăng và bình luận bạn chủ động đăng lên Cộng đồng: người đã đăng nhập đều đọc được chúng kèm tên hiển thị của bạn, và quản trị viên có thể ẩn hoặc xóa khi cần. Bạn có thể gỡ bài bất cứ lúc nào, trừ bài đang bị ẩn thì chỉ xóa được. Ngoài những gì bạn đã đăng, quản trị viên chỉ thấy thông tin tài khoản và số liệu, không bao giờ thấy nội dung tài liệu, highlight, ghi chú, bản nháp hay cuộc trò chuyện.",
        ],
      },
      {
        title: "3. Gửi nội dung tới OpenAI (tùy chọn)",
        body: [
          "Nếu bạn cho phép, PureMind gửi tới dịch vụ API của OpenAI đúng phần nội dung cần cho tính năng bạn dùng:",
          [
            "Tóm tắt: văn bản của tài liệu.",
            "Hỏi đáp: các đoạn liên quan trong tài liệu, câu hỏi của bạn và hình bạn chọn hỏi.",
            "Dịch: đoạn văn bạn đã chọn.",
            "Sổ ghi chú: các highlight và ghi chú bạn chọn.",
            "Bài đăng: ghi chú hoặc bản tóm tắt của bài, khi bạn bấm nhờ AI soạn nháp.",
            "Khi bạn thêm tài liệu: ảnh các trang scan, bảng, công thức và hình minh hoạ, để đọc thành chữ và mô tả hình.",
          ],
          "Nếu bạn không cho phép, PureMind không gửi gì tới OpenAI. Các tính năng AI khi đó bị tắt; bạn vẫn đọc, highlight, ghi chú và tìm kiếm bình thường. Trang scan khi đó không có văn bản sạch, còn bảng, công thức và hình hiện ở dạng ảnh.",
          "OpenAI xử lý dữ liệu nhận qua API theo chính sách của họ (openai.com/policies). Khi bạn tắt lựa chọn này, PureMind ngừng gửi từ lúc đó; nội dung đã gửi trước đó không thu hồi được.",
          "Kết quả do AI tạo có thể sai hoặc thiếu. Hãy đối chiếu với tài liệu gốc trước khi dựa vào.",
        ],
      },
      {
        title: "4. Trách nhiệm của bạn",
        body: [
          [
            "Chỉ tải lên hoặc lưu nội dung mà bạn có quyền sử dụng, và không vi phạm pháp luật.",
            "Chỉ đăng lên Cộng đồng lời của bạn hoặc nội dung bạn có quyền chia sẻ, ghi đúng nguồn, và tôn trọng người khác. Bạn chịu trách nhiệm về những gì mình đăng.",
            "Giữ an toàn cho tài khoản và mật khẩu của bạn.",
            "Không dùng PureMind để làm gián đoạn dịch vụ hay truy cập dữ liệu của người khác.",
          ],
          "Tài khoản vi phạm có thể bị quản trị viên khoá. Mỗi tài khoản có giới hạn số lượt dùng AI mỗi ngày.",
        ],
      },
      {
        title: "5. Xoá dữ liệu",
        body: [
          "Bạn xoá được từng tài liệu bất cứ lúc nào. Khi bạn xoá tài khoản trong Cài đặt, toàn bộ bản ghi và tệp của bạn bị xoá vĩnh viễn và không thể khôi phục.",
        ],
      },
      {
        title: "6. Thay đổi điều khoản",
        body: [
          "Khi điều khoản thay đổi, PureMind sẽ hỏi lại bạn ở lần đăng nhập tiếp theo trước khi bạn tiếp tục dùng.",
        ],
      },
    ],
  },
  en: {
    updated: "Last updated 5 November 2026",
    intro:
      "By creating an account and using PureMind, you agree to the terms below. Sending content to OpenAI is a separate, optional choice that you can turn on or off at any time.",
    sections: [
      {
        title: "1. What PureMind is",
        body: [
          "PureMind keeps your documents (PDF, EPUB, web articles), lets you read them as clean text, highlight, annotate and build notebooks. Some features use AI from OpenAI.",
        ],
      },
      {
        title: "2. What PureMind stores",
        body: [
          [
            "Your account: email, display name, profile picture. Sign-in is handled by Supabase (email and password, or Google); PureMind never stores your password.",
            "Your content: document files, the text and pictures extracted from them, highlights, notes, notebooks, summaries and chat conversations.",
            "Your reading settings, how many AI requests you used today, and when you last used the app.",
          ],
          "Only you can see your content, except posts and comments you choose to publish to the Community: anyone signed in can read those, with your display name, and admins can hide or delete them when needed. You can unpublish a post at any time, unless it has been hidden, in which case you can only delete it. Beyond what you publish, admins see account details and counts only, never the content of documents, highlights, notes, drafts or conversations.",
        ],
      },
      {
        title: "3. Sending content to OpenAI (optional)",
        body: [
          "If you allow it, PureMind sends OpenAI's API only what the feature you use needs:",
          [
            "Summaries: the text of the document.",
            "Chat: the relevant passages of the document, your question and any figure you ask about.",
            "Translation: the passage you selected.",
            "Notebooks: the highlights and notes you picked.",
            "Posts: the notes or summary behind the post, when you ask AI for a draft.",
            "When you add a document: pictures of its scanned pages, tables, equations and figures, to read them as text and describe the figures.",
          ],
          "If you do not allow it, PureMind sends nothing to OpenAI. The AI features are then off; reading, highlighting, notes and search work as usual. Scanned pages then have no clean text, and tables, equations and figures show as pictures.",
          "OpenAI handles data received through its API under its own policies (openai.com/policies). When you turn this choice off, PureMind stops sending from then on; content already sent cannot be recalled.",
          "AI output can be wrong or incomplete. Check it against the original before relying on it.",
        ],
      },
      {
        title: "4. Your responsibilities",
        body: [
          [
            "Only upload or save content you have the right to use, and nothing unlawful.",
            "Only publish to the Community your own words or content you have the right to share, credit your sources, and respect others. You are responsible for what you publish.",
            "Keep your account and password safe.",
            "Do not use PureMind to disrupt the service or to reach other people's data.",
          ],
          "Accounts that break these terms can be locked by an admin. Each account has a daily limit of AI requests.",
        ],
      },
      {
        title: "5. Deleting your data",
        body: [
          "You can delete any document at any time. Deleting your account in Settings removes all of your records and files for good; they cannot be brought back.",
        ],
      },
      {
        title: "6. Changes to these terms",
        body: [
          "When these terms change, PureMind asks you again the next time you sign in, before you go on.",
        ],
      },
    ],
  },
};
