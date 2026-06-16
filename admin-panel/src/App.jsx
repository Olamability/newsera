import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Sources from './pages/Sources'
import PublisherApplication from './pages/PublisherApplication'
import Categories from './pages/Categories'
import Analytics from './pages/Analytics'
import PublisherTraffic from './pages/PublisherTraffic'
import Infrastructure from './pages/Infrastructure'
import ModerationOverview from './pages/moderation/Overview'
import ReportsQueue from './pages/moderation/Reports'
import CaseView from './pages/moderation/CaseView'
import Verifications from './pages/moderation/Verifications'
import FraudMonitor from './pages/moderation/FraudMonitor'
import AuditLog from './pages/moderation/AuditLog'
import ModerationAnalytics from './pages/moderation/Analytics'
import UsersModeration from './pages/moderation/Users'

function Unauthorized() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white rounded-2xl shadow-md p-8 max-w-sm text-center">
        <p className="text-4xl mb-3">🚫</p>
        <h2 className="text-xl font-bold text-gray-800 mb-2">Access Denied</h2>
        <p className="text-sm text-gray-500">This account does not have admin privileges.</p>
        <a href="/login" className="mt-4 inline-block text-sm text-indigo-600 hover:underline">← Back to Login</a>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/unauthorized" element={<Unauthorized />} />

          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout>
                  <Dashboard />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/sources"
            element={
              <ProtectedRoute>
                <Layout>
                  <Sources />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/publisher-application"
            element={
              <ProtectedRoute>
                <Layout>
                  <PublisherApplication />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/categories"
            element={
              <ProtectedRoute>
                <Layout>
                  <Categories />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/analytics"
            element={
              <ProtectedRoute>
                <Layout>
                  <Analytics />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/publisher-traffic"
            element={
              <ProtectedRoute>
                <Layout>
                  <PublisherTraffic />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/infrastructure"
            element={
              <ProtectedRoute>
                <Layout>
                  <Infrastructure />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/moderation"
            element={
              <ProtectedRoute>
                <Layout>
                  <ModerationOverview />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/moderation/reports"
            element={
              <ProtectedRoute>
                <Layout>
                  <ReportsQueue />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/moderation/cases/:id"
            element={
              <ProtectedRoute>
                <Layout>
                  <CaseView />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/moderation/users"
            element={
              <ProtectedRoute>
                <Layout>
                  <UsersModeration />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/moderation/verifications"
            element={
              <ProtectedRoute>
                <Layout>
                  <Verifications />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/moderation/fraud"
            element={
              <ProtectedRoute>
                <Layout>
                  <FraudMonitor />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/moderation/analytics"
            element={
              <ProtectedRoute>
                <Layout>
                  <ModerationAnalytics />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/moderation/audit"
            element={
              <ProtectedRoute>
                <Layout>
                  <AuditLog />
                </Layout>
              </ProtectedRoute>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
