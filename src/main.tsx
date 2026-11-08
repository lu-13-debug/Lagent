import React from 'react';
import ReactDOM from 'react-dom/client';
import { Entry } from './PublicShare';
import { MobileApp } from './mobile/MobileApp';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import './appearance.css';
import './styles.css';
import './readability.css';
import './accounts.css';
import './appearance-overrides.css';
import './concise-theme.css';

const mobilePath = /^\/m\/?$/.test(window.location.pathname);

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><AppErrorBoundary>{mobilePath ? <MobileApp /> : <Entry />}</AppErrorBoundary></React.StrictMode>);
