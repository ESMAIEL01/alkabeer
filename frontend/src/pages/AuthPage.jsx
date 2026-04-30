import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setSession } from '../services/api';
import AkBrandMark from '../components/AkBrandMark';
import AkButton from '../components/AkButton';

/**
 * AuthPage — first impression of the brand.
 *
 * Layout: full-bleed scene-archive-room.png background + radial scrim,
 * centered glass card with the AlKabeer brand mark, three tab buttons
 * (دخول / عضوية / ضيف), single-column form, primary CTA in crimson.
 *
 * No game logic changed. Same handler, same endpoints, same setSession().
 */
export default function AuthPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('login'); // login | register | guest
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingMsg, setPendingMsg] = useState('');

  const handleAuth = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setPendingMsg('');
    try {
      let endpoint = '/api/auth/login';
      if (activeTab === 'register') endpoint = '/api/auth/register';
      if (activeTab === 'guest')    endpoint = '/api/auth/guest';
      const payload = activeTab === 'guest' ? { username } : { username, password };
      const data = await api.post(endpoint, payload);
      if (data && data.pending) {
        setPendingMsg(data.message || 'حسابك بينتظر موافقة الأدمن.');
        return;
      }
      setSession({ token: data.token, user: data.user });
      navigate('/lobby');
    } catch (err) {
      setError(err.message || 'فشلت عملية الدخول');
    } finally {
      setLoading(false);
    }
  };

  const submitLabel =
    loading
      ? 'يتم التحقق من الأرشيف...'
      : activeTab === 'login'
      ? 'ادخل الساحة'
      : activeTab === 'register'
      ? 'تسجيل البصمة'
      : 'دخول كضيف';

  const placeholderName =
    activeTab === 'guest' ? 'اسمك كضيف (اختياري)' : 'اسم المستخدم';

  return (
    <div className="s-auth">
      <div className="s-auth-card">
        <AkBrandMark variant="full" size={36} />
        <h1>الأرشيف المختوم بانتظارك</h1>
        <p className="auth-sub">سجّل دخولك أو ادخل كضيف لتبدأ التحقيق.</p>

        <div className="s-auth-tabs" role="tablist" aria-label="نوع الدخول">
          <button
            role="tab"
            type="button"
            id="tab-login"
            aria-selected={activeTab === 'login'}
            aria-controls="tabpanel-auth"
            className="s-auth-tab"
            onClick={() => { setActiveTab('login'); setError(''); setPendingMsg(''); }}
          >
            دخول
          </button>
          <button
            role="tab"
            type="button"
            id="tab-register"
            aria-selected={activeTab === 'register'}
            aria-controls="tabpanel-auth"
            className="s-auth-tab"
            onClick={() => { setActiveTab('register'); setError(''); setPendingMsg(''); }}
          >
            عضوية
          </button>
          <button
            role="tab"
            type="button"
            id="tab-guest"
            aria-selected={activeTab === 'guest'}
            aria-controls="tabpanel-auth"
            className="s-auth-tab"
            onClick={() => { setActiveTab('guest'); setError(''); setPendingMsg(''); }}
          >
            ضيف
          </button>
        </div>

        {error && <div className="s-auth-error" role="alert">{error}</div>}
        {pendingMsg && (
          <div className="s-host-ai-note" role="status" style={{ marginBottom: 'var(--ak-space-3)' }}>
            {pendingMsg}
          </div>
        )}

        <form
          id="tabpanel-auth"
          role="tabpanel"
          aria-labelledby={`tab-${activeTab}`}
          onSubmit={handleAuth}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ak-space-3)' }}
        >
          <label htmlFor="auth-username" className="sr-only">
            {activeTab === 'guest' ? 'اسمك كضيف (اختياري)' : 'اسم المستخدم'}
          </label>
          <input
            id="auth-username"
            type="text"
            placeholder={placeholderName}
            className="s-auth-field"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required={activeTab !== 'guest'}
          />
          {activeTab !== 'guest' && (
            <>
              <label htmlFor="auth-password" className="sr-only">شفرة المرور</label>
              <input
                id="auth-password"
                type="password"
                placeholder="شفرة المرور"
                className="s-auth-field"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </>
          )}
          <AkButton
            variant="primary"
            type="submit"
            disabled={loading}
            style={{ width: '100%', padding: '0.95rem', marginTop: 'var(--ak-space-2)' }}
          >
            {submitLabel}
          </AkButton>
        </form>
      </div>
    </div>
  );
}
