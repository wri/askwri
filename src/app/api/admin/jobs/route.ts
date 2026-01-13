import { NextRequest, NextResponse } from "next/server";
import { jobQueue } from "@/lib/job-queue";

export async function GET(req: NextRequest) {
  try {
    const jobs = jobQueue.getAllJobs();
    return NextResponse.json({ jobs });
  } catch (error: any) {
    console.error("[Jobs API] Error:", error);
    return NextResponse.json(
      { error: "Failed to get jobs", details: error.message },
      { status: 500 }
    );
  }
}