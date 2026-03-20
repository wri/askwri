'use client'

const IsQA = () => {
  const isQa =
    process.env.NEXT_PUBLIC_ENVIRONMENT === 'qa' ||
    process.env.NEXT_PUBLIC_ENVIRONMENT === 'development'
  if (!isQa) return null
  return (
    <div
      style={{
        backgroundColor: '#C11101',
        color: 'white',
        padding: '10px 20px',
        textAlign: 'center',
        position: 'fixed',
        bottom: '3%',
        right: '3%',
        zIndex: 1000,
        borderRadius: '16px',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      QA
    </div>
  )
}

export default IsQA
