/* eslint-disable @typescript-eslint/no-explicit-any */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";
import { expandQueryWithSummaries } from "@/lib/query-expansion";

/** ENV (unchanged names) */
const BASE_URL = (process.env.LLAMA_CLOUD_BASE_URL || "https://api.cloud.llamaindex.ai").replace(/\/$/, "");
const API_KEY  = process.env.LLAMA_CLOUD_API_KEY || "";
const PIPELINE = process.env.PIPELINE_ID || "";

/* ---------------- small utils ---------------- */
function fail(reason: string, extra: Record<string, any> = {}) {
  // Maintain legacy behavior: return ok: true with a fallback block so the UI still renders
  return NextResponse.json({ ok: true, message: "", sources: [], docs: [], debug: { fallback: true, reason, ...extra } });
}
async function postJSON(url: string, body: any) {
  const res  = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      accept: "application/json,text/event-stream;q=0.9,*/*;q=0.8",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json, text, headers: res.headers };
}
function ensureMessages(body: any) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    const sys = typeof body?.system === "string" && body.system.trim() ? [{ role: "system", content: body.system.trim() }] : [];
    const content = typeof body?.query === "string" ? body.query : "";
    return { ...body, messages: [...sys, { role: "user", content }] };
  }
  return body;
}

/* ---------------- SSE parsing ---------------- */
/** Join all 0:"..." tokens to one Answer string; collect sources from frames like 8:[{type:"sources", data:{nodes|sources|docs:[...]}}] */
function parseSSERaw(raw: string): { message: string; sources: any[] } {
  let message = "";
  const sources: any[] = [];

  // Answer tokens (channel 0)
  const tokenRe = /(?:^|\n)0:\s*("(?:\\.|[^"])*")/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(raw)) !== null) { try { message += JSON.parse(m[1]); } catch {} }
  message = message.trim();

  // Any channel array frame → look for type:"sources"
  const frameRe = /(?:^|\n)\d+:\s*(\[[\s\S]*?\])(?=\n\d+:|$)/g;
  let f: RegExpExecArray | null;
  let frameCount = 0;
  
  while ((f = frameRe.exec(raw)) !== null) {
    frameCount++;
    const block = f[1];
    try {
      const arr = JSON.parse(block);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item && item.type === "sources" && item.data) {
            const data = item.data || {};
            console.log(`[parseSSERaw] Found sources frame with:`, {
              nodes: Array.isArray(data.nodes) ? data.nodes.length : 0,
              sources: Array.isArray(data.sources) ? data.sources.length : 0,
              docs: Array.isArray(data.docs) ? data.docs.length : 0
            });
            if (Array.isArray(data.nodes))   sources.push(...data.nodes);
            if (Array.isArray(data.sources)) sources.push(...data.sources);
            if (Array.isArray(data.docs))    sources.push(...data.docs);
          }
        }
      }
    } catch (e) {
      console.log(`[parseSSERaw] Failed to parse frame ${frameCount}:`, e);
    }
  }
  
  console.log(`[parseSSERaw] Parsed ${frameCount} frames, extracted ${sources.length} total sources`);
  return { message, sources };
}

/* ---------------- doc normalization (group-by-document) ---------------- */
type CitationTarget = { score: number; page: number; passage_id: string };
type KP = { kp_relevance: number; snippet: string; passage_id: string; page: number; citation_targets: CitationTarget[] };
type Doc = {
  doc_id: string; document_id: string; ref: string; title: string; url?: string; _url?: string; host?: string; authors?: string[]; year?: number; source?: string; score?: number; kps: KP[]; meta?: any;
};

const norm = (s?: string) => (s || "").trim().toLowerCase();
function isFootnoteOrBibliography(snippet: string, allSnippets?: string[], currentIndex?: number): boolean {
  const text = snippet.toLowerCase().trim();
  
  // Skip very short snippets (likely incomplete fragments)
  if (text.length < 15) return true;
  
  // Strong individual patterns (definitive matches)
  const strongBibPatterns = [
    /^references?\s*$/,
    /^bibliography\s*$/,
    /^works?\s+cited\s*$/,
    /^literature\s+cited\s*$/,
    /^sources?\s*$/,
    /^appendix\s+[a-z]?:?\s*(references|bibliography)/i,
  ];
  
  // Strong footnote patterns
  const strongFootnotePatterns = [
    /^\d+\s+[^.]{5,50}\.?\s*$/,  // "1 Some footnote text."
    /^(ibid|op\.?\s*cit|loc\.?\s*cit|supra)/i,  // Latin references
    /^note\s+\d+/i,               // "Note 12"
    /^fn\.\s*\d+/i,               // "Fn. 5"
  ];
  
  // Check strong patterns first
  if ([...strongBibPatterns, ...strongFootnotePatterns].some(pattern => pattern.test(text))) {
    return true;
  }
  
  // Citation-like patterns (may need context)
  const citationPatterns = [
    /^\d+\.\s*[a-z]+,?\s+[a-z]+/i, // "1. Author, Title"
    /^[a-z]+,?\s+[a-z]+\.?\s+\(\d{4}\)/i, // "Author, Title. (2023)"
    /^[a-z]+,?\s+[a-z]+\.?\s+\d{4}/i, // "Author, Title. 2023"
    /^[a-z]+\s+et\s+al\./i,        // "Smith et al."
    /^see\s+(also\s+)?[a-z]+/i,    // "See also Author"
    /\b(doi|isbn|issn):\s*[\w\-\.\/]+/i, // DOI/ISBN identifiers
    /\b(pp?\.|pages?)\s+\d+/i,     // Page references
    /\b(vol\.|volume)\s+\d+/i,     // Volume references
  ];
  
  // URL-heavy content
  const urlPattern = /(https?:\/\/[^\s]+)/gi;
  const urlMatches = text.match(urlPattern);
  if (urlMatches && urlMatches.join('').length > text.length * 0.5) {
    return true; // More than 50% URLs
  }
  
  // Context-aware detection (if surrounding chunks are provided)
  if (allSnippets && typeof currentIndex === 'number') {
    return isInBibliographySectionRoute(snippet, allSnippets, currentIndex);
  }
  
  // Fallback to citation patterns for individual chunks
  return citationPatterns.some(pattern => pattern.test(text));
}

function isInBibliographySectionRoute(snippet: string, allSnippets: string[], currentIndex: number): boolean {
  const text = snippet.toLowerCase().trim();
  const windowSize = 3; // Look at 3 chunks before and after
  
  // Get surrounding context
  const start = Math.max(0, currentIndex - windowSize);
  const end = Math.min(allSnippets.length, currentIndex + windowSize + 1);
  const contextSnippets = allSnippets.slice(start, end).map(s => s.toLowerCase().trim());
  
  // Check if any nearby chunk contains bibliography section headers
  const bibHeaders = [
    /^references?\s*$/,
    /^bibliography\s*$/,
    /^works?\s+cited\s*$/,
    /^literature\s+cited\s*$/,
    /^sources?\s*$/,
    /references?\s+and\s+sources?/i,
    /acknowledgments?\s+and\s+references?/i,
  ];
  
  const hasBibHeader = contextSnippets.some(chunk => 
    bibHeaders.some(pattern => pattern.test(chunk))
  );
  
  if (hasBibHeader) {
    // We're near a bibliography section, check if this chunk looks citation-like
    const citationIndicators = [
      /^\d+\.\s/,                    // Numbered list
      /^[a-z]+,?\s+[a-z]+\./i,      // "Author, Name."
      /\(\d{4}\)/,                   // Year in parentheses
      /\b(journal|proceedings|conference|university|press)\b/i,
      /\b(pp?\.|pages?|vol\.|volume|no\.|number)\s*\d+/i,
      /\b(doi|isbn|issn):/i,
      /https?:\/\//,                 // URLs
      /\b(accessed|retrieved|available)\s+(at|from|on)\b/i,
    ];
    
    if (citationIndicators.some(pattern => pattern.test(text))) {
      return true;
    }
  }
  
  // Check for footnote sections by looking for numbered patterns
  const footnoteContext = contextSnippets.some(chunk => 
    /^(footnotes?|notes?)\s*$/i.test(chunk) || 
    /^\d+\s+[^.]+\.\s*$/.test(chunk)
  );
  
  if (footnoteContext && /^\d+/.test(text)) {
    return true;
  }
  
  // Check density of citation-like patterns in surrounding context
  const citationDensity = contextSnippets.filter(chunk => {
    return /^[a-z]+,?\s+[a-z]+/i.test(chunk) || // Author names
           /\(\d{4}\)/.test(chunk) ||            // Years
           /\b(pp?\.|vol\.|doi)/.test(chunk);    // Academic indicators
  }).length;
  
  // If 50%+ of surrounding chunks look like citations, this is likely a bib section
  return citationDensity >= contextSnippets.length * 0.5;
}
const toRef = (id: string) => norm(id).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || `ref_${Math.random().toString(36).slice(2, 10)}`;
function toYear(x: any): number | undefined { if (typeof x === "number") return x; const s=String(x||""); const m=s.match(/\b(19|20)\d{2}\b/); return m ? Number(m[0]) : undefined; }
function toHost(u?: string){ try { return u ? new URL(u).host.replace(/^www\./,"") : undefined; } catch { return undefined; } }
function parseAuthors(raw:any): string[]|undefined { if(!raw) return undefined; if(Array.isArray(raw)) return raw.map(String).filter(Boolean); return String(raw).split(/[;|,]/).map(s=>s.trim()).filter(Boolean); }

function scoreOf(x:any): number | undefined {
  const c = x ?? {};
  for (const k of ["score","similarity","relevance","kp_relevance"]) if (typeof c[k] === "number") return c[k] as number;
  return undefined;
}

function toKP(raw:any): KP {
  const passage_id = String(raw.passage_id ?? raw.pid ?? raw.node_id ?? raw.id ?? ""); const page = Number(raw.page ?? 1);
  const kp_relevance = Number(scoreOf(raw) ?? 0.7);
  const snippet = String(raw.snippet ?? raw.text ?? "");
  const citation_targets: CitationTarget[] = Array.isArray(raw.citation_targets)
    ? raw.citation_targets.map((t:any)=>({ score:Number(scoreOf(t) ?? kp_relevance), page: Number(t.page ?? page), passage_id:String(t.passage_id ?? t.pid ?? passage_id) }))
    : [{ score: kp_relevance, page, passage_id }];
  return { kp_relevance, snippet, passage_id: passage_id || `${Math.random().toString(36).slice(2,8)}:${page}`, page, citation_targets };
}

function normalizeNode(n: any): Doc | null {
  if (!n) return null;
  const md = n.metadata || {};
  const document_id = String(
    n.document_id || n.doc_id || md.document_id || md.parent_document_id || md.parent_id || md.pipeline_file_id || md.external_file_id || n.id || ""
  );
  if (!document_id) return null;

  const title =
    String(n.title || md["Article Title"] || md.title || md.file_name || md.file_path || n.heading || n.section_title || (n.text||"").slice(0,80) || "Untitled");
  const url = n.url || md["Source URL"] || md.url || undefined;
  const authors = parseAuthors(md["All authors"] || md.authors || md.author || md.creator);
  const year = toYear(md["YEAR accepted"] || md.year || md.pub_year || md["Date accepted"] || md.date);
  const source = md.source || md.collection || md.domain || toHost(url);
  const score = scoreOf(n);

  // KP from node
  const page = n.page ?? md.page_label ?? md.page ?? md.start_page_label ?? 1;
  const passage_id = String(n.passage_id ?? n.node_id ?? n.id ?? `${document_id}:${page}`);
  const snippet = String(n.text ?? n.snippet ?? n.excerpt ?? "");
  const kps: KP[] = snippet
    ? [{
        kp_relevance: Number(score ?? 0.7),
        snippet,
        page: Number(page ?? 1),
        passage_id,
        citation_targets: [{ score: Number(score ?? 0.7), page: Number(page ?? 1), passage_id }],
      }]
    : [];

  const out: Doc = {
    doc_id: document_id, document_id, ref: toRef(document_id), title, url, _url: md.file_path || md.file_name || undefined,
    host: toHost(url), authors, year, source, score, kps, meta: { raw: n }
  };
  return out;
}

function groupDocs(nodes: any[], capPerDoc: number): Doc[] {
  console.log(`[groupDocs] Starting with ${nodes.length} nodes`);
  
  // First, let's see all unique document IDs
  const allDocIds = new Set<string>();
  nodes.forEach(node => {
    const docId = node.document_id || node.doc_id || node.metadata?.document_id || 
                  node.metadata?.parent_document_id || node.metadata?.parent_id || 
                  node.metadata?.pipeline_file_id || node.metadata?.external_file_id || node.id;
    if (docId) allDocIds.add(docId);
  });
  console.log(`[groupDocs] Found ${allDocIds.size} unique document IDs:`, Array.from(allDocIds).slice(0, 10));
  
  const map = new Map<string, Doc>();
  let skippedNodes = 0;
  
  for (const node of nodes) {
    const d = normalizeNode(node); 
    if (!d) {
      skippedNodes++;
      console.log(`[groupDocs] Skipped node (no doc):`, node.id || 'unknown');
      continue;
    }
    const ex = map.get(d.doc_id);
    if (!ex) { 
      map.set(d.doc_id, d); 
      console.log(`[groupDocs] Added new doc: ${d.doc_id.slice(0, 20)}... - ${d.title?.slice(0, 50)}`);
      continue; 
    }
    // merge
    ex.title  ||= d.title;  ex.url ||= d.url; ex._url ||= d._url;
    if (!ex.authors?.length && d.authors?.length) ex.authors = d.authors;
    ex.year   ||= d.year;   ex.source ||= d.source;
    ex.score   = Math.max(ex.score ?? 0, d.score ?? 0);
    ex.kps.push(...d.kps);
  }
  
  console.log(`[groupDocs] Result: ${map.size} docs from ${nodes.length} nodes (${skippedNodes} skipped)`);
  const out = Array.from(map.values());
  // ensure ≥1 KP; cap
  out.forEach(doc => {
    if (!doc.kps.length) {
      const base = doc.score ?? 0.7;
      doc.kps = [{ kp_relevance: base, snippet: doc.title, page: 1, passage_id: `${doc.doc_id}:t`, citation_targets: [{ score: base, page: 1, passage_id: `${doc.doc_id}:t` }] }];
    }
    // Apply context-aware filtering with surrounding chunks
    const allSnippets = doc.kps.map(kp => kp.snippet);
    const filteredKps = doc.kps.filter((kp, index) => !isFootnoteOrBibliography(kp.snippet, allSnippets, index));
    
    // Ensure we always keep at least 3-5 KPs per document for rich citations  
    if (filteredKps.length < 3 && doc.kps.length > 0) {
      // If filtering removed too much, keep top KPs regardless of filtering
      const topKps = doc.kps.sort((a,b)=>b.kp_relevance-a.kp_relevance).slice(0, Math.min(5, capPerDoc));
      doc.kps = topKps;
    } else {
      doc.kps = filteredKps.sort((a,b)=>b.kp_relevance-a.kp_relevance).slice(0, capPerDoc);
    }
  });
  // rank by score then KP strength
  out.sort((a,b)=> (b.score??0)-(a.score??0) || (Math.max(...b.kps.map(k=>k.kp_relevance))-Math.max(...a.kps.map(k=>k.kp_relevance))));
  return out;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("diag")) {
    return NextResponse.json({
      ok: true,
      diag: { hasKey: Boolean(API_KEY), pipeline: PIPELINE ? "set" : "unset", base: BASE_URL, note: "chat-only; SSE parsed to {message,sources,docs}" }
    });
  }
  return NextResponse.json({ ok: true, info: "POST to call pipeline /chat. /?diag=1 for diagnostics." });
}

export async function POST(req: NextRequest) {
  try {
    const original = await req.json().catch(()=> ({}));
    const mode = original?.mode === "cite" ? "cite" : "answer";
    const capPerDoc = mode === "answer" ? 100 : 200; // Further increased: Answer 40→100, Cite 100→200 for maximum recall
    const endpoint = `${BASE_URL}/api/v1/pipelines/${PIPELINE}/chat`;
    
    // Expand query for Cite mode with document summaries
    if (mode === "cite" && original.query) {
      const expandedQuery = await expandQueryWithSummaries(original.query, mode);
      if (expandedQuery !== original.query) {
        console.log('[API Route] Query expanded for Cite mode');
        original.query = expandedQuery;
      }
    }

    // 1) forward as-is (NOTE: client no longer sends preview:true)
    let body = { ...original };
    console.log('[API Route] Full body being sent to LlamaCloud:', JSON.stringify(body, null, 2));
    let r = await postJSON(endpoint, body);

    // 2) if “messages array should not be empty”, add messages from query/system and retry once
    const detail = String((r.json as any)?.detail || "").toLowerCase();
    if (!r.ok && r.status === 422 && detail.includes("messages") && detail.includes("empty")) {
      body = ensureMessages(original);
      r = await postJSON(endpoint, body);
    }
    if (!r.ok) {
      // Preserve legacy OK=true shape with fallback flag
      return NextResponse.json({ ok: true, message: "", sources: [], docs: [], debug: { fallback: true, reason: `upstream ${r.status}`, endpoint, sample: String(r.text||"").slice(0,300) } });
    }

    // 3) Structured JSON path: if upstream already returned sources/docs, pass through + compute docs if needed
    const upstream = r.json;
    if (Array.isArray((upstream as any)?.sources) || Array.isArray((upstream as any)?.docs) || (upstream as any)?.citations) {
      const sources = Array.isArray((upstream as any)?.sources) ? (upstream as any).sources : [];
      console.log(`[API Route] Mode: ${mode}, Raw sources count: ${sources.length}`);
      
      const docs = Array.isArray((upstream as any)?.docs) && (upstream as any).docs.length
        ? (upstream as any).docs
        : groupDocs(sources, capPerDoc);
      
      console.log(`[API Route] After grouping: ${docs.length} docs, capPerDoc: ${capPerDoc}`);
      console.log(`[API Route] KPs per doc:`, docs.slice(0, 5).map((d: any) => ({ 
        title: d.title?.slice(0, 50), 
        kps: d.kps.length 
      })));
      
      return NextResponse.json({ ok: true, message: String((upstream as any)?.message || ""), sources, docs, debug: { 
        ...(upstream?.debug||{}), 
        sourcesCount: sources.length, 
        docsCount: docs.length,
        capPerDoc,
        mode,
        retrievalParams: body
      }});
    }

    // 4) SSE raw path → parse into {message, sources} then normalize to docs
    if (typeof (upstream as any)?.raw === "string") {
      const { message, sources } = parseSSERaw((upstream as any).raw);
      console.log(`[API Route SSE] Mode: ${mode}, Parsed sources: ${sources.length}`);
      
      const docs = groupDocs(sources, capPerDoc);
      console.log(`[API Route SSE] After grouping: ${docs.length} docs`);
      
      return NextResponse.json({ ok: true, message, sources, docs, debug: { 
        sourcesCount: sources.length, 
        docsCount: docs.length, 
        capPerDoc,
        mode,
        note: "parsed SSE" 
      }});
    }

    // 5) Unknown shape
    return NextResponse.json({ ok: true, message: "", sources: [], docs: [], debug: { fallback: true, reason: "unknown upstream shape", endpoint, upstreamKeys: Object.keys(upstream||{}) } });
  } catch (err: any) {
    return fail("exception", { message: String(err?.message || err) });
  }
}

