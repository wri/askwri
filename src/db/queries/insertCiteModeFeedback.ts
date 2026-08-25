import { AppDataSource } from '../data-source'
import { CiteModeFeedback } from '../entities/CiteModeFeedback.entity'

export async function insertCiteModeFeedback(data: Partial<CiteModeFeedback>) {
  const repo = AppDataSource.getRepository(CiteModeFeedback)
  const feedback = repo.create(data)
  return repo.save(feedback)
}
