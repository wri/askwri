import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { CiteModeFeedback } from './entities/CiteModeFeedback.entity'
import { AnswerModeFeedback } from './entities/AnswerModeFeedback.entity'
import { CiteModeQueryLogs } from './entities/CiteModeQueryLogs.entity'
import { AnswerModeQueryLogs } from './entities/AnswerModeQueryLogs.entity'
import { Document } from './entities/Document.entity'
import { IngestionJob } from './entities/IngestionJob.entity'
import { User } from './entities/User.entity'
import { Tag } from './entities/Tag.entity'
import { DocumentTag } from './entities/DocumentTag.entity'
import { Collection } from './entities/Collection.entity'
import { DocumentCollection } from './entities/DocumentCollection.entity'
import { AuditLog } from './entities/AuditLog.entity'
import { TagAlias } from './entities/TagAlias.entity'
import { ReclassifyJob } from './entities/ReclassifyJob.entity'

const DATABASE_URL =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`

// Default export for TypeORM CLI
const MigrationDataSource = new DataSource({
  type: 'postgres',
  url: DATABASE_URL,
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === 'true',
  entities: [
    CiteModeFeedback,
    AnswerModeFeedback,
    CiteModeQueryLogs,
    AnswerModeQueryLogs,
    Document,
    IngestionJob,
    User,
    Tag,
    DocumentTag,
    Collection,
    DocumentCollection,
    AuditLog,
    TagAlias,
    ReclassifyJob,
  ],
  migrations: ['src/db/migrations/**/*.ts'],
  subscribers: [],
  // DATABASE_SSL=false disables SSL for local dev databases (docker has no SSL);
  // default stays SSL-on for RDS.
  ssl:
    process.env.DATABASE_SSL === 'false'
      ? false
      : {
          rejectUnauthorized:
            process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
        },
})

export default MigrationDataSource
