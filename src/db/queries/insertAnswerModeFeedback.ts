import { AppDataSource } from '../data-source'
import { AnswerModeFeedback } from '../entities/AnswerModeFeedback.entity'

export async function insertAnswerModeFeedback(
  data: Partial<AnswerModeFeedback>,
) {
  const repo = AppDataSource.getRepository(AnswerModeFeedback)
  const feedback = repo.create(data)
  return repo.save(feedback)
}
