import { NextResponse } from "next/server";

export async function GET() {
  try {
    const hybridServiceUrl = process.env.LLAMAINDEX_SERVICE_URL || "http://127.0.0.1:8002";

    // Get health/stats from hybrid service
    const healthRes = await fetch(`${hybridServiceUrl}/health`);

    if (!healthRes.ok) {
      return NextResponse.json(
        {
          status: "unhealthy",
          indexing_status: "error",
          message: "Hybrid service is not responding"
        },
        { status: 503 }
      );
    }

    const healthData = await healthRes.json() as any;

    return NextResponse.json({
      status: healthData.status || "unknown",
      indexing_status: "healthy",
      documents_indexed: healthData.documents_count || 0,
      document_texts: healthData.document_texts_count || 0,
      indexes: {
        vector_index: healthData.indexes_loaded?.vector_index || false,
        bm25_retriever: healthData.indexes_loaded?.bm25_retriever || false,
      },
      cache: {
        pdfs_cached: healthData.cache_stats?.pdfs || 0,
        texts_cached: healthData.cache_stats?.texts || 0,
        embeddings_cached: healthData.cache_stats?.embeddings || 0,
      },
      rerankers: {
        answer_mode: healthData.rerankers_loaded?.answer_mode || false,
        cite_mode: healthData.rerankers_loaded?.cite_mode || false,
      },
      service_version: healthData.version || "unknown",
    });
  } catch (error: any) {
    console.error("[Status API] Error:", error);
    return NextResponse.json(
      {
        status: "unhealthy",
        indexing_status: "error",
        message: error instanceof Error ? error.message : "Failed to get indexing status"
      },
      { status: 500 }
    );
  }
}
