export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";

function normKey(k: string) { return k.trim().toLowerCase(); }
function normalizeCM(cm: any) {
  const out: Record<string, any> = {};
  if (!cm) return out;
  for (const [k, v] of Object.entries(cm)) out[normKey(k)] = v;
  // common harmonization
  if (out["sub-tag (clean1)"] && !out["sub-tag"]) out["sub-tag"] = out["sub-tag (clean1)"];
  if (out["doi (from rdi mastersheet)"] && !out["doi"]) out["doi"] = out["doi (from rdi mastersheet)"];
  return out;
}

async function listFiles(pipelineId: string, key: string) {
  const items: any[] = [];
  let offset = 0, limit = 500;
  while (true) {
    const url = `https://api.cloud.llamaindex.ai/api/v1/pipelines/${pipelineId}/files?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`files ${res.status}`);
    const json = await res.json();
    const page: any[] = Array.isArray(json) ? json : (json.items ?? []);
    items.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return items;
}

export async function GET(req: NextRequest) {
  try {
    const pipelineId = process.env.PIPELINE_ID;
    const key = process.env.LLAMA_CLOUD_API_KEY;
    if (!pipelineId || !key) {
      return NextResponse.json({ ok: false, error: "Missing PIPELINE_ID or LLAMA_CLOUD_API_KEY" }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const fieldsParam = searchParams.get("fields") || ""; // comma-separated, e.g., "article title,all authors,source url"
    const sampleN = Math.max(0, Math.min(50, Number(searchParams.get("sample") || 0)));
    const inspectFileId = (searchParams.get("fileId") || "").trim();

    const wantFields = fieldsParam
      .split(",")
      .map(s => normKey(s))
      .filter(Boolean);

    // 1) fetch all files
    const files = await listFiles(pipelineId, key);

    // 2) normalize, compute coverage
    const total = files.length;
    let withAnyMeta = 0;
    const perField: Record<string, { present: number; missing: number; missingSamples: string[] }> = {};
    for (const f of files) {
      const file_id = f.file_id ?? f.file?.id ?? "";
      const file_name = f.file_name ?? f.file?.name ?? f.external_file_id ?? f.file?.external_file_id ?? null;
      const cm = normalizeCM(f.custom_metadata ?? f.file?.custom_metadata ?? {});
      if (Object.keys(cm).length > 0) withAnyMeta++;

      for (const fld of wantFields) {
        if (!perField[fld]) perField[fld] = { present: 0, missing: 0, missingSamples: [] };
        const has = Object.prototype.hasOwnProperty.call(cm, fld) && String(cm[fld] ?? "").trim() !== "";
        if (has) perField[fld].present++;
        else {
          perField[fld].missing++;
          if (sampleN > 0 && perField[fld].missingSamples.length < sampleN) {
            perField[fld].missingSamples.push(file_id || String(file_name));
          }
        }
      }
    }

    // 3) optional single-file inspection
    let fileDetail: any = null;
    if (inspectFileId) {
      const match = files.find(f => (f.file_id ?? f.file?.id) === inspectFileId);
      if (match) {
        fileDetail = {
          file_id: match.file_id ?? match.file?.id ?? null,
          file_name: match.file_name ?? match.file?.name ?? match.external_file_id ?? match.file?.external_file_id ?? null,
          custom_metadata: normalizeCM(match.custom_metadata ?? match.file?.custom_metadata ?? {}),
          keys: Object.keys(normalizeCM(match.custom_metadata ?? match.file?.custom_metadata ?? {})),
        };
      } else {
        fileDetail = { file_id: inspectFileId, error: "not found in this pipeline" };
      }
    }

    return NextResponse.json({
      ok: true,
      totalFiles: total,
      filesWithCustomMetadata: withAnyMeta,
      filesWithoutCustomMetadata: total - withAnyMeta,
      fieldCoverage: wantFields.length ? perField : undefined,
      fileDetail,
    });

  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
