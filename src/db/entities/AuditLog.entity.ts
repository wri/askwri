import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm'

@Entity('audit_log')
export class AuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string

  @Column('uuid', { name: 'actor_user_id', nullable: true })
  actorUserId!: string | null

  @Column('text')
  source!: string

  @Column('text')
  action!: string

  @Column('text', { name: 'entity_type' })
  entityType!: string

  @Column('uuid', { name: 'entity_id', nullable: true })
  entityId!: string | null

  @Column('jsonb', { nullable: true })
  before!: Record<string, any> | null

  @Column('jsonb', { nullable: true })
  after!: Record<string, any> | null

  @CreateDateColumn({ name: 'at', type: 'timestamptz' })
  at!: Date
}
