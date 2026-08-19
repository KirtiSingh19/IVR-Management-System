/**
 * The shell, and the reason the phone survives navigation.
 *
 * Every page renders inside this one component tree. Moving from Phone to Edit
 * IVR swaps what <Routes> renders — it does not reload the document — so the SIP
 * service module, its WebSocket and any call in progress are never torn down.
 * That is the whole migration in one sentence.
 *
 * Pages not yet migrated are listed here as placeholders rather than omitted, so
 * the nav is complete and it is obvious what remains.
 */

import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { phone } from './hooks/usePhone.js';
import { auth } from './hooks/useAuth.js';
import { attach as attachRecorder } from './services/recorder.js';

import Sidebar from './components/Sidebar.jsx';
import Navbar from './components/Navbar.jsx';
import Footer from './components/Footer.jsx';
import Phone from './pages/Phone.jsx';
import Dashboard from './pages/Dashboard.jsx';
import IvrList from './pages/IvrList.jsx';
import CreateIvr from './pages/CreateIvr.jsx';
import EditIvr from './pages/EditIvr.jsx';
import AudioFiles from './pages/AudioFiles.jsx';
import TestIvr from './pages/TestIvr.jsx';
import Login from './pages/Login.jsx';
import CallHistory from './pages/CallHistory.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import Toaster from './components/ui/Toaster.jsx';
import ConfirmHost from './components/ui/ConfirmHost.jsx';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Restore a session left open by a previous *document* — a browser reload, not
  // a route change. Route changes never reach here, because this component is
  // not remounted by them, which is precisely why the phone survives them.
  //
  // Safe under StrictMode's double-invoke: resume() returns early when a
  // UserAgent already exists, so the second call is a no-op rather than a second
  // registration.
  useEffect(() => {
    phone.resume();
    // Follows the phone's call state for the life of the app, so recording is
    // not tied to whether the Phone page happens to be mounted.
    attachRecorder();
    // Only the server can answer this: the cookie may be expired or revoked.
    auth.check();
  }, []);

  return (
    <Routes>
      {/* Outside the shell: there is nothing to navigate to until signed in. */}
      <Route path="/login" element={<Login />} />
      <Route
        path="*"
        element={
          <RequireAuth>
            <Shell sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} />
          </RequireAuth>
        }
      />
    </Routes>
  );
}

/**
 * The signed-in application.
 *
 * Rendered once and kept mounted across every route change, which is what keeps
 * the phone alive — see services/phone-service.js.
 */
function Shell({ sidebarOpen, setSidebarOpen }) {
  return (
    <div className="app-shell">
      <Sidebar show={sidebarOpen} onHide={() => setSidebarOpen(false)} />

      <div className="app-content">
        <Navbar onToggleSidebar={() => setSidebarOpen((open) => !open)} />

        <main className="app-main" id="main">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/phone" element={<Phone />} />

            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/ivr-list" element={<IvrList />} />
            <Route path="/create-ivr" element={<CreateIvr />} />
            <Route path="/edit-ivr" element={<EditIvr />} />
            <Route path="/audio-files" element={<AudioFiles />} />
            <Route path="/test-ivr" element={<TestIvr />} />
            <Route path="/call-history" element={<CallHistory />} />

            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>

        <Footer />
      </div>

      {/* Hosts for notify.js. Mounted once, outside the routes, so a toast
          raised while navigating still appears. */}
      <Toaster />
      <ConfirmHost />
    </div>
  );
}
