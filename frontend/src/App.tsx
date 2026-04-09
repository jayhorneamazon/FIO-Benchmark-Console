import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './components/AuthProvider';
import { AppHeader } from './components/AppHeader';
import { DashboardPage } from './pages/DashboardPage';
import { NewRunPage } from './pages/NewRunPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { ComparePage } from './pages/ComparePage';
import { AnalyticsPage } from './pages/AnalyticsPage';

const App: React.FC = () => {
  return (
    <AuthProvider>
      <AppHeader />
      <RequireAuth>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/new" element={<NewRunPage />} />
            <Route path="/runs/:runId" element={<RunDetailPage />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/auth/callback" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </RequireAuth>
    </AuthProvider>
  );
};

export default App;
