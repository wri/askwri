import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm'

@Entity('cite_mode_feedback')
export class CiteModeFeedback {
  @PrimaryGeneratedColumn()
  id!: number

  @Column('text')
  query!: string

  @Column({ name: 'doc_id', length: 64 })
  docId!: string

  @Column('text', { name: 'relevance_score' })
  relevanceScore!: string

  @Column({ name: 'publication_name', length: 256 })
  publicationName!: string

  @Column({ name: 'row_number' })
  rowNumber!: number

  @Column('text', { name: 'summary' })
  summary!: string

  @Column('text', { name: 'how_relevant' })
  howRelevant!: string

  @Column({ length: 8 })
  feedback!: string // 'positive' | 'negative'

  @CreateDateColumn({ type: 'timestamptz' })
  timestamp!: Date
}
