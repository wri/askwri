import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm'

@Entity('cite_mode_query_logs')
export class CiteModeQueryLog {
  @PrimaryGeneratedColumn()
  id!: number

  @Column('text')
  query!: string

  @Column('text', { name: 'top_ten_results' })
  topTenResults!: string

  @CreateDateColumn({ type: 'timestamptz' })
  timestamp!: Date
}
