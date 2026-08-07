import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'

@Entity('document_tags')
export class DocumentTag {
  @PrimaryColumn('uuid', { name: 'document_id' })
  documentId!: string

  @PrimaryColumn('uuid', { name: 'tag_id' })
  tagId!: string

  @Column('text')
  source!: string

  @Column('numeric', { nullable: true })
  confidence!: string | null

  @Column('text', { name: 'model_version', nullable: true })
  modelVersion!: string | null

  @Column('text', { default: 'accepted' })
  status!: string

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
