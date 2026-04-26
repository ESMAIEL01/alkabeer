import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { socket } from '../services/socket';
import { getStoredUser } from '../services/api';

export default function GameBoard() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  
  const [gameState, setGameState] = useState('LOADING'); 
  const [timer, setTimer] = useState(0);
  const [archiveBase64, setArchiveBase64] = useState('');
  const [currentClue, setCurrentClue] = useState('');
  const [players, setPlayers] = useState([]);
  const [votes, setVotes] = useState({});
  const [amIHost, setAmIHost] = useState(false);
  const [myVote, setMyVote] = useState(null);
  const [user, setUser] = useState(getStoredUser());

  useEffect(() => {
    socket.emit('get_game_state', { roomId });

    socket.on('full_state_update', (data) => {
       setPlayers(data.players || []);
       setGameState(data.phase);
       setTimer(data.timer);
       if (data.archive) setArchiveBase64(data.archive);
       if (data.currentClue) setCurrentClue(data.currentClue);
       setAmIHost(data.hostId === user?.id);
    });

    socket.on('timer_update', (time) => setTimer(time));
    socket.on('phase_change', (newPhase) => setGameState(newPhase));
    socket.on('archive_sealed', (data) => setArchiveBase64(data.archive));
    socket.on('clue_revealed', (data) => setCurrentClue(data.text));
    socket.on('vote_registered', (data) => {
        // update local state that vote went through
        if(data.userId === user?.id) setMyVote(data.targetId);
    });

    return () => {
      socket.off('full_state_update');
      socket.off('timer_update');
      socket.off('phase_change');
      socket.off('archive_sealed');
      socket.off('clue_revealed');
      socket.off('vote_registered');
    };
  }, [roomId, user?.id]);

  const handleHostAction = (action) => {
    socket.emit('host_control', { action, roomId });
  };

  const handleVote = (targetId) => {
     socket.emit('submit_vote', { roomId, targetId });
  };

  return (
    <div className="container mt-2 animate-fade-in" style={{ maxWidth: '1400px' }}>
      <div className="flex justify-between items-center mb-6 p-4 rounded-xl" style={{ background: 'rgba(0,0,0,0.6)', borderBottom: '2px solid var(--accent-red)' }}>
        <h2 className="golden-text" style={{ margin: 0 }}>الساحة المستديرة ⚖️</h2>
        <div style={{ 
          fontSize: '2rem', fontWeight: '900', 
          color: timer <= 10 ? 'var(--accent-red)' : 'var(--text-main)',
          fontFamily: 'monospace'
        }} className={timer <= 10 && timer > 0 ? 'pulse-animation' : ''}>
          ⏳ 00:{Math.max(0, timer).toString().padStart(2, '0')}
        </div>
      </div>

      <div className="flex flex-wrap gap-6" style={{ minHeight: '65vh' }}>
        <div className="card flex-col justify-center items-center" style={{ flex: '1 1 60%', position: 'relative' }}>
          
          {gameState === 'LOBBY' || gameState === 'LOADING' && (
             <div className="text-center">
                 <h2 className="cinematic-glow">جاري تهيئة التحقيق...</h2>
             </div>
          )}

          {gameState === 'ARCHIVE_LOCKED' && (
            <div className="animate-fade-in text-center w-full max-w-lg mx-auto">
              <div className="mb-6" style={{ fontSize: '5rem', filter: 'drop-shadow(0 0 20px rgba(229,9,20,0.6))' }}>🔒</div>
              <h2 className="cinematic-glow mb-4" style={{ fontSize: '2.5rem' }}>الأرشيف مختوم</h2>
              <p className="text-muted mb-6">تم تشفير الحقيقة. القصة ثابتة ولا مجال لتغييرها الآن.</p>
              
              <div className="p-4 rounded-lg mb-6" style={{ backgroundColor: 'rgba(20, 0, 0, 0.5)', border: '1px solid var(--accent-red)', color: 'rgba(255,255,255,0.5)', wordBreak: 'break-all', fontSize: '0.8rem' }}>
                PROTOCOL_ZERO_HASH: <br/>{archiveBase64.repeat(4).substring(0, 200)}...
              </div>
              <p className="golden-text pulse-animation">بانتظار نطق الدليل...</p>
            </div>
          )}

          {gameState === 'CLUE_REVEAL' && (
            <div className="animate-fade-in text-center w-full">
              <h3 className="golden-text mb-6" style={{ fontSize: '2.2rem'}}>🔍 دليل من الكبير</h3>
              <div className="cinematic-glow p-6 rounded-xl mx-auto" style={{ fontSize: '1.6rem', backgroundColor: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.1)', maxWidth: '80%' }}>
                "{currentClue || 'لا يوجد دليل متاح حالياً.'}"
              </div>
              <p className="mt-8 text-muted">تناقشوا فيما بينكم. الوقت يمر.</p>
            </div>
          )}

          {gameState === 'VOTING' && (
            <div className="animate-fade-in text-center w-full">
              <div className="mb-4 pulse-animation" style={{ fontSize: '4rem' }}>⚠️</div>
              <h1 className="cinematic-glow mb-4" style={{ fontSize: '3rem' }}>حان وقت الحُكم</h1>
              <p className="text-muted mb-8" style={{ fontSize: '1.2rem' }}>من هو المافيوزو؟ الأرشيف لا يرحم والمشنقة لا تفرق.</p>
              
              <div className="flex justify-center flex-wrap gap-4 mx-auto" style={{ maxWidth: '80%' }}>
                {players.filter(p => !p.isHost).map(p => (
                   <button 
                     key={p.id}
                     className="btn-secondary" 
                     style={{ 
                         width: '45%', 
                         fontSize: '1.2rem', 
                         padding: '1.5rem',
                         background: myVote === p.id ? 'var(--accent-red)' : '' 
                     }}
                     onClick={() => handleVote(p.id)}
                   >
                     {p.username} {myVote === p.id && '✅'}
                   </button>
                ))}
                <button 
                  className="btn-secondary" 
                  style={{ width: '45%', fontSize: '1.2rem', padding: '1.5rem', background: myVote === 'skip' ? '#555' : '' }}
                  onClick={() => handleVote('skip')}
                >
                  امتناع عن التصويت {myVote === 'skip' && '✅'}
                </button>
              </div>
            </div>
          )}
          
          {gameState === 'POST_GAME' && (
            <div className="animate-fade-in text-center w-full">
               <h1 className="cinematic-glow mb-4">انتهت التحقيقات</h1>
               <button className="btn-primary" onClick={() => navigate('/report')} style={{ maxWidth: '300px', margin: '0 auto'}}>الاطلاع على التقرير النهائي</button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-6" style={{ flex: '1 1 30%', minWidth: '350px' }}>
          
          {amIHost && (
            <div className="card p-4" style={{ background: 'rgba(20, 0, 0, 0.4)', border: '1px solid rgba(229, 9, 20, 0.3)' }}>
              <h4 className="golden-text mb-4"><span>🕹️</span> لوحة تحكم الكبير (المضيف فقط)</h4>
              <div className="grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.8rem' }}>
                <button className="btn-secondary" onClick={() => handleHostAction('pause')}>إيقاف ⏸️</button>
                <button className="btn-secondary" onClick={() => handleHostAction('resume')}>استكمال ▶️</button>
                <button className="btn-secondary" onClick={() => handleHostAction('extend')}>+30 ثانية ⏳</button>
                <button className="btn-secondary" onClick={() => handleHostAction('skip')}>انهاء النقاش ⏭️</button>
                <button className="btn-secondary" onClick={() => socket.emit('force_phase', { phase: 'CLUE_REVEAL', roomId })} style={{ gridColumn: 'span 2' }}>
                   فرض الدليل
                </button>
                <button className="btn-primary" onClick={() => socket.emit('force_phase', { phase: 'VOTING', roomId })} style={{ gridColumn: 'span 2' }}>
                   فرض التصويت
                </button>
              </div>
            </div>
          )}

          <div className="card flex-1 p-4 flex flex-col">
            <h4 className="mb-4 text-main border-b border-gray-700 pb-2">المسجلون بالغرفة</h4>
            <ul className="player-list overflow-y-auto">
               {players.length === 0 && <p className="text-muted text-sm">جاري التحديث...</p>}
               {players.map(p => (
                 <li key={p.id} className="player-item" style={{ background: 'transparent', padding: '0.5rem 0', border: 'none', borderBottom: '1px solid var(--border-subtle)' }}>
                   <span>{p.isHost ? '🎩' : '👤'} {p.username} {p.id === user?.id && '(أنت)'}</span>
                   <span className="text-muted" style={{ fontSize: '0.8rem'}}>{p.isHost ? 'المضيف' : 'مشتبه'}</span>
                 </li>
               ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
