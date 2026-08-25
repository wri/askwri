import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm'

@Entity('answer_mode_feedback')
export class AnswerModeFeedback {
  @PrimaryGeneratedColumn()
  id!: number

  @Column('text')
  answer!: string

  @Column('text')
  query!: string

  @Column('text', { name: 'consulted_doc_ids', nullable: true })
  consultedDocIds?: string | null

  @Column('text', { name: 'supporting_doc_ids' })
  supportingDocIds!: string

  @Column('text', { name: 'first_relevance_score' })
  firstRelevanceScore!: string

  @Column({ name: 'first_publication_name', length: 256 })
  firstPublicationName!: string

  @Column('text', { name: 'first_doc_summary' })
  firstDocSummary!: string

  @Column('text', { name: 'first_doc_how_relevant' })
  firstDocHowRelevant!: string

  @Column({ length: 8 })
  feedback!: string // 'positive' | 'negative'

  @CreateDateColumn({ type: 'timestamptz' })
  timestamp!: Date
}
