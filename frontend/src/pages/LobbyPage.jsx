import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { socket, connectSocket } from '../services/socket';
import { api, getToken, getStoredUser, clearSession } from '../services/api';

export default function LobbyPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const roomIdFromUrl = searchParams.get('room');

  const [user, setUser] = useState(null);
  const [roomCode, setRoomCode] = useState(roomIdFromUrl || '');
  const [activeRoom, setActiveRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [error, setError] = useState('');
  const [roomMode, setRoomMode] = useState('HUMAN');
  const [creatorId, setCreatorId] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    const token = getToken();
    const u = getStoredUser();
    if (!token || !u) {
      navigate('/');
      return;
    }
    setUser(u);
    connectSocket(token, u);

    socket.on('room_update', (data) => {
      setActiveRoom(data.id);
      setPlayers(data.players);
      setRoomMode(data.mode);
      setCreatorId(data.creatorId);
    });

    socket.on('game_started', (data) => {
      navigate(`/game/${data?.id || activeRoom}`);
    });

    if (roomIdFromUrl && !activeRoom) {
      handleJoinRoom(roomIdFromUrl);
    }

    return () => {
      socket.off('room_update');
      socket.off('game_started');
    };
  }, [navigate]);

  const handleCreateRoom = (mode = 'HUMAN') => {
    socket.emit('create_room', { mode }, (response) => {
      if (response.success) {
        setActiveRoom(response.roomId);
        window.history.replaceState(null, '', '/lobby');
      } else {
        setError('فشل في إنشاء الغرفة السريّة.');
      }
    });
  };

  const handleJoinRoom = (code) => {
    const joinCode = code || roomCode;
    if (!joinCode) return;
    
    socket.emit('join_room', { roomId: joinCode }, (response) => {
      if (response.success) {
        setActiveRoom(response.roomId);
      } else {
        setError(response.message || 'الغرفة غير موجودة أو تم قفلها.');
      }
    });
  };

  const handleStartGame = async () => {
    if (roomMode === 'AI') {
      setAiLoading(true);
      try {
        const data = await api.post('/api/scenarios/ai-generate', {
          idea: 'جريمة عشوائية مشوقة',
          players: players.length || 5,
          mood: 'مكس',
          difficulty: 'متوسط',
        });
        // Backend now seals the archive itself (UTF-8 safe Base64).
        socket.emit('finalize_archive', {
          archive: data.archive_b64,
          raw: data.scenario,
          clues: data.clues,
        });
        socket.emit('start_game_setup', { roomId: activeRoom });
        if (data.source === 'fallback' && data.note) {
          setError(data.note);
        }
      } catch(err) {
        setError(err.message || 'فشل في الذكاء الاصطناعي');
      } finally {
        setAiLoading(false);
      }
    } else {
      socket.emit('start_game_setup', { roomId: activeRoom });
      navigate('/host-dashboard');
    }
  };

  if (!user) return <div className="container items-center justify-center cinematic-glow">يتم فك التشفير...</div>;

  const roomLink = `${window.location.origin}/lobby?room=${activeRoom}`;

  return (
    <div className="container mt-4 animate-fade-in">
      <header className="flex justify-between items-center mb-6 p-4 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', backdropFilter: 'var(--glass-blur)' }}>
        <div className="flex flex-col">
          <h2 className="golden-text" style={{ fontSize: '1.8rem', margin: 0 }}>المحقق: {user.username}</h2>
          {user.isGuest && <span className="text-muted" style={{ fontSize: '0.9rem'}}>هوية مؤقتة (ضيف)</span>}
        </div>
        <div className="flex gap-4">
          <button className="btn-secondary" onClick={() => navigate('/explain')} style={{ padding: '0.5rem 1rem' }}>القوانين 📜</button>
          <button className="btn-secondary" onClick={() => { clearSession(); navigate('/'); }} style={{ padding: '0.5rem 1rem', borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }}>انسحاب 🚪</button>
        </div>
      </header>

      {!activeRoom ? (
        <div className="card max-w-md mx-auto text-center mt-4">
          <h1 className="cinematic-glow mb-6" style={{ fontSize: '2.5rem' }}>الساحة المظلمة</h1>
          
          {error && <div className="mb-4 p-2 rounded text-main" style={{ background: 'rgba(229,9,20,0.2)', border: '1px solid var(--accent-red)' }}>{error}</div>}
          
          <div className="flex justify-center gap-4 mb-6">
            <button className="btn-primary" onClick={() => handleCreateRoom('HUMAN')} style={{ fontSize: '1.2rem', padding: '1rem', flex: 1 }}>
              مضيف (بشري) 👤
            </button>
            <button className="btn-primary" onClick={() => handleCreateRoom('AI')} style={{ fontSize: '1.2rem', padding: '1rem', flex: 1, background: 'linear-gradient(135deg, #1f1c2c, #928DAB)' }}>
              الكبير الاصطناعي 🤖
            </button>
          </div>
          
          <div className="divider"></div>
          
          <div className="mt-4">
            <h3 className="text-muted mb-4 font-normal">أو اقتحم غرفة قائمة</h3>
            <input 
              type="text" 
              placeholder="شفرة الغرفة (مثال: M4F1A)" 
              className="input-field text-center font-bold"
              style={{ fontSize: '1.5rem', letterSpacing: '2px' }}
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
            />
            <button className="btn-secondary mt-2" onClick={() => handleJoinRoom()} disabled={!roomCode}>
              انضم للتحقيق 🔍
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-6 justify-center mt-4">
          {/* Room Details & Access Card */}
          <div className="card text-center" style={{ flex: '1 1 350px', maxWidth: '450px' }}>
            <h2 className="cinematic-glow mb-2" style={{ fontSize: '2rem' }}>مقر التحقيق</h2>
            <p className="golden-text mb-6" style={{ fontSize: '2.5rem', letterSpacing: '4px' }}>{activeRoom}</p>
            
            <p className="text-muted mb-4">شارك هذا الختم العالي السرية لدعوة اللاعبين</p>
            
            <div className="qr-container bg-white p-4 rounded-xl mx-auto mb-6 flex justify-center items-center" style={{ width: 'fit-content', boxShadow: '0 0 20px rgba(255,255,255,0.1)' }}>
              <QRCodeSVG value={roomLink} size={180} />
            </div>

            <div className="mb-4 text-left" dir="ltr">
              <input type="text" readOnly value={roomLink} className="input-field text-center mb-0" style={{ fontSize: '0.9rem', color: '#888' }} onClick={e => e.target.select()} />
            </div>
          </div>

          {/* Players Roster Card */}
          <div className="card" style={{ flex: '1 1 400px', maxWidth: '600px', display: 'flex', flexDirection: 'column' }}>
            <h3 className="golden-text mb-4" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '1rem' }}>
              المشتبه بهم المتواجدون ({players.length})
            </h3>
            
            <ul className="player-list flex-1" style={{ overflowY: 'auto', maxHeight: '350px' }}>
              {players.length === 0 ? <p className="text-muted text-center mt-4">لا يوجد أحد هنا بعد...</p> : null}
              {players.map(p => (
                <li key={p.id} className="player-item">
                  <div className="flex items-center gap-4">
                    <span style={{ fontSize: '1.5rem' }}>{p.isHost ? '🎩' : '🕵️'}</span>
                    <span style={{ fontSize: '1.2rem', fontWeight: p.id === user.id ? '800' : 'normal', color: p.id === user.id ? 'var(--text-main)' : '#ccc' }}>
                      {p.username} {p.id === user.id && '(أنت)'}
                    </span>
                  </div>
                  {p.isHost && <span className="status-badge status-host">الكبير</span>}
                </li>
              ))}
            </ul>

            <div className="mt-6 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              {players.find(p => p.id === user.id)?.isHost || (roomMode === 'AI' && creatorId === user.id) ? (
                <button className="btn-primary pulse-animation" onClick={handleStartGame} disabled={aiLoading}>
                  {aiLoading ? 'الكبير يكتب الأرشيف... ⏳' : (roomMode === 'AI' ? 'صناعة القصة بالذكاء وبدء اللعبة 🤖' : 'انتقال لغرفة صياغة الأرشيف 📂')}
                </button>
              ) : (
                <div className="text-center p-4 rounded-lg" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid var(--border-subtle)' }}>
                  <p className="golden-text pulse-animation" style={{ margin: 0, fontSize: '1.1rem' }}>⏳ بانتظار الكبير لختم الأرشيف وبدء اللعبة...</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
