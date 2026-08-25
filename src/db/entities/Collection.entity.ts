import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'

@Entity('collections')
export class Collection {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column('text')
  name!: string

  @Column('text', { unique: true })
  slug!: string

  @Column('text', { nullable: true })
  description!: string | null

  @Column('text', { nullable: true })
  owner!: string | null

  @Column('text', { default: 'internal' })
  visibility!: string

  @Column('jsonb', { name: 'language_policy', nullable: true })
  languagePolicy!: Record<string, any> | null

  @Column('text', { name: 'embedding_model_version', nullable: true })
  embeddingModelVersion!: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
