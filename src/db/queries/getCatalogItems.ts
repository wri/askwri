import { AppDataSource } from '../data-source'
import { Document } from '../entities/Document.entity'

export interface CatalogItem {
  file_id: string
  file_name: string
  external_file_id: string
  meta: Record<string, any>
}

// Mirrors normalizeRow() in src/app/api/catalog/route.ts over the legacy CSV
// shape {file_path, metadata: <json string>, summary}: file_id is empty (the
// CSV had no file_id column), file_name is the file path, and meta carries the
// raw metadata JSON as a string, exactly as the CSV path produced it.
export function mapDocumentToCatalogItem(
  doc: Pick<Document, 'sourceMetadata' | 's3Key'>,
): CatalogItem {
  const src = doc.sourceMetadata ?? {}
  const filePath = src.file_path || doc.s3Key
  return {
    file_id: '',
    file_name: filePath,
    external_file_id: '',
    meta: {
      file_path: filePath,
      metadata: JSON.stringify(src.metadata ?? {}),
      summary: src.summary ?? '',
    },
  }
}

export async function getCatalogItems(): Promise<CatalogItem[]> {
  const repo = AppDataSource.getRepository(Document)
  const docs = await repo.find({
    where: { status: 'searchable' },
    order: { externalId: 'ASC' },
  })
  return docs.map(mapDocumentToCatalogItem)
}
