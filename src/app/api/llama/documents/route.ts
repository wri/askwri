/**
 * Proxy: List Pipeline Documents.
 * Paginates via limit/offset and returns { items, next } for the client to iterate.
 *
 * GET /api/llama/documents?offset=0&limit=500
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const pipelineId = process.env.PIPELINE_ID;
    const key = process.env.LLAMA_CLOUD_API_KEY;
    if (!pipelineId || !key) {
      return NextResponse.json({ error: "Missing PIPELINE_ID or LLAMA_CLOUD_API_KEY" }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const offset = Number(searchParams.get("offset") ?? 0);
    const limit = Math.min(Number(searchParams.get("limit") ?? 500), 1000);

    const url = `https://api.cloud.llamaindex.ai/api/v1/pipelines/${pipelineId}/documents?offset=${offset}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` }
    });

    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = []; }

    if (!res.ok) {
      return NextResponse.json({ error: json?.error ?? text }, { status: res.status });
    }

    const items: any[] = Array.isArray(json) ? json : (json.items ?? []);
    const hasMore = items.length >= limit;
    const next = hasMore ? `/api/llama/documents?offset=${offset + limit}&limit=${limit}` : "";

    return NextResponse.json({ items, next });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
