import styles from './page.module.css';

export default function Home() {
  const environment = process.env.NEXT_PUBLIC_ENVIRONMENT || 'development';

  return (
    <main className={styles.main}>
      <div className={styles.container}>
        <h1 className={styles.title}>
          Welcome to Next.js on ECS Fargate
        </h1>
        <p className={styles.description}>
          This application is deployed using Terraform and GitHub Actions
        </p>
        <div className={styles.environmentBadge}>
          Environment: <strong>{environment}</strong>
        </div>
        <div className={styles.grid}>
          <div className={styles.card}>
            <h2>Infrastructure as Code</h2>
            <p>Deployed with Terraform on AWS ECS Fargate</p>
          </div>
          <div className={styles.card}>
            <h2>CI/CD Pipeline</h2>
            <p>Automated deployments via GitHub Actions</p>
          </div>
          <div className={styles.card}>
            <h2>Multi-Environment</h2>
            <p>Separate QA and Production environments</p>
          </div>
          <div className={styles.card}>
            <h2>Containerized</h2>
            <p>Docker container with standalone Next.js build</p>
          </div>
        </div>
      </div>
    </main>
  );
}
