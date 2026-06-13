import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import LoginPage from './pages/LoginPage';
import LobbyPage from './pages/LobbyPage';
import RoomPage from './pages/RoomPage';
import GamePage from './pages/GamePage';
import LogPage from './pages/LogPage';

function App() {
  const { user, loading } = useAuth();

  if (loading) return <div style={{ padding: 20 }}>読み込み中...</div>;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login"          element={!user ? <LoginPage /> : <Navigate to="/lobby" />} />
        <Route path="/lobby"          element={user  ? <LobbyPage /> : <Navigate to="/login" />} />
        <Route path="/room/:roomId"   element={user  ? <RoomPage />  : <Navigate to="/login" />} />
        <Route path="/game/:gameId"   element={user  ? <GamePage />  : <Navigate to="/login" />} />
        <Route path="/log/:gameId"    element={<LogPage />} />
        <Route path="*"              element={<Navigate to={user ? '/lobby' : '/login'} />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;