import React from 'react';
import { useNavigate } from 'react-router-dom';

export default function ExplainPage() {
  const navigate = useNavigate();

  return (
    <div className="container mt-4 animate-fade-in">
      <div className="flex justify-between items-center mb-4 border-b">
        <h2 className="golden-text">قوانين الساحة</h2>
        <button className="btn-secondary" onClick={() => navigate(-1)} style={{ width: 'auto' }}>عودة</button>
      </div>

      <div className="card mx-auto max-w-md">
        <h3 className="mb-2 text-center cinematic-glow">كيف تلعب مافيوزو؟</h3>
        <p className="mb-4 text-muted text-center">لعبة الجريمة والتحقيق والأرشيف المختوم.</p>

        <h4 className="golden-text mb-1">الوضعيات:</h4>
        <ul className="mb-4" style={{ paddingRight: '1rem' }}>
          <li><strong>الوضع الفردي (Solo):</strong> المضيف يمتلك كل الأسرار ويدير اللعبة في العالم الحقيقي (مدمج).</li>
          <li><strong>وضع المجموعة (Group):</strong> الجميع متصلون هنا، والنظام هو الكبير.</li>
        </ul>

        <h4 className="golden-text mb-1">الأرشيف المختوم (PROTOCOL ZERO):</h4>
        <p className="mb-4" style={{ paddingRight: '1rem' }}>
          يتم كتابة القصة وتحديد المجرم (المافيوزو) قبل أن تبدأ اللعبة ويتم تشفيرها، فلا مجال لتغيير الحقيقة!
        </p>

        <h4 className="golden-text mb-1">سير اللعبة:</h4>
        <ol className="mb-4" style={{ paddingRight: '1rem' }}>
           <li>يتم الكشف عن الدليل الأول للنقاش.</li>
           <li>بعد انتهاء وقت النقاش (المحدد بمؤقت قوي)، يتم التصويت.</li>
           <li>إن تم استبعاد المافيوزو، يفوز الأبرياء. وإن كان بريئاً، تستمر اللعبة للدليل التالي.</li>
        </ol>
        
        <p className="text-center mt-4 cinematic-glow" style={{ color: 'var(--accent-red)'}}>
          "شكلكوا مش واخدين بالكوا من حاجة..."
        </p>
      </div>
    </div>
  );
}
