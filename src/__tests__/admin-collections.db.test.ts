/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import {
  slugify,
  listCollectionsWithCounts,
  createCollection,
  addDocumentsToCollection,
  removeDocumentFromCollection,
} from '@/db/queries/collectionsAdmin'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip
const identity = { kind: 'token', role: 'admin' } as const

// Pure function — runs ungated
describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric runs with hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world')
    expect(slugify('  WRI Reports 2024  ')).toBe('wri-reports-2024')
    expect(slugify('---foo---')).toBe('foo')
    expect(slugify('A')).toBe('a')
  })

  it('returns empty string for input with no letters or numbers', () => {
    expect(slugify('---')).toBe('')
    expect(slugify('   ')).toBe('')
  })
})

d('collectionsAdmin (DB integration)', () => {
  const externalId = `colladmin_test_${Date.now()}`
  let docId: string
  let collectionId: string

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const [docRow] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Collection Admin Test', 'needs_review') RETURNING id`,
      [externalId, `documents/${externalId}.pdf`],
    )
    docId = docRow.id
  })

  afterAll(async () => {
    if (collectionId) {
      await AppDataSource.query(
        `DELETE FROM audit_log WHERE entity_id = $1`,
        [collectionId],
      )
      await AppDataSource.query(
        `DELETE FROM document_collections WHERE collection_id = $1`,
        [collectionId],
      )
      await AppDataSource.query(`DELETE FROM collections WHERE id = $1`, [collectionId])
    }
    await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    await AppDataSource.destroy()
  })

  it('createCollection creates a new collection and returns it', async () => {
    const name = `Test Collection ${Date.now()}`
    const result = await createCollection(name, null, identity)
    expect('error' in result).toBe(false)
    if ('error' in result) throw new Error(result.error)
    collectionId = result.id
    expect(result.slug).toBe(slugify(name))
    expect(result.name).toBe(name)
  })

  it('createCollection returns conflict for duplicate slug', async () => {
    // Derive the same name to produce the same slug
    const [existing] = await AppDataSource.query(
      `SELECT name FROM collections WHERE id = $1`,
      [collectionId],
    )
    const result = await createCollection(existing.name, null, identity)
    expect(result).toHaveProperty('error', 'a collection with this slug exists')
  })

  it('addDocumentsToCollection adds a document idempotently (add same id twice → count stays 1)', async () => {
    const r1 = await addDocumentsToCollection(collectionId, [docId], identity)
    expect('error' in r1).toBe(false)

    // Add again — should be a no-op
    const r2 = await addDocumentsToCollection(collectionId, [docId], identity)
    expect('error' in r2).toBe(false)

    // Verify membership count is 1
    const [{ n }] = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM document_collections WHERE collection_id = $1`,
      [collectionId],
    )
    expect(n).toBe(1)
  })

  it('removeDocumentFromCollection removes the document from the collection', async () => {
    await removeDocumentFromCollection(collectionId, docId, identity)
    const [{ n }] = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM document_collections
       WHERE collection_id = $1 AND document_id = $2`,
      [collectionId, docId],
    )
    expect(n).toBe(0)
  })

  it('listCollectionsWithCounts returns the collection with documentCount', async () => {
    const collections = await listCollectionsWithCounts()
    const found = collections.find((c) => c.id === collectionId)
    expect(found).toBeDefined()
    expect(found).toMatchObject({
      id: collectionId,
      documentCount: 0,
    })
    expect(typeof found!.name).toBe('string')
    expect(typeof found!.slug).toBe('string')
  })
})
