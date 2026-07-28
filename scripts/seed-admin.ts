import 'reflect-metadata'
import bcrypt from 'bcryptjs'
import { AppDataSource } from '../src/db/data-source'
import { User } from '../src/db/entities/User.entity'

/**
 * Reads the password from ADMIN_PASSWORD, or from stdin when it is absent.
 *
 * It used to be argv[3], which put the live admin password into the shell
 * history, into `ps` output for the lifetime of the process, and into the npm
 * lifecycle banner npm prints for every `npm run` invocation.
 */
async function readPassword(): Promise<string> {
  const fromEnv = process.env.ADMIN_PASSWORD
  if (fromEnv) return fromEnv

  if (process.stdin.isTTY) {
    console.error(
      'Provide the password on stdin or via ADMIN_PASSWORD, never as an argument:\n' +
        '  ADMIN_PASSWORD="$(...)" npm run seed:admin -- <username>\n' +
        '  printf %s "$PASSWORD" | npm run seed:admin -- <username>',
    )
    process.exit(1)
  }

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  // Only a trailing newline is stripped — a password may legitimately end in
  // spaces, and trimming them would silently store a different credential.
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '')
}

async function main() {
  const [username, ...rest] = process.argv.slice(2)
  if (!username) {
    console.error('Usage: ADMIN_PASSWORD=... npm run seed:admin -- <username>')
    process.exit(1)
  }
  if (rest.length > 0) {
    console.error(
      'Refusing to run: the password must not be passed as an argument ' +
        '(it leaks into shell history and ps). Use ADMIN_PASSWORD or stdin.',
    )
    process.exit(1)
  }

  const password = await readPassword()
  if (!password) {
    console.error('Empty password — refusing to set it.')
    process.exit(1)
  }

  await AppDataSource.initialize()
  const repo = AppDataSource.getRepository(User)
  const passwordHash = await bcrypt.hash(password, 12)
  const existing = await repo.findOne({ where: { username } })
  if (existing) {
    await repo.update(existing.id, {
      passwordHash,
      active: true,
      role: 'admin',
    })
    console.log(`Reset password and re-activated admin '${username}'`)
  } else {
    await repo.save(
      repo.create({ username, passwordHash, role: 'admin', active: true }),
    )
    console.log(`Created admin user '${username}'`)
  }
  await AppDataSource.destroy()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
