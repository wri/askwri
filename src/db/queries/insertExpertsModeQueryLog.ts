import { AppDataSource } from '../data-source'
import { ExpertsModeQueryLogs } from '../entities/ExpertsModeQueryLogs.entity'

export async function insertExpertsModeQueryLog(
  data: Pick<ExpertsModeQueryLogs, 'query' | 'mode' | 'topTenPeople'>,
) {
  const repo = AppDataSource.getRepository(ExpertsModeQueryLogs)
  return repo.save(repo.create(data))
}
