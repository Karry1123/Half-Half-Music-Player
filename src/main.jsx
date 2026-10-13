import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { engine } from './engine/session.js';
import { useMusic } from './store/useMusic.js';
import { useSession } from './store/useSession.js';
import './styles.css';

// 开发调试：控制台里可用 __hh.engine.position()、__hh.session.getState() 等
if (import.meta.env.DEV) window.__hh = { engine, session: useSession, music: useMusic };

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
