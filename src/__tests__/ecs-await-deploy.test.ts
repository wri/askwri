/**
 * The deploy wait used to be a bare `aws ecs wait services-stable`, which fails
 * with an exit code and nothing else (#503). These tests drive the replacement
 * with a stubbed `aws` to prove it (a) bounds the wait, (b) names the service,
 * revision and stop reason when a rollout dies, and (c) fails when the live
 * revision is not this build.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const SCRIPT = join(ROOT, 'scripts/ecs-await-deploy.sh')
const ARN = (rev: string) =>
  `arn:aws:ecs:us-east-2:1:task-definition/svc:${rev}`

type Run = { status: number | null; out: string; ms: number }

/** Stubs `aws` with canned JSON; `--query` calls get the text they asked for. */
function runAws(
  fixtures: Record<string, unknown>,
  args: string[],
  images: string,
  taskDefArn: string,
  opts: { failTaskDef?: boolean } = {},
): Run {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-await-'))
  const bin = join(dir, 'bin')
  spawnSync('mkdir', ['-p', bin])
  for (const [name, body] of Object.entries(fixtures)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(body))
  }
  writeFileSync(
    join(bin, 'aws'),
    `#!/bin/sh
case "$1 $2" in
  "ecs describe-services")
    case "$*" in *--query*) echo "${taskDefArn}" ;; *) cat "${dir}/services.json" ;; esac ;;
  "ecs describe-task-definition")
    ${opts.failTaskDef ? 'echo "stub: throttled" >&2; exit 254' : `echo "${images}"`} ;;
  "ecs list-tasks") echo "arn:aws:ecs:us-east-2:1:task/cluster/deadbeef" ;;
  "ecs describe-tasks") cat "${dir}/tasks.json" ;;
  *) echo "stub: unhandled aws $*" >&2; exit 1 ;;
esac
`,
  )
  chmodSync(join(bin, 'aws'), 0o755)
  const started = Date.now()
  const res = spawnSync('bash', [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    encoding: 'utf8',
  })
  return {
    status: res.status,
    out: `${res.stdout}${res.stderr}`,
    ms: Date.now() - started,
  }
}

const args = (sha?: string) => [
  '--cluster',
  'c',
  '--services',
  'svc-a svc-b',
  '--timeout',
  '1',
  '--interval',
  '1',
  ...(sha ? ['--expected-image-tag', sha] : []),
]

function service(name: string, rev: string, stable: boolean) {
  return {
    serviceName: name,
    status: 'ACTIVE',
    runningCount: stable ? 1 : 0,
    desiredCount: 1,
    taskDefinition: ARN(rev),
    deployments: [
      ...(stable
        ? []
        : [
            {
              id: 'ecs-svc/old',
              taskDefinition: ARN('1'),
              createdAt: '2026-11-24T10:00:00Z',
            },
          ]),
      {
        id: `ecs-svc/${name}`,
        taskDefinition: ARN(rev),
        createdAt: '2026-11-25T09:45:00Z',
        runningCount: stable ? 1 : 0,
        desiredCount: 1,
        failedTasks: stable ? 0 : 2,
        rolloutState: stable ? 'COMPLETED' : 'IN_PROGRESS',
        rolloutStateReason: stable
          ? ''
          : 'ECS deployment circuit breaker: tasks failed to start.',
      },
    ],
    events: [
      {
        createdAt: '2026-11-25T09:47:58Z',
        message: `(service ${name}) has begun draining`,
      },
    ],
  }
}

it('passes once every service is stable and the live revision is this build', () => {
  const r = runAws(
    {
      services: {
        failures: [],
        services: [service('svc-a', '7', true), service('svc-b', '9', true)],
      },
    },
    args('abc123'),
    '1.dkr.ecr.us-east-2.amazonaws.com/app:abc123\t1.dkr.ecr.us-east-2.amazonaws.com/app:abc123',
    ARN('7'),
  )
  expect(r.out).toContain('All services stable')
  expect(r.out).toContain('carry image tag abc123')
  expect(r.status).toBe(0)
})

it('gives up on the deadline and names the service, revision and stop reason', () => {
  const r = runAws(
    {
      services: {
        failures: [],
        services: [service('svc-a', '7', false), service('svc-b', '9', true)],
      },
      tasks: {
        tasks: [
          {
            taskArn: 'arn:aws:ecs:us-east-2:1:task/cluster/deadbeef',
            taskDefinitionArn: ARN('7'),
            stopCode: 'EssentialContainerExited',
            stoppedReason:
              'Task failed ELB health checks in (target-group askwri-app-qa-tg)',
            containers: [
              {
                name: 'askwri-app-qa',
                exitCode: 143,
                reason: 'health check failed',
              },
            ],
          },
          {
            // An older revision's corpse must not be blamed on this rollout.
            taskArn: 'arn:aws:ecs:us-east-2:1:task/cluster/old',
            taskDefinitionArn: ARN('1'),
            stopCode: 'UserInitiated',
            stoppedReason: 'stopped by a previous deploy',
            containers: [],
          },
        ],
      },
    },
    args(),
    '',
    ARN('7'),
  )
  expect(r.status).toBe(1)
  expect(r.out).toContain('did not stabilise (bound 1s)')
  expect(r.out).toContain('SERVICE svc-a: ACTIVE, running 0/1')
  expect(r.out).toContain(
    'rollout=IN_PROGRESS — ECS deployment circuit breaker',
  )
  expect(r.out).toContain(
    'STOPPED TASK deadbeef  EssentialContainerExited: Task failed ELB health checks',
  )
  expect(r.out).toContain('container askwri-app-qa exit=143')
  expect(r.out).not.toContain('stopped by a previous deploy')
})

it('fails when the live revision is not the image that was built', () => {
  const r = runAws(
    {
      services: {
        failures: [],
        services: [service('svc-a', '7', true), service('svc-b', '9', true)],
      },
    },
    args('abc123'),
    '1.dkr.ecr.us-east-2.amazonaws.com/app:stale999',
    ARN('7'),
  )
  expect(r.status).toBe(1)
  expect(r.out).toContain(
    'svc-a runs 1.dkr.ecr.us-east-2.amazonaws.com/app:stale999, not tag abc123',
  )
})

it('fails rather than reporting success when it cannot read the live images', () => {
  // The guard must never pass by checking nothing: a throttled/denied call here
  // used to leave `images` empty, skip the loop and print success.
  const r = runAws(
    {
      services: {
        failures: [],
        services: [service('svc-a', '7', true), service('svc-b', '9', true)],
      },
    },
    args('abc123'),
    '',
    ARN('7'),
    { failTaskDef: true },
  )
  expect(r.status).toBe(1)
  expect(r.out).toContain('could not read the images of')
  expect(r.out).not.toContain('carry image tag')
})

it('fails at once, not on the deadline, when a service does not exist', () => {
  const r = runAws(
    {
      services: {
        failures: [
          {
            arn: 'arn:aws:ecs:us-east-2:1:service/cluster/nope',
            reason: 'MISSING',
          },
        ],
        services: [],
      },
    },
    [
      '--cluster',
      'c',
      '--services',
      'svc-a',
      '--timeout',
      '60',
      '--interval',
      '15',
    ],
    '',
    ARN('7'),
  )
  expect(r.status).toBe(1)
  expect(r.out).toContain('MISSING SERVICE')
  expect(r.ms).toBeLessThan(5000)
})
