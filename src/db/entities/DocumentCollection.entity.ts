import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'

@Entity('document_collections')
export class DocumentCollection {
  @PrimaryColumn('uuid', { name: 'document_id' })
  documentId!: string

  @PrimaryColumn('uuid', { name: 'collection_id' })
  collectionId!: string

  @Column('text', { name: 'added_by', nullable: true })
  addedBy!: string | null

  @CreateDateColumn({ name: 'added_at', type: 'timestamptz' })
  addedAt!: Date
}
