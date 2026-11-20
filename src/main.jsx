import './lib/authLink'; // must stay first: captures invite/reset link info before the Supabase client clears the URL
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
<StrictMode>
    <App />
</StrictMode>
);