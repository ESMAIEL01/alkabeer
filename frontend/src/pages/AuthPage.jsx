import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setSession } from '../services/api';

export default function AuthPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('login'); // login | register | guest
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleAuth = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      let endpoint = '/api/auth/login';
      if (activeTab === 'register') endpoint = '/api/auth/register';
      if (activeTab === 'guest') endpoint = '/api/auth/guest';

      const payload = activeTab === 'guest' ? { username } : { username, password };

      const data = await api.post(endpoint, payload);
      setSession({ token: data.token, user: data.user });
      navigate('/lobby');
    } catch (err) {
      setError(err.message || 'فشلت عملية الدخول');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container justify-center items-center">
      <div className="card max-w-md animate-fade-in text-center mx-auto" style={{ marginTop: '5vh' }}>
        
        <div className="mb-6">
          <h1 className="cinematic-glow golden-text mb-2" style={{ fontSize: '3.5rem' }}>مافيوزو</h1>
          <p className="text-muted" style={{ fontSize: '1.2rem'}}>Mafiozo</p>
          <div className="divider"></div>
          <p className="text-main" style={{ fontSize: '1.1rem', fontWeight: '500'}}>الأرشيف المختوم بانتظارك...</p>
        </div>

        <div className="flex justify-between gap-2 mb-6 p-2" style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '16px' }}>
          <button 
            className={`btn-secondary \${activeTab === 'login' ? 'golden-text' : ''}`}
            onClick={() => { setActiveTab('login'); setError(''); }}
            style={{ padding: '0.8rem 1rem', border: activeTab === 'login' ? '1px solid var(--accent-gold)' : 'none' }}
          >
            دخول مباشر
          </button>
          <button 
            className={`btn-secondary \${activeTab === 'register' ? 'golden-text' : ''}`}
            onClick={() => { setActiveTab('register'); setError(''); }}
            style={{ padding: '0.8rem 1rem', border: activeTab === 'register' ? '1px solid var(--accent-gold)' : 'none' }}
          >
            عضوية جديدة
          </button>
          <button 
            className={`btn-secondary \${activeTab === 'guest' ? 'golden-text' : ''}`}
            onClick={() => { setActiveTab('guest'); setError(''); }}
            style={{ padding: '0.8rem 1rem', border: activeTab === 'guest' ? '1px solid var(--accent-gold)' : 'none' }}
          >
            كضيف
          </button>
        </div>

        {error && (
          <div className="mb-4 p-4 text-center rounded-lg" style={{ background: 'rgba(229, 9, 20, 0.15)', color: 'var(--accent-red)', border: '1px solid rgba(229, 9, 20, 0.3)' }}>
            ⚠️ {error}
          </div>
        )}

        <form onSubmit={handleAuth} className="flex flex-col gap-4">
          <input 
            type="text" 
            placeholder={activeTab === 'guest' ? 'اسمك كضيف (اختياري)' : 'اسم المستخدم السري'} 
            className="input-field mb-1" 
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required={activeTab !== 'guest'}
          />
          
          {activeTab !== 'guest' && (
            <input 
              type="password" 
              placeholder="شفرة المرور" 
              className="input-field mb-1" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required 
            />
          )}

          <button type="submit" className="btn-primary mt-2" disabled={loading}>
            {loading ? 'يتم التحقق من الأرشيف...' : (activeTab === 'login' ? 'ادخل الساحة 🎬' : (activeTab === 'register' ? 'تسجيل البصمة 📝' : 'دخول سريع ⚡'))}
          </button>
        </form>
      </div>
    </div>
  );
}
