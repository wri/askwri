import { AppDataSource } from '../data-source'
import { UserFeedback } from '../entities/UserFeedback.entity'

export async function insertFeedback(data: Partial<UserFeedback>) {
  const repo = AppDataSource.getRepository(UserFeedback)
  const feedback = repo.create(data)
  return repo.save(feedback)
}
