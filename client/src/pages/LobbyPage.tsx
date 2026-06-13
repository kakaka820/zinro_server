import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../hooks/useAuth';

type Room = {
  id: number;
  name: string;
  owner_id: number;
  status: string;
  max_players: number;
  member_count: number;
};

export default function LobbyPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [newRoomName, setNewRoomName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const fetchRooms = async () => {
    try {
      const res = await api.get<Room[]>('/api/rooms');
      setRooms(res.data);
    } catch {
      setError('ルーム一覧の取得に失敗しました');
    }
  };

  useEffect(() => {
    fetchRooms();
    const interval = setInterval(fetchRooms, 5000); // 5秒ごとに更新
    return () => clearInterval(interval);
  }, []);

  const createRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<Room>('/api/rooms', {
        name: newRoomName || `${user?.handleName}の部屋`,
        maxPlayers,
      });
      navigate(`/room/${res.data.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '部屋作成に失敗しました');
    }
  };

  const joinRoom = async (roomId: number, asSpectator = false) => {
  try {
    await api.post(`/api/rooms/${roomId}/join`, { asSpectator });
    navigate(`/room/${roomId}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '入室に失敗しました');
    }
  };

  const handleLogout = async () => {
    await logout();
  };

  return (
    <div className="container">
      {/* ヘッダー */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderBottom: '1px solid #4a4a7a', paddingBottom: 8, marginBottom: 16 }}>
        <h1 style={{ fontSize: 18 }}>🐺 人狼ゲーム — ロビー</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: '#aaa', fontSize: 13 }}>{user?.handleName}</span>
          <button onClick={handleLogout} style={{ fontSize: 12 }}>ログアウト</button>
        </div>
      </div>

      {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}

      {/* 部屋作成 */}
      <div style={{ marginBottom: 20 }}>
        <button onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? '▲ 閉じる' : '▶ 部屋を作る'}
        </button>

        {showCreate && (
          <form onSubmit={createRoom} style={{
            marginTop: 10, padding: 12, border: '1px solid #4a4a7a',
            display: 'flex', flexDirection: 'column', gap: 8
          }}>
            <div>
              <label style={{ display: 'block', marginBottom: 4 }}>部屋名</label>
              <input
                value={newRoomName}
                onChange={e => setNewRoomName(e.target.value)}
                placeholder={`${user?.handleName}の部屋`}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 4 }}>定員</label>
              <select value={maxPlayers} onChange={e => setMaxPlayers(Number(e.target.value))}>
                {[5,6,7,8,9,10,11,12,13,14,15,16].map(n => (
                  <option key={n} value={n}>{n}人</option>
                ))}
              </select>
            </div>
            <button type="submit">作成</button>
          </form>
        )}
      </div>

      {/* 部屋一覧 */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ fontSize: 15 }}>部屋一覧</h2>
          <button onClick={fetchRooms} style={{ fontSize: 12 }}>更新</button>
        </div>

        {rooms.length === 0 ? (
          <p style={{ color: '#888', fontSize: 13 }}>部屋がありません。最初の部屋を作ってみましょう！</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #4a4a7a', color: '#aaa' }}>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>部屋名</th>
                <th style={{ textAlign: 'center', padding: '4px 8px' }}>人数</th>
                <th style={{ textAlign: 'center', padding: '4px 8px' }}>状態</th>
                <th style={{ padding: '4px 8px' }}></th>
              </tr>
            </thead>
            <tbody>
              {rooms.map(room => (
                <tr key={room.id} style={{ borderBottom: '1px solid #2a2a4a' }}>
                  <td style={{ padding: '6px 8px' }}>{room.name}</td>
                  <td style={{ textAlign: 'center', padding: '6px 8px' }}>
                    {room.member_count}/{room.max_players}
                  </td>
                  <td style={{ textAlign: 'center', padding: '6px 8px' }}>
                    <span style={{ color: room.status === 'waiting' ? '#6bffb8' : '#aaa' }}>
                      {room.status === 'waiting' ? '待機中' :
                       room.status === 'playing' ? '進行中' : '終了'}
                    </span>
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    {room.status === 'waiting' && (
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button onClick={() => joinRoom(room.id)} style={{ fontSize: 12 }}>
                          入室
                        </button>
                        <button onClick={() => joinRoom(room.id, true)}
                          style={{ fontSize: 12, background: 'transparent', color: '#aaa', borderColor: '#555' }}>
                          観戦
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}