import { AppDataSource } from '../data-source'
import { User } from '../entities/User.entity'

export async function findActiveUserByUsername(username: string): Promise<User | null> {
  return AppDataSource.getRepository(User).findOne({ where: { username, active: true } })
}

export async function touchLastLogin(id: string): Promise<void> {
  await AppDataSource.getRepository(User).update(id, { lastLogin: new Date() })
}

export interface UserSummary {
  id: string
  username: string
  email: string | null
  role: string
  active: boolean
  lastLogin: Date | null
  createdAt: Date
}

export async function listUsers(): Promise<UserSummary[]> {
  const users = await AppDataSource.getRepository(User).find({ order: { username: 'ASC' } })
  return users.map(({ passwordHash: _ph, ...rest }) => rest)
}

export async function createUser(input: {
  username: string
  email?: string | null
  passwordHash: string
  role: 'admin' | 'editor'
}): Promise<UserSummary> {
  const repo = AppDataSource.getRepository(User)
  const saved = await repo.save(repo.create({ ...input, active: true }))
  const { passwordHash: _ph, ...rest } = saved
  return rest
}

export async function updateUser(
  id: string,
  patch: Partial<{ role: 'admin' | 'editor'; active: boolean; passwordHash: string }>,
): Promise<void> {
  await AppDataSource.getRepository(User).update(id, patch)
}
