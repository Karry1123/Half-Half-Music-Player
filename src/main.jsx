import { useEffect } from 'react';
import { AccountGate } from '../public/accountUI.js';
import { account } from './account.js';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { engine } from './engine/session.js';
import { useMusic } from './store/useMusic.js';
import { useSession } from './store/useSession.js';
import './styles.css';

// 开发调试：控制台里可用 __hh.engine.position()、__hh.session.getState() 等
if (import.meta.env.DEV) window.__hh = { engine, session: useSession, music: useMusic };

function AuthorizedApp() {
  useEffect(() => { engine.connectSignaling(); return () => engine.sig?.ws?.close(); }, []);
  return <App />;
}
createRoot(document.getElementById('root')).render(<AccountGate client={account}><AuthorizedApp /></AccountGate>);
