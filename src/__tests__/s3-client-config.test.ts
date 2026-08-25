import { s3ClientConfig } from '@/lib/s3'

describe('s3ClientConfig', () => {
  const original = process.env.AWS_ENDPOINT_URL

  afterEach(() => {
    if (original === undefined) delete process.env.AWS_ENDPOINT_URL
    else process.env.AWS_ENDPOINT_URL = original
  })

  it('returns empty config when AWS_ENDPOINT_URL is unset (production)', () => {
    delete process.env.AWS_ENDPOINT_URL
    expect(s3ClientConfig()).toEqual({})
  })

  it('returns endpoint + forcePathStyle when AWS_ENDPOINT_URL is set (MinIO)', () => {
    process.env.AWS_ENDPOINT_URL = 'http://localhost:9000'
    expect(s3ClientConfig()).toEqual({
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
    })
  })
})
