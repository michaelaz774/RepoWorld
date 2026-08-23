
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// NOTE: no StrictMode. Its double-invoked mount/cleanup tears down the react-three-fiber
// WebGL root before it finishes initializing, leaving a permanently blank 300x150 canvas.
createRoot(document.getElementById('root')).render(<App />);
