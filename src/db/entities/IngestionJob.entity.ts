import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'
import { Document } from './Document.entity'

@Entity('ingestion_jobs')
export class IngestionJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @ManyToOne(() => Document, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'document_id',
    foreignKeyConstraintName: 'ingestion_jobs_document_id_fkey',
  })
  document!: Document | null

  @Column('uuid', { name: 'document_id', nullable: true })
  documentId!: string | null

  @Column('text', { nullable: true })
  stage!: string | null

  @Index('idx_ingestion_jobs_status')
  @Column('text', { default: 'queued' })
  status!: string

  @Column('text', { nullable: true })
  error!: string | null

  @Column('integer', { default: 0 })
  attempts!: number

  @Column('jsonb', { name: 'model_versions', nullable: true })
  modelVersions!: Record<string, any> | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
