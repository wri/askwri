import { render, screen } from '@testing-library/react';
import Home from '@/app/page';

describe('Home Page', () => {
  it('renders the main heading', () => {
    render(<Home />);
    
    const heading = screen.getByRole('heading', {
      name: /Welcome to Next\.js on ECS Fargate/i,
    });
    
    expect(heading).toBeInTheDocument();
  });

  it('renders the environment badge', () => {
    render(<Home />);
    
    const badge = screen.getByText(/Environment:/i);
    expect(badge).toBeInTheDocument();
  });

  it('renders feature cards', () => {
    render(<Home />);
    
    expect(screen.getByText(/Infrastructure as Code/i)).toBeInTheDocument();
    expect(screen.getByText(/CI\/CD Pipeline/i)).toBeInTheDocument();
    expect(screen.getByText(/Multi-Environment/i)).toBeInTheDocument();
    expect(screen.getByText(/Containerized/i)).toBeInTheDocument();
  });
});
