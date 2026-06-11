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
}
