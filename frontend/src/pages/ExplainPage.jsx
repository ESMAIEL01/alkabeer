import React from 'react';
import { useNavigate } from 'react-router-dom';
import AkButton from '../components/AkButton';

export default function ExplainPage() {
  const navigate = useNavigate();

  return (
    <div className="s-explain animate-fade-in">
      <div className="s-explain-topbar">
        <span className="ak-overline">Codex · قوانين الساحة</span>
        <AkButton variant="ghost" onClick={() => navigate(-1)}>عودة</AkButton>
      </div>

      <header className="s-explain-hero">
        <span className="ak-overline">How to Play · كيف تلعب</span>
        <h1 className="s-explain-title">قوانين الساحة</h1>
        <p className="s-explain-sub">لعبة الجريمة والتحقيق والأرشيف المختوم.</p>
      </header>

      <section className="s-explain-section">
        <span className="ak-overline">Modes · الوضعيات</span>
        <h2 className="s-explain-section-title">طريقة اللعب</h2>
        <ul className="s-explain-list">
          <li>
            <strong>الوضع الفردي (Solo):</strong>
            <span> المضيف يمتلك كل الأسرار ويدير اللعبة في العالم الحقيقي (مدمج).</span>
          </li>
          <li>
            <strong>وضع المجموعة (Group):</strong>
            <span> الجميع متصلون هنا، والنظام هو الكبير.</span>
          </li>
        </ul>
      </section>

      <section className="s-explain-section">
        <span className="ak-overline">Protocol Zero · الأرشيف المختوم</span>
        <h2 className="s-explain-section-title">الأرشيف المختوم</h2>
        <p className="s-explain-body">
          يتم كتابة القصة وتحديد المجرم (المافيوزو) قبل أن تبدأ اللعبة ويتم تشفيرها،
          فلا مجال لتغيير الحقيقة!
        </p>
      </section>

      <section className="s-explain-section">
        <span className="ak-overline">Game Flow · سير اللعبة</span>
        <h2 className="s-explain-section-title">سير الجلسة</h2>
        <ol className="s-explain-steps">
          <li>يتم الكشف عن الدليل الأول للنقاش.</li>
          <li>بعد انتهاء وقت النقاش (المحدد بمؤقت قوي)، يتم التصويت.</li>
          <li>إن تم استبعاد المافيوزو، يفوز الأبرياء. وإن كان بريئاً، تستمر اللعبة للدليل التالي.</li>
        </ol>
      </section>

      <p className="s-explain-quote">
        "شكلكوا مش واخدين بالكوا من حاجة..."
      </p>
    </div>
  );
}
