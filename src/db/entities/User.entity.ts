import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm'

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column('text', { unique: true })
  username!: string

  @Column('text', { nullable: true })
  email!: string | null

  @Column('text', { name: 'password_hash' })
  passwordHash!: string

  @Column('text', { default: 'editor' })
  role!: string

  @Column('boolean', { default: true })
  active!: boolean

  @Column('timestamptz', { name: 'last_login', nullable: true })
  lastLogin!: Date | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
