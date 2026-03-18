import { AppDataSource } from '../data-source'
import { CiteModeQueryLogs } from '../entities/CiteModeQueryLogs.entity'

export async function insertCiteModeQueryLog(data: Partial<CiteModeQueryLogs>) {
  const repo = AppDataSource.getRepository(CiteModeQueryLogs)
  const record = repo.create(data)
  return repo.save(record)
}
