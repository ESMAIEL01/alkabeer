import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function ProfilePage() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);

  useEffect(() => {
    const uStr = localStorage.getItem('mafUser');
    if (uStr) setUser(JSON.parse(uStr));
  }, []);

  if (!user) return null;

  const mockStats = {
    wins: 14,
    survival: 8,
    accuracy: '75%',
    mafiozoCount: 5,
    title: 'مُعلم الظلام (Lord of Shadows)'
  };

  return (
    <div className="container mt-4 animate-fade-in">
      <div className="flex justify-between items-center mb-4 border-b">
         <h2 className="golden-text">ملف المحقق</h2>
         <button className="btn-secondary" onClick={() => navigate('/lobby')} style={{ width: 'auto'}}>عودة للساحة</button>
      </div>
      
      <div className="card max-w-md mx-auto text-center">
        <div style={{ fontSize: '4rem' }} className="mb-2">🕵️‍♂️</div>
        <h2 className="mb-1">{user.username}</h2>
        {user.isGuest ? (
          <p className="text-muted mb-4">حساب ضيف - لن يتم حفظ الإحصائيات الدائمة</p>
        ) : (
          <h3 className="cinematic-glow mb-4" style={{ color: 'var(--accent-red)'}}>{mockStats.title}</h3>
        )}

        {!user.isGuest && (
          <div className="flex flex-wrap justify-between" style={{ gap: '1rem', textAlign: 'right' }}>
            <div className="w-full" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.5rem' }}>
              <strong>عدد الانتصارات:</strong> <span className="float-left">{mockStats.wins}</span>
            </div>
            <div className="w-full" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.5rem' }}>
              <strong>النجاة للنهاية:</strong> <span className="float-left">{mockStats.survival}</span>
            </div>
            <div className="w-full" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.5rem' }}>
              <strong>دقة التصويت:</strong> <span className="float-left">{mockStats.accuracy}</span>
            </div>
            <div className="w-full" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.5rem' }}>
              <strong>كم مرة كنت مافيوزو:</strong> <span className="float-left">{mockStats.mafiozoCount}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
