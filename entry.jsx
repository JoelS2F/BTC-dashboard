import React from 'react';
import ReactDOM from 'react-dom/client';
import BTCDashboard from './btc-dashboard.jsx';

document.getElementById('spinner').style.display = 'none';
ReactDOM.createRoot(document.getElementById('root')).render(<BTCDashboard />);
