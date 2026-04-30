import React from 'react';
import { useNavigate } from 'react-router-dom';

export default function PostGameReport() {
  const navigate = useNavigate();
  // In a real app, report data would come from the backend or socket state
  const mockReport = {
    mafiozoCaught: false, // Innocents lost
    mafiozo: 'اللاعب 2',
    mostSuspicious: 'اللاعب 1 (Obvious Suspect)',
    bestPlayer: 'الكبير',
    votes: [
      { from: 'اللاعب 1', to: 'اللاعب 2' },
      { from: 'اللاعب 2', to: 'اللاعب 1' },
      { from: 'اللاعب 3', to: 'اللاعب 1' }
    ]
  };

  return (
    <div className="container animate-fade-in text-center mt-4">
      <h2 style={{ fontSize: '2.5rem', color: mockReport.mafiozoCaught ? 'var(--text-main)' : 'var(--accent-red)' }} className="mb-4">
        {mockReport.mafiozoCaught ? "انتصر المستثمرون" : "المافيوزو انتصر"}
      </h2>
      
      <div className="card max-w-md mx-auto mb-4 text-right">
        <h3 className="golden-text mb-2">الحقيقة (الأرشيف)</h3>
        <p className="mb-2">المافيوزو الحقيقي كان: <strong className="cinematic-glow">{mockReport.mafiozo}</strong></p>
        <p className="mb-4">المشتبه به الظاهر الذي خدعكم كان: <strong>{mockReport.mostSuspicious}</strong></p>

        <h4 className="golden-text mb-2">من صوّت لمن؟</h4>
        <ul className="mb-4 text-muted">
          {mockReport.votes.map((v, i) => (
             <li key={i}>{v.from} ➔ {v.to}</li>
          ))}
        </ul>
        
        <p className="cinematic-glow" style={{ fontSize: '1.2rem', color: 'var(--accent-gold)'}}>
          "الدليل كان قدام عينيكم.. بس الأرشيف مسجل كل حاجة" - الكبير
        </p>
      </div>

      <div className="flex justify-center flex-wrap" style={{ gap: '1rem' }}>
        <button className="ak-btn ak-btn-primary" style={{ width: 'auto' }} onClick={() => navigate('/lobby')}>
          لعبة جديدة لنفس الفريق
        </button>
        <button className="ak-btn ak-btn-ghost" style={{ width: 'auto' }} onClick={() => navigate('/profile')}>
          إحصائياتي والألقاب
        </button>
      </div>
    </div>
  );
}
