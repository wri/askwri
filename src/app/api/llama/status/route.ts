// Route: GET /api/llama/status
// Verifies env visibility (no secrets leaked)

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";

export async function GET() {
  const base = process.env.LLAMA_CLOUD_BASE ?? "https://api.cloud.llamaindex.ai";

  const hasKey =
    typeof process.env.LLAMA_CLOUD_API_KEY === "string" &&
    process.env.LLAMA_CLOUD_API_KEY.trim() !== "" &&
    process.env.LLAMA_CLOUD_API_KEY !== "sk-...";

  const hasPipeline =
    typeof process.env.PIPELINE_ID === "string" &&
    process.env.PIPELINE_ID.trim() !== "" &&
    process.env.PIPELINE_ID !== "__REPLACE_ME__";

  const hasOpenAI =
    typeof process.env.OPENAI_API_KEY === "string" &&
    process.env.OPENAI_API_KEY.trim() !== "" &&
    process.env.OPENAI_API_KEY !== "sk-...";

  return NextResponse.json({
    ok: hasKey && hasPipeline,
    hasKey,
    hasPipeline,
    hasOpenAI,
    base,
  });
}
