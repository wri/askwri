import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'

@Entity('tag_aliases')
export class TagAlias {
  @PrimaryColumn('uuid', { name: 'tag_id' })
  tagId!: string

  @PrimaryColumn('text')
  alias!: string

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
