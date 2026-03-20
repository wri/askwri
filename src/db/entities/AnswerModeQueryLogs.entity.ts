import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm'

@Entity('answer_mode_query_logs')
export class AnswerModeQueryLogs {
  @PrimaryGeneratedColumn()
  id!: number

  @Column('text')
  query!: string

  @Column('text')
  answer!: string

  @Column('text', { name: 'top_ten_results' })
  topTenResults!: string

  @CreateDateColumn({ type: 'timestamptz' })
  timestamp!: Date
}
