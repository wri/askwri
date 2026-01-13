/**
 * In-memory job queue for document processing and reindexing tasks
 * This is a simple implementation suitable for development/small deployments
 * For production at scale, consider using Bull/BullMQ or AWS SQS
 */

import path from 'path';
import { generateSummary } from './summary-generator';
import { updateDocumentInCSV } from './csv-utils';

const DATA_DIR = path.join(process.cwd(), 'data', 'documents');
const MIN_SUMMARY_LENGTH = 50;

export interface Job {
  id: string;
  type: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  data: any;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

class JobQueueImpl {
  private jobs: Map<string, Job> = new Map();
  private jobCounter: number = 0;

  async addJob(type: string, data: any): Promise<string> {
    const id = `job_${++this.jobCounter}_${Date.now()}`;
    const now = new Date().toISOString();

    const job: Job = {
      id,
      type,
      data,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(id, job);
    console.log(`[JobQueue] Added job ${id} of type ${type}`);

    // Simulate async processing
    this.processJob(id).catch(error => {
      console.error(`[JobQueue] Error processing job ${id}:`, error);
    });

    return id;
  }

  getAllJobs(): Job[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  private async processJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    try {
      job.status = 'processing';
      job.updatedAt = new Date().toISOString();

      // Handle different job types
      if (job.type === 'reindex') {
        await this.handleReindexJob(job);
      } else if (job.type === 'process_document') {
        await this.handleProcessDocumentJob(job);
      } else {
        // Unknown job type - just wait a bit and mark complete
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      job.status = 'completed';
      job.updatedAt = new Date().toISOString();
      console.log(`[JobQueue] Completed job ${jobId}`);
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = new Date().toISOString();
      console.error(`[JobQueue] Failed job ${jobId}:`, error);
    }
  }

  private async handleReindexJob(job: Job): Promise<void> {
    const hybridServiceUrl = process.env.LLAMAINDEX_SERVICE_URL || 'http://127.0.0.1:8002';

    console.log(`[JobQueue] Reindexing: ${job.data.reason}`);

    try {
      const response = await fetch(`${hybridServiceUrl}/reindex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Reindex failed with status ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      console.log(`[JobQueue] Reindex successful:`, result);
    } catch (error) {
      throw new Error(`Failed to trigger reindex on hybrid service: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleProcessDocumentJob(job: Job): Promise<void> {
    const { documentId, metadata, fileName } = job.data;

    console.log(`[JobQueue] Processing document: ${documentId} (${fileName})`);

    // Check if summary already provided and is sufficient
    const existingSummary = metadata?.summary?.trim() || '';
    if (existingSummary.length >= MIN_SUMMARY_LENGTH) {
      console.log(`[JobQueue] Document ${documentId} already has summary (${existingSummary.length} chars), skipping generation`);
      return;
    }

    // Generate summary from PDF
    const pdfPath = path.join(DATA_DIR, `${documentId}.pdf`);
    const title = metadata?.['Article Title'] || 'Untitled';

    try {
      console.log(`[JobQueue] Generating summary for ${documentId}...`);
      const summary = await generateSummary({ pdfPath, title });

      if (summary && summary.length >= MIN_SUMMARY_LENGTH) {
        // Update CSV with generated summary
        const updatedMetadata = { ...metadata, summary };
        await updateDocumentInCSV(documentId, updatedMetadata, summary);
        console.log(`[JobQueue] Generated summary for ${documentId} (${summary.length} chars)`);
      } else {
        console.warn(`[JobQueue] Generated summary too short for ${documentId}, skipping update`);
      }
    } catch (error) {
      // Log error but don't fail the job - document is still usable without summary
      console.error(`[JobQueue] Failed to generate summary for ${documentId}:`, error instanceof Error ? error.message : error);
      console.log(`[JobQueue] Document ${documentId} saved without auto-generated summary`);
    }
  }
}

export const jobQueue = new JobQueueImpl();
