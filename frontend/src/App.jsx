import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import AuthPage from './pages/AuthPage';
import LobbyPage from './pages/LobbyPage';
import ExplainPage from './pages/ExplainPage';
import HostDashboard from './pages/HostDashboard';
import GameBoard from './pages/GameBoard';
import PostGameReport from './pages/PostGameReport';
import ProfilePage from './pages/ProfilePage';
import ArchiveReplay from './pages/ArchiveReplay';
import AdminDashboard from './pages/AdminDashboard';

function App() {
  const token = localStorage.getItem('mafToken');

  return (
    <Router>
      <div className="app-container">
        <Routes>
          <Route path="/" element={token ? <Navigate to="/lobby" /> : <LandingPage />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/lobby" element={<LobbyPage />} />
          <Route path="/explain" element={<ExplainPage />} />
          <Route path="/host-dashboard" element={<HostDashboard />} />
          <Route path="/game/:roomId" element={<GameBoard />} />
          <Route path="/report" element={<PostGameReport />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/archive/:gameId" element={<ArchiveReplay />} />
          {/* F4: admin dashboard. Page-level guard checks /api/auth/me.user.isAdmin
              and bounces non-admins with the documented Arabic 403 copy. */}
          <Route path="/admin" element={<AdminDashboard />} />
        </Routes>
      </div>
    </Router>
  );
}

export default App;
