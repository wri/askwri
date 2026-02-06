import { NextResponse } from 'next/server';

export async function GET() {
  const searchServiceUrl = process.env.SEARCH_SERVICE_URL || 'http://localhost:8000';
  const searchHealthUrl = `${searchServiceUrl}/health`;

  try {
    const response = await fetch(searchHealthUrl, { method: 'GET' });
    // eslint-disable-next-line no-console -- surface health check requests during development
    console.log('Search service health', response, new Date().toISOString());
    if (!response.ok) {
      throw new Error(`Search service health check failed with status ${response.status}`);
    }
    return NextResponse.json({
      status: 'healthy',
      response: await response.json()
    });
  } catch (error: any) {
    return NextResponse.json({
      status: 'unhealthy',
      error: error.message
    }, { status: 503 });
  }
}
