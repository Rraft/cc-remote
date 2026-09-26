import { useEffect, useState } from 'react';
import Login from './pages/Login';
import Chat, { type ChatSessionKey } from './pages/Chat';
import Sessions from './pages/Sessions';
import Files from './pages/Files';
import Settings from './pages/Settings';
import { StoreProvider, useStore } from './store';

export type Tab = 'sessions' | 'files' | 'settings';
type View = { name: 'main'; tab: Tab } | { name: 'chat'; session: ChatSessionKey; from: Tab };

function ErrorToast() {
  const { lastError, clearError } = useStore();
  useEffect(() => {
    if (!lastError) return;
    const t = setTimeout(clearError, 5000);
    return () => clearTimeout(t);
  }, [lastError, clearError]);
  if (!lastError) return null;
  return (
    <button
      onClick={clearError}
      className="fixed left-3 right-3 bottom-24 z-50 rounded-xl border border-red-800 bg-red-950/95 px-4 py-3 text-left text-sm text-red-200 shadow-lg backdrop-blur safe-bottom"
    >
      ⚠ {lastError}
      <span className="block text-xs text-red-400 mt-0.5">点击关闭</span>
    </button>
  );
}

function NoticeToast() {
  const { notice, clearNotice } = useStore();
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(clearNotice, 4500);
    return () => clearTimeout(t);
  }, [notice, clearNotice]);
  if (!notice) return null;
  return (
    <button
      onClick={clearNotice}
      className="fixed left-3 right-3 bottom-24 z-50 rounded-xl border border-amber-700 bg-amber-950/95 px-4 py-3 text-left text-sm text-amber-200 shadow-lg backdrop-blur safe-bottom"
    >
      {notice}
    </button>
  );
}

function WsBanner() {
  const { wsState } = useStore();
  if (wsState === 'open') return null;
  return (
    <div className="px-4 py-1.5 text-center text-xs bg-amber-900/80 text-amber-200">
      {wsState === 'connecting' ? '正在连接服务器…' : '连接已断开，正在重连…'}
    </div>
  );
}

function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const items: Array<{ key: Tab; icon: string; label: string }> = [
    { key: 'sessions', icon: '💬', label: '会话' },
    { key: 'files', icon: '📁', label: '文件' },
    { key: 'settings', icon: '⚙️', label: '设置' },
  ];
  return (
    <nav className="flex border-t border-zinc-800 bg-zinc-950 safe-bottom">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={`flex-1 py-2 text-center text-xs ${
            tab === it.key ? 'text-emerald-400' : 'text-zinc-500'
          }`}
        >
          <span className="block text-lg leading-6">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </nav>
  );
}

function Shell() {
  const { booted, authed } = useStore();
  const [view, setView] = useState<View>({ name: 'main', tab: 'sessions' });

  if (!booted) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-500">
        <span className="animate-pulse">CC Remote</span>
      </div>
    );
  }
  if (!authed) return <Login />;

  if (view.name === 'chat') {
    return (
      <div className="h-full flex flex-col">
        <div className="safe-top" />
        <WsBanner />
        <div className="flex-1 min-h-0 relative">
          <Chat session={view.session} onBack={() => setView({ name: 'main', tab: view.from })} />
        </div>
        <ErrorToast />
        <NoticeToast />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="safe-top" />
      <WsBanner />
      <div className="flex-1 min-h-0 relative">
        {view.tab === 'sessions' && (
          <Sessions
            onOpen={(session) => setView({ name: 'chat', session, from: 'sessions' })}
          />
        )}
        {view.tab === 'files' && <Files />}
        {view.tab === 'settings' && <Settings />}
      </div>
      <TabBar tab={view.tab} onChange={(tab) => setView({ name: 'main', tab })} />
      <ErrorToast />
      <NoticeToast />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
