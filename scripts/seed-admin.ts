import 'reflect-metadata'
import bcrypt from 'bcryptjs'
import { AppDataSource } from '../src/db/data-source'
import { User } from '../src/db/entities/User.entity'

async function main() {
  const [username, password] = process.argv.slice(2)
  if (!username || !password) {
    console.error('Usage: npm run seed:admin -- <username> <password>')
    process.exit(1)
  }
  await AppDataSource.initialize()
  const repo = AppDataSource.getRepository(User)
  const passwordHash = await bcrypt.hash(password, 12)
  const existing = await repo.findOne({ where: { username } })
  if (existing) {
    await repo.update(existing.id, { passwordHash, active: true, role: 'admin' })
    console.log(`Reset password and re-activated admin '${username}'`)
  } else {
    await repo.save(repo.create({ username, passwordHash, role: 'admin', active: true }))
    console.log(`Created admin user '${username}'`)
  }
  await AppDataSource.destroy()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
