export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";

function norm(s: string) { return s.trim().toLowerCase(); }

export async function GET(req: NextRequest) {
  try {
    const base = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
    const res = await fetch(new URL("/api/catalog", base), { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `/api/catalog ${res.status}` }, { status: res.status });
    }
    const cat = await res.json();

    const { searchParams } = new URL(req.url);
    const id = (searchParams.get("fileId") || "").trim();
    const name = (searchParams.get("fileName") || "").trim();

    let item: any = null;
    if (id) item = cat.items.find((r: any) => r.file_id === id);
    if (!item && name) {
      const nameL = norm(name);
      item = cat.items.find((r: any) => norm(r.file_name) === nameL || norm(r.external_file_id) === nameL);
    }

    return NextResponse.json({
      ok: true,
      count: cat.count,
      source: cat.source,
      fileIdEcho: id || null,
      fileNameEcho: name || null,
      matched: Boolean(item),
      item: item || null,
      metaKeys: item?.meta ? Object.keys(item.meta) : [],
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
