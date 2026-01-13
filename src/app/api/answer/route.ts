// Route: POST /api/answer
// Crisp 3–5 sentence synthesis, model-aware (gpt-5*: max_completion_tokens & omit temperature).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";

const MODEL = (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();
const IS_GPT5 = /^gpt-5/i.test(MODEL);
// Optimized for concise 2-3 sentence answers
const DEFAULT_MAX = IS_GPT5 ? 2000 : 1500;
const ENV_MAX = Number(process.env.OPENAI_MAX_TOKENS || DEFAULT_MAX);
const MAX = IS_GPT5 ? Math.max(2000, ENV_MAX) : ENV_MAX;
const TEMP = Number(process.env.OPENAI_TEMPERATURE ?? 0.3); // Moderate temperature for concise synthesis

// Log config at module load time to diagnose env var issues
console.log("[Answer Route INIT] MODEL:", MODEL, "IS_GPT5:", IS_GPT5, "ENV_MAX:", ENV_MAX, "FINAL MAX:", MAX, "RAW_ENV:", process.env.OPENAI_MAX_TOKENS);

// Concise prompt for 2-3 sentence answers
const SYS = IS_GPT5 ? `
Synthesize a concise answer from the provided documents. Write exactly 2-3 clear sentences.
Transform language - don't quote directly. Focus on the most important findings.
Return JSON: {"sentences":["sentence1","sentence2","sentence3"]}
`.trim() : `
You are a careful research assistant. Write a clear, concise answer that synthesizes the most important information from the provided documents.

CRITICAL RULES:
- CONCISE: Write exactly 2-3 sentences total (not paragraphs)
- SYNTHESIZE: Combine key information - do NOT copy phrases verbatim
- PRIORITIZE: Focus on the most relevant and important findings
- GROUND: Every claim must be traceable to the provided documents
- ACCURACY: Preserve the meaning and facts from the original sources

Return strict JSON with exactly 2-3 sentences:
{"sentences":["First sentence with key finding.","Second sentence with supporting detail.","Third sentence with additional context or implication."]}

Example:
{"sentences":[
  "Electric buses reduce operational costs by approximately 40% compared to diesel alternatives due to lower fuel and maintenance expenses.",
  "They achieve 70-80% reductions in greenhouse gas emissions when powered by renewable energy and eliminate local air pollution in urban areas.",
  "Successful implementation requires strategic charging infrastructure planning and upfront investment, though long-term savings offset initial costs."
]}
`.trim();

function synthFallback(query: string, docs: any[]) {
  // Only used when API key is missing or there's a critical error
  // This should rarely be seen by users
  if (!docs?.length) {
    return { sentences: ["No relevant documents found to answer this query."] };
  }
  
  return { 
    sentences: [
      "Answer synthesis is temporarily unavailable.",
      "Please review the source documents below for information on this topic."
    ]
  };
}

function safeParse(text: string, allowPartial: boolean = false) {
  try {
    return JSON.parse(text);
  } catch (err1) {
    console.log("[safeParse] First parse failed:", (err1 as Error).message);
    console.log("[safeParse] Content sample:", text.slice(0, 200));

    // Try extracting JSON from text
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s !== -1 && e !== -1 && e > s) {
      const extracted = text.slice(s, e + 1);
      try {
        console.log("[safeParse] Trying extracted JSON, length:", extracted.length);
        return JSON.parse(extracted);
      } catch (err2) {
        console.log("[safeParse] Extracted parse also failed:", (err2 as Error).message);

        // PARTIAL ANSWER HANDLING: Try to extract partial sentences array
        if (allowPartial) {
          console.log("[safeParse] Attempting partial extraction...");
          const sentencesMatch = text.match(/"sentences"\s*:\s*\[([^\]]*)/);
          if (sentencesMatch) {
            // Extract individual sentence strings
            const sentencesText = sentencesMatch[1];
            const sentences: string[] = [];
            const sentenceMatches = sentencesText.matchAll(/"([^"]+)"/g);
            for (const match of sentenceMatches) {
              sentences.push(match[1]);
            }
            if (sentences.length > 0) {
              console.log(`[safeParse] ✅ Extracted ${sentences.length} partial sentences`);
              return { sentences, _partial: true };
            }
          }
        }
      }
    }
    console.log("[safeParse] Returning empty object");
    return {};
  }
}

// Check if a sentence appears to be a direct quote from the documents
// Much more conservative - only catches obvious verbatim quotes
function detectVerbatimCopying(sentences: string[], docs: any[]): boolean {
  for (const sentence of sentences) {
    if (sentence.length < 50) continue; // Skip short sentences
    
    // Check each source document
    for (const doc of docs) {
      const snippet = String(doc.kps?.[0]?.snippet || "");
      if (!snippet || snippet.length < 50) continue;
      
      // Normalize both for comparison (keep punctuation to detect exact quotes)
      const sentNorm = sentence.trim().toLowerCase();
      const snippetNorm = snippet.trim().toLowerCase();
      
      // Check if the sentence is a substring of the snippet (exact quote)
      if (snippetNorm.includes(sentNorm) || sentNorm.includes(snippetNorm)) {
        console.warn(`Detected exact quote from source`);
        return true;
      }
      
      // Check for very long verbatim sequences (20+ words) 
      // This catches quotes with minor modifications
      const sentWords = sentNorm.replace(/[^\w\s]/g, '').split(/\s+/);
      const snippetWords = snippetNorm.replace(/[^\w\s]/g, '').split(/\s+/);
      
      for (let i = 0; i <= sentWords.length - 20; i++) {
        const longPhrase = sentWords.slice(i, i + 20).join(' ');
        const snippetText = snippetWords.join(' ');
        if (snippetText.includes(longPhrase)) {
          console.warn(`Detected 20+ word verbatim sequence`);
          return true;
        }
      }
    }
  }
  return false;
}

export async function POST(req: NextRequest) {
  const debugInfo: any = { timestamp: new Date().toISOString() };
  
  try {
    const reqBody = await req.json();
    const { query, docs } = reqBody;
    
    // Debug: Log what we received
    debugInfo.received = {
      hasQuery: !!query,
      queryLength: query?.length || 0,
      docsCount: Array.isArray(docs) ? docs.length : 0,
      docsStructure: Array.isArray(docs) ? docs.slice(0, 2).map((d: any) => ({
        hasTitle: !!d?.title,
        hasKps: !!d?.kps,
        kpsCount: Array.isArray(d?.kps) ? d.kps.length : 0,
        firstSnippetLength: d?.kps?.[0]?.snippet?.length || 0
      })) : "not-array"
    };
    
    console.log("[Answer Route] Received:", JSON.stringify(debugInfo.received, null, 2));
    
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) {
      console.log("[Answer Route] No API key, using fallback");
      debugInfo.fallbackReason = "no_api_key";
      return NextResponse.json({ 
        ok: true, 
        synthesis: synthFallback(query, docs),
        debug: debugInfo 
      });
    }

    // DYNAMIC FILTERING: Only use high-relevance documents (>0.75 threshold)
    const RELEVANCE_THRESHOLD = 0.75;
    const maxDocs = IS_GPT5 ? 8 : 6; // Reduced for concise answers
    const maxSnippetLen = IS_GPT5 ? 400 : 350; // Shorter snippets

    // Filter by relevance first, then take top N
    const filteredDocs = (Array.isArray(docs) ? docs : [])
      .filter((d: any) => {
        const relevance = d.kps?.[0]?.kp_relevance || d.score || 0;
        return relevance >= RELEVANCE_THRESHOLD;
      })
      .slice(0, maxDocs);

    const docList = filteredDocs.map((d: any, idx: number) => ({
      id: idx + 1,
      title: d.title || "Untitled",
      authors: d.authors,
      year: d.year,
      key_finding: String(d.kps?.[0]?.snippet ?? "").slice(0, maxSnippetLen),
      relevance: d.kps?.[0]?.kp_relevance || d.score || 0
    }));
    
    debugInfo.docListCreated = {
      count: docList.length,
      hasContent: docList.some(d => d.key_finding.length > 0),
      avgSnippetLength: docList.reduce((sum, d) => sum + d.key_finding.length, 0) / (docList.length || 1)
    };
    
    console.log("[Answer Route] DocList created:", debugInfo.docListCreated);

    // Create a structured prompt that frames the task clearly
    const userContent = `Question: ${query}

Source documents with key findings:
${docList.map(d =>
  `[${d.id}] "${d.title}" (${d.year || 'n.d.'})
   Key finding: ${d.key_finding}
   Relevance: ${(d.relevance * 100).toFixed(0)}%`
).join('\n\n')}

Task: Write exactly 2-3 clear sentences that synthesize the most important information from these sources. Focus on breadth - touch on multiple key findings rather than elaborating on one.`;

    const messages = [
      { role: "system", content: SYS },
      { role: "user", content: userContent },
    ];

    // Build model-aware chat body
    let used = IS_GPT5 ? "chat.max_completion_tokens.no_temp" : "chat.max_tokens.with_temp";
    let apiBody: any = {
      model: MODEL,
      messages,
      ...(IS_GPT5 ? { max_completion_tokens: MAX } : { max_tokens: MAX, temperature: TEMP }),
    };
    
    debugInfo.apiCall = {
      model: MODEL,
      maxTokens: MAX,
      actualMaxTokens: IS_GPT5 ? apiBody.max_completion_tokens : apiBody.max_tokens,
      temperature: IS_GPT5 ? "omitted" : TEMP,
      messageCount: messages.length,
      userContentLength: userContent.length,
      envMaxTokens: process.env.OPENAI_MAX_TOKENS
    };
    
    console.log("[Answer Route] Calling OpenAI:", debugInfo.apiCall);
    console.log(`[Answer Route] Token config: ENV=${process.env.OPENAI_MAX_TOKENS}, DEFAULT=${DEFAULT_MAX}, FINAL=${MAX}`);

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(apiBody),
    });
    const text = await r.text();
    let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    
    const finishReason = json?.choices?.[0]?.finish_reason;
    const content = json?.choices?.[0]?.message?.content ?? "";

    debugInfo.apiResponse = {
      status: r.status,
      ok: r.ok,
      hasChoices: !!json?.choices?.length,
      finishReason,
      contentLength: content.length,
      wasTruncated: finishReason === 'length'
    };

    console.log("[Answer Route] OpenAI response:", debugInfo.apiResponse);

    if (!r.ok) {
      console.log("[Answer Route] API call failed, using fallback. Error:", json);
      debugInfo.fallbackReason = "api_error";
      debugInfo.apiError = json;
      return NextResponse.json({
        ok: true,
        synthesis: synthFallback(query, docs),
        debug: { ...debugInfo, used, status: r.status, upstream: json }
      });
    }

    // TRUNCATION DETECTION: Check if response was cut off
    const wasTruncated = finishReason === 'length';
    if (wasTruncated) {
      console.warn("[Answer Route] ⚠️  Response truncated by token limit!");
      debugInfo.truncationDetected = true;
    }

    // Enable partial extraction if truncated
    const parsed = safeParse(content, wasTruncated);

    // Enhanced debug info for both formats
    const hasParagraphs = Array.isArray(parsed.paragraphs);
    const hasSentences = Array.isArray(parsed.sentences);
    const isPartial = parsed._partial === true;

    debugInfo.parsing = {
      contentReceived: content.length > 0,
      contentPreview: content.slice(0, 100),
      hasParagraphs,
      hasSentences,
      paragraphsType: hasParagraphs ? typeof parsed.paragraphs[0] : undefined,
      paragraphsCount: hasParagraphs ? parsed.paragraphs.length : 0,
      parsedSuccessfully: hasParagraphs || hasSentences,
      sentenceCount: Array.isArray(parsed.sentences) ? parsed.sentences.length : 0
    };

    console.log("[Answer Route] Parsing result:", JSON.stringify(debugInfo.parsing, null, 2));
    console.log("[Answer Route] Paragraphs structure:", hasParagraphs ? JSON.stringify(parsed.paragraphs.slice(0, 2), null, 2) : "none");

    // Handle both old format (sentences) and new format (paragraphs)
    let sentences: string[] = [];

    if (Array.isArray(parsed.paragraphs)) {
      console.log("[Answer Route] Processing paragraphs format");
      // New format: flatten paragraphs into sentences
      sentences = parsed.paragraphs.flat();
      console.log("[Answer Route] After flattening paragraphs:", {
        sentencesCount: sentences.length,
        firstSentenceType: sentences.length > 0 ? typeof sentences[0] : undefined,
        firstSentencePreview: sentences.length > 0 ? sentences[0].slice(0, 100) : undefined
      });
    } else if (Array.isArray(parsed.sentences)) {
      console.log("[Answer Route] Processing sentences format");
      // Old format: use sentences directly
      sentences = parsed.sentences;
    } else {
      console.log("[Answer Route] No valid format found, using fallback");
      sentences = synthFallback(query, docs).sentences;
    }

    if (sentences.length === 0) {
      console.log("[Answer Route] No valid sentences parsed, using fallback");
      debugInfo.fallbackReason = "no_valid_sentences";
      sentences = synthFallback(query, docs).sentences;
    }

    // Check for verbatim copying but don't override the response
    const hasQuotes = detectVerbatimCopying(sentences, docs);

    // Build synthesis response with appropriate warnings
    const synthesis: any = { sentences };

    if (isPartial || wasTruncated) {
      synthesis.warning = "partial_answer";
      synthesis.warningMessage = "Answer may be incomplete due to length constraints. Consider refining your query.";
      console.warn("[Answer Route] Returning partial answer with warning");
    } else if (hasQuotes) {
      synthesis.warning = "possible_quotes";
      synthesis.warningMessage = "Answer may contain direct quotes from sources.";
      console.warn("[Answer Route] Quote detection triggered");
    }

    debugInfo.success = true;
    debugInfo.warnings = {
      isPartial,
      wasTruncated,
      hasQuotes
    };

    return NextResponse.json({
      ok: true,
      synthesis,
      debug: debugInfo
    });
  } catch (error: any) {
    console.error("[Answer Route] Exception:", error);
    debugInfo.exception = error?.message || String(error);
    debugInfo.fallbackReason = "exception";
    return NextResponse.json({ 
      ok: true, 
      synthesis: { sentences: ["Could not synthesize a full answer from the provided context."] },
      debug: debugInfo 
    });
  }
}
