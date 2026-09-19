import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'

@Entity('reclassify_jobs')
export class ReclassifyJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column('uuid', { name: 'document_id' })
  documentId!: string

  @Column('uuid', { name: 'scope_tag_id', nullable: true })
  scopeTagId!: string | null

  @Column('uuid', { name: 'run_id' })
  runId!: string

  @Column('text', { default: 'queued' })
  status!: string

  @Column('integer', { default: 0 })
  attempts!: number

  @Column('text', { nullable: true })
  error!: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
