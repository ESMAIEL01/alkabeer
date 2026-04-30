import React from 'react';
import { useNavigate } from 'react-router-dom';
import AkBrandMark from '../components/AkBrandMark';
import AkButton from '../components/AkButton';

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="s-landing">
      <header className="s-landing-header">
        <AkBrandMark variant="full" size={28} />
      </header>

      <main className="s-landing-hero">
        <img
          src="/design/scene-archive-book.png"
          alt=""
          aria-hidden="true"
          className="s-landing-seal"
        />

        <p className="ak-overline s-landing-overline">الأرشيف المختوم</p>

        <h1 className="s-landing-headline">
          الحقيقة مكتوبة
          <br />
          قبل أن تبدأ
        </h1>

        <p className="s-landing-body">
          لعبة استنتاج اجتماعية عربية. اكشف المافيوزو قبل ما يهرب من الأرشيف.
        </p>

        <div className="s-landing-cta">
          <AkButton
            variant="primary"
            onClick={() => navigate('/auth')}
            style={{ minWidth: '220px', padding: '1.1rem 2.5rem' }}
          >
            ادخل الساحة
          </AkButton>
        </div>
      </main>

      <footer className="s-landing-footer">
        <span className="s-landing-stamp">MAFIOZO — SEALED ARCHIVE PROTOCOL</span>
      </footer>
    </div>
  );
}
