// RoomPage.tsx
import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import api from '../api/client';
import { useAuth } from '../hooks/useAuth';

type Member = {
  id: number;
  handle_name: string;
  is_ready?: boolean;
  is_spectator?: boolean;
  is_bot?: boolean;
};

type RoomDetail = {
  id: number;
  name: string;
  owner_id: number;
  status: string;
  max_players: number;
  members: Member[];
};

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const socketRef = useRef<Socket | null>(null);

  const [room, setRoom] = useState<RoomDetail | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  const id = Number(roomId);

  // ─── ルーム情報取得 ───
  const fetchRoom = async () => {
  try {
    const res = await api.get<RoomDetail>(`/api/rooms/${id}`);
    setRoom(res.data);
    setMembers(res.data.members);
  } catch {
    setError('ルーム情報の取得に失敗しました');
  }
};

  // ─── Socket.io 接続 ───
  useEffect(() => {
    fetchRoom();

    socketRef.current = io(
      import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001',
      { withCredentials: true }
    );

    socketRef.current.emit('join_room', { roomId: id, userId: user?.id });

    socketRef.current.on('room_updated', () => {
      fetchRoom(); // 誰かが入退室したら再取得
    });

    socketRef.current.on('game_started', (data: { gameId: number }) => {
      navigate(`/game/${data.gameId}`);
    });

    socketRef.current.on('kicked', ({ userId: kickedId }: { userId: number }) => {
      if (kickedId === user?.id) {
        alert('キックされました');
        navigate('/lobby');
      }
    });


    return () => {
      socketRef.current?.emit('leave_room', { roomId: id, userId: user?.id });
      socketRef.current?.disconnect();
    };
  }, [id]);

  // ─── 退室 ───
  const leaveRoom = async () => {
    await api.post(`/api/rooms/${id}/leave`);
    navigate('/lobby');
  };

  // ─── ゲーム開始（オーナーのみ）───
  const startGame = async () => {
    setStarting(true);
    setError('');
    try {
      const res = await api.post<{ id: number }>('/api/games/start', { roomId: id });
      // game_started イベントは Socket.io で全員に届くので、
      // ここでは念のため自分だけ遷移
      navigate(`/game/${res.data.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'ゲーム開始に失敗しました');
      setStarting(false);
    }
  };

  const isOwner = user?.id === room?.owner_id;
  const isLastMember = members.length === 1;
  const canStart = isOwner && members.length >= 1; //開発用　一人でもゲーム開始できるように（メモ）

  if (!room) return <div className="container">読み込み中...</div>;

  return (
    <div className="container">
      {/* ヘッダー */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderBottom: '1px solid #4a4a7a', paddingBottom: 8, marginBottom: 16 }}>
        <h1 style={{ fontSize: 18 }}>🚪 {room.name}</h1>
        <button onClick={leaveRoom} style={{ fontSize: 12 }}>
          {isLastMember ? '村を閉じる' : '退室'}
        </button>
      </div>

      {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}

      {/* 参加者一覧 */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 14, color: '#aaa', marginBottom: 8 }}>
          参加者　{members.filter(m => !m.is_spectator).length} / {room.max_players}人
          {members.filter(m => m.is_spectator).length > 0 &&
            `　観戦 ${members.filter(m => m.is_spectator).length}人`}
        </h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {members.map((m, i) => (
              <tr key={m.id} style={{ borderBottom: '1px solid #2a2a4a' }}>
                <td style={{ padding: '6px 8px', color: '#aaa' }}>{i + 1}</td>
                <td style={{ padding: '6px 8px' }}>
                  {m.handle_name}
                  {m.id === room.owner_id && (
                    <span style={{ color: '#f4c430', fontSize: 11, marginLeft: 6 }}>★オーナー</span>
                  )}
                   {m.is_spectator && (
                    <span style={{ color: '#888', fontSize: 11, marginLeft: 6 }}>👁 観戦</span>
                  )}
                  {m.is_bot && <span style={{ color: '#a78bfa', fontSize: 11, marginLeft: 6 }}>🤖 Bot</span>}
                  {m.id === user?.id && (
                    <span style={{ color: '#7ec8e3', fontSize: 11, marginLeft: 6 }}>(あなた)</span>
                  )}
                </td>
                 <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    {isOwner && m.id !== user?.id && (
                      <button
                        onClick={() => api.post(`/api/rooms/${id}/kick`, { targetUserId: m.id })
                          .catch(err => setError(err.message))}
                        style={{ fontSize: 11, color: '#f87171', borderColor: '#7f1d1d', background: 'transparent' }}
                      >
                        キック
                      </button>
                    )}
                  </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 開始ボタン or 待機メッセージ */}
      <div style={{ marginTop: 20 }}>
        {isOwner && (
          <button
            onClick={() => api.post(`/api/rooms/${id}/add-bot`)
              .catch(err => setError(err instanceof Error ? err.message : 'Bot追加失敗'))}
            style={{ fontSize: 12, marginBottom: 8, display: 'block' }}
          >
            🤖 Bot を追加
          </button>
        )}
        {isOwner ? (
          <div>
            {!canStart && (
              <p style={{ color: '#aaa', fontSize: 13, marginBottom: 8 }}>
                ゲーム開始には最低5人必要です（現在{members.length}人）
              </p>
            )}
            <button
              onClick={startGame}
              disabled={!canStart || starting}
              style={{
                padding: '6px 24px',
                background: canStart ? '#4a2a7a' : undefined,
                borderColor: canStart ? '#7a4aaa' : undefined,
                fontSize: 14,
              }}
            >
              {starting ? '開始中...' : 'ゲームを開始する'}
            </button>
          </div>
        ) : (
          <p style={{ color: '#aaa', fontSize: 13 }}>
            オーナーがゲームを開始するのを待っています...
          </p>
        )}
      </div>
    </div>
  );
}