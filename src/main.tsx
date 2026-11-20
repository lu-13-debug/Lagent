import React from 'react';
import ReactDOM from 'react-dom/client';
import { Entry } from './PublicShare';
import { MobileApp } from './mobile/MobileApp';
import { AppErrorBoundary } from './components/AppErrorBoundary';
// 字体随应用一起打包，Electron 离线与内网部署都不依赖 CDN。
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './appearance.css';
import './styles.css';
import './readability.css';
import './accounts.css';
import './appearance-overrides.css';
import './concise-theme.css';

const mobilePath = /^\/m\/?$/.test(window.location.pathname);

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><AppErrorBoundary>{mobilePath ? <MobileApp /> : <Entry />}</AppErrorBoundary></React.StrictMode>);
