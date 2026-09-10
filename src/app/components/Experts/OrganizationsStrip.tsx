'use client'

export const OrganizationsStrip = ({
  organizations,
}: {
  organizations: { name: string; docs: number }[]
}) => {
  if (organizations.length === 0) return null
  return (
    <p style={{ padding: '10px 4px', fontSize: 12.5, color: '#5E5B52' }}>
      Also publishing on this:{' '}
      {organizations.slice(0, 5).map((o, i) => (
        <span key={o.name}>
          {i > 0 && ', '}
          {o.name} ({o.docs} doc{o.docs === 1 ? '' : 's'})
        </span>
      ))}
    </p>
  )
}
