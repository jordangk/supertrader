import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import ArbPage from './ArbPage.jsx';
import './index.css';

const path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
const root = document.getElementById('root');

if (path === '/arb') {
  ReactDOM.createRoot(root).render(<ArbPage />);
} else {
  ReactDOM.createRoot(root).render(<App />);
}
