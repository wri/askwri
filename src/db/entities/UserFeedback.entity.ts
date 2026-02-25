import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm'

@Entity('user_feedback')
export class UserFeedback {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ length: 16 })
  mode!: string // 'answer' | 'cite'

  @Column('text')
  query!: string

  @Column({ name: 'doc_id', length: 64 })
  docId!: string

  @Column('float')
  relevance_score!: number

  @Column({ length: 256 })
  publication_name!: string

  @Column()
  row_number!: number

  @Column('text')
  summary!: string

  @Column('text')
  how_relevant!: string

  @Column({ length: 8, nullable: true })
  feedback!: string // 'positive' | 'negative'

  @CreateDateColumn({ type: 'timestamptz' })
  timestamp!: Date
}
