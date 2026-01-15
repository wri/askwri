import { NextResponse } from 'next/server';

export async function GET() {
  console.log('Health check requested', new Date().toISOString());
  return NextResponse.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NEXT_PUBLIC_ENVIRONMENT || 'development',
    version: process.env.npm_package_version || '1.0.0',
  });
}
