import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

export const useSocket = () => {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    socketRef.current = io(
      import.meta.env.VITE_SOCKET_URL || window.location.origin,
      { withCredentials: true }
    );
    return () => { socketRef.current?.disconnect(); };
  }, []);

  return socketRef;
};