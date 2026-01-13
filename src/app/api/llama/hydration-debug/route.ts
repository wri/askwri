export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";

function normKey(k: string) { return k.trim().toLowerCase(); }
function normalizeCM(cm: any) {
  const out: Record<string, any> = {};
  if (!cm) return out;
  for (const [k, v] of Object.entries(cm)) out[normKey(k)] = v;
  if (out["sub-tag (clean1)"] && !out["sub-tag"]) out["sub-tag"] = out["sub-tag (clean1)"];
  if (out["doi (from rdi mastersheet)"] && !out["doi"]) out["doi"] = out["doi (from rdi mastersheet)"];
  return out;
}

// ---- LlamaCloud helpers (direct; server-side, keeps secrets off client) ----
async function listFiles(pipelineId: string, key: string) {
  const map = new Map<string, any>();
  let offset = 0, limit = 500;
  while (true) {
    const url = `https://api.cloud.llamaindex.ai/api/v1/pipelines/${pipelineId}/files?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`files ${res.status}`);
    const json = await res.json();
    const items: any[] = Array.isArray(json) ? json : (json.items ?? []);
    for (const it of items) {
      const file_id = it.file_id ?? it.file?.id;
      if (!file_id) continue;
      map.set(file_id, {
        file_id,
        file_name: it.file_name ?? it.file?.name,
        custom_metadata: normalizeCM(it.custom_metadata ?? it.file?.custom_metadata ?? {}),
      });
    }
    if (items.length < limit) break;
    offset += limit;
  }
  return map;
}

async function listDocuments(pipelineId: string, key: string) {
  const list: any[] = [];
  let offset = 0, limit = 500;
  while (true) {
    const url = `https://api.cloud.llamaindex.ai/api/v1/pipelines/${pipelineId}/documents?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`documents ${res.status}`);
    const json = await res.json();
    const items: any[] = Array.isArray(json) ? json : (json.items ?? []);
    list.push(...items);
    if (items.length < limit) break;
    offset += limit;
  }
  return list;
}

async function getFirstChunk(pipelineId: string, key: string, docId: string) {
  const url = `https://api.cloud.llamaindex.ai/api/v1/pipelines/${pipelineId}/documents/${docId}/chunks?limit=1&offset=0`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) return null;
  const json = await res.json();
  const items: any[] = Array.isArray(json) ? json : (json.items ?? []);
  return items[0] || null;
}

export async function GET(req: NextRequest) {
  try {
    const pipelineId = process.env.PIPELINE_ID;
    const key = process.env.LLAMA_CLOUD_API_KEY;
    if (!pipelineId || !key) {
      return NextResponse.json({ ok: false, error: "Missing PIPELINE_ID or LLAMA_CLOUD_API_KEY" }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const docIdRaw = searchParams.get("docId");
    const docId = (docIdRaw ?? "").trim();

    // Fresh fetch each time (debug should reflect current index state)
    const fileMap = await listFiles(pipelineId, key);
    const docs = await listDocuments(pipelineId, key);

    // Build doc→file using documents metadata (and by-name fallback)
    const docToFile = new Map<string, string>();
    const filesByName = new Map<string, string>();
    for (const v of fileMap.values()) if (v.file_name) filesByName.set(v.file_name, v.file_id);

    for (const d of docs) {
      const id = d.id;
      const md = d.metadata || {};
      const fid = md.file_id ?? md.source_file_id;
      if (id && fid) { docToFile.set(id, String(fid)); continue; }
      const fname = md.file_name;
      if (id && fname && filesByName.has(fname)) {
        docToFile.set(id, filesByName.get(fname)!);
      }
    }

    // Summary
    const out: any = {
      ok: true,
      fileMapSize: fileMap.size,
      docToFileSize: docToFile.size,
      unmappedCount: null,
      sampleFile: [...fileMap.values()].slice(0, 3),
      sampleDocMap: [...docToFile.entries()].slice(0, 5).map(([d,f]) => ({ document_id: d, file_id: f })),
    };

    // If no docId requested, just return summary
    if (!docId) {
      return NextResponse.json(out);
    }

    // ---- Detailed resolution for a specific document_id ----
    const detail: any = { document_id: docId, resolved_via: "not_found" };

    // A) direct doc→file map
    let fid = docToFile.get(docId);
    if (fid && fileMap.has(fid)) {
      const f = fileMap.get(fid);
      detail.resolved_via = "docToFile";
      detail.file_id = fid;
      detail.file_name = f.file_name ?? null;
      detail.custom_metadata = f.custom_metadata ?? {};
      out.docDetail = detail;
      out.docIdEcho = docId;
      return NextResponse.json(out);
    }

    // B) exact document row scan, then by-name
    const drow = docs.find(d => String(d.id) === docId);
    if (drow) {
      const md = drow.metadata || {};
      const fid2 = md.file_id ?? md.source_file_id;
      if (fid2 && fileMap.has(fid2)) {
        const f = fileMap.get(fid2);
        detail.resolved_via = "documents_metadata";
        detail.file_id = fid2;
        detail.file_name = f.file_name ?? null;
        detail.custom_metadata = f.custom_metadata ?? {};
        out.docDetail = detail;
        out.docIdEcho = docId;
        return NextResponse.json(out);
      }
      if (md.file_name && filesByName.has(md.file_name)) {
        const fidByName = filesByName.get(md.file_name)!;
        const f = fileMap.get(fidByName);
        detail.resolved_via = "documents_metadata(file_name)";
        detail.file_id = fidByName;
        detail.file_name = f.file_name ?? null;
        detail.custom_metadata = f.custom_metadata ?? {};
        out.docDetail = detail;
        out.docIdEcho = docId;
        return NextResponse.json(out);
      }
    }

    // C) chunk-level hint (pipeline_file_id/file_id) — first chunk is enough
    const chunk = await getFirstChunk(pipelineId, key, docId);
    if (chunk) {
      const m = chunk.metadata || {};
      const fid3 = m.pipeline_file_id || m.file_id || m.source_file_id;
      if (fid3 && fileMap.has(fid3)) {
        const f = fileMap.get(fid3);
        detail.resolved_via = "chunks_metadata";
        detail.file_id = fid3;
        detail.file_name = f.file_name ?? null;
        detail.custom_metadata = f.custom_metadata ?? {};
        detail.chunk_hint = {
          pipeline_file_id: m.pipeline_file_id || null,
          file_id: m.file_id || null,
          source_file_id: m.source_file_id || null,
          page: m.page ?? m.page_label ?? null,
          keys: Object.keys(m),
        };
        out.docDetail = detail;
        out.docIdEcho = docId;
        return NextResponse.json(out);
      }
      // chunk present but no usable fid
      detail.resolved_via = "chunks_metadata(no_match)";
      detail.chunk_hint = {
        pipeline_file_id: m.pipeline_file_id || null,
        file_id: m.file_id || null,
        source_file_id: m.source_file_id || null,
        page: m.page ?? m.page_label ?? null,
        keys: Object.keys(m),
      };
      out.docDetail = detail;
      out.docIdEcho = docId;
      return NextResponse.json(out);
    }

    // D) nothing mapped
    out.docDetail = detail;
    out.docIdEcho = docId;
    return NextResponse.json(out);

  } catch (err:any) {
    return NextResponse.json({ ok:false, error:String(err?.message||err) }, { status:500 });
  }
}
