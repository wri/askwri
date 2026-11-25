/**
 * Regression guard for #502. start-app.sh used to run a full `aws s3 sync` of
 * the documents bucket before exec'ing node: 607 objects / 3.12 GB took 2m00s,
 * and the ALB marks a target unhealthy after 75s (15s x 5), so every new task
 * was SIGTERMed mid-download before it ever bound :3000 and deploys could not
 * converge. Nothing in the deployed app needs that directory — the PDF and
 * admin-preview handlers fetch from S3 by s3_key, and the catalog defaults to
 * Postgres; /tmp/askWRI_docs is only a local-dev fallback.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')

function stub(binDir: string, name: string) {
  // Records its own invocation, then exits 0 — like the real tool would.
  const p = join(binDir, name)
  writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "$CALLS"\n`)
  chmodSync(p, 0o755)
}

it('execs the server without downloading the documents bucket first', () => {
  const work = mkdtempSync(join(tmpdir(), 'start-app-boot-'))
  const binDir = join(work, 'bin')
  const calls = join(work, 'calls.log')
  execFileSync('mkdir', ['-p', binDir])
  stub(binDir, 'aws')
  stub(binDir, 'node')
  writeFileSync(calls, '')

  execFileSync('sh', ['start-app.sh'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin`,
      CALLS: calls,
      DOCUMENTS_S3_BUCKET: 'askwri-data', // configured, yet no download at boot
      DOCUMENTS_S3_PREFIX: 'documents/',
    },
  })

  expect(readFileSync(calls, 'utf8').trim()).toBe('node server.js')
})
