import { AppDataSource } from '../data-source'
import { AnswerModeQueryLogs } from '../entities/AnswerModeQueryLogs.entity'

export async function insertAnswerModeQueryLog(
  data: Partial<AnswerModeQueryLogs>,
) {
  const repo = AppDataSource.getRepository(AnswerModeQueryLogs)
  const record = repo.create(data)
  return repo.save(record)
}
