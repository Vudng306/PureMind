"use client";

import { useRef, useState } from "react";

import { Icon } from "@/components/icons";
import { useT, type Key } from "@/lib/i18n";
import type { PostCard, PostKind } from "@/lib/posts";
import { toneOf } from "@/lib/tone";

export const kindLabel = (kind: PostKind) => `post.kind.${kind}` as Key;

/** The cards of a post, swiped or stepped through. The same in the Studio's preview and in the community. */
export function PostPager({ title, cards }: { title: string; cards: PostCard[] }) {
  const t = useT();
  const strip = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const go = (i: number) => {
    const el = strip.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  };
  const n = cards.length;
  const current = Math.min(at, Math.max(0, n - 1));

  return (
    <div className={`relative flex flex-col gap-2 ${toneOf(title)}`}>
      <div
        ref={strip}
        tabIndex={0}
        role="group"
        aria-label={t("post.cardsAria", { n })}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAt(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
        }}
        className="flex snap-x snap-mandatory overflow-x-auto rounded-2xl outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-focus"
      >
        {cards.map((card, i) => (
          <article
            key={i}
            className="flex min-h-[300px] w-full shrink-0 snap-center flex-col gap-3 bg-tone-bg p-6 text-tone-fg sm:min-h-[340px] sm:p-8"
          >
            <span className="text-xs font-semibold opacity-70">
              {i + 1}/{n}
            </span>
            {card.heading && <h3 className="font-display text-2xl font-semibold leading-tight">{card.heading}</h3>}
            <p className="whitespace-pre-line text-[17px] leading-relaxed">{card.body}</p>
          </article>
        ))}
      </div>
      {n > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            className="icon-btn h-9 w-9"
            aria-label={t("post.prevCard")}
            disabled={current === 0}
            onClick={() => go(current - 1)}
          >
            <Icon name="back" size={16} />
          </button>
          <span aria-hidden className="flex items-center gap-1.5">
            {cards.map((_, i) => (
              <span key={i} className={`h-1.5 w-1.5 rounded-full ${i === current ? "bg-tone" : "bg-line"}`} />
            ))}
          </span>
          <button
            type="button"
            className="icon-btn h-9 w-9"
            aria-label={t("post.nextCard")}
            disabled={current === n - 1}
            onClick={() => go(current + 1)}
          >
            <Icon name="next" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
