import { useState, useEffect } from 'react';
import api from '../api/client';

export type User = {
  id: number;
  handleName: string;
};

export const useAuth = () => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/api/auth/me')
      .then(res => setUser(res.data))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (handleName: string, password: string) => {
    const res = await api.post('/api/auth/login', { handleName, password });
    setUser(res.data);
    return res.data;
  };

  const register = async (handleName: string, password: string) => {
    const res = await api.post('/api/auth/register', { handleName, password });
    setUser(res.data);
    return res.data;
  };

  const logout = async () => {
    await api.post('/api/auth/logout');
    setUser(null);
  };

  return { user, loading, login, register, logout };
};