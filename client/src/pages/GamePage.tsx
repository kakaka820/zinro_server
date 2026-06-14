// client/src/pages/GamePage.tsx
// GamePage.tsx — /game/:gameId から /room/:roomId へリダイレクト
import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../api/client';

export default function GamePage() {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    api.get<{ room_id: number }>(`/api/games/${gameId}`)
      .then(res => navigate(`/room/${res.data.room_id}`, { replace: true }))
      .catch(() => navigate('/lobby', { replace: true }));
  }, [gameId]);

  return <div className="container">読み込み中...</div>;
}