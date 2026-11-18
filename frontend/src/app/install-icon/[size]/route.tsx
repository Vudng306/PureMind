import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

export const dynamic = "force-static";
export function generateStaticParams() {
  return [{ size: "192" }, { size: "512" }];
}

/** Render installation sizes from the existing brand asset, keeping its original colours and shape. */
export async function GET(_request: Request, { params }: { params: Promise<{ size: string }> }) {
  const { size } = await params;
  if (size !== "192" && size !== "512") return new Response("Not found", { status: 404 });
  const pixels = Number(size);
  const logo = await readFile(path.join(process.cwd(), "public/brand/puremind-mark.png"));
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center", background: "#faf6ee" }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- Preserve the existing brand in generated installation icons. */}
      <img alt="" src={`data:image/png;base64,${logo.toString("base64")}`} width={pixels * 0.8} height={pixels * 0.8} />
    </div>,
    { width: pixels, height: pixels },
  );
}
