"use client";

import { FigureImage } from "@/components/clean-reader";

/** A chart of the article, from the publisher's site. The source's text is trusted here, unlike a model's. */
export function articleFigure(src: string, alt: string) {
  return (
    <figure className="mb-6">
      <FigureImage documentId="" src={src} alt={alt} />
      {alt && <figcaption className="mt-2 text-center font-sans text-sm leading-normal text-muted">{alt}</figcaption>}
    </figure>
  );
}
