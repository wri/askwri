/**
 * Feedback API Endpoint
 *
 * Purpose: Handle feedback submission from the client
 * Contract: POST endpoint that validates, enriches, and stores feedback
 *
 * Request Body:
 * - feedbackType: 'positive' | 'negative'
 * - comment?: string
 * - query: string
 * - mode: 'answer' | 'cite'
 * - resultCount: number
 *
 * Response:
 * - Success: { success: true }
 * - Error: { success: false, error: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { saveFeedback, type Feedback } from '@/lib/feedback/store';

// Get or create session ID from cookies
function getSessionId(request: NextRequest): string {
  const sessionId = request.cookies.get('session_id')?.value;
  return sessionId || uuidv4();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate required fields
    if (!body.feedbackType || !['positive', 'negative'].includes(body.feedbackType)) {
      return NextResponse.json(
        { success: false, error: 'Invalid feedback type' },
        { status: 400 }
      );
    }

    if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'Query is required' },
        { status: 400 }
      );
    }

    if (!body.mode || !['answer', 'cite'].includes(body.mode)) {
      return NextResponse.json(
        { success: false, error: 'Invalid mode' },
        { status: 400 }
      );
    }

    if (typeof body.resultCount !== 'number' || body.resultCount < 0) {
      return NextResponse.json(
        { success: false, error: 'Invalid result count' },
        { status: 400 }
      );
    }

    // Create feedback record with server-generated values
    const feedback: Feedback = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      feedbackType: body.feedbackType,
      comment: body.comment?.trim() || undefined,
      query: body.query.trim(),
      mode: body.mode,
      sessionId: getSessionId(request),
      resultCount: body.resultCount
    };

    // Save to storage
    await saveFeedback(feedback);

    // Set session cookie if new
    const response = NextResponse.json({ success: true });
    if (!request.cookies.get('session_id')) {
      response.cookies.set('session_id', feedback.sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 // 30 days
      });
    }

    return response;
  } catch (error) {
    console.error('Failed to save feedback:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to save feedback' },
      { status: 500 }
    );
  }
}