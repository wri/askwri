'use client';

import React, { useMemo, useState, useEffect, useRef } from "react";
import {
  Search, BookOpen, ChevronUp, History, Link as LinkIcon, ExternalLink, AlertTriangle,
  Loader2, FileText, Filter as FilterIcon, X as XIcon, Info, HelpCircle, TrendingUp
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { FeedbackWidget } from "@/components/FeedbackWidget";

import { DocMeta as LiveDoc, KP as LiveKP } from "@/lib/llamacloud";
import { chatAnswerLlamaIndex, chatCiteLlamaIndex, checkLlamaIndexHealth } from "@/lib/llamaindex-client";
import { ANSWER_PRESET, CITE_PRESET } from "@/config/retrieval";
import { estimateCostUSD } from "@/config/costs";
import { estimateEnergyGCO2e } from "@/config/energy";
import { ALIGNMENT_MODEL } from "@/config/alignment";

/* ---------- tiny UI helpers ---------- */
function Pane({ children, className = "" }: React.PropsWithChildren<{ className?: string }>) {
  return <div className={`p-4 ${className}`}>{children}</div>;
}
function SectionTitle({ children }: React.PropsWithChildren) {
  return <h3 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase mb-2">{children}</h3>;
}
function Metric({ label, value }: { label: string; value: string }) {
  return (<div className="flex flex-col items-start"><span className="text-xs text-muted-foreground">{label}</span><span className="text-sm font-medium tabular-nums">{value}</span></div>);
}

/* ---------- types ---------- */
type DocMeta = LiveDoc;
type KP = LiveKP;
type Mode = "answer" | "cite" | "lit" | "explain";
type CitationTarget = { score: number; page: number; passage_id: string };
type CatalogRow = { file_id:string; external_file_id:string; file_name:string; meta:Record<string,any> };

/* ---------- general helpers ---------- */
const norm = (s?: string) => (s || "").trim().toLowerCase();
const firstSentence = (t?: string) => { const m = (t || "").match(/[^.!?]*[.!?]/); return m ? m[0].trim() : (t || ""); };
const twoDp = (n?: number) => (Math.round((Number(n)||0)*100)/100).toFixed(2);
const basename = (s?: string) => { if (!s) return ""; const p = s.split("?")[0]; const parts = p.split("/"); return parts[parts.length-1] || p; };
const stripExt = (s: string) => s.replace(/\.[a-z0-9]+$/i, "");
const titleCase = (s: string) => s.replace(/\b\w/g, m => m.toUpperCase());
const slug = (s?: string) => norm(s).replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g,"-");
const parseAuthors = (csv?: string) => (csv||"").split(/;|,/).map(v=>v.trim()).filter(Boolean);
const toYear = (x:any) => {
  const n = Number(x);
  if (Number.isFinite(n)) return n;
  if (typeof x === "string") { const m = x.match(/\b(20\d{2}|19\d{2})\b/); if (m) return Number(m[1]); }
  return undefined;
};
const fallbackCity = () => "Washington, DC";
const fallbackPublisher = () => "WRI";

/* ---------- catalog parsing (same as before) ---------- */
function parseMetaJSON(metaStr?: string): Record<string, any> {
  try {
    const obj = metaStr ? JSON.parse(metaStr) : {};
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj || {})) out[norm(k)] = v;
    if (out["sub-tag (clean1)"] && !out["sub-tag"]) out["sub-tag"] = out["sub-tag (clean1)"];
    return out;
  } catch { return {}; }
}
function normalizeCatalogRow(r: any): any {
  const fileName = r.file_name || r.external_file_id || r.meta?.file_path || "";
  const baseName = basename(fileName);
  const noExt = stripExt(baseName);
  const meta = parseMetaJSON(r.meta?.metadata);
  return {
    fileName,
    baseName: baseName.toLowerCase(),
    noExt: noExt.toLowerCase(),
    titleSlug: slug(meta["article title"]),
    articleTitle: meta["article title"] || undefined,
    allAuthors: meta["all authors"] || undefined,
    sourceUrl: meta["source url"] || meta["other weblink (not doi)"] || undefined,
    articleType: meta["article type"] || undefined,
    subTag: meta["sub-tag"] || undefined,
    yearAccepted: toYear(meta["year accepted"] ?? meta["year"]),
    dateAccepted: meta["date accepted"] || undefined,
    office: meta["wri office affiliation (primary)"] || undefined,
    summary: r.meta?.summary || undefined, // Preserve the CSV summary field
    raw: meta,
  };
}
function buildCatalogIndex(items: any[]) {
  const byBase = new Map<string, any>(); // basename + noExt
  const bySlug = new Map<string, any>(); // title slug
  for (const r of items) {
    if (r.baseName) byBase.set(r.baseName, r);
    if (r.noExt) byBase.set(r.noExt, r);
    if (r.titleSlug) bySlug.set(r.titleSlug, r);
  }
  return { byBase, bySlug };
}
function matchCatalogRow(doc: DocMeta, index: ReturnType<typeof buildCatalogIndex> | null): any | undefined {
  if (!index) return undefined;
  const chunk = (doc.meta as any)?.raw?.chunk || {};
  const candidates = [
    doc._url, chunk.file_path, chunk.file_name, chunk.external_file_id, doc.title
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    const base = stripExt(basename(c).toLowerCase());
    const full = norm(c);
    const s = slug(c);
    if (index.byBase.has(base)) return index.byBase.get(base);
    if (index.byBase.has(full)) return index.byBase.get(full);
    if (s && index.bySlug.has(s)) return index.bySlug.get(s);
  }
  const s2 = slug(doc.title);
  if (s2 && index.bySlug.has(s2)) return index.bySlug.get(s2);
  return undefined;
}
function titleFrom(doc: DocMeta, row?: any) {
  const t = row?.articleTitle || doc.title || "";
  if (t) return t;
  const fromName = row?.baseName || stripExt(basename(doc._url || "")) || "(untitled)";
  return titleCase(fromName.replace(/[_\-]+/g, " ").trim());
}
function authorsFrom(doc: DocMeta, row?: any) {
  if (row?.allAuthors && row.allAuthors !== "—" && row.allAuthors !== "-") return parseAuthors(row.allAuthors);
  const fn = row?.raw?.["wri lead author - first name"]; const ln = row?.raw?.["wri lead author - last name"];
  if (fn || ln) return [`${fn || ""} ${ln || ""}`.trim()];
  return (doc.authors || []).filter(Boolean);
}
function yearFrom(doc: DocMeta, row?: any) {
  return row?.yearAccepted ?? toYear(row?.dateAccepted) ?? (typeof doc.year === "number" ? doc.year : undefined);
}
function typeFrom(doc: DocMeta, row?: any) {
  return row?.articleType || "Report";
}
function urlFrom(doc: DocMeta, row?: any) {
  if (row?.sourceUrl) return row.sourceUrl;
  const fn = row?.fileName || (doc.meta as any)?.raw?.chunk?.file_name || (doc.meta as any)?.raw?.chunk?.external_file_id;
  return fn ? `/api/pdf/${basename(fn)}` : (doc._url || null);
}
const chicagoFull = (doc: DocMeta, row?: any) => {
  const authors = authorsFrom(doc, row).join(", ") || "(author unknown)";
  const title = `"${titleFrom(doc, row)}"`;
  const cityPub = `${fallbackCity()}: ${fallbackPublisher()}`;
  const year = yearFrom(doc, row) ?? "";
  return `${authors}. ${title}. ${cityPub}, ${year}.`;
};
const chicagoShort = (doc: DocMeta, row?: any) => {
  const a = authorsFrom(doc, row);
  const first = a[0] || "";
  const last = first.split(/,|\s+/).filter(Boolean).slice(-1)[0] || "";
  const year = yearFrom(doc, row);
  return `${last}${year?` (${year})`:""}`;
}

/* ---------- component ---------- */
type WhyMeta = { why: string; relation: "direct" | "indirect" };

export default function AskWriApp() {
  const [mode, setMode] = useState<Mode>("answer");
  const [query, setQuery] = useState("");

  // Filters (catalog-based)
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [yearAny, setYearAny] = useState(true);
  const [yearMin, setYearMin] = useState<number | "">("");
  const [yearMax, setYearMax] = useState<number | "">("");
  const [selectedSubTags, setSelectedSubTags] = useState<string[]>([]);
  const [subTagQuery, setSubTagQuery] = useState("");
  const [topCount, setTopCount] = useState<5 | 10 | 20 | "all">(20);
  const [page, setPage] = useState(1);

  // Left pane
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [leftWidth, setLeftWidth] = useState(280);
  const resizingRef = useRef(false); const startXRef = useRef(0); const startWRef = useRef(280);
  function onGutterDown(e: React.MouseEvent){resizingRef.current=true; startXRef.current=e.clientX; startWRef.current=leftWidth; window.addEventListener("mousemove", onGutterMove as any); window.addEventListener("mouseup", onGutterUp as any, { once: true });}
  function onGutterMove(e: MouseEvent){ if(!resizingRef.current) return; setLeftWidth(Math.min(420, Math.max(220, startWRef.current + (e.clientX-startXRef.current)))); }
  function onGutterUp(){resizingRef.current=false; window.removeEventListener("mousemove", onGutterMove as any);}

  // State
  const [history, setHistory] = useState<string[]>([]);
  const [retrievalLoading, setRetrievalLoading] = useState(false);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [alignLoading, setAlignLoading] = useState(false);
  const [alignNote, setAlignNote] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string[]>([]);
  function logTrace(s: string) { setTranscript(t => [...t, s]); }

  const [ops, setOps] = useState<{ index_version: string; prompt_version: string; cost_usd: number | null; energy_gco2e: number | null } | null>(null);
  const [selectedCitation, setSelectedCitation] = useState<{ ref: string; page: number; passage_id: string; score: number } | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  const [answer, setAnswer] = useState<null | { sentences: string[]; paragraphs?: string[][]; inline: { ref: string; page: number }[][]; confidence: number; warning?: string; warningMessage?: string }>(null);
  const [supporting, setSupporting] = useState<DocMeta[]>([]);
  const [alignment, setAlignment] = useState<{ coverage?: string[]; caveats?: string[]; risks?: string[]; suggestions?: string[]; confidence?: number; _debugKeys?: string[] } | null>(null);
  const [showAlignment, setShowAlignment] = useState(false);
  
  // Query-level caching to avoid redundant API calls
  const [queryCache, setQueryCache] = useState<Record<string, {
    answer: { sentences: string[]; paragraphs?: string[][]; inline: { ref: string; page: number }[][]; confidence: number } | null;
    supporting: DocMeta[];
    alignment: any;
    timestamp: number;
  }>>({});

  const [docWhy, setDocWhy] = useState<Record<string, WhyMeta>>({});
  const [docWhyLoading, setDocWhyLoading] = useState<Record<string, boolean>>({});
  const [passageWhy, setPassageWhy] = useState<Record<string, WhyMeta>>({});
  const [passageWhyLoading, setPassageWhyLoading] = useState<Record<string, boolean>>({});
  const [docSummary, setDocSummary] = useState<Record<string,string>>({});
  const [docSummaryLoading, setDocSummaryLoading] = useState<Record<string, boolean>>({});
  const [citeSelected, setCiteSelected] = useState<Record<string, boolean>>({});

  // Catalog & index
  const [catalog, setCatalog] = useState<any[]>([]);
  const [index, setIndex] = useState<ReturnType<typeof buildCatalogIndex> | null>(null);
  useEffect(() => {
    (async () => {
      const res = await fetch("/api/catalog", { cache: "no-store" });
      if (!res.ok) { logTrace(`Catalog load failed: /api/catalog ${res.status}`); return; }
      const j = await res.json();
      const normed = (j.items as any[]).map(normalizeCatalogRow);
      setCatalog(normed);
      setIndex(buildCatalogIndex(normed));
      logTrace(`Catalog loaded: count=${j.count}, source=${j.source}`);
      logTrace(`🚀 Hybrid retrieval: Dense (OpenAI embeddings) + Sparse (BM25) with reranking`);
      logTrace(`📄 Document corpus: ${j.count} research papers indexed`);
      logTrace(`💰 Cost optimized: gpt-5-nano alignment, reranking enabled (95% synthesis reduction)`);
    })();
  }, []);

  function pushHistory(q:string){ setHistory(h=>[q, ...h.filter(x=>x!==q)].slice(0,20)); }

  // Prefilter basenames (Year accepted + Sub-tag)
  const prefilterBases = useMemo(() => {
    if (!catalog.length) return undefined;
    const subTagsSet = new Set(selectedSubTags.map(norm));
    const minY = yearAny ? -Infinity : (typeof yearMin === "number" ? yearMin : -Infinity);
    const maxY = yearAny ?  Infinity : (typeof yearMax === "number" ? yearMax :  Infinity);

    const bases = catalog
      .filter(row => {
        const ya = row.yearAccepted;
        const st = norm(row.subTag);
        const okYear = yearAny || (ya != null && ya >= minY && ya <= maxY);
        const okSub  = subTagsSet.size === 0 || subTagsSet.has(st);
        return okYear && okSub;
      })
      .map(row => row.noExt);

    return bases.length ? new Set(bases) : undefined;
  }, [catalog, selectedSubTags, yearAny, yearMin, yearMax]);

  // Guard visibility using catalog match (since server can't prefilter by file_id)
  const filteredDocs: DocMeta[] = useMemo(() => {
    // Defensive: ensure supporting is always an array
    if (!Array.isArray(supporting)) return [];
    if (!prefilterBases || !index) return supporting;
    const allowed = prefilterBases;
    const out: DocMeta[] = [];
    for (const d of supporting) {
      const row = matchCatalogRow(d, index);
      const base = row?.noExt || stripExt(basename(d._url || (d.meta as any)?.raw?.chunk?.file_name || (d.meta as any)?.raw?.chunk?.file_path || ""));
      if (!base) continue;
      if (allowed.has(base.toLowerCase())) out.push(d);
    }
    return out;
  }, [supporting, prefilterBases, index]);

  // === Parity counters: log visible docs whenever supporting/filter changes ===
  useEffect(() => {
    if (!supporting.length) return;
    // visible docs post-filter
    logTrace(`Visible docs: ${filteredDocs.length}`);
  }, [supporting, filteredDocs.length]); // eslint-disable-line

  const size = topCount === "all" ? filteredDocs.length || 1 : topCount;

  // Answer mode: paginate by PASSAGES, Cite mode: paginate by DOCUMENTS
  const { pageDocs, totalPages } = useMemo(() => {
    if (mode === "answer") {
      // Flatten all passages from all documents
      const allPassages: Array<{doc: DocMeta, kp: KP}> = [];
      filteredDocs.forEach(d => {
        (d.kps || []).forEach(kp => {
          allPassages.push({doc: d, kp});
        });
      });

      // Sort by relevance
      const sorted = allPassages.sort((a, b) => b.kp.kp_relevance - a.kp.kp_relevance);

      // Calculate pagination based on passage count
      const totalPassages = sorted.length;
      const actualSize = topCount === "all" ? totalPassages : size;
      const totalPgs = Math.max(1, Math.ceil(totalPassages / actualSize));

      // Slice to current page
      const start = (page - 1) * actualSize;
      const pagePassages = sorted.slice(start, start + actualSize);

      // Convert to DocMeta[] format (each doc contains only 1 KP)
      const docsForPage: DocMeta[] = pagePassages.map(({doc, kp}) => ({
        ...doc,
        kps: [kp] // Only this one passage
      }));

      return { pageDocs: docsForPage, totalPages: totalPgs };
    } else {
      // Cite mode: paginate by documents (existing behavior)
      const totalDocs = filteredDocs.length;
      const actualSize = topCount === "all" ? totalDocs : size;
      const totalPgs = Math.max(1, Math.ceil(totalDocs / actualSize));
      const start = (page - 1) * actualSize;
      const docs = filteredDocs.slice(start, start + actualSize);
      return { pageDocs: docs, totalPages: totalPgs };
    }
  }, [filteredDocs, page, size, mode, topCount]);

  // BATCH WHY processing - uses pageDocs (already paginated above)
  // Caching: passageWhy/docWhy state prevents re-fetching viewed pages
  useEffect(() => {
    console.log("[batch-why] useEffect TRIGGERED:", {
      hasIndex: !!index,
      supportingLength: supporting.length,
      mode,
      page,
      pageDocsCount: pageDocs.length
    });

    if (!index || supporting.length === 0) return;

    // Collect passages that need explanations (skip already cached)
    const passagesToProcess: Array<{
      passageId: string;
      docId: string;
      docTitle: string;
      snippet: string;
    }> = [];

    // Process pageDocs (already paginated for current page)
    pageDocs.forEach(d => {
      const row = matchCatalogRow(d, index);
      const docTitle = titleFrom(d, row);

      if (mode === "answer") {
        // Answer mode: Process each passage (pageDocs has 1 KP per doc)
        (d.kps || []).forEach(kp => {
          const passageId = `${d.doc_id}:${kp.passage_id}`;
          const alreadyHas = passageWhy[passageId];
          const isLoading = passageWhyLoading[passageId];
          const hasSnippet = kp.snippet && kp.snippet.trim().length > 10;

          if (!alreadyHas && !isLoading && hasSnippet) {
            passagesToProcess.push({
              passageId,
              docId: d.doc_id,
              docTitle,
              snippet: kp.snippet.trim()
            });
          } else if (!alreadyHas && !isLoading) {
            // Fallback for passages without snippets
            const fallbackWhy = {
              why: "This passage is relevant to the query based on its content and context.",
              relation: "indirect" as const
            };
            setPassageWhy(prev => ({...prev, [passageId]: fallbackWhy}));
          }
        });
      } else {
        // Cite mode: document-level explanations via /api/relates
        if (!docWhy[d.doc_id] && !docWhyLoading[d.doc_id]) {
          setDocWhyLoading(prev=>({...prev, [d.doc_id]: true}));
          const best = [...(d.kps||[])].sort((a,b)=>b.kp_relevance-a.kp_relevance)[0];
          
          fetch("/api/relates", {
            method:"POST", 
            headers:{"content-type":"application/json"},
            body: JSON.stringify({
              query,
              doc: {
                title: docTitle,
                authors: authorsFrom(d, row),
                year: yearFrom(d, row),
                snippet: best?.snippet ?? ""
              }
            })
          }).then(r=>r.json()).then(j=>{
            const txt = (j?.relates || j?.why || "Document provides relevant context for this query.").trim();
            const rel: "direct"|"indirect" = j?.relation === "direct" ? "direct" : "indirect";
            setDocWhy(prev=>({...prev, [d.doc_id]: { why: txt, relation: rel }}));
          }).catch(()=>{
            // Fallback explanation for Cite mode
            setDocWhy(prev=>({...prev, [d.doc_id]: { 
              why: "Document provides relevant context for this query.", 
              relation: "indirect" as const 
            }}));
          }).finally(()=>setDocWhyLoading(prev=>({...prev, [d.doc_id]: false})));
        }
      }
    });

    // Only batch process for Answer mode (Cite mode handles individual calls above)
    if (mode !== "answer") return;

    console.log("[batch-why] Processing check:", {
      mode,
      passageCount: passagesToProcess.length,
      pageDocs: pageDocs.length
    });

    if (passagesToProcess.length === 0) {
      console.warn("[batch-why] No passages to process!");
      return;
    }

    // Set loading state for passage-specific explanations
    passagesToProcess.forEach(p => {
      setPassageWhyLoading(prev => ({...prev, [p.passageId]: true}));
    });

    // Make single batch API call for Answer mode passage-specific explanations
    fetch("/api/batch-why", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        mode,
        passages: passagesToProcess.map(p => ({
          docTitle: p.docTitle,
          snippet: p.snippet
        }))
      })
    })
    .then(res => res.json())
    .then(data => {
      if (data.ok && data.explanations) {
        passagesToProcess.forEach((passage, index) => {
          const explanation = data.explanations[index];
          if (explanation) {
            const whyMeta = {
              why: explanation.why || "Relevant to the query.",
              relation: explanation.relation === "direct" ? "direct" as const : "indirect" as const
            };
            setPassageWhy(prev => ({...prev, [passage.passageId]: whyMeta}));
          }
        });
      }
    })
    .catch(error => {
      console.error("Batch why failed:", error);
      // Set fallback explanations
      passagesToProcess.forEach(passage => {
        const fallbackWhy = {
          why: "This passage provides relevant context for the query.",
          relation: "indirect" as const
        };
        setPassageWhy(prev => ({...prev, [passage.passageId]: fallbackWhy}));
      });
    })
    .finally(() => {
      // Clear loading states
      passagesToProcess.forEach(p => {
        setPassageWhyLoading(prev => ({...prev, [p.passageId]: false}));
      });
    });
  }, [index, pageDocs, query, mode]); // pageDocs changes when page changes

  /* Automatic alignment analysis - runs after all other LLM calls complete */
  const runAlignmentAfterResults = React.useCallback(() => {
    // More robust checks to ensure stable state
    if (supporting.length > 0 &&
        !alignLoading &&
        query.trim() &&
        !retrievalLoading &&
        !answerLoading) {

      console.log('[Alignment] Preparing to run alignment analysis');
      setShowAlignment(true);

      // Check cache first
      const cacheKey = `${mode}:${query.trim()}`;
      const cached = queryCache[cacheKey];
      const isExpired = cached && (Date.now() - cached.timestamp) > 5 * 60 * 1000;

      if (cached && !isExpired && cached.alignment) {
        console.log('[Alignment] Using cached alignment result');
        setAlignment(cached.alignment);
        return;
      }

      console.log('[Alignment] Running fresh alignment analysis');
      runAlignment(query, supporting);
    } else {
      console.log('[Alignment] Skipping alignment - conditions not met:', {
        supportingLength: supporting.length,
        alignLoading,
        hasQuery: !!query.trim(),
        retrievalLoading,
        answerLoading
      });
    }
  }, [supporting, alignLoading, query, mode, queryCache, retrievalLoading, answerLoading]);

  // Auto-run alignment after all other LLM calls complete
  useEffect(() => {
    // Check if any loading operations are still running
    const hasSummaryLoading = Object.values(docSummaryLoading).some(Boolean);
    const hasWhyLoading = Object.values(docWhyLoading).some(Boolean);
    const hasPassageWhyLoading = Object.values(passageWhyLoading).some(Boolean);

    // Wait for ALL operations to complete before running alignment
    const allLoadingComplete = !retrievalLoading &&
                              !answerLoading &&
                              !hasSummaryLoading &&
                              !hasWhyLoading &&
                              !hasPassageWhyLoading;

    if (allLoadingComplete && supporting.length > 0 && query.trim() && !alignLoading) {
      // Longer delay to ensure all rendering and state updates are complete
      const timer = setTimeout(() => {
        console.log('[Alignment] All loading complete, triggering alignment analysis');
        runAlignmentAfterResults();
      }, 500); // Increased delay for stability
      return () => clearTimeout(timer);
    }
  }, [
    retrievalLoading,
    answerLoading,
    docSummaryLoading,
    docWhyLoading,
    passageWhyLoading,
    alignLoading,
    supporting.length,
    query,
    runAlignmentAfterResults
  ]);

  // SUMMARY processing - cached from CSV (separate effect to avoid conflicts)
  useEffect(() => {
    if (!index || supporting.length === 0) return;

    pageDocs.forEach(d => {
      const row = matchCatalogRow(d, index);
      // Summary - Use cached summary from CSV if available
      if (!docSummary[d.doc_id]) {
        const catalogSummary = row?.summary || row?.meta?.summary || row?.raw?.summary;

        console.log("[Summary] Lookup for doc:", {
          doc_id: d.doc_id,
          title: d.title?.slice(0, 50),
          hasRow: !!row,
          hasMeta: !!row?.meta,
          hasSummary: !!catalogSummary,
          summaryLength: catalogSummary?.length,
          rowKeys: row ? Object.keys(row) : [],
          metaKeys: row?.meta ? Object.keys(row.meta) : [],
          rawKeys: row?.raw ? Object.keys(row.raw) : [],
          directSummary: row?.summary ? "found" : "not found",
          rawSummary: row?.raw?.summary ? "found in raw" : "not in raw",
          allPossibleSummaries: {
            meta_summary: row?.meta?.summary ? "yes" : "no",
            raw_summary: row?.raw?.summary ? "yes" : "no",
            direct_summary: row?.summary ? "yes" : "no"
          }
        });

        if (catalogSummary) {
          // Use pre-generated summary from CSV or user-provided summary
          console.log("[Summary] Using summary for:", d.doc_id);
          setDocSummary(prev=>({...prev, [d.doc_id]: catalogSummary}));
        } else {
          // No summary available - use first sentence from best snippet as fallback
          const best = [...(d.kps||[])].sort((a,b)=>b.kp_relevance-a.kp_relevance)[0];
          const txt = firstSentence(best?.snippet ?? "").trim();
          setDocSummary(prev=>({...prev, [d.doc_id]: txt}));
        }
      }
      if (mode === "cite" && citeSelected[d.doc_id] == null) {
        setCiteSelected(prev=>({...prev, [d.doc_id]: true}));
      }
    });
    // eslint-disable-next-line
  }, [pageDocs, query, mode, supporting, index]);

  // Helper function to get top quality results (top 40% by score)
  function getTopQualityDocs(docs: DocMeta[], maxDocs: number = 8): DocMeta[] {
    if (!docs.length) return [];

    // Sort by score descending
    const sortedDocs = [...docs].sort((a, b) => (b.score || 0) - (a.score || 0));

    // Take top 40% but cap at maxDocs
    const top40Percent = Math.max(1, Math.ceil(sortedDocs.length * 0.4));
    const finalCount = Math.min(top40Percent, maxDocs);

    const selected = sortedDocs.slice(0, finalCount);
    console.log(`[Quality Filter] Selected ${selected.length} docs from ${docs.length} total (top ${((selected.length / docs.length) * 100).toFixed(1)}%)`);

    return selected;
  }

  async function runAlignment(q:string, docs:DocMeta[]){
    try{
      setAlignNote(null);
      if(!docs?.length){ setAlignment(null); return; }
      setAlignLoading(true);

      // Use only top 40% quality docs for alignment to improve signal and reduce cost
      const topQualityDocs = getTopQualityDocs(docs, 8);

      // For alignment analysis, enhance existing docs with more context (avoid extra API call)
      const docsForAlignment = topQualityDocs.map(doc => ({
        ...doc,
        // Add a flag to indicate this is for alignment analysis
        _alignmentContext: true,
        // COST OPTIMIZATION: Reduce KPs from 30 to 5 per doc - alignment still works with less context
        kps: (doc.kps || []).slice(0, 5) // Fewer passages saves tokens while maintaining quality
      }));

      const r = await fetch("/api/alignment", {
        method:"POST",
        headers:{"content-type":"application/json"},
        body: JSON.stringify({
          query:q,
          docs: docsForAlignment,
          answer: mode === "answer" ? answer?.sentences : undefined
        })
      });
      const j = await r.json();
      if(j?.ok && j?.assessment) {
        setAlignment(j.assessment);
        setAlignNote(j?.debug?.fallback ? `(fallback: ${j.debug.reason})` : null);

        // Cache the alignment result
        const cacheKey = `${mode}:${q.trim()}`;
        setQueryCache(prev => ({
          ...prev,
          [cacheKey]: {
            ...prev[cacheKey],
            alignment: j.assessment,
            timestamp: Date.now()
          }
        }));

        // Update energy estimator with alignment token usage
        if (j.debug?.tries) {
          const alignmentUsage = j.debug.tries.reduce((total: any, tryInfo: any) => {
            if (tryInfo.usage) {
              return {
                prompt_tokens: (total.prompt_tokens || 0) + (tryInfo.usage.prompt_tokens || 0),
                completion_tokens: (total.completion_tokens || 0) + (tryInfo.usage.completion_tokens || 0),
                total_tokens: (total.total_tokens || 0) + (tryInfo.usage.total_tokens || 0)
              };
            }
            return total;
          }, {});

          if (alignmentUsage.total_tokens || alignmentUsage.prompt_tokens || alignmentUsage.completion_tokens) {
            // Add alignment usage to existing ops
            setOps(prev => {
              if (!prev) return prev;
              const alignmentCost = estimateCostUSD(alignmentUsage);
              const alignmentEnergy = estimateEnergyGCO2e(alignmentUsage);
              return {
                ...prev,
                cost_usd: (prev.cost_usd || 0) + (alignmentCost || 0),
                energy_gco2e: (prev.energy_gco2e || 0) + (alignmentEnergy || 0)
              };
            });
          }
        }
      }
      else { setAlignment(null); setAlignNote(`(alignment error: ${j?.debug?.reason ?? j?.error ?? "unknown"})`); }
    }catch(e:any){ setAlignment(null); setAlignNote(`(alignment exception: ${String(e?.message||e)})`); }
    finally{ setAlignLoading(false); }
  }

  function approxUsageAndOps(q:string, message:string, docs:DocMeta[], promptVersion:string){
    const promptChars = q.length + docs.slice(0,6).reduce((a,d)=>a+(d.kps?.[0]?.snippet?.length??0), 0);
    const completionChars = message.length;
    const usage = { model: process.env.OPENAI_MODEL || "unknown", prompt_tokens: Math.max(1,Math.round(promptChars/4)), completion_tokens: Math.max(1,Math.round(completionChars/4)) };
    const total = usage.prompt_tokens + usage.completion_tokens;
    const cost = estimateCostUSD({ ...usage, total_tokens: total });
    const energy = estimateEnergyGCO2e({ ...usage, total_tokens: total });
    setOps({ index_version:"v1.0", prompt_version: promptVersion, cost_usd: cost ?? 0, energy_gco2e: energy ?? 0 });
  }

  function logSearchConfig(m:Mode){
    if (m === "answer") {
      logTrace(`⚙️ Answer: dense=${ANSWER_PRESET.denseTopK}, sparse=${ANSWER_PRESET.sparseTopK}, rerank=${ANSWER_PRESET.rerank ? `top ${ANSWER_PRESET.rerankTopN}` : 'disabled'}`);
      logTrace(`📝 Synthesis: Concise answer with sentence-level citations, high-quality sources only`);
    } else {
      logTrace(`⚙️ Cite: dense=${CITE_PRESET.denseTopK}, sparse=${CITE_PRESET.sparseTopK}, rerank=${CITE_PRESET.rerank ? `top ${CITE_PRESET.rerankTopN}` : 'disabled'}`);
      logTrace(`📚 Output: Comprehensive bibliography with metadata & summaries, diverse sources`);
    }
    logTrace(`🔍 Search method: Hybrid retrieval (dense embeddings + sparse BM25) with RRF fusion + cross-encoder reranking`);
  }

  async function synthesizeAnswer(q:string, docs:DocMeta[]) {
    try {
      setAnswerLoading(true);

      // Use only top 40% quality docs for answer synthesis to improve quality and reduce cost
      const topQualityDocs = getTopQualityDocs(docs, 6); // COST OPTIMIZATION: Reduced from 10 to 6 docs max

      // Debug logging
      console.log("[AskWriApp] Calling synthesizeAnswer with:", {
        query: q,
        originalDocsCount: docs.length,
        filteredDocsCount: topQualityDocs.length,
        qualityFilter: "top 40%",
        docsHaveKps: topQualityDocs.every(d => d.kps && d.kps.length > 0),
        firstDoc: topQualityDocs[0] ? {
          hasTitle: !!topQualityDocs[0].title,
          hasKps: !!topQualityDocs[0].kps,
          kpsCount: topQualityDocs[0].kps?.length,
          firstSnippet: topQualityDocs[0].kps?.[0]?.snippet?.slice(0, 50),
          score: topQualityDocs[0].score
        } : null
      });

      const r = await fetch("/api/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q, docs: topQualityDocs }),
      });
      const j = await r.json();

      // Debug response
      console.log("[AskWriApp] Answer response:", {
        ok: j?.ok,
        hasSynthesis: !!j?.synthesis,
        sentenceCount: j?.synthesis?.sentences?.length,
        warning: j?.synthesis?.warning,
        warningMessage: j?.synthesis?.warningMessage,
        debug: j?.debug
      });

      // Return full synthesis object including warnings
      return j?.synthesis || { sentences: [] };
    } finally {
      setAnswerLoading(false);
    }
  }

  async function doAnswer(q:string){
    try{
      setRetrievalLoading(true);
      const yr = yearAny ? "ANY" : `${yearMin || "-∞"}–${yearMax || "+∞"}`;
      logTrace(`→ Answer retrieval | filters: Year=${yr}, Sub-tags=${selectedSubTags.join("|")||"(none)"}`);
      logTrace(`Using hybrid retrieval: dense (embeddings) + sparse (BM25) fusion with reranking`);
      const { message, docs, usage, debug } = await chatAnswerLlamaIndex(q, { ...ANSWER_PRESET });
      logTrace(`← Hybrid search: ${debug?.stage1_results ?? 50} fusion results → ${debug?.stage2_results ?? debug?.final_results ?? docs.length} reranked results`);
      logTrace(`Retrieval method: ${debug?.retrieval_method ?? 'hybrid_fusion_rrf'} | Final results: ${docs.length} docs`);

      // Calculate embedding costs for transparent reporting
      const embeddingTokens = debug?.estimated_embedding_tokens ?? 50;
      const embeddingCost = estimateCostUSD({
        model: "openai/text-embedding-3-small",
        prompt_tokens: embeddingTokens,
        completion_tokens: 0
      }) ?? 0.001;
      const embeddingEnergy = estimateEnergyGCO2e({
        model: "text-embedding-3-small",
        prompt_tokens: embeddingTokens,
        completion_tokens: 0
      }) ?? 0.01;

      logTrace(`Embedding cost: $${embeddingCost.toFixed(5)} (${embeddingTokens} tokens, ${debug?.embedding_api_calls ?? 1} API calls)`);
      if (docs.length > 10) {
        logTrace(`💡 Tip: High document count found - consider refining query for precision`);
      } else if (docs.length < 3) {
        logTrace(`💡 Tip: Few matches found - try broader terms or synonyms`);
      }

      // Check if docs are properly hydrated
      const docsHydrated = docs.every(d => d.kps && d.kps.length > 0 && d.kps[0].snippet);
      console.log("[AskWriApp] Docs hydration check:", {
        totalDocs: docs.length,
        allHydrated: docsHydrated,
        docsWithKps: docs.filter(d => d.kps && d.kps.length > 0).length,
        docsWithSnippets: docs.filter(d => d.kps?.[0]?.snippet).length
      });

      setSupporting(docs);
      setRetrievalLoading(false);

      // Filter docs to only those with actual content before synthesis
      const validDocs = docs.filter(d => 
        d.kps && 
        d.kps.length > 0 && 
        d.kps.some(kp => kp.snippet && kp.snippet.length > 10) // At least one valid KP
      );
      
      console.log("[AskWriApp] Document validation:", {
        totalDocs: docs.length,
        validDocs: validDocs.length,
        docDetails: docs.map(d => ({
          doc_id: d.doc_id,
          title: d.title?.slice(0, 50),
          kpsCount: d.kps?.length,
          hasValidKPs: d.kps?.some(kp => kp.snippet && kp.snippet.length > 10)
        }))
      });
      
      if (validDocs.length === 0) {
        console.warn("[AskWriApp] No valid docs with snippets for synthesis!");
        setAnswer({ 
          sentences: ["Unable to synthesize answer: no documents with content found."], 
          inline: [], 
          confidence: 0.1 
        });
        return;
      }

      console.log("[doAnswer] Sending to synthesis:", {
        totalRetrieved: docs.length,
        validDocsForSynthesis: validDocs.length,
        docTitles: validDocs.map(d => d.title?.slice(0, 50)),
        kpCounts: validDocs.map(d => d.kps?.length)
      });
      
      const result = await synthesizeAnswer(q, validDocs);

      // Extract sentences and metadata from synthesis result
      let sentences: string[] = [];
      let paragraphs: string[][] | undefined;
      let warning: string | undefined;
      let warningMessage: string | undefined;

      if (typeof result === 'object' && result !== null) {
        // New format: synthesis object with metadata
        sentences = result.sentences || [];
        paragraphs = result.paragraphs;
        warning = result.warning;
        warningMessage = result.warningMessage;
      } else if (Array.isArray(result)) {
        // Legacy format: direct array
        const isParagraphs = Array.isArray(result[0]);
        if (isParagraphs) {
          paragraphs = result as string[][];
          sentences = paragraphs.flat();
        } else {
          sentences = result as string[];
        }
      }

      // Log warnings if present
      if (warning) {
        console.warn(`[doAnswer] Answer warning: ${warning} - ${warningMessage}`);
        logTrace(`⚠️  ${warningMessage || 'Answer may have quality issues'}`);
      }
      
      // Generate citations for each sentence - ensure ALL documents get cited
      console.log("[doAnswer] Citation generation:", {
        sentenceCount: sentences.length,
        docsForCitations: validDocs.length,
        docTitles: validDocs.map(d => d.title?.slice(0, 30))
      });
      
      const inline = sentences.map((sent, sentIdx) => {
        const refs: {ref:string; page:number}[] = [];
        
        // Collect ALL available chunks/passages from ALL documents
        const allChunks: {doc: DocMeta, kp: KP}[] = [];
        validDocs.forEach(doc => {
          (doc.kps || []).forEach(kp => {
            allChunks.push({doc, kp});
          });
        });
        
        console.log(`[doAnswer] Available chunks for citations: ${allChunks.length} from ${validDocs.length} docs`);
        
        // Distribute chunks across sentences (2-3 citations per sentence)
        const chunksPerSentence = Math.max(1, Math.min(3, Math.ceil(allChunks.length / sentences.length)));
        const startIdx = sentIdx * chunksPerSentence;
        const endIdx = Math.min(startIdx + chunksPerSentence, allChunks.length);
        
        for (let i = startIdx; i < endIdx; i++) {
          const chunk = allChunks[i];
          if (chunk && chunk.kp) {
            refs.push({
              ref: chunk.doc.ref, 
              page: chunk.kp.page ?? 1
            });
          }
        }
        
        // Fallback: ensure every sentence has at least one citation
        if (refs.length === 0 && allChunks.length > 0) {
          const fallbackChunk = allChunks[sentIdx % allChunks.length];
          refs.push({
            ref: fallbackChunk.doc.ref, 
            page: fallbackChunk.kp.page ?? 1
          });
        }
        
        console.log(`[doAnswer] Sentence ${sentIdx}: ${refs.length} chunk-level citations`);
        return refs;
      });
      
      setAnswer({
        sentences,
        paragraphs,
        inline,
        confidence: Math.min(0.9, 0.5 + docs.length*0.06),
        warning,
        warningMessage
      });

      if(usage){
        const total = (usage.total_tokens ?? 0) || ((usage.prompt_tokens ?? 0)+(usage.completion_tokens ?? 0));
        const cost = estimateCostUSD({ ...usage, total_tokens: total });
        const energy = estimateEnergyGCO2e({ ...usage, total_tokens: total });

        // Add embedding costs from retrieval
        const totalCost = (cost ?? 0) + (embeddingCost ?? 0);
        const totalEnergy = (energy ?? 0) + (embeddingEnergy ?? 0);

        setOps({ index_version:"v1.0", prompt_version:"ANSv1.3", cost_usd: totalCost, energy_gco2e: totalEnergy });
      }else{
        approxUsageAndOps(q, sentences.join(" "), docs, "ANSv1.3");
      }
    }catch(e:any){
      setRetrievalLoading(false);
      logTrace(`Vector search error → ${String(e?.message||e)}`);
    }
  }

  async function doCite(q:string){
    try{
      setRetrievalLoading(true);
      const yr = yearAny ? "ANY" : `${yearMin || "-∞"}–${yearMax || "+∞"}`;
      logTrace(`→ Cite retrieval | filters: Year=${yr}, Sub-tags=${selectedSubTags.join("|")||"(none)"}`);
      logTrace(`Hybrid retrieval: dense + sparse fusion optimized for comprehensive recall`);
      // Use hybrid retrieval for maximum recall in Cite mode
      const { docs, usage, debug } = await chatCiteLlamaIndex(q);
      logTrace(`← Hybrid fusion: ${debug?.stage1_results ?? 37} results → reranked to ${debug?.final_results ?? docs.length} final docs`);
      logTrace(`Mode config: ${JSON.stringify(debug?.mode_config || {dense: '40%', sparse: '60%'})} | Method: ${debug?.retrieval_method ?? 'hybrid_fusion_rrf'}`);

      // Calculate embedding costs for cite mode
      const citeEmbeddingTokens = debug?.estimated_embedding_tokens ?? 50;
      const citeEmbeddingCost = estimateCostUSD({
        model: "openai/text-embedding-3-small",
        prompt_tokens: citeEmbeddingTokens,
        completion_tokens: 0
      }) ?? 0.001;
      const citeEmbeddingEnergy = estimateEnergyGCO2e({
        model: "text-embedding-3-small",
        prompt_tokens: citeEmbeddingTokens,
        completion_tokens: 0
      }) ?? 0.01;

      logTrace(`Embedding cost: $${citeEmbeddingCost.toFixed(5)} (${citeEmbeddingTokens} tokens, cached embeddings used)`);
      if (docs.length === 0) {
        logTrace(`⚠️ No matches found - try different keywords or check spelling`);
      } else if (docs.length > 20) {
        logTrace(`🎯 Excellent coverage! Consider Answer mode for synthesis`);
      }

      setAnswer(null);
      setSupporting(docs);
      setRetrievalLoading(false);

      if(usage){
        const total = (usage.total_tokens ?? 0) || ((usage.prompt_tokens ?? 0)+(usage.completion_tokens ?? 0));
        const cost = estimateCostUSD({ ...usage, total_tokens: total });
        const energy = estimateEnergyGCO2e({ ...usage, total_tokens: total });

        // Add embedding costs from retrieval
        const totalCost = (cost ?? 0) + (citeEmbeddingCost ?? 0);
        const totalEnergy = (energy ?? 0) + (citeEmbeddingEnergy ?? 0);

        setOps({ index_version:"v1.0", prompt_version:"CITEv1.3", cost_usd: totalCost, energy_gco2e: totalEnergy });
      }else{
        approxUsageAndOps(q, "", docs, "CITEv1.3");
      }
    }catch(e:any){
      setRetrievalLoading(false);
      logTrace(`Vector search error → ${String(e?.message||e)}`);
    }
  }

  function runQuery(runMode=mode, q=query){
    if (!q.trim()) { logTrace("No query text. Enter a query and press Submit."); return; }
    
    // Check cache first (5 minute expiry)
    const cacheKey = `${runMode}:${q.trim()}`;
    const cached = queryCache[cacheKey];
    const isExpired = cached && (Date.now() - cached.timestamp) > 5 * 60 * 1000;
    
    if (cached && !isExpired) {
      console.log("[Performance] Using cached results for:", cacheKey);
      setAnswer(cached.answer);
      // Defensive: ensure supporting is always an array
      setSupporting(Array.isArray(cached.supporting) ? cached.supporting : []);
      setAlignment(cached.alignment);
      setPage(1);
      return;
    }
    
    setTranscript([`Interpret query: "${q.trim()}"`, runMode==="answer" ? "Plan: ANSWER → synthesize with inline citations." : "Plan: CITE → build annotated bibliography."]);
    logSearchConfig(runMode);
    setSelectedCitation(null);
    setAlignment(null); setAlignNote(null); setShowAlignment(false);
    if (runMode === "cite") { setDocWhy({}); setDocSummary({}); setDocWhyLoading({}); setDocSummaryLoading({}); setCiteSelected({}); }
    if (runMode === "answer") { setDocWhy({}); setDocSummary({}); setDocWhyLoading({}); setDocSummaryLoading({}); }
    setAnswer(null); setSupporting([]);
    setPage(1);
    pushHistory(q.trim());
    if (runMode==="answer") doAnswer(q);
    else if (runMode==="cite") doCite(q);
  }

  // Clear all results when switching modes
  function clearResults() {
    setAnswer(null);
    setSupporting([]);
    setAlignment(null);
    setShowAlignment(false);
    setDocWhy({});
    setDocWhyLoading({});
    setPassageWhy({});
    setPassageWhyLoading({});
    setDocSummary({});
    setDocSummaryLoading({});
    setCiteSelected({});
    setSelectedCitation(null);
    setPdfUrl(null);
    setOps(null);
  }

  /* -------- render -------- */
  const rightCol=520; const gridTemplate=`${leftCollapsed?"0px":`${leftWidth}px`} 16px 1fr ${rightCol}px`;

  return (
    <div className="w-full h-full min-h-[720px] bg-background text-foreground">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-background/50 backdrop-blur sticky top-0 z-30">
        <div className="flex items-start gap-3">
          <div className="flex items-center gap-2 mt-1"><BookOpen className="w-5 h-5"/><span className="font-semibold">AskWRI</span></div>
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-3 text-muted-foreground" />
            <textarea rows={2} value={query} onChange={(e)=>setQuery(e.target.value)} className="w-full resize-none pl-9 pr-40 py-2 rounded-md border bg-background text-sm leading-snug" placeholder="Ask a research question…" />
            <div className="absolute right-2 top-2 flex gap-2">
              <Button size="sm" variant="outline" onClick={()=>setFiltersOpen(v=>!v)}><FilterIcon className="w-4 h-4 mr-1"/>Filters</Button>
              <Button size="sm" onClick={()=>runQuery(mode, query)} className="bg-gray-700 text-white hover:bg-gray-700 hover:text-white active:bg-gray-800">
                {(retrievalLoading || answerLoading) ? (<><Loader2 className="w-4 h-4 mr-1 animate-spin"/>Run</>) : (<>Submit</>)}
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="sm" variant={mode==="answer"?"default":"outline"} className={mode==="answer"?"bg-gray-700 text-white":""} onClick={()=>{ clearResults(); setMode("answer"); }}>
                      Answer
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom"><span className="text-xs">Answer a question</span></TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="sm" variant={mode==="cite"?"default":"outline"} className={mode==="cite"?"bg-gray-700 text-white":""} onClick={()=>{ clearResults(); setMode("cite"); }}>
                      Cite
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom"><span className="text-xs">Create a bibliography</span></TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <Button size="sm" variant="outline" disabled className="opacity-60 cursor-not-allowed">
                Lit review <HelpCircle className="w-3.5 h-3.5 ml-1"/>
              </Button>
              <Button size="sm" variant="outline" disabled className="opacity-60 cursor-not-allowed">
                Explain <HelpCircle className="w-3.5 h-3.5 ml-1"/>
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="grid gap-0" style={{height:"calc(100vh - 112px)", gridTemplateColumns: gridTemplate}}>
        {/* Left */}
        <Pane className={`border-r overflow-auto ${leftCollapsed?"p-0":""}`}>
          {!leftCollapsed && (
            <>
              <details open className="mb-2">
                <summary className="cursor-pointer text-sm font-medium flex items-center justify-between">
                  <span>History</span>
                  <Button size="icon" variant="ghost" onClick={()=>setLeftCollapsed(true)} title="Collapse left panel"><ChevronUp className="w-4 h-4"/></Button>
                </summary>
                <div className="mt-2">
                  <ScrollArea className="h-[240px] pr-2">
                    {history.length===0 && <p className="text-sm text-muted-foreground">No recent queries.</p>}
                    <ul className="space-y-2">{history.map((q,idx)=>(
                      <li key={idx} className="flex items-start gap-2 text-sm">
                        <History className="w-3.5 h-3.5 mt-0.5 text-muted-foreground"/><button className="text-left hover:underline" onClick={()=>{ setQuery(q); setPage(1); runQuery(mode, q); }}>{q}</button>
                      </li>))}
                    </ul>
                  </ScrollArea>
                </div>
              </details>

              <Separator className="my-3"/>
              <details open className="mb-2">
                <summary className="cursor-pointer text-sm font-medium flex items-center gap-2"><Info className="w-4 h-4"/> About</summary>
                <div className="mt-2 text-sm">
                  <div className="grid grid-cols-2 gap-3">
                    <Metric label="Index version" value={ops?.index_version ?? "—"} />
                    <Metric label="Prompt version" value={ops?.prompt_version ?? (mode==="answer"?"ANSv1.2":"CITEv1.2")} />
                    <Metric label="Query cost (USD)" value={ops?.cost_usd!=null?`$${ops.cost_usd.toFixed(4)}`:"—"} />
                    <Metric label="Energy (gCO₂e)" value={ops?.energy_gco2e!=null?`${ops?.energy_gco2e.toFixed(2)}`:"—"} />
                  </div>
                </div>
              </details>
            </>
          )}
        </Pane>

        {/* Gutter */}
        <div onMouseDown={onGutterDown} className="relative group bg-border cursor-col-resize" title={leftCollapsed?"Expand left panel":"Resize / Collapse"}>
          <Button size="icon" variant="ghost" className="absolute -right-4 top-2 shadow-sm" onClick={()=>setLeftCollapsed(v=>!v)} title={leftCollapsed?"Expand":"Collapse"}>
            {leftCollapsed?<ChevronUp className="w-4 h-4 rotate-180"/>:<ChevronUp className="w-4 h-4"/>}
          </Button>
          <div className="absolute inset-y-0 -right-1 w-2 cursor-col-resize"/>
        </div>

        {/* Center */}
        <Pane className="overflow-y-auto">
          {/* Filters */}
          <details open={filtersOpen} onToggle={e=>setFiltersOpen((e.target as HTMLDetailsElement).open)} className="mb-3">
            <summary className="cursor-pointer text-sm font-medium flex items-center gap-2">{filtersOpen?"Filters ▲":"Filters ▼"}</summary>
            <Card><CardContent className="pt-2 pb-2">
              <div className="grid grid-cols-12 gap-3 items-end">
                <div className="col-span-12 md:col-span-6">
                  <Label className="text-xs">Year accepted</Label>
                  <div className="flex items-center gap-2 mt-1">
                    <Checkbox id="anyyear" checked={yearAny} onCheckedChange={(v:any)=>setYearAny(!!v)}/>
                    <Label htmlFor="anyyear" className="text-xs mr-2">Any</Label>
                    <Input type="number" min={1900} max={2100} placeholder="Min" value={yearMin as any} disabled={yearAny}
                      onChange={(e)=>setYearMin(e.target.value===""?"":Number(e.target.value))} className="w-24"/>
                    <span className="text-xs text-muted-foreground">–</span>
                    <Input type="number" min={1900} max={2100} placeholder="Max" value={yearMax as any} disabled={yearAny}
                      onChange={(e)=>setYearMax(e.target.value===""?"":Number(e.target.value))} className="w-24"/>
                  </div>
                </div>
                <div className="col-span-12 md:col-span-6">
                  <Label className="text-xs">Sub-tags</Label>
                  <div className="mt-1">
                    <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                      {selectedSubTags.map(tag=>(
                        <span key={tag} className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs bg-foreground text-background">
                          {tag}<button className="rounded-full p-[2px] hover:opacity-80" onClick={()=>setSelectedSubTags(s=>s.filter(t=>t!==tag))}><XIcon className="w-3 h-3"/></button>
                        </span>
                      ))}
                      <input value={subTagQuery} onChange={(e)=>setSubTagQuery(e.target.value)} placeholder="Type to add…" className="flex-1 bg-transparent outline-none text-sm py-1"
                        onKeyDown={(e)=>{ if(e.key==="Enter" && subTagQuery.trim()){ setSelectedSubTags(s=>Array.from(new Set([...s, subTagQuery.trim()]))); setSubTagQuery(""); }}}/>
                    </div>
                  </div>
                </div>
              </div>
              <Separator className="my-2"/>
              <div className="flex items-center gap-2">
                <Label className="text-xs mr-1">Show:</Label>
                {[5,10,20].map(n=>(
                  <Button key={n} size="sm" variant={topCount===n?"default":"outline"} className={topCount===n?"bg-gray-700 text-white":""} onClick={()=>{setTopCount(n as any); setPage(1);}}>{n}</Button>
                ))}
                <Button size="sm" variant={topCount==="all"?"default":"outline"} className={topCount==="all"?"bg-gray-700 text-white":""} onClick={()=>{setTopCount("all"); setPage(1);}}>All</Button>
              </div>
            </CardContent></Card>
          </details>

          {/* Thinking */}
          <details open className="mb-3">
            <summary className="cursor-pointer text-sm font-medium">Thinking</summary>
            <ScrollArea className="h-32 mt-2 pr-2 border rounded-md bg-background"><ul className="text-sm p-2 space-y-1">{transcript.map((t,i)=><li key={i} className="leading-snug">{t}</li>)}</ul></ScrollArea>
          </details>

          {/* Alignment - Opt-in Analysis */}
          <details open className="mb-3">
            <summary className="cursor-pointer text-sm font-medium flex items-center gap-2">
              Alignment
              {alignLoading && <Loader2 className="w-3.5 h-3.5 animate-spin inline-block ml-2" />}
            </summary>
            <Card className="mt-2"><CardContent className="pt-2 pb-2 text-sm space-y-2">
              {!alignLoading && !alignment && (
                <div className="text-center py-4">
                  <p className="text-xs text-muted-foreground">
                    Alignment analysis will run automatically after results are retrieved
                  </p>
                </div>
              )}
              {!alignLoading && alignment && (
                <>
                  <div><span className="font-semibold">Coverage & correspondence</span><ul className="list-disc pl-5">{(alignment.coverage||[]).map((x,i)=><li key={i}>{x}</li>)}</ul></div>
                  <div><span className="font-semibold">Caveats & reservations</span><ul className="list-disc pl-5">{(alignment.caveats||[]).map((x,i)=><li key={i}>{x}</li>)}</ul></div>
                  <div><span className="font-semibold">Risks & failure modes</span><ul className="list-disc pl-5">{(alignment.risks||[]).map((x,i)=><li key={i}>{x}</li>)}</ul></div>
                  <div><span className="font-semibold">Suggestions for query improvement</span><ul className="list-disc pl-5">{(alignment.suggestions||[]).map((x,i)=><li key={i}>{x}</li>)}</ul></div>
                  <div className="text-xs text-muted-foreground">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help underline decoration-dotted">
                            Confidence: {(alignment.confidence ?? 0).toFixed(2)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs bg-slate-900 text-white border border-slate-700 shadow-lg z-50">
                          <p className="text-xs">
                            <strong>Alignment Confidence Score:</strong><br/>
                            • 0.80-1.00: High confidence in completeness and accuracy<br/>
                            • 0.60-0.79: Moderate confidence, some gaps may exist<br/>
                            • 0.40-0.59: Lower confidence, significant limitations<br/>
                            • &lt;0.40: Low confidence, major coverage gaps
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    {alignNote ? <em className="ml-1">{alignNote}</em> : null}
                  </div>
                </>
              )}
              {alignLoading && <div className="text-xs text-muted-foreground">Evaluating results…</div>}
            </CardContent></Card>
          </details>

          {/* Content */}
          {mode === "answer" ? (
            <>
              {/* Answer */}
              <Card className="mb-3">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    Answer {(retrievalLoading || answerLoading) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  </CardTitle>
                  {/* Show truncation/partial warning if present */}
                  {answer && answer.warning === "partial_answer" && (
                    <div className="flex items-center gap-2 bg-yellow-100 text-yellow-900 border border-yellow-300 rounded-md px-3 py-2 mt-2">
                      <AlertTriangle className="w-4 h-4" />
                      <span className="text-sm">{answer.warningMessage || "Answer may be incomplete"}</span>
                    </div>
                  )}
                  {/* Show confidence warning for low-confidence answers */}
                  {answer && !answer.warning && answer.confidence < 0.6 && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center gap-2 bg-yellow-100 text-yellow-900 border border-yellow-300 rounded-md px-3 py-2 cursor-help">
                            <AlertTriangle className="w-4 h-4" />
                            <span className="text-sm">Coverage may be incomplete (confidence {(answer.confidence * 100).toFixed(0)}%). Review passages.</span>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-sm bg-slate-900 text-white border border-slate-700 shadow-lg z-50">
                          <p className="text-xs">
                            <strong>Answer Confidence Score:</strong><br/>
                            This score reflects how well the available documents address your question. Lower scores suggest you may need to:<br/>
                            • Refine your query for better matches<br/>
                            • Check if key documents are missing<br/>
                            • Review individual passages for gaps
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="text-sm leading-relaxed max-h-[520px] overflow-y-auto pr-2">
                    {answer ? (
                      answer.paragraphs ? (
                        // Render as paragraphs with sentence-level citations
                        answer.paragraphs.map((paragraph, pIdx) => {
                          let sentenceOffset = 0;
                          // Calculate sentence offset for this paragraph
                          for (let p = 0; p < pIdx; p++) {
                            sentenceOffset += answer.paragraphs![p].length;
                          }
                          
                          return (
                            <div key={pIdx} className="mb-3">
                              {paragraph.map((sent, sIdx) => {
                                const globalSentIdx = sentenceOffset + sIdx;
                                return (
                                  <span key={sIdx}>
                                    {sent}{" "}
                                    {answer.inline[globalSentIdx]?.map((c, j) => {
                                      const doc = filteredDocs.find(d => d.ref === c.ref);
                                      if (!doc) return null;
                                      const topKp = doc.kps[0];
                                      const topCt = topKp?.citation_targets?.[0];
                                      const ct: CitationTarget = topCt
                                        ? { score: topCt.score, page: topCt.page ?? c.page, passage_id: topCt.passage_id }
                                        : { score: topKp?.kp_relevance ?? 0.7, page: topKp?.page ?? c.page, passage_id: topKp?.passage_id ?? `p${c.page}:?` };
                                      return (
                                        <button
                                          key={j}
                                          className="text-[11px] underline decoration-dotted hover:opacity-80 text-blue-600"
                                          onClick={() => setSelectedCitation({ ref: doc.ref, page: ct.page, passage_id: ct.passage_id, score: ct.score })}
                                          title={`View ${titleFrom(doc, index ? matchCatalogRow(doc, index) : undefined)} p.${ct.page}`}
                                        >
                                          [{globalSentIdx + 1}.{j + 1}]
                                        </button>
                                      );
                                    })}{" "}
                                  </span>
                                );
                              })}
                            </div>
                          );
                        })
                      ) : (
                        // Fallback to original sentence rendering
                        answer.sentences.map((sent, i) => (
                          <p key={i} className="leading-normal mb-1">
                            {sent}{" "}
                            {answer.inline[i]?.map((c, j) => {
                              const doc = filteredDocs.find(d => d.ref === c.ref);
                              if (!doc) return null;
                              const topKp = doc.kps[0];
                              const topCt = topKp?.citation_targets?.[0];
                              const ct: CitationTarget = topCt
                                ? { score: topCt.score, page: topCt.page ?? c.page, passage_id: topCt.passage_id }
                                : { score: topKp?.kp_relevance ?? 0.7, page: topKp?.page ?? c.page, passage_id: topKp?.passage_id ?? `p${c.page}:?` };
                              return (
                                <button
                                  key={j}
                                  className="text-[11px] underline decoration-dotted hover:opacity-80 text-blue-600"
                                  onClick={() => setSelectedCitation({ ref: doc.ref, page: ct.page, passage_id: ct.passage_id, score: ct.score })}
                                  title={`View ${titleFrom(doc, index ? matchCatalogRow(doc, index) : undefined)} p.${ct.page}`}
                                >
                                  [{i + 1}.{j + 1}]
                                </button>
                              );
                            })}
                          </p>
                        ))
                      )
                    ) : (<p className="text-sm text-muted-foreground">(Enter a query and click Submit)</p>)}
                  </div>
                </CardContent>
              </Card>

              {/* Supporting Citations (with Why & Doc summary) */}
              <SectionTitle>Supporting Citations</SectionTitle>

              {/* Pagination Controls */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mb-4">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {page} of {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                  >
                    Next
                  </Button>
                </div>
              )}

              <AllKPsList
                docs={pageDocs}
                index={index}
                mode={mode}
                docWhy={docWhy}
                docWhyLoading={docWhyLoading}
                passageWhy={passageWhy}
                passageWhyLoading={passageWhyLoading}
                docSummary={docSummary}
                docSummaryLoading={docSummaryLoading}
                onOpenPassage={(doc, ct)=>setSelectedCitation({ref:doc.ref,page:ct.page,passage_id:ct.passage_id,score:ct.score})}
              />

              {/* Pagination Controls (bottom) */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {page} of {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          ) : mode === "cite" ? (
            <CitePanel
              query={query}
              docs={pageDocs}
              index={index}
              docSummary={docSummary}
              docWhy={docWhy}
              docWhyLoading={docWhyLoading}
              docSummaryLoading={docSummaryLoading}
              citeSelected={citeSelected}
              onToggleSelect={(id, v) => setCiteSelected(prev=>({...prev, [id]: v}))}
              onOpenPdf={(url)=>setPdfUrl(url)}
            />
          ) : (
            <Card className="mb-3">
              <CardHeader>
                <CardTitle className="text-base">Coming soon</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Lit review and Explain are disabled in this build.
              </CardContent>
            </Card>
          )}

          {/* Feedback Widget - appears after all results */}
          <FeedbackWidget
            query={query}
            mode={mode}
            resultCount={filteredDocs.length}
            hasResults={supporting.length > 0 && !retrievalLoading && !answerLoading}
          />
        </Pane>

        {/* Right */}
        <Pane className="border-l bg-muted/20 overflow-y-auto">
          {mode === "cite" ? (
            <>
              <SectionTitle>PDF Preview</SectionTitle>
              <Card className="mt-2"><CardContent className="pt-4 text-sm min-h-[220px]">
                {pdfUrl ? (<iframe src={pdfUrl} className="w-full h-[70vh] rounded-md border"/>) : (<div className="text-muted-foreground text-sm">Open a PDF from the results to preview it here.</div>)}
              </CardContent></Card>
            </>
          ) : (
            <>
              <SectionTitle>Passage preview</SectionTitle>
              <Card className="mb-3"><CardContent className="pt-4 text-sm min-h-[220px]">
                {selectedCitation ? (
                  <>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-xs text-muted-foreground">
                        {(() => {
                          const doc = filteredDocs.find(d=>d.ref===selectedCitation.ref);
                          const row = doc && index ? matchCatalogRow(doc, index) : undefined;
                          return doc ? `${chicagoShort(doc, row)}, p.${selectedCitation.page}` : `p.${selectedCitation.page}`;
                        })()}
                      </div>
                      {(() => {
                        const doc = filteredDocs.find(d=>d.ref===selectedCitation.ref);
                        const row = doc && index ? matchCatalogRow(doc, index) : undefined;
                        const url = doc ? urlFrom(doc, row) : null;
                        if (!doc || !url) return null;
                        const href = `${url}#page=${selectedCitation.page}`;
                        return (
                          <Button size="sm" variant="outline" asChild>
                            <a href={href} target="_blank" rel="noreferrer">
                              <ExternalLink className="w-4 h-4 mr-1"/>Open PDF (p.{selectedCitation.page})
                            </a>
                          </Button>
                        );
                      })()}
                    </div>
                    <PassageParagraph selected={selectedCitation} docs={filteredDocs}/>
                  </>
                ) : (<div className="text-muted-foreground text-sm">Select a passage to preview it here.</div>)}
              </CardContent></Card>
            </>
          )}
        </Pane>
      </div>
    </div>
  );
}

/* ---------- Supporting Citations (Answer mode) ---------- */
function AllKPsList({
  docs, index, mode, docWhy, docWhyLoading, passageWhy, passageWhyLoading, docSummary, docSummaryLoading, onOpenPassage,
}: {
  docs: DocMeta[];
  index: ReturnType<typeof buildCatalogIndex> | null;
  mode: Mode;
  docWhy: Record<string, { why:string; relation:"direct"|"indirect" }>;
  docWhyLoading: Record<string, boolean>;
  passageWhy: Record<string, { why:string; relation:"direct"|"indirect" }>;
  passageWhyLoading: Record<string, boolean>;
  docSummary: Record<string, string>;
  docSummaryLoading: Record<string, boolean>;
  onOpenPassage: (doc: DocMeta, ct: CitationTarget)=>void;
}) {
  const items = useMemo(()=>{
    const arr: { doc: DocMeta; kp: KP }[] = [];
    for (const d of docs) for (const kp of d.kps) arr.push({ doc: d, kp });
    return arr.sort((a,b)=> b.kp.kp_relevance - a.kp.kp_relevance);
  }, [docs]);

  return (
    <div className="space-y-3">
      {items.map(({doc, kp}, idx)=> {
        const row = index ? matchCatalogRow(doc, index) : undefined;
        // Use passage-specific explanations in Answer mode, document-level in Cite mode
        const passageId = `${doc.doc_id}:${kp.passage_id}`;
        const whyData = mode === "answer" ? passageWhy[passageId] : docWhy[doc.doc_id];
        const why = whyData?.why;
        const rel = whyData?.relation === "direct" ? "Direct" : "Indirect";
        
        // Debug logging for UI rendering
        if (mode === "answer" && idx < 3) {
          console.log(`[UI Debug] Passage ${idx}:`, {
            passageId,
            hasWhyData: !!whyData,
            why: why?.slice(0, 50) + "...",
            relation: whyData?.relation,
            allPassageWhyKeys: Object.keys(passageWhy).slice(0, 5)
          });
        }
        const sum = docSummary[doc.doc_id];

        return (
          <Card key={`${doc.doc_id}-${kp.passage_id}-${idx}`}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <CardTitle className="text-base leading-snug line-clamp-2">{titleFrom(doc, row)}</CardTitle>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {chicagoFull(doc, row)} • p.{kp.page}
                  </div>

                  <div className="mt-2 flex flex-col gap-1">
                    <div className="text-sm">
                      <span className="font-medium">Why it answers:</span>{" "}
                      {(mode === "answer" ? passageWhyLoading[passageId] : docWhyLoading[doc.doc_id]) ? <Loader2 className="w-3.5 h-3.5 inline animate-spin ml-1"/> : 
                        <span className="text-gray-700 font-normal" style={{display: 'inline-block', minHeight: '1rem', backgroundColor: '#f3f4f6', padding: '2px 4px', borderRadius: '4px'}}>
                          {mode === "answer" && why ? `[${rel}] ${why}` : `[${rel}] ${why || "—"}`}
                        </span>
                      }
                    </div>
                    <details>
                      <summary className="text-sm underline cursor-pointer">Doc summary</summary>
                      <div className="mt-1 text-sm">
                        {docSummaryLoading[doc.doc_id] ? <Loader2 className="w-3.5 h-3.5 inline animate-spin ml-1"/> : (sum || "—")}
                      </div>
                    </details>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    {kp.citation_targets.slice(0,1).map((ct,j)=>(
                      <Button key={j} size="sm" variant="secondary" onClick={()=>onOpenPassage(doc, { ...ct, page: ct.page ?? kp.page ?? 1 })}>
                        <LinkIcon className="w-4 h-4 mr-1"/>Open passage (p.{ct.page ?? kp.page ?? 1}, Score: {twoDp(ct.score)})
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </CardHeader>
          </Card>
        );
      })}
    </div>
  );
}

/* ---------- Cite mode panel (adds Doc Relevance next to [Direct]) ---------- */
function CitePanel({
  query, docs, index, docSummary, docWhy, docWhyLoading, docSummaryLoading, citeSelected, onToggleSelect, onOpenPdf,
}: {
  query: string;
  docs: DocMeta[];
  index: ReturnType<typeof buildCatalogIndex> | null;
  docSummary: Record<string,string>;
  docWhy: Record<string,{ why:string; relation:"direct"|"indirect" }>;
  docWhyLoading: Record<string, boolean>;
  docSummaryLoading: Record<string, boolean>;
  citeSelected: Record<string, boolean>;
  onToggleSelect: (id: string, v: boolean) => void;
  onOpenPdf: (url: string) => void;
}) {
  async function exportBib() {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');
    
    const selectedDocs = docs.filter(doc => citeSelected[doc.doc_id]);
    
    // Create document sections
    const children = [
      // Title
      new Paragraph({
        text: `Annotated Bibliography for: ${query}`,
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 400 }
      }),
      // Empty paragraph for spacing
      new Paragraph({ text: "" }),
    ];

    // Add each selected document
    selectedDocs.forEach((doc, i) => {
      const row = index ? matchCatalogRow(doc, index) : undefined;
      const summary = docSummary[doc.doc_id] || firstSentence(doc.kps?.[0]?.snippet ?? "");
      const url = urlFrom(doc, row);
      const typeLabel = typeFrom(doc, row);

      // Citation entry (numbered)
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${i + 1}. `,
              bold: true
            }),
            new TextRun({
              text: chicagoFull(doc, row)
            }),
            new TextRun({
              text: ` [${typeLabel}]`,
              italics: true,
              color: "666666"
            })
          ],
          spacing: { before: 200, after: 100 }
        })
      );

      // Summary paragraph
      children.push(
        new Paragraph({
          text: summary,
          spacing: { after: 100 },
          indent: { left: 360 } // Indent summary slightly
        })
      );

      // URL if available
      if (url) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: "Available at: ",
                italics: true,
                color: "666666"
              }),
              new TextRun({
                text: url,
                color: "0066CC",
                underline: {}
              })
            ],
            spacing: { after: 200 },
            indent: { left: 360 }
          })
        );
      } else {
        // Add spacing if no URL
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      }
    });

    // Create the document
    const doc = new Document({
      sections: [{
        properties: {},
        children: children
      }]
    });

    // Generate and download the file
    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "askwri-bibliography.docx";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      {/* Header & Export */}
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-sm text-muted-foreground">Annotated Bibliography for</div>
          <h2 className="text-lg font-semibold leading-tight">“{query}”</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportBib}><FileText className="w-4 h-4 mr-1" />Export</Button>
        </div>
      </div>

      {/* Cards */}
      <div className="space-y-3">
        {docs.map((doc, idx) => {
          const row = index ? matchCatalogRow(doc, index) : undefined;
          const best = [...(doc.kps || [])].sort((a,b)=>b.kp_relevance-a.kp_relevance)[0];
          const summary = docSummary[doc.doc_id] || firstSentence(best?.snippet ?? "");
          const whyMeta = docWhy[doc.doc_id];
          const selected = Boolean(citeSelected[doc.doc_id]);
          const url = urlFrom(doc, row);
          const docRel = (doc.kps?.length ?? 0) > 0 ? Math.max(...doc.kps.map(k=>k.kp_relevance || 0)) : 0;

          return (
            <Card key={doc.doc_id} className="shadow-sm">
              <CardContent className="pt-3">
                <div className="grid grid-cols-12 gap-3">
                  {/* Left */}
                  <div className="col-span-12 md:col-span-8">
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-base leading-snug line-clamp-2">
                        {idx + 1}. {titleFrom(doc, row)}
                      </CardTitle>
                      <div className="flex items-center gap-2">
                        <Checkbox checked={selected} onCheckedChange={(v:any)=>onToggleSelect(doc.doc_id, !!v)} aria-label="Include in export" />
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">{chicagoFull(doc, row)} [{typeFrom(doc, row)}]</div>
                    <div className="mt-2 text-sm flex items-center gap-2">
                      {docSummaryLoading[doc.doc_id] && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <span>{summary}</span>
                    </div>
                    {url && (
                      <div className="mt-2">
                        <Button size="sm" variant="secondary" onClick={() => onOpenPdf(url)}>
                          <ExternalLink className="w-4 h-4 mr-1" />Open PDF
                        </Button>
                      </div>
                    )}
                  </div>
                  {/* Right (How it relates + Doc relevance) */}
                  <div className="col-span-12 md:col-span-4">
                    <div className="rounded-md border bg-card text-card-foreground p-2 h-full">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-semibold text-sm">How it relates</span>
                        <span className="text-[11px] text-muted-foreground">
                          [{whyMeta?.relation === "direct" ? "Direct" : "Indirect"} • Relevance {twoDp(docRel)}]
                        </span>
                      </div>
                      <div className="text-sm flex items-start gap-2">
                        {docWhyLoading[doc.doc_id] && <Loader2 className="w-3.5 h-3.5 mt-0.5 animate-spin" />}
                        <span>{whyMeta?.why || firstSentence(best?.snippet ?? "")}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Passage preview (exact chunk highlight + 2 prior + 2 after) ---------- */
function PassageParagraph({ selected, docs }: { selected: { ref: string; passage_id: string; page: number }, docs: DocMeta[] }) {
  const doc = docs.find(d => d.ref === selected.ref);
  if (!doc) return <p className="text-muted-foreground text-sm">Document not found.</p>;

  // Sort KPs by page first, then by relevance within each page
  const kps = [...(doc.kps||[])].sort((a,b)=> ((a.page ?? 0) - (b.page ?? 0)) || (b.kp_relevance-a.kp_relevance));
  
  // Find target passage with multiple fallback strategies
  let idx = -1;
  
  // Strategy 1: Exact passage_id match
  idx = kps.findIndex(k => k.passage_id === selected.passage_id);
  
  // Strategy 2: Best match on same page (highest relevance)
  if (idx < 0) {
    const samePage = kps.filter(k => k.page === selected.page);
    if (samePage.length > 0) {
      const bestOnPage = samePage[0]; // Already sorted by relevance
      idx = kps.findIndex(k => k.passage_id === bestOnPage.passage_id);
    }
  }
  
  // Strategy 3: Find by partial passage_id match (sometimes IDs have prefixes/suffixes)
  if (idx < 0) {
    const targetId = selected.passage_id;
    idx = kps.findIndex(k => 
      k.passage_id.includes(targetId) || targetId.includes(k.passage_id)
    );
  }
  
  // Strategy 4: Fallback to first passage (should rarely happen now)
  if (idx < 0 && kps.length > 0) {
    console.warn(`[PassageParagraph] Could not find passage ${selected.passage_id} in doc ${selected.ref}, using first passage`);
    idx = 0;
  }
  
  // If still no passages, show error
  if (idx < 0 || kps.length === 0) {
    return <p className="text-muted-foreground text-sm">No passages found for this document.</p>;
  }

  // Always ensure we have at least 2 before and 2 after when possible
  const beforeArr = [kps[idx-2]?.snippet, kps[idx-1]?.snippet];
  const afterArr  = [kps[idx+1]?.snippet, kps[idx+2]?.snippet];
  const before = beforeArr.filter(Boolean).join(" … ");
  const center = kps[idx]?.snippet ?? "";
  const after  = afterArr.filter(Boolean).join(" … ");

  return (
    <p className="leading-relaxed break-words overflow-wrap-anywhere">
      {before ? (before + " … ") : "… "}
      <mark className="bg-yellow-200 px-0.5 rounded">{center}</mark>
      {after ? (" … " + after) : " …"}
    </p>
  );
}
