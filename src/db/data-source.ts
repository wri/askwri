import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { CiteModeFeedback } from './entities/CiteModeFeedback.entity'
import { AnswerModeFeedback } from './entities/AnswerModeFeedback.entity'
import { CiteModeQueryLogs } from './entities/CiteModeQueryLogs.entity'

const DATABASE_URL =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: DATABASE_URL,
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === 'true',
  entities: [CiteModeFeedback, AnswerModeFeedback, CiteModeQueryLogs],
  ssl: {
    rejectUnauthorized:
      process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
  },
})

// Initialize connection (for Next.js API routes)
export const initializeDatabase = async () => {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize()
    console.log('✅ Database connection established')
  }
  return AppDataSource
}
