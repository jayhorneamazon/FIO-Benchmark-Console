import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';

export const AppHeader: React.FC = () => {
  const { user, signOut } = useAuth();
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;

  return (
    <header className="app-header">
      <div className="header-left">
        <Link to="/" className="header-brand">FIO Benchmark Console</Link>
        {user && (
          <nav className="header-nav" aria-label="Main navigation">
            <Link to="/" className={isActive('/') ? 'nav-link active' : 'nav-link'}>
              Dashboard
            </Link>
            <Link to="/new" className={isActive('/new') ? 'nav-link active' : 'nav-link'}>
              New Run
            </Link>
            <Link to="/compare" className={isActive('/compare') ? 'nav-link active' : 'nav-link'}>
              Compare
            </Link>
            <Link to="/analytics" className={isActive('/analytics') ? 'nav-link active' : 'nav-link'}>
              Analytics
            </Link>
          </nav>
        )}
      </div>
      {user && (
        <div className="header-user">
          <span className="user-email">{user.email}</span>
          <button onClick={signOut} className="sign-out-btn">Sign Out</button>
        </div>
      )}
    </header>
  );
};
