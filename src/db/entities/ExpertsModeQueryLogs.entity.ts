import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm'

@Entity('experts_mode_query_logs')
export class ExpertsModeQueryLogs {
  @PrimaryGeneratedColumn()
  id!: number

  @Column('text')
  query!: string

  @Column('text')
  mode!: string

  @Column('text', { name: 'top_ten_people' })
  topTenPeople!: string

  @CreateDateColumn({ type: 'timestamptz' })
  timestamp!: Date
}
