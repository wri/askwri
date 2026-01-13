import { NextRequest, NextResponse } from "next/server";
import { jobQueue } from "@/lib/job-queue";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    const job = jobQueue.getJob(jobId);

    if (!job) {
      return NextResponse.json(
        { error: "Job not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(job);
  } catch (error: any) {
    console.error("[Jobs API] Error:", error);
    return NextResponse.json(
      { error: "Failed to get job status", details: error.message },
      { status: 500 }
    );
  }
}