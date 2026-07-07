import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'

@Entity('documents')
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column('text', { name: 'external_id', unique: true })
  externalId!: string

  @Column('text', { nullable: true })
  doi!: string | null

  @Column('text', { name: 's3_key' })
  s3Key!: string

  @Column('text', { nullable: true })
  title!: string | null

  @Column('text', { name: 'title_en', nullable: true })
  titleEn!: string | null

  @Column('text', { nullable: true })
  authors!: string | null

  @Column('text', { nullable: true })
  url!: string | null

  @Column('date', { name: 'date_published', nullable: true })
  datePublished!: string | null

  @Column('text', { nullable: true })
  language!: string | null

  @Column('text', { array: true, nullable: true })
  languages!: string[] | null

  @Column('integer', { name: 'year_published', nullable: true })
  yearPublished!: number | null

  @Column('text', { name: 'publication_title', nullable: true })
  publicationTitle!: string | null

  @Column('text', { name: 'article_type', nullable: true })
  articleType!: string | null

  @Column('text', { name: 'wri_primary_office', nullable: true })
  wriPrimaryOffice!: string | null

  @Column('text', { name: 'content_hash', nullable: true })
  contentHash!: string | null

  @Column('numeric', { name: 'extraction_confidence', nullable: true })
  extractionConfidence!: string | null

  @Index('idx_documents_status')
  @Column('text', { default: 'draft' })
  status!: string

  @Column('jsonb', { name: 'source_metadata', nullable: true })
  sourceMetadata!: Record<string, any> | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
