import { NextRequest, NextResponse } from "next/server";
import { detectBatchDuplicates } from "@/lib/csv-utils";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { documents } = body;

    if (!Array.isArray(documents)) {
      return NextResponse.json(
        { error: "Expected documents array" },
        { status: 400 }
      );
    }

    // Check for duplicates
    const conflicts = await detectBatchDuplicates(documents);

    return NextResponse.json({
      ok: true,
      conflicts,
      hasConflicts: conflicts.length > 0,
      conflictCount: conflicts.length,
    });
  } catch (error) {
    console.error("Error checking duplicates:", error);
    return NextResponse.json(
      { error: "Failed to check duplicates" },
      { status: 500 }
    );
  }
}
