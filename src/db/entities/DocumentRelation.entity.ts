import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm'

/** Directed edge: documentId is the translation, relatedDocumentId the original. */
@Entity('document_relations')
export class DocumentRelation {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column('uuid', { name: 'document_id' })
  documentId!: string

  @Column('uuid', { name: 'related_document_id' })
  relatedDocumentId!: string

  @Column('text', { name: 'relation_type', default: 'translation_of' })
  relationType!: string

  @Column('text', { default: 'suggested' })
  status!: string

  @Column('text')
  source!: string

  @Column('numeric', { nullable: true })
  confidence!: string | null

  @Column('jsonb', { default: () => "'{}'" })
  signals!: Record<string, unknown>

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @Column('text', { name: 'reviewed_by', nullable: true })
  reviewedBy!: string | null

  @Column('timestamptz', { name: 'reviewed_at', nullable: true })
  reviewedAt!: Date | null
}
