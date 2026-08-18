import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity('tags')
export class Tag {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column('text')
  facet!: string

  @Column('text', { name: 'value_id' })
  valueId!: string

  @Column('text', { name: 'taxonomy_version', default: 'v1' })
  taxonomyVersion!: string

  @Column('uuid', { name: 'parent_tag_id', nullable: true })
  parentTagId!: string | null

  @Column('text', { nullable: true })
  description!: string | null

  @Column('boolean', { name: 'needs_reembed', default: false })
  needsReembed!: boolean
}
