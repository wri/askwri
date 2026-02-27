import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { CiteModeFeedback } from './entities/CiteModeFeedback.entity'
import { AnswerModeFeedback } from './entities/AnswerModeFeedback.entity'

const DATABASE_URL =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`

// Default export for TypeORM CLI
const MigrationDataSource = new DataSource({
  type: 'postgres',
  url: DATABASE_URL,
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === 'true',
  entities: [CiteModeFeedback, AnswerModeFeedback],
  migrations: ['src/db/migrations/**/*.ts'],
  subscribers: [],
  ssl: {
    rejectUnauthorized:
      process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
  },
})

export default MigrationDataSource
