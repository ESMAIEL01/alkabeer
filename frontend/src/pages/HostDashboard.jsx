import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { emitWithAck, setActiveRoomId, getActiveRoomId } from '../services/socket';
import { api } from '../services/api';

/**
 * Host crafts (or AI-generates) the sealed archive, then commits it.
 * Navigation to /game/:roomId only happens AFTER the server acknowledges
 * `finalize_archive`. No client-side guessing of the room id.
 */
export default function HostDashboard() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('create');
  const [prompt, setPrompt] = useState('');
  const [scenarioText, setScenarioText] = useState('');
  const [base64Archive, setBase64Archive] = useState('');
  const [clues, setClues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const [error, setError] = useState('');
  const [showRawArchive, setShowRawArchive] = useState(false);

  // sealing → 'idle' | 'sealing' | 'sealed'
  const [sealing, setSealing] = useState('idle');

  const handleGenerateAI = async () => {
    setLoading(true);
    setError('');
    setAiNote('');
    try {
      const data = await api.post('/api/scenarios/ai-generate', {
        idea: prompt,
        players: 5,
        difficulty: 'متوسط',
      });
      setScenarioText(data.scenario || '');
      setBase64Archive(data.archive_b64 || '');
      setClues(Array.isArray(data.clues) ? data.clues : []);
      if (data.source === 'fallback' && data.note) setAiNote(data.note);
    } catch (err) {
      setError(err.message || 'فشل في توليد الأرشيف.');
    } finally {
      setLoading(false);
    }
  };

  const finalizeScenario = async () => {
    if (sealing !== 'idle') return; // double-click guard
    setError('');

    // Step-by-step preconditions, each with an Arabic message.
    if (!base64Archive || !scenarioText) {
      setError('لازم تولّد الأرشيف الأول.');
      return;
    }
    const roomId = getActiveRoomId();
    if (!roomId) {
      setError('الغرفة مش محفوظة. ارجع للساحة وابدأ غرفة جديدة.');
      return;
    }

    setSealing('sealing');
    try {
      const ack = await emitWithAck('finalize_archive', {
        roomId,
        archive: base64Archive,
        raw: scenarioText,
        clues,
      }, 8_000);

      if (!ack || !ack.success) {
        throw new Error((ack && ack.error) || 'تعذّر ختم الأرشيف.');
      }

      setActiveRoomId(ack.roomId || roomId);
      setSealing('sealed');
      // Brief "sealed, opening arena" pause so the user sees confirmation.
      setTimeout(() => navigate(`/game/${ack.roomId || roomId}`), 600);
    } catch (err) {
      setSealing('idle');
      const msg = err && err.message === 'socket-ack-timeout'
        ? 'الخادم ما ردّش في الوقت. تأكد من الاتصال وحاول تاني.'
        : (err.message || 'تعذّر ختم الأرشيف.');
      setError(msg);
    }
  };

  const buttonLabel =
    sealing === 'sealing' ? 'جاري ختم الأرشيف... ⏳'
    : sealing === 'sealed' ? 'تم الختم، جار فتح الساحة... 🔥'
    : 'ختم الأرشيف وبدء اللعبة 🔥';

  return (
    <div className="container">
      <h2 className="golden-text mb-4 text-center">لوحة تحكم الكبير (المضيف)</h2>

      <div className="card max-w-md mx-auto animate-fade-in">
        <div className="flex justify-between mb-4 border-b pb-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <button className={`btn-secondary ${activeTab === 'create' ? 'golden-text' : ''}`} onClick={() => setActiveTab('create')}>صناعة الأرشيف</button>
          <button className={`btn-secondary ${activeTab === 'drafts' ? 'golden-text' : ''}`} onClick={() => setActiveTab('drafts')}>مسودات</button>
          <button className={`btn-secondary ${activeTab === 'market' ? 'golden-text' : ''}`} onClick={() => setActiveTab('market')}>المكتبة</button>
        </div>

        {activeTab === 'create' && (
          <div>
            <textarea
              className="input-field mb-2"
              rows="3"
              placeholder="وصف الجريمة (مثال: سرقة لوحة نادرة في متحف مصري)... أو سيب الكبير يبدع"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={sealing !== 'idle'}
            />
            <button className="btn-secondary mb-4" onClick={handleGenerateAI} disabled={loading || sealing !== 'idle'}>
              {loading ? '⏳ الكبير بيكتب...' : '✨ توليد السيناريو بالذكاء الاصطناعي'}
            </button>

            {error && (
              <div className="mb-4 p-2 rounded text-main" style={{ background: 'rgba(229,9,20,0.2)', border: '1px solid var(--accent-red)' }}>
                ⚠️ {error}
              </div>
            )}

            {aiNote && (
              <div className="mb-4 p-2 rounded text-muted" style={{ background: 'rgba(212,175,55,0.1)', border: '1px solid rgba(212,175,55,0.4)' }}>
                {aiNote}
              </div>
            )}

            {scenarioText && (
              <div className="mb-4">
                <h4 className="cinematic-glow mb-1">القصة (سرية للمضيف):</h4>
                <div style={{ backgroundColor: 'rgba(0,0,0,0.5)', padding: '1rem', borderRadius: '4px', fontSize: '0.9rem', marginBottom: '1rem', whiteSpace: 'pre-wrap' }}>
                  {scenarioText}
                </div>

                {clues.length > 0 && (
                  <div className="mb-4">
                    <h4 className="golden-text mb-1">🔍 الأدلة الثلاثة:</h4>
                    <ol style={{ paddingInlineStart: '1.2rem' }}>
                      {clues.map((c, i) => (
                        <li key={i} style={{ marginBottom: '0.4rem' }}>{c}</li>
                      ))}
                    </ol>
                  </div>
                )}

                {/* Raw archive is debug data — collapsed by default. */}
                <div className="mb-4">
                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                    onClick={() => setShowRawArchive(s => !s)}
                  >
                    {showRawArchive ? 'إخفاء بيانات الأرشيف' : 'عرض بيانات الأرشيف (للمطورين)'}
                  </button>
                  {showRawArchive && (
                    <>
                      <h4 className="golden-text mt-2 mb-1">🔴 الأرشيف المختوم (PROTOCOL ZERO)</h4>
                      <div className="text-muted" style={{ wordWrap: 'break-word', fontSize: '0.75rem', backgroundColor: '#330000', padding: '0.5rem', border: '1px solid var(--accent-red)' }}>
                        {base64Archive.slice(0, 200)}{base64Archive.length > 200 ? '…' : ''}
                      </div>
                    </>
                  )}
                </div>

                <div className="mt-4">
                  <button
                    className="btn-primary"
                    onClick={finalizeScenario}
                    disabled={sealing !== 'idle'}
                    style={sealing === 'sealing' ? { opacity: 0.85, cursor: 'wait' } : null}
                  >
                    {buttonLabel}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'drafts' && <p className="text-muted">لا يوجد مسودات حالياً.</p>}
        {activeTab === 'market' && <p className="text-muted">تحميل السيناريوهات المجتمعية...</p>}
      </div>
    </div>
  );
}
